import { Pool } from "pg";
import { createPool } from "./db";
import { KNOB_DEFINITIONS_BY_NAME } from "./knobs";
import {
  DECISION_EVENT_TYPES,
  MiningDecisionRecord,
  readMiningRecord,
  REPLAYABLE_DECISION_PREDICATE,
} from "./plannerDecision";
import { breachesReserveFloor, isViableCandidate, miningScore } from "./scoring";

/**
 * "What would the fleet have done if this knob had been different?"
 *
 * Every planner decision is logged with the full set of inputs it used — each
 * candidate's distance, the calibrated model, and every knob value. Because
 * scoring.ts is pure arithmetic over exactly those inputs, past decisions can
 * be re-scored against different knobs without touching the network, the game,
 * or the clock. That's the whole point of logging the inputs rather than just
 * the outcome.
 *
 * Use it before turning a knob in production:
 *
 * ```bash
 * npm run replay -- --set mine.taskWeight=2
 * npm run replay -- --since 2h --set credit.reserveFloor=50000 --verbose
 * ```
 *
 * It reports how many past decisions would have chosen a different asteroid
 * field. Zero flips means the change you're considering does nothing — which is
 * worth knowing before you attribute a later change in profit to it.
 *
 * **Scope**: this replays the mining choice between asteroid fields, which is
 * where the field-vs-field trade-off lives. It does not re-derive whether a
 * contract or a scouting run would have beaten mining outright — those scores
 * were frozen from market state at the time and can't be honestly recomputed
 * from the log alone. The log line for each decision still shows what won.
 */

/**
 * One logged decision, ready to re-score. The scoring block is
 * `MiningDecisionRecord` — the same type the planner writes — so the two cannot
 * drift; only the log-row identity around it is added here.
 */
interface ReplayDecision extends MiningDecisionRecord {
  id: string;
  occurredAt: string;
  chosenKind: string | null;
}

/** The `model` block, read back with each field optional: old rows predate some of them. */
type ReplayedModel = {
  speedUnitsPerHour?: number;
  overheadHours?: number;
  fuelCreditsPerUnitDistance?: number;
  fleetCreditsPerCycle?: number;
};

export interface ReplayOutcome {
  decision: ReplayDecision;
  originalChoice: string | null;
  replayedChoice: string | null;
  changed: boolean;
  replayedCandidates: { waypoint: string; score: number | null; excluded: string | null }[];
}

/** Parses `--set name=value` pairs, rejecting anything that isn't a real knob. */
export function parseOverrides(pairs: string[]): Record<string, number> {
  const overrides: Record<string, number> = {};
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    if (index <= 0) throw new Error(`--set expects name=value, got "${pair}"`);
    const name = pair.slice(0, index);
    const value = Number(pair.slice(index + 1));
    const definition = KNOB_DEFINITIONS_BY_NAME.get(name);
    if (definition === undefined) throw new Error(`unknown knob "${name}"`);
    if (!Number.isFinite(value)) throw new Error(`value for "${name}" must be a finite number`);
    if (value < definition.min || value > definition.max) {
      throw new Error(`${name} must be between ${definition.min} and ${definition.max}, got ${value}`);
    }
    overrides[name] = value;
  }
  return overrides;
}

/** `90m`, `2h`, `7d` → milliseconds. Plain numbers are read as hours. */
export function parseDuration(raw: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([mhd]?)$/.exec(raw.trim());
  if (match === null) throw new Error(`could not read duration "${raw}" — try 90m, 2h or 7d`);
  const amount = Number(match[1]);
  const unit = match[2] === "" ? "h" : match[2];
  const multiplier = unit === "m" ? 60_000 : unit === "d" ? 86_400_000 : 3_600_000;
  return amount * multiplier;
}

/**
 * Re-scores one logged decision under overridden knobs.
 *
 * Reachability and distance are properties of the universe at the time, so they
 * are replayed as recorded. Everything downstream of them — cycle time, score,
 * whether the reserve floor excludes a candidate — is recomputed.
 */
