/**
 * Judge worker — Stages 2–3.
 *
 * Claim loop (concurrency 2) + reaper, both DB-enforced so any number of
 * worker processes can run safely against the same database:
 *
 *  - Claiming is a single UPDATE ... WHERE id = (SELECT ... FOR UPDATE
 *    SKIP LOCKED LIMIT 1): the database picks the winner. There is no
 *    in-process lock anywhere in this file.
 *  - Verdict application is one transaction, conditional on
 *    (status='running', worker_id): if 0 rows are affected, a newer
 *    attempt superseded this one and the worker must NOT touch the
 *    submission.
 *  - Judge infra failure never writes a student verdict. The attempt is
 *    left 'running' with its heartbeat going stale; the reaper requeues
 *    it (up to 3 times), then marks it 'failed' with verdict
 *    'judge_error' — which never reduces a score (see scoring.ts).
 *
 * Scoring note: the score column on an attempt stores 100 for accepted
 * and 0 otherwise. Per-problem points with wrong-attempt penalties live
 * in the leaderboard computation (core/scoring.ts), not here.
 *
 * Shutdown: stop() stops claiming and aborts in-flight runs; in-flight
 * attempts stay 'running' in the DB with a stale heartbeat and are
 * recovered by the reaper. A worker never deletes or rewrites another
 * worker's verdict.
 */
