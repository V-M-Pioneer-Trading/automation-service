import http from "http";
import { AddressInfo } from "net";
import request from "supertest";
import { Pool } from "pg";
import { FakeClock } from "../testSupport/fakeClock";
import { createTestApp } from "../testSupport/createTestApp";
import { bearer, TEST_SERVICE_SECRET } from "../testSupport/authTokens";
import { createPool, migrate } from "../db";
import { resetDatabase } from "../testSupport/resetDatabase";

function makeShip(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "MINING-1",
    nav: {
      systemSymbol: "X1-TEST",
      waypointSymbol: "X1-TEST-MARKET",
      status: "DOCKED",
      route: { arrival: "2026-01-01T00:00:00Z" },
    },
    cooldown: { expiration: null },
    fuel: { current: 100, capacity: 100 },
    cargo: { units: 0, capacity: 1, inventory: [] as { symbol: string; units: number }[] },
    ...overrides,
  };
}

function startStubServer(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void) {
  const calls: { method: string; url: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method ?? "", url: req.url ?? "", body });
      handler(req, body, res);
    });
  });
  return { server, calls };
}

const respondJson = (res: http.ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};

describe("automation-service planner (meta#10)", () => {
  let pool: Pool;
  let clock: FakeClock;
  let credits = 100_000;
  let fleetShouldFail = false;

  let agent: ReturnType<typeof startStubServer>;
  let fleet: ReturnType<typeof startStubServer>;
  let nav: ReturnType<typeof startStubServer>;
  let agentUrl: string, fleetUrl: string, navUrl: string;

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL!);
    await migrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Scouting off: these cases assert which asteroid field wins, so mining
    // needs to be the only bidder.
    await resetDatabase(pool);
    clock = new FakeClock(new Date("2026-01-01T00:00:00Z"));
    credits = 100_000;
    fleetShouldFail = false;

    agent = startStubServer((req, _body, res) => {
      if (req.url === "/agent" && req.method === "GET") {
        respondJson(res, 200, { credits });
        return;
      }
      if (req.url === "/ships/MINING-1" && req.method === "GET") {
        respondJson(res, 200, makeShip());
        return;
      }
      if (req.url === "/contracts" && req.method === "GET") {
        respondJson(res, 200, []); // no contracts in this suite — mining-only fixtures
        return;
      }
      respondJson(res, 404, { error: "not found" });
    });

    fleet = startStubServer((_req, _body, res) => {
      if (fleetShouldFail) {
        // A game refusal, not a 500: the retry limit is about "is this target
        // working out?", and only the game saying no is evidence about the
        // target. A 5xx classifies as `unavailable` and deliberately does not
        // count, so simulating a bad target with one would test nothing.
        respondJson(res, 400, { error: { message: "Ship is not currently in orbit." } });
        return;
      }
      respondJson(res, 404, { error: "unused in this suite" });
    });

    nav = startStubServer((req, _body, res) => {
      if (req.url === "/systems/X1-TEST/waypoints") {
        respondJson(res, 200, {
          data: [
            { symbol: "X1-TEST-MARKET", type: "PLANET", x: 0, y: 0, traits: [{ symbol: "MARKETPLACE" }] },
            // Near field: cheap, reachable, low round-trip time -> higher score.
            { symbol: "X1-TEST-BELT-NEAR", type: "ASTEROID_FIELD", x: 10, y: 0, traits: [] },
            // Far field: still reachable in one hop (within fuel capacity) but costs more time -> lower score.
            { symbol: "X1-TEST-BELT-FAR", type: "ASTEROID_FIELD", x: 90, y: 0, traits: [] },
            // Unreachable field: farther than any single tank can cover, and no
            // intermediate fuel station to hop through.
            { symbol: "X1-TEST-BELT-UNREACHABLE", type: "ASTEROID_FIELD", x: 500, y: 0, traits: [] },
          ],
        });
      } else {
        respondJson(res, 404, { error: "unhandled: " + req.url });
      }
    });

    await Promise.all([
      new Promise<void>((r) => agent.server.listen(0, r)),
      new Promise<void>((r) => fleet.server.listen(0, r)),
      new Promise<void>((r) => nav.server.listen(0, r)),
    ]);
    agentUrl = `http://127.0.0.1:${(agent.server.address() as AddressInfo).port}`;
    fleetUrl = `http://127.0.0.1:${(fleet.server.address() as AddressInfo).port}`;
    navUrl = `http://127.0.0.1:${(nav.server.address() as AddressInfo).port}`;
  });

  let gateways: ReturnType<typeof createTestApp>[] = [];

  afterEach(async () => {
    await Promise.all(gateways.map((g) => request(g).post("/api/automation/v1/autopilot/abort").set("Authorization", bearer())));
    gateways = [];
    await Promise.all([
      new Promise<void>((r) => agent.server.close(() => r())),
      new Promise<void>((r) => fleet.server.close(() => r())),
      new Promise<void>((r) => nav.server.close(() => r())),
    ]);
  });

  const app = () => {
    const gateway = createTestApp(pool, clock, {
      agentServiceUrl: agentUrl,
      fleetServiceUrl: fleetUrl,
      navigationServiceUrl: navUrl,
      miningShipSymbol: "MINING-1",
      schedulerIntervalMs: 100_000, // never fires on its own; forceFleetTick drives every tick
      replanIntervalMs: 300_000,
    });
    gateways.push(gateway);
    return gateway;
  };

  /** Run the fleet loop exactly `times`, in place of sleeping and hoping. */
  const tick = async (gateway: ReturnType<typeof createTestApp>, times = 1) => {
    for (let t = 0; t < times; t++) await gateway.locals.forceFleetTick();
  };

  const waitForAssignment = async (gateway: ReturnType<typeof createTestApp>, maxTicks = 200) => {
    for (let tick = 0; tick <= maxTicks; tick++) {
      const res = await request(gateway).get("/api/automation/v1/autopilot/ships/MINING-1");
      if (res.status === 200 && res.body.task.asteroidWaypoint !== null) return res.body.task;
      await gateway.locals.forceFleetTick();
    }
    throw new Error("timed out waiting for a planner assignment");
  };

  /** An armed gateway, ready to make its first assignment. */
  const armed = async () => {
    const gateway = app();
    await request(gateway).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({});
    return gateway;
  };

  /**
   * The point of measuring revenue per field rather than assuming one number
   * for all of them. With a single flat estimate every field scores the same
   * per cycle, so the nearest one always wins and the planner is really just
   * a distance sort. These two cases show the planner changing its mind purely
   * because of what the fleet has learned.
   */
  describe("scoring on measured revenue", () => {
    const recordCycle = (waypoint: string, revenue: number, at: Date) =>
      pool.query(
        `INSERT INTO mining_observation
           (ship_symbol, asteroid_waypoint, observed_at, revenue, cycle_hours, travel_distance, units_extracted)
         VALUES ('MINING-1', $1, $2, $3, 1, 0, 10)`,
        [waypoint, at, revenue]
      );

    it("picks the nearest field while every field is still an unknown quantity", async () => {
      const task = await waitForAssignment(await armed());
      expect(task.asteroidWaypoint).toBe("X1-TEST-BELT-NEAR");
    });

    it("switches to a farther field once that field is measured to be worth much more", async () => {
      // NEAR is a 20-unit round trip; FAR is 180. At the default 30 units/hour
      // and 0.3h overhead that's 0.97h vs 6.3h per cycle — so FAR only wins if
      // its measured revenue more than makes up for the extra flying.
      //
      // Eight cycles each, not one: a field's estimate is shrunk toward the
      // fleet average until it has been measured enough to be believed, so
      // the switch is now driven by repeated evidence rather than by a single
      // lucky trip. That is the point of the shrinkage, not a workaround.
      for (let i = 0; i < 8; i++) {
        await recordCycle("X1-TEST-BELT-NEAR", 500, clock.now());
        await recordCycle("X1-TEST-BELT-FAR", 60_000, clock.now());
      }

      const task = await waitForAssignment(await armed());
      expect(task.asteroidWaypoint).toBe("X1-TEST-BELT-FAR");
    });

    it("records where each field's revenue estimate came from, so a decision can be explained", async () => {
      await recordCycle("X1-TEST-BELT-NEAR", 4000, clock.now());
      const gateway = await armed();
      await waitForAssignment(gateway);

      const eventsRes = await request(gateway).get("/api/automation/v1/autopilot/events?limit=50");
      const assignment = eventsRes.body.events.find((e: { type: string }) => e.type === "planner_assignment");
      const candidates = assignment.detail.candidates as {
        waypoint: string;
        creditsPerCycle?: number;
        creditsPerCycleSource?: string;
      }[];

      const near = candidates.find((c) => c.waypoint === "X1-TEST-BELT-NEAR");
      const far = candidates.find((c) => c.waypoint === "X1-TEST-BELT-FAR");
      expect(near).toMatchObject({ creditsPerCycle: 4000, creditsPerCycleSource: "measured-here" });
      // FAR has never been mined, so it inherits the fleet-wide average.
      expect(far).toMatchObject({ creditsPerCycle: 4000, creditsPerCycleSource: "fleet-average" });
      expect(assignment.detail.model.provenance.creditsPerCycle).toBe("measured");
    });

    it("reports an uncalibrated model as running on priors, not as measured fact", async () => {
      const gateway = await armed();
      await waitForAssignment(gateway);

      const modelRes = await request(gateway).get("/api/automation/v1/planner/model");
      expect(modelRes.status).toBe(200);
      expect(modelRes.body.model.provenance).toMatchObject({
        creditsPerCycle: "prior",
        speed: "prior",
        overhead: "prior",
        fuel: "prior",
      });
      expect(modelRes.body.model.speedUnitsPerHour).toBe(30);
    });
  });

  it("knob table: reads defaults, accepts an in-range write, rejects out-of-range and unknown names", async () => {
    const gateway = app();

    const listRes = await request(gateway).get("/api/automation/v1/planner/knobs");
    expect(listRes.status).toBe(200);
    const reserveFloor = listRes.body.knobs.find((k: { name: string }) => k.name === "credit.reserveFloor");
    // Reads back at its default, whatever that is — the value itself is
    // pinned in knobClasses.test.ts, where the reason for it lives.
    expect(reserveFloor).toMatchObject({ value: reserveFloor.default, min: 0 });

    const okRes = await request(gateway).put("/api/automation/v1/planner/knobs/credit.reserveFloor").set("Authorization", bearer()).send({ value: 1000 });
    expect(okRes.status).toBe(200);
    expect(okRes.body.knob.value).toBe(1000);

    const rangeRes = await request(gateway).put("/api/automation/v1/planner/knobs/credit.reserveFloor").set("Authorization", bearer()).send({ value: -5 });
    expect(rangeRes.status).toBe(400);

    const unknownRes = await request(gateway).put("/api/automation/v1/planner/knobs/does.not.exist").set("Authorization", bearer()).send({ value: 1 });
    expect(unknownRes.status).toBe(404);

    const persistedRes = await request(gateway).get("/api/automation/v1/planner/knobs");
    const persisted = persistedRes.body.knobs.find((k: { name: string }) => k.name === "credit.reserveFloor");
    expect(persisted.value).toBe(1000); // the rejected write never took effect

    // The one successful write above is visible in the event feed with both
    // values — the rejected out-of-range and unknown-name writes are not.
    const eventsRes = await request(gateway).get("/api/automation/v1/autopilot/events?limit=50");
    const knobEvents = eventsRes.body.events.filter((e: { type: string }) => e.type === "knob_changed");
    expect(knobEvents).toHaveLength(1);
    expect(knobEvents[0].detail).toMatchObject({
      name: "credit.reserveFloor",
      previousValue: reserveFloor.default,
      newValue: 1000,
    });
  });

  it("POST /events accepts an ai_-namespaced event and rejects anything outside that namespace", async () => {
    const gateway = app();

    const okRes = await request(gateway)
      .post("/api/automation/v1/events").set("X-Service-Secret", TEST_SERVICE_SECRET)
      .send({ type: "ai_intervention", detail: { anomalyId: "42", rationale: "raised the failure limit" } });
    expect(okRes.status).toBe(201);

    const spoofRes = await request(gateway)
      .post("/api/automation/v1/events").set("X-Service-Secret", TEST_SERVICE_SECRET)
      .send({ type: "armed", detail: {} });
    expect(spoofRes.status).toBe(400);

    const missingPrefixRes = await request(gateway).post("/api/automation/v1/events").set("X-Service-Secret", TEST_SERVICE_SECRET).send({ type: "intervention" });
    expect(missingPrefixRes.status).toBe(400);

    const eventsRes = await request(gateway).get("/api/automation/v1/autopilot/events?limit=50");
    const aiEvents = eventsRes.body.events.filter((e: { type: string }) => e.type === "ai_intervention");
    expect(aiEvents).toHaveLength(1);
    expect(aiEvents[0].detail).toMatchObject({ anomalyId: "42", rationale: "raised the failure limit" });
  });

  it("assigns the reachable, highest-scoring asteroid field and logs the scoring inputs for replay", async () => {
    const gateway = app();
    await request(gateway).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({});

    const task = await waitForAssignment(gateway);
    expect(task.asteroidWaypoint).toBe("X1-TEST-BELT-NEAR");

    const eventsRes = await request(gateway).get("/api/automation/v1/autopilot/events?limit=50");
    const assignmentEvent = eventsRes.body.events.find((e: { type: string }) => e.type === "planner_assignment");
    expect(assignmentEvent).toBeDefined();
    expect(assignmentEvent.detail.chosen).toBe("X1-TEST-BELT-NEAR");
    expect(assignmentEvent.detail.currentCredits).toBe(100_000);

    const candidateSymbols = assignmentEvent.detail.candidates.map((c: { waypoint: string }) => c.waypoint);
    expect(candidateSymbols).toEqual(
      expect.arrayContaining(["X1-TEST-BELT-NEAR", "X1-TEST-BELT-FAR", "X1-TEST-BELT-UNREACHABLE"])
    );
    const unreachable = assignmentEvent.detail.candidates.find(
      (c: { waypoint: string }) => c.waypoint === "X1-TEST-BELT-UNREACHABLE"
    );
    expect(unreachable.reachable).toBe(false);
    const near = assignmentEvent.detail.candidates.find((c: { waypoint: string }) => c.waypoint === "X1-TEST-BELT-NEAR");
    const far = assignmentEvent.detail.candidates.find((c: { waypoint: string }) => c.waypoint === "X1-TEST-BELT-FAR");
    expect(near.score).toBeGreaterThan(far.score); // closer field scores higher (less time per cycle)
  });

  it("never assigns work that would breach the credit reserve floor", async () => {
    const gateway = app();

    // Set the floor above what the agent can afford after any candidate's estimated fuel cost.
    await request(gateway).put("/api/automation/v1/planner/knobs/credit.reserveFloor").set("Authorization", bearer()).send({ value: 99_999 });
    credits = 100_000; // fuel cost > 1 credit for any reachable field, so every candidate would breach the floor

    await request(gateway).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({});

    // Give the scheduler a few ticks and confirm it never assigns. Ticks, not a
    // sleep: the point is that the loop *ran* and still declined, which sleeping
    // never established.
    await tick(gateway, 3);

    const task = await request(gateway).get("/api/automation/v1/autopilot/ships/MINING-1").then((r) => r.body.task);
    expect(task.asteroidWaypoint).toBeNull();

    const eventsRes = await request(gateway).get("/api/automation/v1/autopilot/events?limit=50");
    const eventTypes = eventsRes.body.events.map((e: { type: string }) => e.type);
    expect(eventTypes).toContain("planner_no_viable_target");

    const assignmentEvent = eventsRes.body.events.find((e: { type: string }) => e.type === "planner_assignment");
    const allBreach = assignmentEvent.detail.candidates
      .filter((c: { reachable: boolean }) => c.reachable)
      .every((c: { breachesReserveFloor: boolean }) => c.breachesReserveFloor === true);
    expect(allBreach).toBe(true);
  });

  it("idles rather than mining when mine.taskWeight is 0, so the knob really is an off switch", async () => {
    const gateway = app();
    await request(gateway).put("/api/automation/v1/planner/knobs/mine.taskWeight").set("Authorization", bearer()).send({ value: 0 });
    await request(gateway).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({});

    await tick(gateway, 3);

    // Pre-fix a zero-weight field scored 0, which still beat "nothing else on
    // offer" and got assigned — the weight demoted mining instead of disabling it.
    const task = await request(gateway).get("/api/automation/v1/autopilot/ships/MINING-1").then((r) => r.body.task);
    expect(task.asteroidWaypoint).toBeNull();
    const eventsRes = await request(gateway).get("/api/automation/v1/autopilot/events?limit=50");
    expect(eventsRes.body.events.map((e: { type: string }) => e.type)).toContain("planner_no_viable_target");
  });

  it("reassigns away from a target after it fails repeatedly, without a separate periodic planner sweep", async () => {
    // Every fleet-service call errors, so the ship can never progress past dispatching
    // orbit/navigate against its assigned target.
    fleetShouldFail = true;

    const gateway = app();
    await request(gateway).post("/api/automation/v1/autopilot/arm").set("Authorization", bearer()).send({});

    await waitForAssignment(gateway); // first assignment happens immediately

    let failedEventSeen = false;
    for (let t = 0; t < 200 && !failedEventSeen; t++) {
      const eventsRes = await request(gateway).get("/api/automation/v1/autopilot/events?limit=100");
      failedEventSeen = eventsRes.body.events.some((e: { type: string }) => e.type === "mining_task_failed");
      if (!failedEventSeen) await gateway.locals.forceFleetTick();
    }
    expect(failedEventSeen).toBe(true);

    // Reassignment happens on the very next tick after the failure, not a separate sweep:
    // a second planner_assignment shows up without any extra external trigger.
    let assignmentCount = 0;
    for (let t = 0; t < 200 && assignmentCount < 2; t++) {
      const eventsRes = await request(gateway).get("/api/automation/v1/autopilot/events?limit=100");
      assignmentCount = eventsRes.body.events.filter((e: { type: string }) => e.type === "planner_assignment").length;
      if (assignmentCount < 2) await gateway.locals.forceFleetTick();
    }
    expect(assignmentCount).toBeGreaterThanOrEqual(2);
  }, 10_000);
});
