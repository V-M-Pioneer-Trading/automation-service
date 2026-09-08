import { Pool } from "pg";
import { createPool, migrate } from "../db";
import { ObservationRepo, decayWeight, weightedMean, weightedRatio } from "../observations";
import { FakeClock } from "../testSupport/fakeClock";
import { resetDatabase } from "../testSupport/resetDatabase";

const PRIORS = {
  creditsPerCyclePrior: 5000,
  speedUnitsPerHourPrior: 30,
  overheadHoursPrior: 0.3,
  fuelCreditsPerUnitDistancePrior: 5,
  halfLifeHours: 6,
};

describe("observation weighting", () => {
  it("halves an observation's weight every half-life", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const sixHoursAgo = new Date("2026-01-01T06:00:00Z");
    expect(decayWeight(now, now, 6)).toBeCloseTo(1);
    expect(decayWeight(now, sixHoursAgo, 6)).toBeCloseTo(0.5);
  });

  it("ignores zero-weight and non-finite samples rather than poisoning the average", () => {
    expect(weightedMean([{ value: 10, weight: 1 }, { value: NaN, weight: 1 }, { value: 20, weight: 0 }])).toBeCloseTo(10);
    expect(weightedMean([])).toBeNull();
  });

  it("weights a rate by how much evidence each sample carries, not per-sample equally", () => {
    // One long haul and one tiny hop, both at honest speeds. A plain mean of
    // per-sample speeds would say 30; summing distance over summed time gives
    // the long haul the weight its distance earns.
    const ratio = weightedRatio([
      { numerator: 100, denominator: 5, weight: 1 }, // 20 units/hour over a long flight
      { numerator: 4, denominator: 0.1, weight: 1 }, // 40 units/hour over a short one
    ]);
    expect(ratio).toBeCloseTo(104 / 5.1);
  });
});

