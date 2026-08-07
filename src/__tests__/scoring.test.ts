import { breachesReserveFloor, contractScore, creditsPerHour, cycleHours, miningScore, scoutScore } from "../scoring";

/**
 * The decision model, tested directly. These are the only tests in the suite
 * that don't need a database or a stub server, because scoring is pure
 * arithmetic — which is exactly why it was worth pulling out of the planner.
 */
describe("scoring", () => {
  describe("cycleHours", () => {
    it("is travel time plus fixed overhead", () => {
      expect(cycleHours({ distance: 60, speedUnitsPerHour: 30, overheadHours: 0.5 })).toBeCloseTo(2.5);
    });

    it("is infinite at zero speed, so nothing scores on a ship that cannot move", () => {
      expect(cycleHours({ distance: 10, speedUnitsPerHour: 0, overheadHours: 1 })).toBe(Infinity);
      expect(creditsPerHour(5000, Infinity)).toBe(0);
    });
  });

  describe("miningScore", () => {
    it("prefers the nearer field when both are worth the same per cycle", () => {
      const near = miningScore({ roundTripDistance: 20, creditsPerCycle: 5000, taskWeight: 1, speedUnitsPerHour: 30, overheadHours: 0.3 });
      const far = miningScore({ roundTripDistance: 200, creditsPerCycle: 5000, taskWeight: 1, speedUnitsPerHour: 30, overheadHours: 0.3 });
      expect(near.score).toBeGreaterThan(far.score);
    });

    /**
     * The whole reason revenue is measured per field rather than assumed
     * fleet-wide. With one flat revenue constant this case is impossible —
     * scoring reduces to picking the closest field, every time.
     */
    it("prefers a richer distant field over a poorer near one", () => {
      const poorAndNear = miningScore({
        roundTripDistance: 20,
        creditsPerCycle: 1000,
        taskWeight: 1,
        speedUnitsPerHour: 30,
        overheadHours: 0.3,
      });
      const richAndFar = miningScore({
        roundTripDistance: 60,
        creditsPerCycle: 9000,
        taskWeight: 1,
        speedUnitsPerHour: 30,
        overheadHours: 0.3,
      });
      expect(richAndFar.score).toBeGreaterThan(poorAndNear.score);
    });

    it("scales linearly with task weight, so weight trades mining off against other work", () => {
      const base = miningScore({ roundTripDistance: 30, creditsPerCycle: 5000, taskWeight: 1, speedUnitsPerHour: 30, overheadHours: 0.3 });
      const doubled = miningScore({ roundTripDistance: 30, creditsPerCycle: 5000, taskWeight: 2, speedUnitsPerHour: 30, overheadHours: 0.3 });
      expect(doubled.score).toBeCloseTo(base.score * 2);
    });

    it("scores zero at zero weight, which is how mining is switched off", () => {
      expect(
        miningScore({ roundTripDistance: 30, creditsPerCycle: 5000, taskWeight: 0, speedUnitsPerHour: 30, overheadHours: 0.3 }).score
      ).toBe(0);
    });
  });

  describe("contractScore", () => {
    it("is profit per hour, in the same units mining is scored in", () => {
      expect(contractScore({ expectedProfit: 4000, cycleHours: 2, taskWeight: 1 })).toBeCloseTo(2000);
    });

    it("can be negative, so an unprofitable contract loses to doing nothing", () => {
      expect(contractScore({ expectedProfit: -500, cycleHours: 1, taskWeight: 1 })).toBeLessThan(0);
    });
  });

  describe("scoutScore", () => {
    it("scores zero for a market refreshed just now", () => {
      const { score } = scoutScore({
        distance: 10,
        elapsedHours: 0,
        stalenessThresholdHours: 0.5,
        creditsPerRefresh: 5000,
        speedUnitsPerHour: 30,
        overheadHours: 0.3,
      });
      expect(score).toBe(0);
    });

    it("grows linearly with staleness, so markets rotate without an explicit cooldown", () => {
      const common = {
        distance: 10,
        stalenessThresholdHours: 0.5,
        creditsPerRefresh: 5000,
        speedUnitsPerHour: 30,
        overheadHours: 0.3,
      };
      const oneThreshold = scoutScore({ ...common, elapsedHours: 0.5 });
      const twoThresholds = scoutScore({ ...common, elapsedHours: 1 });
      expect(twoThresholds.score).toBeCloseTo(oneThreshold.score * 2);
      expect(oneThreshold.stalenessFactor).toBeCloseTo(1);
    });

    /**
     * The calibration that makes the three task kinds genuinely comparable:
     * at exactly one threshold of staleness, a refresh priced the same as a
     * mining cycle scores the same as that mining cycle over the same distance.
     */
    it("matches an equally-priced mining cycle at one threshold of staleness", () => {
      const shared = { speedUnitsPerHour: 30, overheadHours: 0.3 };
      const scout = scoutScore({
        distance: 30,
        elapsedHours: 0.5,
        stalenessThresholdHours: 0.5,
        creditsPerRefresh: 5000,
        ...shared,
      });
      const mining = miningScore({ roundTripDistance: 30, creditsPerCycle: 5000, taskWeight: 1, ...shared });
      expect(scout.score).toBeCloseTo(mining.score);
    });

    it("scores zero when scouting is priced at zero, which is how it is switched off", () => {
      const { score } = scoutScore({
        distance: 10,
        elapsedHours: 10,
        stalenessThresholdHours: 0.5,
        creditsPerRefresh: 0,
        speedUnitsPerHour: 30,
        overheadHours: 0.3,
      });
      expect(score).toBe(0);
    });
  });

  describe("breachesReserveFloor", () => {
    it("blocks work that would spend past the floor", () => {
      expect(breachesReserveFloor({ currentCredits: 10_000, estimatedCost: 3000, reserveFloor: 8000 })).toBe(true);
    });

    it("allows work that lands exactly on the floor", () => {
      expect(breachesReserveFloor({ currentCredits: 10_000, estimatedCost: 2000, reserveFloor: 8000 })).toBe(false);
    });
  });
});
