/**
 * The record a planner decision leaves behind, and the only place that knows
 * where it sits inside `event_log.detail`.
 *
 * A logged decision is the input to `replay.ts`, which is the mechanism the
 * whole knob-tuning workflow rests on: it re-scores past decisions under
 * different knob values so an operator can see whether a change would have
 * done anything before making it. That only works if the shape the planner
 * writes and the shape replay reads are the same shape. They were declared
 * separately in two files, with a comment in `CLAUDE.md` asking future readers
 * not to add a third — which is what a missing module looks like.
 *
 * **There are two on-disk layouts, and there will go on being two.** A mining
 * or no-target decision carries the mining block flat, because for those the
 * mining block *is* the decision: `detail.chosen` names the thing the ship was
 * sent to. A contract or scout decision nests it under `miningDetail`, because
 * a flat `chosen` there would name an asteroid field the ship was never sent
 * to. Normalising would strand every historical row — and the rows are the
 * archive replay reads — so both layouts stay, written and read through here.
 */

/**
 * One asteroid field as the planner saw it: reachable, how far, what a cycle
 * there is believed to earn, and what that scored. Every field it considered is
 * logged, not just the winner, which is what makes a replay a comparison rather
 * than a recount.
 */
export interface PlannerCandidate {
  waypoint: string;
  reachable: boolean;
  distance?: number;
  cycleHours?: number;
  estimatedFuelCost?: number;
  /** What one cycle here is expected to earn, and whether that is measured or assumed. */
  creditsPerCycle?: number;
  creditsPerCycleSource?: "measured-here" | "fleet-average" | "prior";
  score?: number;
  breachesReserveFloor?: boolean;
}

/** The scoring block a replay can re-run: the same evidence, under different policy. */
export interface MiningDecisionRecord {
  shipSymbol: string;
  systemSymbol: string;
  shipWaypoint: string;
  currentCredits: number;
  candidates: PlannerCandidate[];
  chosen: string | null;
  knobsUsed: Record<string, number>;
  /** The calibrated numbers actually scored with, so a replay reproduces the beliefs too. */
  model: Record<string, unknown>;
}

/** The event types a planner decision is logged as. Shadow decisions replay identically. */
export const DECISION_EVENT_TYPES = ["planner_assignment", "planner_shadow_assignment"];

/**
 * Rows carrying a scoring block in either layout. A decision logged before
 * candidates were recorded, or one from a system with no asteroid fields at
 * all, has nothing to re-score and is skipped rather than replayed as empty.
 */
export const REPLAYABLE_DECISION_PREDICATE = "(detail ? 'candidates' OR detail->'miningDetail' ? 'candidates')";

/** Which layout a decision of this kind is written in. See the note above. */
const isFlat = (chosenKind: string): boolean => chosenKind === "mine" || chosenKind === "none";

/** Assembles one decision's `detail`, in whichever layout its kind calls for. */
export function decisionDetail(
  chosenKind: "mine" | "contract" | "scout" | "none",
  mining: MiningDecisionRecord,
  extra: Record<string, unknown>
): Record<string, unknown> {
  return isFlat(chosenKind)
    ? { chosenKind, ...mining, ...extra }
    : { chosenKind, ...extra, miningDetail: mining };
}

/**
 * The inverse: pulls the scoring block back out of a logged `detail`, whichever
 * layout it was written in. Returns null for a row that carries no block.
 *
 * Reads defensively rather than casting the whole thing, because these rows are
 * an archive: the oldest of them predate fields the current writer always sets.
 */
export function readMiningRecord(detail: Record<string, unknown>): MiningDecisionRecord | null {
  const nested = detail.miningDetail as Record<string, unknown> | undefined;
  const block = nested ?? detail;
  if (block.candidates === undefined) return null;
  return {
    shipSymbol: (block.shipSymbol as string | undefined) ?? "",
    systemSymbol: (block.systemSymbol as string | undefined) ?? "",
    shipWaypoint: (block.shipWaypoint as string | undefined) ?? "",
    currentCredits: Number(block.currentCredits ?? 0),
    candidates: (block.candidates as PlannerCandidate[] | undefined) ?? [],
    chosen: (block.chosen as string | null | undefined) ?? null,
    knobsUsed: (block.knobsUsed as Record<string, number> | undefined) ?? {},
    model: (block.model as Record<string, unknown> | undefined) ?? {},
  };
}