describe("ObservationRepo.calibrate", () => {
  let pool: Pool;
  let clock: FakeClock;
  let repo: ObservationRepo;

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL!);
    await migrate(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    clock = new FakeClock(new Date("2026-01-01T12:00:00Z"));
    repo = new ObservationRepo(pool, clock);
  });

  it("falls back to every prior when the fleet has never flown", async () => {
    const model = await repo.calibrate(PRIORS);

    expect(model.fleetCreditsPerCycle).toBe(5000);
    expect(model.speedUnitsPerHour).toBe(30);
    expect(model.overheadHours).toBe(0.3);
    expect(model.fuelCreditsPerUnitDistance).toBe(5);
    expect(model.provenance).toMatchObject({
      creditsPerCycle: "prior",
      speed: "prior",
      overhead: "prior",
      fuel: "prior",
    });
    expect(model.creditsPerCycleByWaypoint).toEqual({});
  });

  it("measures speed from real flights instead of assuming it", async () => {
    await repo.recordTravel({ distance: 100, hours: 2 });
    await repo.recordTravel({ distance: 50, hours: 1 });

    const model = await repo.calibrate(PRIORS);
    expect(model.speedUnitsPerHour).toBeCloseTo(50);
    expect(model.provenance.speed).toBe("measured");
    expect(model.provenance.flightSampleCount).toBe(2);
  });

  it("measures fuel cost from real refuels, ignoring flights that carry no price", async () => {
    await repo.recordTravel({ distance: 100, hours: 2 });
    await repo.recordTravel({ distance: 40, fuelCredits: 320 });

    const model = await repo.calibrate(PRIORS);
    expect(model.fuelCreditsPerUnitDistance).toBeCloseTo(8);
    expect(model.provenance.fuel).toBe("measured");
    expect(model.provenance.refuelSampleCount).toBe(1);
  });

  const recordCycles = (waypoint: string, revenue: number, times = 1) =>
    Promise.all(
      Array.from({ length: times }, () =>
        repo.recordMiningCycle({
          shipSymbol: "MINING-1",
          asteroidWaypoint: waypoint,
          revenue,
          cycleHours: 1,
          travelDistance: 30,
          unitsExtracted: 10,
        })
      )
    );

  /** The headline behaviour: two fields, different revenue, scored differently. */
  it("learns each field's own revenue and keeps a fleet-wide average for unvisited ones", async () => {
    await recordCycles("X1-RICH", 9000, 5);
    await recordCycles("X1-POOR", 1000, 5);

    const model = await repo.calibrate(PRIORS);
    expect(model.fleetCreditsPerCycle).toBeCloseTo(5000); // the average of the two, for a field never mined
    // Each field is scored on its own measurements, pulled slightly toward the
    // fleet average by the two pseudo-observations every field carries.
    expect(model.creditsPerCycleByWaypoint["X1-RICH"]).toBeCloseTo((9000 * 5 + 5000 * 2) / 7);
    expect(model.creditsPerCycleByWaypoint["X1-POOR"]).toBeCloseTo((1000 * 5 + 5000 * 2) / 7);
    expect(model.provenance.creditsPerCycle).toBe("measured");
    expect(model.provenance.waypointsWithOwnAverage).toEqual(["X1-POOR", "X1-RICH"]);
  });

  /**
   * Recency decay does not stop one lucky trip from swinging an estimate: a
   * weighted mean over a single sample is that sample. Without shrinkage, one
   * rich cycle set a field's estimate outright, the planner kept returning
   * there, and the only cycles that could correct it were the ones the
   * estimate itself caused.
   */
  it("does not let a single outlying cycle set a field's estimate outright", async () => {
    await recordCycles("X1-KNOWN", 1000, 10); // a well-measured, ordinary field
    await recordCycles("X1-LUCKY", 40_000, 1); // one anomalously rich trip

    const model = await repo.calibrate(PRIORS);
    const lucky = model.creditsPerCycleByWaypoint["X1-LUCKY"];
    expect(lucky).toBeLessThan(40_000 / 2); // pulled most of the way back
    expect(lucky).toBeGreaterThan(model.creditsPerCycleByWaypoint["X1-KNOWN"]); // still the better bet

    // Enough repeat evidence and the field is believed on its own terms.
    await recordCycles("X1-LUCKY", 40_000, 9);
    const convinced = await repo.calibrate(PRIORS);
    expect(convinced.creditsPerCycleByWaypoint["X1-LUCKY"]).toBeGreaterThan(30_000);
  });

  /**
   * The cap used to be fleet-wide, so a rarely-mined field's own cycles could
   * fall outside the newest N rows while still inside the age limit — it
   * reverted to the (higher) fleet average and became attractive again, so the
   * fleet re-learned the same disappointment on a loop.
   */
  it("keeps a rarely-mined field's own history even when a busy field fills the window", async () => {
    await recordCycles("X1-RARE", 200, 2);
    await recordCycles("X1-BUSY", 8000, 300);

    const model = await repo.calibrate(PRIORS);
    expect(model.provenance.waypointsWithOwnAverage).toContain("X1-RARE");
    expect(model.creditsPerCycleByWaypoint["X1-RARE"]).toBeLessThan(model.fleetCreditsPerCycle);
  }, 30_000);

  it("weights recent cycles above old ones, so a field that got better is noticed", async () => {
    await repo.recordMiningCycle({
      shipSymbol: "MINING-1",
      asteroidWaypoint: "X1-BELT",
      revenue: 1000,
      cycleHours: 1,
      travelDistance: 30,
      unitsExtracted: 10,
    });
    clock.advance(6 * 3_600_000); // exactly one half-life later
    await repo.recordMiningCycle({
      shipSymbol: "MINING-1",
      asteroidWaypoint: "X1-BELT",
      revenue: 4000,
      cycleHours: 1,
      travelDistance: 30,
      unitsExtracted: 40,
    });

    const model = await repo.calibrate(PRIORS);
    // Fresh cycle carries weight 1, the half-life-old one carries 0.5:
    // (4000 + 500) / 1.5 = 3000. A plain mean would have said 2500.
    expect(model.creditsPerCycleByWaypoint["X1-BELT"]).toBeCloseTo(3000);
  });

  it("derives overhead as the part of a cycle that travel does not explain", async () => {
    await repo.recordTravel({ distance: 60, hours: 2 }); // measured speed: 30 units/hour
    await repo.recordMiningCycle({
      shipSymbol: "MINING-1",
      asteroidWaypoint: "X1-BELT",
      revenue: 5000,
      cycleHours: 2.5,
      travelDistance: 60, // 2 hours of that cycle was flying
      unitsExtracted: 30,
    });

    const model = await repo.calibrate(PRIORS);
    expect(model.speedUnitsPerHour).toBeCloseTo(30);
    expect(model.overheadHours).toBeCloseTo(0.5);
    expect(model.provenance.overhead).toBe("measured");
  });

  it("clamps a cycle that finished faster than its travel allows, rather than going negative", async () => {
    await repo.recordTravel({ distance: 60, hours: 2 }); // 30 units/hour
    await repo.recordMiningCycle({
      shipSymbol: "MINING-1",
      asteroidWaypoint: "X1-BELT",
      revenue: 5000,
      cycleHours: 1, // impossible: 60 units of travel alone needs 2 hours
      travelDistance: 60,
      unitsExtracted: 30,
    });

    const model = await repo.calibrate(PRIORS);
    expect(model.overheadHours).toBe(0);
  });
});
