import type { Pool } from "pg";
import { LEGACY_ERROR_TEXT_PREDICATE, PUBLIC_REQUEST_PATTERN, REPEATED_DENIED_ANOMALY, REPEATED_DENIED_EVENT } from "./fleetEvents";

/** `maintenance_progress.name` for this job. */
export const LEGACY_SCRUB_JOB = "scrub_pre_45_error_text";

export interface LegacyScrubOptions {
  /** Rows of `event_log` looked at per statement, by primary key. Each batch is one statement, so one short transaction. */
  batchSize?: number;
  /**
   * Between batches. Each batch writes new row versions and WAL; on a host
   * with little free disk a fast burst outpaces autovacuum's reclaiming of the
   * old ones, so the walk is paced (~4-5 min for production's ~460k rows at
   * the defaults). It still shares disk and CPU with the fleet, just gently.
   */
  pauseMs?: number;
  /** After a failed batch. The cursor is kept, so the retry picks up at the same batch. */
  retryMs?: number;
  log?: (line: string, err?: unknown) => void;
}

/**
 * Removes pre-#45 error text from rows already written, in the background.
 *
 * Production held ~440k such rows (a 372 MB `event_log`) on a small host with
 * 90 s to answer health checks after `docker run`, so this cannot be one
 * UPDATE in `migrate()`: that blocks startup, writes the whole table's new
 * tuples and WAL in one transaction, and holds its locks throughout. Instead it
 * walks `event_log` by primary key (`id > cursor ORDER BY id LIMIT n`, which
 * needs no new index), one short statement per batch with a pause between,
 * and saves the cursor in `maintenance_progress` after each. It ends at the
 * newest id it saw at start: rows written since are clean by construction, so
 * a busy fleet can't keep it running. A restart resumes where the last one
 * stopped; a finished walk is recorded and never repeated. Progress only moves
 * forward (GREATEST / COALESCE), whatever two instances write.
 *
 * Until it finishes, `legacyErrorTextRemoved` keeps the public routes clean on
 * read; that is what makes doing this slowly safe. Failures are logged and
 * retried later, never thrown: this is housekeeping and must not take the
 * service down. `stop()` returns at once — it never waits for a batch, so the
 * shutdown deadline is never spent here; the batch in flight commits or not
 * as one statement and the loop exits after it.
 */
