import { Pool } from "pg";
import { createPool, migrate } from "../db";
import { formatReport, loadDecisions, parseDuration, parseOverrides, replayDecision } from "../replay";
import { resetDatabase } from "../testSupport/resetDatabase";

/**
 * Replay is what makes "every decision is replayable" a fact rather than a
 * claim about the log's shape. These cases check that a logged decision really
 * can be re-scored under different knobs without touching the game.
 */
describe("replay argument parsing", () => {
  it("accepts a real knob within its bounds", () => {
    expect(parseOverrides(["mine.taskWeight=2"])).toEqual({ "mine.taskWeight": 2 });
  });

  it("rejects an unknown knob rather than silently ignoring it", () => {
    expect(() => parseOverrides(["mine.notAKnob=2"])).toThrow(/unknown knob/);
  });

  it("rejects a value the API itself would reject", () => {
    expect(() => parseOverrides(["mine.taskWeight=999"])).toThrow(/between 0 and 10/);
  });

  it("reads durations the way an operator would write them", () => {
    expect(parseDuration("90m")).toBe(90 * 60_000);
    expect(parseDuration("2h")).toBe(2 * 3_600_000);
    expect(parseDuration("7d")).toBe(7 * 86_400_000);
    expect(parseDuration("3")).toBe(3 * 3_600_000); // bare numbers are hours
    expect(() => parseDuration("soon")).toThrow(/could not read duration/);
  });
});

describe("replayDecision", () => {
  const decision = {
    id: "1",
    occurredAt: "2026-01-01T00:00:00.000Z",
    chosen: "X1-NEAR",
    chosenKind: "mine",
    currentCredits: 100_000,
    knobsUsed: { "mine.taskWeight": 1, "credit.reserveFloor": 0 },
    model: { speedUnitsPerHour: 30, overheadHours: 0.3, fuelCreditsPerUnitDistance: 5, fleetCreditsPerCycle: 5000 },
    candidates: [
      { waypoint: "X1-NEAR", reachable: true, distance: 10, creditsPerCycle: 5000 },
      { waypoint: "X1-FAR", reachable: true, distance: 40, creditsPerCycle: 9000 },
      { waypoint: "X1-UNREACHABLE", reachable: false },
    ],
  };

  it("reproduces the original choice when nothing is overridden", () => {
    const outcome = replayDecision(decision, {});
    expect(outcome.replayedChoice).toBe("X1-NEAR");
    expect(outcome.changed).toBe(false);
  });

  it("shows a reserve floor excluding the choice that was actually made", () => {
    // The near field's round trip costs 10 * 2 * 5 = 100 credits. A floor just
    // under the balance rules it out, and the far field with it.
    const outcome = replayDecision(decision, { "credit.reserveFloor": 99_950 });
    expect(outcome.replayedChoice).toBeNull();
    expect(outcome.changed).toBe(true);
    expect(outcome.replayedCandidates.find((c) => c.waypoint === "X1-NEAR")?.excluded).toBe("reserve-floor");
  });

  it("never scores an unreachable candidate", () => {
    const outcome = replayDecision(decision, {});
    expect(outcome.replayedCandidates.find((c) => c.waypoint === "X1-UNREACHABLE")).toMatchObject({
      score: null,
      excluded: "unreachable",
    });
  });

  it("replays each field's measured revenue, so overrides change policy and not evidence", () => {
    const outcome = replayDecision(decision, { "mine.taskWeight": 5 });
    const near = outcome.replayedCandidates.find((c) => c.waypoint === "X1-NEAR");
    const far = outcome.replayedCandidates.find((c) => c.waypoint === "X1-FAR");
    // Both scale by the same weight — the ranking between them is unchanged,
    // which is the honest answer: a global weight cannot reorder fields.
    expect((far?.score ?? 0) / (near?.score ?? 1)).toBeCloseTo(
      replayDecision(decision, {}).replayedCandidates.find((c) => c.waypoint === "X1-FAR")!.score! /
        replayDecision(decision, {}).replayedCandidates.find((c) => c.waypoint === "X1-NEAR")!.score!
    );
  });

  it("reports plainly when a change would have altered nothing", () => {
    const report = formatReport([replayDecision(decision, { "mine.taskWeight": 2 })], { "mine.taskWeight": 2 }, false);
    expect(report).toContain("0 of 1 decision(s) would have changed");
    expect(report).toContain("would not have altered any past assignment");
  });

  it("does not call an empty run a knob change, since none was made", () => {
    const report = formatReport([replayDecision(decision, {})], {}, false);
    expect(report).toContain("no overrides");
    expect(report).not.toContain("This knob change");
  });

  /**
   * A no-override replay must reproduce history exactly. If it doesn't, the
   * logged inputs and the scoring code have drifted apart and replay can no
   * longer be trusted — that has to be said out loud, not silently reported
   * as an interesting finding.
   */
  it("warns loudly if a decision changes with no overrides applied", () => {
    const drifted = { ...decision, chosen: "X1-FAR" }; // log says FAR; scoring says NEAR
    const report = formatReport([replayDecision(drifted, {})], {}, false);
    expect(report).toContain("Warning:");
    expect(report).toContain("may have drifted");
  });
});

describe("loadDecisions", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL!);
    await migrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  const insertAssignment = async (type: string, detail: Record<string, unknown>) => {
    await pool.query(`INSERT INTO event_log (occurred_at, type, detail) VALUES ($1, $2, $3)`, [
      new Date(),
      type,
      detail,
    ]);
  };

  it("reads both live and shadow decisions, and skips events with no candidates logged", async () => {
    const detail = {
      chosen: "X1-BELT",
      chosenKind: "mine",
      currentCredits: 50_000,
      knobsUsed: { "mine.taskWeight": 1 },
      model: { speedUnitsPerHour: 30, overheadHours: 0.3, fuelCreditsPerUnitDistance: 5 },
      candidates: [{ waypoint: "X1-BELT", reachable: true, distance: 12, creditsPerCycle: 5000 }],
    };
    await insertAssignment("planner_assignment", detail);
    await insertAssignment("planner_shadow_assignment", detail);
    await insertAssignment("planner_no_viable_target", { shipSymbol: "MINING-1" });

    const decisions = await loadDecisions(pool, new Date(Date.now() - 3_600_000), 100);
    expect(decisions).toHaveLength(2);
    expect(decisions[0].chosen).toBe("X1-BELT");
    expect(decisions[0].candidates).toHaveLength(1);
  });

  /** A contract or scout decision nests the mining scoring one level down. */
  it("finds the mining candidates inside a decision that a contract won", async () => {
    await insertAssignment("planner_assignment", {
      chosenKind: "contract",
      contractId: "C-1",
      miningDetail: {
        chosen: "X1-BELT",
        currentCredits: 50_000,
        knobsUsed: { "mine.taskWeight": 1 },
        model: { speedUnitsPerHour: 30, overheadHours: 0.3, fuelCreditsPerUnitDistance: 5 },
        candidates: [{ waypoint: "X1-BELT", reachable: true, distance: 12, creditsPerCycle: 5000 }],
      },
    });

    const decisions = await loadDecisions(pool, new Date(Date.now() - 3_600_000), 100);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].chosenKind).toBe("contract");
    expect(decisions[0].candidates).toHaveLength(1);
  });

  it("says so clearly when there is nothing to replay", () => {
    expect(formatReport([], { "mine.taskWeight": 2 }, false)).toContain("No replayable planner decisions");
  });
});