export function replayDecision(decision: ReplayDecision, overrides: Record<string, number>): ReplayOutcome {
  const knob = (name: string, fallback: number): number => overrides[name] ?? decision.knobsUsed[name] ?? fallback;
  const model = decision.model as ReplayedModel;

  const speedUnitsPerHour = model.speedUnitsPerHour ?? knob("travel.speedUnitsPerHourPrior", 30);
  const overheadHours = model.overheadHours ?? knob("cycle.overheadHoursPrior", 0.3);
  const fuelCreditsPerUnitDistance = model.fuelCreditsPerUnitDistance ?? knob("fuel.creditsPerUnitDistancePrior", 5);
  const fleetCreditsPerCycle = model.fleetCreditsPerCycle ?? knob("mine.creditsPerCyclePrior", 5000);
  const taskWeight = knob("mine.taskWeight", 1);
  const reserveFloor = knob("credit.reserveFloor", 0);

  const replayedCandidates = decision.candidates.map((candidate) => {
    if (!candidate.reachable || candidate.distance === undefined) {
      return { waypoint: candidate.waypoint, score: null, excluded: "unreachable" };
    }
    const roundTripDistance = candidate.distance * 2;
    // What a cycle here was believed to be worth is a measurement, not a knob —
    // replaying it as recorded is what keeps this an honest "same evidence,
    // different policy" comparison.
    const creditsPerCycle = candidate.creditsPerCycle ?? fleetCreditsPerCycle;
    const { score } = miningScore({
      roundTripDistance,
      creditsPerCycle,
      taskWeight,
      speedUnitsPerHour,
      overheadHours,
    });
    const estimatedFuelCost = roundTripDistance * fuelCreditsPerUnitDistance;
    // The planner's own predicate, not a restatement of it: replay exists to
    // answer "what would the planner have done", so any rule it applies and
    // this does not is a wrong answer delivered confidently.
    if (breachesReserveFloor({ currentCredits: decision.currentCredits, estimatedCost: estimatedFuelCost, reserveFloor })) {
      return { waypoint: candidate.waypoint, score, excluded: "reserve-floor" };
    }
    if (!isViableCandidate({ reachable: true, breachesReserveFloor: false, score })) {
      // Scoring at or below zero loses to idling. Without this, replaying
      // `mine.taskWeight=0` reported a chosen field for every decision the
      // planner had logged as `planner_no_viable_target`.
      return { waypoint: candidate.waypoint, score, excluded: "not-worth-it" };
    }
    return { waypoint: candidate.waypoint, score, excluded: null };
  });

  const best = replayedCandidates
    .filter((c) => c.excluded === null && c.score !== null)
    .reduce<{ waypoint: string; score: number } | null>(
      (winner, c) => (winner === null || (c.score as number) > winner.score ? { waypoint: c.waypoint, score: c.score as number } : winner),
      null
    );

  const replayedChoice = best?.waypoint ?? null;
  return {
    decision,
    originalChoice: decision.chosen,
    replayedChoice,
    changed: replayedChoice !== decision.chosen,
    replayedCandidates,
  };
}

/**
 * Loads logged planner decisions that carry enough detail to be replayed.
 *
 * Which types those are, which rows qualify, and where the scoring block sits
 * in each are all `plannerDecision.ts`'s to say — this function's own knowledge
 * is limited to "read them oldest first, up to a limit".
 */
export async function loadDecisions(pool: Pool, since: Date, limit: number): Promise<ReplayDecision[]> {
  const { rows } = await pool.query(
    `SELECT id, occurred_at, detail FROM event_log
     WHERE type = ANY($1::text[])
       AND occurred_at >= $2
       AND ${REPLAYABLE_DECISION_PREDICATE}
     ORDER BY occurred_at ASC, id ASC
     LIMIT $3`,
    [DECISION_EVENT_TYPES, since, limit]
  );

  const decisions: ReplayDecision[] = [];
  for (const row of rows as { id: string | number; occurred_at: Date; detail: Record<string, unknown> }[]) {
    const record = readMiningRecord(row.detail);
    if (record === null) continue; // the SQL already excludes these; belt and braces for old rows
    decisions.push({
      ...record,
      id: String(row.id),
      occurredAt: row.occurred_at.toISOString(),
      chosenKind: (row.detail.chosenKind as string | undefined) ?? null,
    });
  }
  return decisions;
}