import { EventEmitter } from 'events';
import { hostname } from 'os';
import { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { log } from '../core/logger';
import { AttemptDetail, CaseResult, Verdict } from '../core/types';
import {
  JudgeInfraError,
  JudgeJob,
  JudgeRunner,
  createRunner,
} from './runner';

/** Minimal pool surface the worker needs (pg.Pool satisfies this). */
export interface DbPool {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
  connect(): Promise<PoolClient>;
}

export interface AttemptRow {
  id: string;
  submission_id: string;
  attempt_no: number;
  problem_version_id: string;
  test_suite_id: string;
  status: string;
  verdict: string | null;
  score: number;
  detail: Record<string, unknown>;
  worker_id: string | null;
  heartbeat_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
}

/** Single-statement, DB-enforced claim. Never add an in-process lock. */
export const CLAIM_SQL = `
  UPDATE attempts
  SET status = 'running', worker_id = $1, heartbeat_at = now(), started_at = now()
  WHERE id = (
    SELECT id FROM attempts
    WHERE status = 'queued'
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING *`;

const LOAD_JOB_SQL = `
  SELECT a.id AS attempt_id, a.submission_id, a.attempt_no, a.test_suite_id,
         s.code, s.language, s.problem_id,
         p.time_limit_ms, p.memory_mb
  FROM attempts a
  JOIN submissions s ON s.id = a.submission_id
  JOIN problems p ON p.id = s.problem_id
  WHERE a.id = $1`;

const LOAD_CASES_SQL = `
  SELECT position, name, input, expected_output
  FROM test_cases
  WHERE test_suite_id = $1
  ORDER BY position`;

const HEARTBEAT_SQL = `
  UPDATE attempts SET heartbeat_at = now()
  WHERE id = $1 AND worker_id = $2 AND status = 'running'`;

const APPLY_VERDICT_SQL = `
  UPDATE attempts
  SET status = 'completed', verdict = $1, score = $2, detail = (detail || $3::jsonb),
      finished_at = now()
  WHERE id = $4 AND status = 'running' AND worker_id = $5`;

const COMPLETE_SUBMISSION_SQL = `
  UPDATE submissions SET status = 'completed', updated_at = now()
  WHERE id = $1 AND current_attempt_no = $2`;

const STALE_SQL = `
  SELECT id, submission_id, attempt_no,
         COALESCE((detail ->> 'requeue_count')::int, 0) AS requeue_count
  FROM attempts
  WHERE status = 'running'
    AND heartbeat_at < now() - ($1 || ' seconds')::interval
  ORDER BY heartbeat_at`;

export type JudgeFailpoint =
  | 'none'
  | 'crash_before_verdict'
  | 'crash_after_judge'
  | 'runner_crash';

export interface WorkerOptions {
  workerId?: string;
  mode?: 'real' | 'double';
  /** Inject a runner (tests pass a DoubleRunner with scripted behaviour). */
  runner?: JudgeRunner;
  /** Number of parallel claim slots. Default 2. */
  concurrency?: number;
  /** Idle poll delay between claims (ms). Default 1000. */
  pollIntervalMs?: number;
  /** Heartbeat period while an attempt runs (ms). Default 15000. */
  heartbeatIntervalMs?: number;
  /** Reaper sweep period (ms). Default 30000. */
  reaperIntervalMs?: number;
  /** Stale threshold (s). Default WORKER_STALE_AFTER_SECONDS or 120. */
  staleAfterSeconds?: number;
  /** Max requeues before an attempt is failed as judge_error. Default 3. */
  maxRequeues?: number;
  failpoint?: JudgeFailpoint;
  judgeImage?: string;
  judgeCpu?: string;
  judgeMemoryMb?: number;
  judgePidsLimit?: number;
  judgeMaxOutputBytes?: number;
}

export interface WorkerHandle {
  workerId: string;
  /** EventEmitter. Events (each also emitted as `on<Event>`):
   *  claim, judgeStart, judgeDone, ack, superseded, infraError,
   *  requeue, exhausted (requeue budget spent, attempt failed).
   *  Payloads always carry submissionId + attemptId. */
  events: EventEmitter;
  start(): void;
  stop(): Promise<void>;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function envFailpoint(): JudgeFailpoint {
  const raw = (process.env.JUDGE_FAILPOINT ?? 'none').trim();
  if (
    raw === 'crash_before_verdict' ||
    raw === 'crash_after_judge' ||
    raw === 'runner_crash'
  ) {
    return raw;
  }
  return 'none';
}

export function createWorker(db: DbPool, opts: WorkerOptions = {}): WorkerHandle {
  const workerId =
    opts.workerId ??
    (process.env.WORKER_ID || undefined) ??
    `${hostname()}-${process.pid}`;
  const mode = opts.mode ?? (process.env.JUDGE_MODE === 'double' ? 'double' : 'real');
  const concurrency = opts.concurrency ?? 2;
  const pollMs = opts.pollIntervalMs ?? 1000;
  const heartbeatMs = opts.heartbeatIntervalMs ?? 15_000;
  const reaperMs = opts.reaperIntervalMs ?? 30_000;
  const staleAfterSeconds =
    opts.staleAfterSeconds ??
    Number(process.env.WORKER_STALE_AFTER_SECONDS ?? 120);
  const maxRequeues = opts.maxRequeues ?? 3;
  const failpoint = opts.failpoint ?? envFailpoint();
  const runner =
    opts.runner ??
    createRunner({
      mode,
      image: opts.judgeImage,
      cpu: opts.judgeCpu,
      memoryMb: opts.judgeMemoryMb,
      pidsLimit: opts.judgePidsLimit,
      maxOutputBytes: opts.judgeMaxOutputBytes,
    });

  const events = new EventEmitter();
  let stopping = false;
  let started = false;
  let slotPromises: Promise<void>[] = [];
  let reaperTimer: NodeJS.Timeout | undefined;
  const controllers = new Set<AbortController>();

  function emit(name: string, payload: Record<string, unknown>): void {
    events.emit(name, payload);
    events.emit(`on${name[0].toUpperCase()}${name.slice(1)}`, payload);
  }

  async function claim(): Promise<AttemptRow | null> {
    const res = await db.query<AttemptRow>(CLAIM_SQL, [workerId]);
    return res.rows[0] ?? null;
  }

  async function loadJob(attempt: AttemptRow): Promise<JudgeJob> {
    const jobRes = await db.query<{
      attempt_id: string;
      submission_id: string;
      attempt_no: number;
      test_suite_id: string;
      code: string;
      language: string;
      time_limit_ms: number;
      memory_mb: number;
    }>(LOAD_JOB_SQL, [attempt.id]);
    const row = jobRes.rows[0];
    if (!row) {
      throw new JudgeInfraError(`attempt ${attempt.id} has no submission/problem`);
    }
    const caseRes = await db.query<{
      position: number;
      name: string;
      input: string;
      expected_output: string;
    }>(LOAD_CASES_SQL, [row.test_suite_id]);
    if (caseRes.rows.length === 0) {
      throw new JudgeInfraError(
        `test suite ${row.test_suite_id} has no test cases`,
      );
    }
    return {
      submissionId: row.submission_id,
      attemptId: row.attempt_id,
      code: row.code,
      language: row.language,
      cases: caseRes.rows.map((c) => ({
        position: c.position,
        name: c.name,
        input: c.input,
        expectedOutput: c.expected_output,
      })),
      timeLimitMs: row.time_limit_ms,
      memoryMb: row.memory_mb,
    };
  }

  async function heartbeat(attemptId: string): Promise<void> {
    try {
      await db.query(HEARTBEAT_SQL, [attemptId, workerId]);
    } catch (err) {
      log.warn('heartbeat failed', {
        attemptId,
        workerId,
        error: String(err),
      });
    }
  }

  /**
   * Apply a verdict in ONE transaction, conditionally. Returns true if
   * this worker owned the attempt; false if a newer attempt superseded
   * it (0 rows affected) — in that case the submission is untouched.
   */
  async function applyVerdict(
    job: JudgeJob,
    attemptNo: number,
    verdict: Verdict,
    reason: string,
    cases: CaseResult[],
  ): Promise<boolean> {
    const score = verdict === 'accepted' ? 100 : 0;
    const detail: AttemptDetail = {
      mode,
      language: job.language,
      cases,
      reason,
      maxOutputBytes:
        opts.judgeMaxOutputBytes ??
        Number(process.env.JUDGE_MAX_OUTPUT_BYTES ?? 1024 * 1024),
    };
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(APPLY_VERDICT_SQL, [
        verdict,
        score,
        JSON.stringify(detail),
        job.attemptId,
        workerId,
      ]);
      if ((res.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK');
        log.warn('verdict superseded; submission untouched', {
          submissionId: job.submissionId,
          attemptId: job.attemptId,
          workerId,
          verdict,
        });
        emit('superseded', {
          submissionId: job.submissionId,
          attemptId: job.attemptId,
          verdict,
        });
        return false;
      }
      await client.query(COMPLETE_SUBMISSION_SQL, [job.submissionId, attemptNo]);
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async function processAttempt(attempt: AttemptRow): Promise<void> {
    const base = {
      submissionId: attempt.submission_id,
      attemptId: attempt.id,
      workerId,
    };
    const controller = new AbortController();
    controllers.add(controller);
    const hbTimer = setInterval(
      () => void heartbeat(attempt.id),
      heartbeatMs,
    );
    try {
      emit('claim', base);
      log.info('attempt claimed', base);

      // Best-effort: surface that the submission is being judged.
      // Only moves queued -> running; never overwrites a terminal state.
      await db
        .query(
          `UPDATE submissions SET status = 'running', updated_at = now()
           WHERE id = $1 AND status = 'queued'`,
          [attempt.submission_id],
        )
        .catch((err: unknown) =>
          log.warn('mark submission running failed', {
            ...base,
            error: String(err),
          }),
        );

      const job = await loadJob(attempt);
      emit('judgeStart', base);
      log.info('judging started', base);

      if (failpoint === 'runner_crash') {
        throw new JudgeInfraError(
          'simulated runner crash (JUDGE_FAILPOINT=runner_crash)',
        );
      }
      const result = await runner.run(job, { signal: controller.signal });
      emit('judgeDone', { ...base, verdict: result.verdict });
      log.info('judging finished', { ...base, verdict: result.verdict });

      if (
        failpoint === 'crash_before_verdict' ||
        failpoint === 'crash_after_judge'
      ) {
        // Simulate a real crash between judging and ack: exit NOW,
        // before any verdict write. The attempt stays 'running' with a
        // stale heartbeat; the reaper recovers it.
        log.error('simulating crash before verdict ack; exiting', base);
        process.exit(1);
      }

      const applied = await applyVerdict(
        job,
        attempt.attempt_no,
        result.verdict,
        result.reason,
        result.cases,
      );
      if (applied) {
        emit('ack', { ...base, verdict: result.verdict });
        log.info('verdict applied', { ...base, verdict: result.verdict });
      }
    } catch (err) {
      // Judge infra failure (or any failure before the verdict write):
      // do NOT write a student verdict. Leave the attempt 'running';
      // the heartbeat timer is cleared in the finally below, so the
      // heartbeat goes stale and the reaper requeues it.
      if (err instanceof JudgeInfraError) {
        log.error('judge infra failure; attempt left running for reaper', {
          ...base,
          error: err.message,
        });
      } else {
        log.error('attempt processing failed; attempt left running for reaper', {
          ...base,
          error: String(err),
        });
      }
      emit('infraError', { ...base, error: String(err) });
    } finally {
      clearInterval(hbTimer);
      controllers.delete(controller);
    }
  }

  async function slotLoop(): Promise<void> {
    while (!stopping) {
      let attempt: AttemptRow | null = null;
      try {
        attempt = await claim();
      } catch (err) {
        log.error('claim failed', { workerId, error: String(err) });
        await sleep(pollMs);
        continue;
      }
      if (!attempt) {
        await sleep(pollMs);
        continue;
      }
      await processAttempt(attempt);
    }
  }

  /**
   * Reaper: recover attempts whose worker died or stalled. Runs every
   * reaperMs (30 s) and once at start. Per stale attempt, in a
   * transaction (row locked, re-checked inside): requeue while
   * requeue_count < maxRequeues, else fail it with judge_error and
   * complete its submission (only if it is still the current attempt —
   * a judge_error never reduces a score, and a previous authoritative
   * attempt still counts).
   */
  async function reap(): Promise<void> {
    let stale: { id: string; submission_id: string; attempt_no: number; requeue_count: number }[];
    try {
      const res = await db.query<{
        id: string;
        submission_id: string;
        attempt_no: number;
        requeue_count: number;
      }>(STALE_SQL, [staleAfterSeconds]);
      stale = res.rows;
    } catch (err) {
      log.error('reaper scan failed', { workerId, error: String(err) });
      return;
    }
    for (const row of stale) {
      const base = {
        submissionId: row.submission_id,
        attemptId: row.id,
        workerId,
      };
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const locked = await client.query<{
          id: string;
          status: string;
          heartbeat_at: Date | null;
          requeue_count: number;
        }>(
          `SELECT id, status, heartbeat_at,
                  COALESCE((detail ->> 'requeue_count')::int, 0) AS requeue_count
           FROM attempts WHERE id = $1 FOR UPDATE`,
          [row.id],
        );
        const cur = locked.rows[0];
        const stillStale =
          cur &&
          cur.status === 'running' &&
          cur.heartbeat_at !== null &&
          new Date(cur.heartbeat_at).getTime() <
            Date.now() - staleAfterSeconds * 1000;
        if (!stillStale) {
          await client.query('ROLLBACK');
          continue;
        }
        const count = cur.requeue_count;
        if (count < maxRequeues) {
          await client.query(
            `UPDATE attempts
             SET status = 'queued', worker_id = NULL, heartbeat_at = NULL,
                 started_at = NULL,
                 detail = detail || jsonb_build_object('requeue_count', $2::int)
             WHERE id = $1`,
            [row.id, count + 1],
          );
          await client.query('COMMIT');
          log.warn('reaper requeued stale attempt', {
            ...base,
            requeueCount: count + 1,
          });
          emit('requeue', { ...base, requeueCount: count + 1 });
        } else {
          await client.query(
            `UPDATE attempts
             SET status = 'failed', verdict = 'judge_error', finished_at = now()
             WHERE id = $1`,
            [row.id],
          );
          await client.query(COMPLETE_SUBMISSION_SQL, [
            row.submission_id,
            row.attempt_no,
          ]);
          await client.query('COMMIT');
          log.error('reaper exhausted stale attempt as judge_error', {
            ...base,
            requeueCount: count,
          });
          emit('exhausted', { ...base, requeueCount: count });
        }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        log.error('reaper recovery failed', { ...base, error: String(err) });
      } finally {
        client.release();
      }
    }
  }

  function start(): void {
    if (started) return;
    started = true;
    stopping = false;
    slotPromises = Array.from({ length: concurrency }, () => slotLoop());
    reaperTimer = setInterval(() => {
      void reap().catch((err: unknown) =>
        log.error('reaper failed', { workerId, error: String(err) }),
      );
    }, reaperMs);
    void reap().catch((err: unknown) =>
      log.error('reaper failed', { workerId, error: String(err) }),
    );
    log.info('worker started', { workerId, mode, concurrency });
  }

  async function stop(): Promise<void> {
    stopping = true;
    if (reaperTimer) clearInterval(reaperTimer);
    reaperTimer = undefined;
    // Abort in-flight runs so slot loops can finish promptly. Aborted
    // attempts stay 'running' in the DB; the reaper recovers them.
    for (const c of controllers) c.abort();
    await Promise.allSettled(slotPromises);
    started = false;
    log.info('worker stopped', { workerId });
  }

  return { workerId, events, start, stop };
}
