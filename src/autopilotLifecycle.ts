import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { AnomalyCandidate } from "./anomaly";
import { AnomalyRepo } from "./anomaly";
import type { AutopilotMode, AutopilotSnapshot, AutopilotState, AutopilotStatus } from "./autopilotState";
import type { Clock } from "./clock";
import { EventLog } from "./eventLog";
import { withTransaction } from "./transaction";

/**
 * The `actor` on everything a restart writes. Not a `sub` auth-service
 * reported: no caller exists at boot, and the `system:` prefix cannot collide
 * with a Clerk subject (`user_…`, `mch_…`).
 */
export const RESTART_ACTOR = "system:restart";

/** Anomaly type (and dedupe key) raised when a restart refused to resume live. */
export const RESUMED_IN_SHADOW = "autopilot_resumed_in_shadow";

const DISARMED: AutopilotSnapshot = { status: "disarmed", mode: null };

/** Owns the `autopilot_state` row: the lifecycle as last persisted. */
export class AutopilotStateRepo {
  // Pool | PoolClient so a transition's row and its event commit together.
  constructor(private pool: Pool | PoolClient, private clock: Clock) {}

  /** The persisted lifecycle, or null when nothing has ever been persisted. */
  async load(): Promise<AutopilotSnapshot | null> {
    // FOR UPDATE: inside a restore's transaction this holds the row until the
    // downgrade commits, so two booting processes cannot both read "live".
    const { rows } = await this.pool.query<StateRow>("SELECT status, mode FROM autopilot_state FOR UPDATE");
    return rows.length === 0 ? null : { status: rows[0].status, mode: rows[0].mode };
  }