export function formatReport(outcomes: ReplayOutcome[], overrides: Record<string, number>, verbose: boolean): string {
  const lines: string[] = [];
  const overrideList = Object.entries(overrides)
    .map(([name, value]) => `${name}=${value}`)
    .join(", ");

  lines.push(`Replaying ${outcomes.length} decision(s) with ${overrideList || "no overrides"}`);
  lines.push("");

  if (outcomes.length === 0) {
    lines.push("No replayable planner decisions in that window.");
    lines.push("Decisions are logged once the autopilot has been armed (live or shadow).");
    return lines.join("\n");
  }

  const changed = outcomes.filter((o) => o.changed);
  for (const outcome of outcomes) {
    if (!verbose && !outcome.changed) continue;
    const marker = outcome.changed ? "CHANGED" : "same";
    const kind = outcome.decision.chosenKind !== null ? ` [${outcome.decision.chosenKind}]` : "";
    lines.push(
      `${outcome.decision.occurredAt}${kind} ${marker}: ${outcome.originalChoice ?? "(none)"} -> ${outcome.replayedChoice ?? "(none)"}`
    );
    if (verbose) {
      for (const candidate of outcome.replayedCandidates) {
        const score = candidate.score === null ? "—" : candidate.score.toFixed(1);
        const note = candidate.excluded !== null ? ` (${candidate.excluded})` : "";
        lines.push(`    ${candidate.waypoint.padEnd(24)} ${score.padStart(12)} cr/h${note}`);
      }
    }
  }

  lines.push("");
  lines.push(`${changed.length} of ${outcomes.length} decision(s) would have changed.`);
  if (changed.length === 0 && overrideList !== "") {
    lines.push("This knob change would not have altered any past assignment.");
  }
  // With no overrides every decision should reproduce exactly. If one doesn't,
  // the logged inputs and the scoring code have drifted apart — which is worth
  // saying loudly, because it means replay can no longer be trusted.
  if (changed.length > 0 && overrideList === "") {
    lines.push("Warning: decisions changed with no overrides applied — logged inputs and scoring may have drifted.");
  }
  return lines.join("\n");
}

interface ReplayArgs {
  overrides: Record<string, number>;
  sinceMs: number;
  limit: number;
  verbose: boolean;
}

export function parseArgs(argv: string[]): ReplayArgs {
  const sets: string[] = [];
  let sinceMs = parseDuration("24h");
  let limit = 200;
  let verbose = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--set") sets.push(argv[++i] ?? "");
    else if (arg === "--since") sinceMs = parseDuration(argv[++i] ?? "24h");
    else if (arg === "--limit") limit = Number(argv[++i] ?? 200);
    else if (arg === "--verbose" || arg === "-v") verbose = true;
    else throw new Error(`unknown argument "${arg}"`);
  }
  if (!Number.isFinite(limit) || limit <= 0) throw new Error("--limit must be a positive number");

  return { overrides: parseOverrides(sets), sinceMs, limit, verbose };
}

if (require.main === module) {
  const run = async (): Promise<void> => {
    const args = parseArgs(process.argv.slice(2));
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl === "") throw new Error("DATABASE_URL must be set");

    const pool = createPool(databaseUrl);
    try {
      const since = new Date(Date.now() - args.sinceMs);
      const decisions = await loadDecisions(pool, since, args.limit);
      const outcomes = decisions.map((d) => replayDecision(d, args.overrides));
      console.log(formatReport(outcomes, args.overrides, args.verbose));
    } finally {
      await pool.end();
    }
  };

  run().catch((err) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  });
}