export class LegacyErrorTextScrubber {
  private readonly batchSize: number;
  private readonly pauseMs: number;
  private readonly retryMs: number;
  private readonly log: (line: string, err?: unknown) => void;
  private running: Promise<void> | null = null;
  private stopped = false;
  private wake: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly pool: Pool,
    options: LegacyScrubOptions = {}
  ) {
    this.batchSize = options.batchSize ?? 2000;
    this.pauseMs = options.pauseMs ?? 1000;
    this.retryMs = options.retryMs ?? 60_000;
    this.log =
      options.log ??
      ((line, err) => {
        if (err === undefined) console.log(line);
        else console.error(line, err);
      });
  }

  /** Starts the walk unless one is running. Resolves when this run ends: finished, stopped, or already done. For tests; the entrypoint does not await it. */
  start(): Promise<void> {
    if (this.running !== null) return this.running;
    this.stopped = false;
    this.running = this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Returns at once; see the class comment. */
  stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.wake?.();
    return Promise.resolve();
  }

  private async run(): Promise<void> {
    let progress: { cursor: number; finished: boolean } | null = null;
    while (progress === null) {
      try {
        progress = await this.loadProgress();
      } catch (err) {
        this.log("automation-service: legacy error-text scrub could not start; retrying later", err);
        if (!(await this.pause(this.retryMs))) return;
      }
    }
    if (progress.finished) return;

    // Where the walk ends: the newest row at start. Everything written after
    // is clean by construction, and walking to an empty batch instead would
    // chase a busy fleet's tail forever.
    let upTo: number | null = null;
    while (upTo === null) {
      try {
        upTo = await this.newestId();
      } catch (err) {
        this.log("automation-service: legacy error-text scrub could not start; retrying later", err);
        if (!(await this.pause(this.retryMs))) return;
      }
    }

    let { cursor } = progress;
    let events = 0;
    this.log(`automation-service: scrubbing pre-#45 error text from event_log in the background, from id ${String(cursor)}`);
    const anomalies = await this.scrubAnomalies();
    if (anomalies === null) return;

    while (cursor < upTo) {
      if (this.stopped) return;
      let batch: { lastId: number | null; scrubbed: number };
      try {
        batch = await this.scrubBatch(cursor, upTo);
      } catch (err) {
        this.log(`automation-service: legacy error-text scrub batch after id ${String(cursor)} failed; retrying later`, err);
        if (!(await this.pause(this.retryMs))) return;
        continue;
      }
      if (batch.lastId === null) break; // nothing left up to the bound
      cursor = batch.lastId;
      events += batch.scrubbed;
      try {
        await this.saveProgress(cursor, false);
      } catch {
        // Only costs a re-walk of this batch after a restart, which scrubs nothing.
      }
      if (!(await this.pause(this.pauseMs))) return;
    }

    try {
      await this.saveProgress(cursor, true);
    } catch (err) {
      this.log("automation-service: legacy error-text scrub finished but could not record it; the next boot re-checks", err);
    }
    this.log(`automation-service: legacy error-text scrub done: ${String(events)} event_log rows and ${String(anomalies)} anomaly rows scrubbed`);
  }

  /** The anomaly table is one row per deduped firing: small, so one statement. Null when stopped. */
  private async scrubAnomalies(): Promise<number | null> {
    for (;;) {
      if (this.stopped) return null;
      try {
        const { rowCount } = await this.pool.query(
          `UPDATE anomaly SET detail = detail - 'request'
            WHERE type = $1 AND detail ? 'request' AND NOT COALESCE((detail->>'request') ~ $2, false)`,
          [REPEATED_DENIED_ANOMALY, PUBLIC_REQUEST_PATTERN]
        );
        return rowCount ?? 0;
      } catch (err) {
        this.log("automation-service: legacy error-text scrub of anomaly failed; retrying later", err);
        if (!(await this.pause(this.retryMs))) return null;
      }
    }
  }

  private async newestId(): Promise<number> {
    const { rows } = await this.pool.query<{ m: string | null }>("SELECT max(id) AS m FROM event_log");
    return rows[0].m === null ? 0 : Number(rows[0].m);
  }

  private async scrubBatch(cursor: number, upTo: number): Promise<{ lastId: number | null; scrubbed: number }> {
    // `batch` walks every row by primary key, not only dirty ones, so the walk
    // needs no index of its own; the UPDATE touches only the dirty ones in it.
    const { rows } = await this.pool.query<{ last_id: string | null; scrubbed: string }>(
      `WITH batch AS (SELECT id FROM event_log WHERE id > $1 AND id <= $3 ORDER BY id LIMIT $2),
            scrubbed AS (
              UPDATE event_log e
                 SET detail = CASE WHEN e.type = '${REPEATED_DENIED_EVENT}' THEN e.detail - 'request' ELSE e.detail - 'message' END
                FROM batch
               WHERE e.id = batch.id AND ${LEGACY_ERROR_TEXT_PREDICATE}
              RETURNING e.id
            )
       SELECT (SELECT max(id) FROM batch) AS last_id, (SELECT count(*) FROM scrubbed) AS scrubbed`,
      [cursor, this.batchSize, upTo]
    );
    const row = rows[0];
    return { lastId: row.last_id === null ? null : Number(row.last_id), scrubbed: Number(row.scrubbed) };
  }

  private async loadProgress(): Promise<{ cursor: number; finished: boolean }> {
    const { rows } = await this.pool.query<{ cursor: string; finished_at: Date | null }>(
      "SELECT cursor, finished_at FROM maintenance_progress WHERE name = $1",
      [LEGACY_SCRUB_JOB]
    );
    return rows.length === 0 ? { cursor: 0, finished: false } : { cursor: Number(rows[0].cursor), finished: rows[0].finished_at !== null };
  }

  private async saveProgress(cursor: number, finished: boolean): Promise<void> {
    await this.pool.query(
      `INSERT INTO maintenance_progress (name, cursor, finished_at) VALUES ($1, $2, CASE WHEN $3 THEN now() END)
       ON CONFLICT (name) DO UPDATE
         SET cursor = GREATEST(maintenance_progress.cursor, EXCLUDED.cursor),
             finished_at = COALESCE(maintenance_progress.finished_at, EXCLUDED.finished_at)`,
      [LEGACY_SCRUB_JOB, cursor, finished]
    );
  }

  /** Resolves true after `ms`, or false at once if stopped meanwhile. */
  private pause(ms: number): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (completed: boolean) => {
        this.wake = null;
        this.timer = null;
        resolve(completed && !this.stopped);
      };
      this.wake = () => {
        done(false);
      };
      this.timer = setTimeout(() => {
        done(true);
      }, ms);
      this.timer.unref();
    });
  }
}