  async save(snapshot: AutopilotSnapshot, actor: string | null): Promise<void> {
    await this.pool.query(
      `INSERT INTO autopilot_state (singleton, status, mode, updated_at, updated_by) VALUES (TRUE, $1, $2, $3, $4)
       ON CONFLICT (singleton) DO UPDATE
         SET status = EXCLUDED.status, mode = EXCLUDED.mode, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
      [snapshot.status, snapshot.mode, this.clock.now(), actor]
    );
  }
}

interface StateRow extends QueryResultRow {
  status: AutopilotStatus;
  mode: AutopilotMode | null;
}

/** What a boot runs as, and what (if anything) it refused to resume. */
export interface RestorePlan {
  snapshot: AutopilotSnapshot;
  /** The persisted live state that was downgraded to shadow, or null when nothing was. */
  downgradedFrom: AutopilotSnapshot | null;
}

/**
 * The restart rule (owner decision Q29 = C), as a pure function.
 *
 * Status survives a restart; **live does not**. A live autopilot comes back in
 * shadow, armed or paused as it was, and only an operator can put it back to
 * live. A deploy is not the owner saying "keep trading", and the fleet it
 * would resume into may have moved on (a wipe, a knob edit on another
 * instance, a half-finished rollback) — so the restart keeps everything that
 * costs nothing (planning, scoring, the event trail) and stops short of the
 * one thing that does. Shadow, disarmed and aborted come back as they were.
 */
export function restoredAfterRestart(persisted: AutopilotSnapshot | null): RestorePlan {
  if (persisted === null) return { snapshot: DISARMED, downgradedFrom: null };
  if (persisted.mode === "live") {
    return { snapshot: { status: persisted.status, mode: "shadow" }, downgradedFrom: persisted };
  }
  return { snapshot: persisted, downgradedFrom: null };
}

/** The anomaly a downgrade raises: the one place a restart asks for a human. */
export function resumedInShadowAnomaly(was: AutopilotSnapshot): AnomalyCandidate {
  const wasDescription = was.status === "armed" ? String(was.mode) : `${was.status} (${String(was.mode)})`;
  return {
    type: RESUMED_IN_SHADOW,
    dedupeKey: RESUMED_IN_SHADOW,
    detail: {
      message: `autopilot resumed in shadow after restart; was ${wasDescription}; re-arm live to continue trading`,
      was,
      now: { status: was.status, mode: "shadow" },
      actor: RESTART_ACTOR,
    },
  };
}

/** A transition requested after shutdown began; the HTTP layer answers it 503. */
export class LifecycleClosedError extends Error {
  constructor() {
    super("automation-service is shutting down");
  }
}

export interface AutopilotLifecycleDeps {
  state: AutopilotState;
  pool: Pool;
  clock: Clock;
  /** Starts the fleet loop. Called after any change that leaves the autopilot armed or paused. */
  startFleet: () => void;
  /** Drains and stops the fleet loop. Called on abort, before the abort is persisted. */
  stopFleet: () => Promise<void>;
}

/**
 * Every change to the autopilot's lifecycle, persisted (Q29).
 *
 * **One at a time.** Changes run on a single queue, the restore first, so an
 * arm that arrives while the process is still restoring lands after it — the
 * operator's request is the later word, and it wins — and two concurrent
 * requests can never interleave their memory and row writes into a
 * disagreement.
 *
 * **Which goes first, memory or row, depends on the direction.** A change
 * *toward* safety (pause, abort) takes effect in memory first and is persisted
 * after: a Postgres failure then answers 500 with the fleet already stopped,
 * and the row it failed to write is one a restart downgrades to shadow anyway.
 * A change *away* from safety (arm) is persisted first and takes effect only
 * once committed: a failure leaves the autopilot exactly as it was. Either way
 * the row and its lifecycle event commit in one transaction.
 *
 * **Closing** (graceful shutdown) refuses new changes and waits for the queue
 * to drain, so a change acknowledged to its caller is always on disk before
 * the pool closes, and nothing can start the fleet loop again after the
 * shutdown has stopped it.
 */
export class AutopilotLifecycle {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  /**
   * Settles once the persisted lifecycle has been restored. Rejects if the
   * restore failed — the process then stays disarmed, which is the old
   * behaviour and the safe one — so the entrypoint can refuse to serve.
   */
  readonly restored: Promise<void>;

  constructor(private readonly deps: AutopilotLifecycleDeps) {
    this.restored = this.serialize(() => this.restore());
    // Handled here so a test app nobody awaits can't crash the process with an
    // unhandled rejection; awaiting `restored` still sees the failure.
    this.restored.catch((err: unknown) => {
      console.error("automation-service: could not restore the autopilot state; staying disarmed", err);
    });
  }

  arm(mode: AutopilotMode, actor: string | null): Promise<AutopilotSnapshot> {
    return this.serialize(async () => {
      const { state, startFleet } = this.deps;
      const from = state.getStatus();
      const next: AutopilotSnapshot = { status: "armed", mode };
      await this.persist(next, actor, "armed", { from, mode, actor });
      state.restore(next);
      startFleet();
      return state.snapshot();
    });
  }

  pause(actor: string | null): Promise<AutopilotSnapshot> {
    return this.serialize(async () => {
      const { state } = this.deps;
      const from = state.getStatus();
      state.pause(); // throws InvalidTransitionError before anything is written
      await this.persist(state.snapshot(), actor, "paused", { from, actor });
      return state.snapshot();
    });
  }

  abort(actor: string | null): Promise<AutopilotSnapshot> {
    return this.serialize(async () => {
      const { state, stopFleet } = this.deps;
      const from = state.getStatus();
      state.abort();
      // Awaited so the abort only returns once any in-flight tick has actually
      // finished, not just been told to stop.
      await stopFleet();
      await this.persist(state.snapshot(), actor, "aborted", { from, actor });
      return state.snapshot();
    });
  }

  /** Refuses further changes and resolves once every accepted one is persisted. */
  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new LifecycleClosedError());
    const run = this.tail.then(fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async persist(
    snapshot: AutopilotSnapshot,
    actor: string | null,
    eventType: "armed" | "paused" | "aborted",
    detail: Record<string, unknown>
  ): Promise<void> {
    const { pool, clock } = this.deps;
    await withTransaction(pool, async (client) => {
      await new AutopilotStateRepo(client, clock).save(snapshot, actor);
      await new EventLog(client, clock).append(eventType, detail);
    });
  }

  /**
   * Brings back what the last process persisted, under `restoredAfterRestart`.
   * The downgraded row, the lifecycle event and the anomaly commit together:
   * a crash part-way leaves the row live, and the next boot does it again.
   * Because the row is then shadow, a crash-looping process raises the
   * anomaly once, not once per boot.
   */
  private async restore(): Promise<void> {
    const { state, pool, clock, startFleet } = this.deps;
    const plan = await withTransaction(pool, async (client) => {
      const persisted = await new AutopilotStateRepo(client, clock).load();
      const restored = restoredAfterRestart(persisted);
      const { status, mode } = restored.snapshot;
      if (status !== "armed" && status !== "paused") return restored;

      if (restored.downgradedFrom !== null) await new AutopilotStateRepo(client, clock).save(restored.snapshot, RESTART_ACTOR);
      // `from` is this process's own state, which a boot always starts as.
      await new EventLog(client, clock).append(status, { from: "disarmed", mode, actor: RESTART_ACTOR, restoredFrom: persisted });
      if (restored.downgradedFrom !== null) await new AnomalyRepo(client, clock).record(resumedInShadowAnomaly(restored.downgradedFrom));
      return restored;
    });
    state.restore(plan.snapshot);
    if (plan.snapshot.status === "armed" || plan.snapshot.status === "paused") startFleet();
  }
}
