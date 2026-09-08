import { decisionDetail, MiningDecisionRecord, readMiningRecord } from "../plannerDecision";

/**
 * The planner writes a decision; `replay.ts` reads it back and re-scores it
 * under different knobs. These two used to declare the layout separately, with
 * a note in CLAUDE.md asking nobody to add a third — so this pins the layout
 * rule and, more importantly, that the reader is the writer's inverse.
 */

const mining: MiningDecisionRecord = {
  shipSymbol: "MINING-1",
  systemSymbol: "X1-TEST",
  shipWaypoint: "X1-TEST-MARKET",
  currentCredits: 50_000,
  candidates: [{ waypoint: "X1-TEST-BELT", reachable: true, distance: 12, creditsPerCycle: 5000, score: 900 }],
  chosen: "X1-TEST-BELT",
  knobsUsed: { "mine.taskWeight": 1 },
  model: { speedUnitsPerHour: 30 },
};

describe("the decision record's two layouts", () => {
  it.each(["mine", "none"] as const)("carries the scoring block flat for a %s decision", (kind) => {
    const detail = decisionDetail(kind, mining, { miningScore: 900 });
    // Flat is what makes `detail.chosen` mean "the thing the ship was sent to"
    // for these two kinds, which is what an operator reading the log expects.
    expect(detail.chosen).toBe("X1-TEST-BELT");
    expect(detail.candidates).toHaveLength(1);
    expect(detail.miningDetail).toBeUndefined();
  });

  it.each(["contract", "scout"] as const)("nests it for a %s decision", (kind) => {
    const detail = decisionDetail(kind, mining, { contractId: "C-1" });
    // A flat `chosen` here would name an asteroid field the ship was never
    // sent to — the reason the two layouts exist at all.
    expect(detail.chosen).toBeUndefined();
    expect(detail.chosenKind).toBe(kind);
    expect((detail.miningDetail as MiningDecisionRecord).chosen).toBe("X1-TEST-BELT");
  });

  it.each(["mine", "none", "contract", "scout"] as const)("reads back what it wrote, for a %s decision", (kind) => {
    expect(readMiningRecord(decisionDetail(kind, mining, {}))).toEqual(mining);
  });

  it("reads whichever layout actually carries the candidates", () => {
    // A row qualifying on the flat disjunct while also carrying an unrelated
    // nested object. The planner does not write this, but the reader and the
    // SQL predicate must agree about which rows exist or a decision goes
    // missing from the denominator of "X of Y would have changed" - the class
    // of gap this module was extracted to close.
    const record = readMiningRecord({ ...mining, miningDetail: { note: "something else" } });
    expect(record?.chosen).toBe("X1-TEST-BELT");
    expect(record?.candidates).toHaveLength(1);
  });

  it("returns null for a decision that logged no candidates to re-score", () => {
    expect(readMiningRecord({ chosenKind: "none", shipSymbol: "MINING-1" })).toBeNull();
  });

  it("fills in fields the oldest rows predate rather than failing on them", () => {
    // These rows are an archive; a decision logged before `shipWaypoint` was
    // recorded is still replayable, and replay only needs the scoring inputs.
    const record = readMiningRecord({ candidates: [], chosen: null });
    expect(record).not.toBeNull();
    expect(record?.currentCredits).toBe(0);
    expect(record?.knobsUsed).toEqual({});
  });
});
