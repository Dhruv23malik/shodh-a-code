/**
 * Worker double tests (Stage 4).
 *
 * Two layers:
 *
 * A) CONTRACT-INVARIANT TESTS (always run, pg-mem, no Agent B code).
 *    They verify the exact SQL patterns the worker MUST use, against the
 *    schema in migrations/001_init.sql:
 *      (a) simultaneous claim of the same queued attempt -> exactly one
 *          claimer wins (atomic UPDATE ... WHERE status='queued' ... RETURNING);
 *      (b) crash_before_verdict -> the attempt stays 'running' with a stale
 *          heartbeat, the reaper requeues it, and it is judged exactly once
 *          with no duplicate score;
 *      (c) rejudge / late result -> a stale worker's conditional verdict
 *          UPDATE (WHERE status='running' AND worker_id=...) affects 0 rows,
 *          standings unchanged;
 *      (d) out-of-order completion -> leaderboard (aggregates SQL +
 *          computeStandings) equals the hand-computed standings.
 *    These run in pg-mem, so they pin the semantics even though they do not
 *    execute Agent B's worker code.
 *
 * B) AGENT B INTEGRATION TESTS (real PostgreSQL only; skip when the DB
 *    is unreachable). They run createWorker + DoubleRunner for real:
 *    (a)–(d) with event barriers. Agent B landed src/worker/worker.ts +
 *    runner.ts on 18 Nov 2026 ~21:05 IST, so these are written against
 *    the real interface — but no PostgreSQL is reachable on this VM, so
 *    they skip here and must be run by the reviewer/coordinator after
 *    `docker compose up --build` (or against any DATABASE_URL).
 *    (c) documents one divergence from the brief's assumption: see the
 *    note at the top of section B.
 */
import { computeStandings, ProblemAggregate } from '../../src/core/scoring';
import { AGGREGATES_SQL } from '../../scripts/leaderboard-sql';
import { applyMinimalSchema, createPgMem, PgMemHandle } from '../helpers/db';

const OPENS = new Date('2026-11-18T10:00:00.000Z');
const PV = 'pv-1';
const TS = 'ts-1';

let pg: PgMemHandle;

async function seedContest(contestId = 'c1', penaltyPerWrong = 20): Promise<void> {
  await pg.pool.query(
    `INSERT INTO contests (id, org_id, title, slug, status, opens_at, closes_at, penalty_per_wrong)
     VALUES ($1, 'org-1', 'T', 't', 'open', $2, $3, $4)`,
    [contestId, OPENS.toISOString(), new Date(OPENS.getTime() + 4 * 3600_000).toISOString(), penaltyPerWrong],
  );
}

let subSeq = 0;
async function addSubmission(
  authorId: string,
  problemId: string,
  createdAt: Date,
  contestId = 'c1',
): Promise<string> {
  subSeq += 1;
  const id = `sub-${authorId}-${problemId}-${subSeq}`;
  await pg.pool.query(
    `INSERT INTO submissions (id, contest_id, problem_id, problem_version_id, test_suite_id,
       author_id, code, code_hash, language, idempotency_key, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'print(1)','h','python',$7,'queued',$8)`,
    [id, contestId, problemId, PV, TS, authorId, `key-${id}`, createdAt.toISOString()],
  );
  return id;
}

async function addAttempt(
  submissionId: string,
  attemptNo: number,
  status: string,
  verdict: string | null,
  workerId: string | null = null,
  heartbeatAt: Date | null = null,
): Promise<string> {
  const id = `att-${submissionId}-${attemptNo}`;
  await pg.pool.query(
    `INSERT INTO attempts (id, submission_id, attempt_no, problem_version_id, test_suite_id,
       status, verdict, worker_id, heartbeat_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, submissionId, attemptNo, PV, TS, status, verdict, workerId, heartbeatAt?.toISOString() ?? null],
  );
  return id;
}

/** The claim every worker must use: atomic, exactly one winner. */
async function claimAttempt(workerId: string): Promise<string | null> {
  const r = await pg.pool.query<{ id: string }>(
    `UPDATE attempts SET status='running', worker_id=$1, started_at=now(), heartbeat_at=now()
     WHERE id = (
       SELECT id FROM attempts WHERE status='queued' ORDER BY created_at ASC LIMIT 1
     ) RETURNING id`,
    [workerId],
  );
  return r.rows[0]?.id ?? null;
}

/** The conditional verdict application: only the owning running worker may apply it. */
async function applyVerdict(
  attemptId: string,
  workerId: string,
  verdict: string,
): Promise<number> {
  const r = await pg.pool.query(
    `UPDATE attempts SET status='completed', verdict=$2, finished_at=now()
     WHERE id=$1 AND status='running' AND worker_id=$3`,
    [attemptId, verdict, workerId],
  );
  return r.rowCount ?? 0;
}

/** The reaper: stale 'running' attempts (no heartbeat) go back to 'queued'. */
async function reapStale(staleAfterSeconds: number): Promise<string[]> {
  const r = await pg.pool.query<{ id: string }>(
    `UPDATE attempts SET status='queued', worker_id=NULL, heartbeat_at=NULL
     WHERE status='running'
       AND (heartbeat_at IS NULL OR heartbeat_at < now() - ($1 || ' seconds')::interval)
     RETURNING id`,
    [String(staleAfterSeconds)],
  );
  return r.rows.map((row) => row.id);
}

async function aggregates(contestId = 'c1'): Promise<ProblemAggregate[]> {
  const r = await pg.pool.query(AGGREGATES_SQL, [contestId]);
  return r.rows.map((row) => ({
    userId: row.userId as string,
    problemId: row.problemId as string,
    solved: Boolean(row.solved),
    firstAcceptAt: row.firstAcceptAt ? new Date(row.firstAcceptAt as string) : null,
    wrongBeforeAccept: Number(row.wrongBeforeAccept),
  }));
}

describe('worker contract invariants (pg-mem)', () => {
  beforeEach(async () => {
    pg = createPgMem();
    await applyMinimalSchema(pg.pool);
    await seedContest();
    subSeq = 0;
  });

  afterEach(async () => {
    await pg.pool.end();
  });

  it('(a) simultaneous claim of the same queued attempt -> exactly one worker judges it', async () => {
    const sub = await addSubmission('u1', 'p1', new Date(OPENS.getTime() + 60_000));
    await addAttempt(sub, 1, 'queued', null);
    // Two workers racing: run the atomic claims back-to-back the way two
    // concurrent transactions would (pg-mem is single-threaded, so the
    // atomicity is what is under test: the second UPDATE finds no queued row).
    const first = await claimAttempt('worker-A');
    const second = await claimAttempt('worker-B');
    expect(first).toBe(`att-${sub}-1`);
    expect(second).toBeNull();
    const rows = await pg.pool.query<{ status: string; worker_id: string }>(
      `SELECT status, worker_id FROM attempts WHERE id=$1`,
      [`att-${sub}-1`],
    );
    expect(rows.rows[0]).toEqual({ status: 'running', worker_id: 'worker-A' });
    const queued = await pg.pool.query(`SELECT id FROM attempts WHERE status='queued'`);
    expect(queued.rows).toHaveLength(0);
  });

  it('(b) crash_before_verdict -> reaper recovers the attempt, judged exactly once, no duplicate score', async () => {
    const sub = await addSubmission('u1', 'p1', new Date(OPENS.getTime() + 60_000));
    const att = await addAttempt(sub, 1, 'queued', null);
    // Worker claims it, then "crashes" before any verdict: heartbeat goes stale.
    expect(await claimAttempt('worker-A')).toBe(att);
    await pg.pool.query(`UPDATE attempts SET heartbeat_at=$1 WHERE id=$2`, [
      new Date(Date.now() - 600_000).toISOString(), att,
    ]);
    // A verdict from the crashed worker must NOT land after the requeue:
    // reaper runs first (stale threshold 120s), attempt returns to queued.
    const reaped = await reapStale(120);
    expect(reaped).toEqual([att]);
    // Crashed worker's late verdict attempt: conditional update affects 0 rows.
    expect(await applyVerdict(att, 'worker-A', 'accepted')).toBe(0);
    // A second worker claims and judges it exactly once.
    expect(await claimAttempt('worker-B')).toBe(att);
    expect(await applyVerdict(att, 'worker-B', 'accepted')).toBe(1);
    expect(await applyVerdict(att, 'worker-B', 'accepted')).toBe(0); // not twice
    const rows = await pg.pool.query<{ status: string; verdict: string }>(
      `SELECT status, verdict FROM attempts WHERE id=$1`,
      [att],
    );
    expect(rows.rows[0]).toEqual({ status: 'completed', verdict: 'accepted' });
    const standings = computeStandings(await aggregates(), 20, OPENS);
    expect(standings).toEqual([{ userId: 'u1', totalScore: 100, totalPenaltyMinutes: 1 }]);
  });

  it("(c) rejudge: late result for attempt 1 after attempt 2 completed -> standings unchanged", async () => {
    const sub = await addSubmission('u1', 'p1', new Date(OPENS.getTime() + 60_000));
    const att1 = await addAttempt(sub, 1, 'running', null, 'worker-A', new Date());
    const att2 = await addAttempt(sub, 2, 'queued', null);
    // Attempt 2 is claimed and completed (accepted) while attempt 1 still runs.
    expect(await claimAttempt('worker-B')).toBe(att2);
    expect(await applyVerdict(att2, 'worker-B', 'accepted')).toBe(1);
    // Attempt 1's worker finally delivers its (stale) result — but attempt 1
    // is no longer the live attempt: mark it superseded, then the conditional
    // verdict update must affect 0 rows.
    await pg.pool.query(`UPDATE attempts SET status='superseded' WHERE id=$1`, [att1]);
    expect(await applyVerdict(att1, 'worker-A', 'wrong_answer')).toBe(0);
    const rows = await pg.pool.query<{ attempt_no: number; status: string; verdict: string | null }>(
      `SELECT attempt_no, status, verdict FROM attempts WHERE submission_id=$1 ORDER BY attempt_no`,
      [sub],
    );
    expect(rows.rows).toEqual([
      { attempt_no: 1, status: 'superseded', verdict: null },
      { attempt_no: 2, status: 'completed', verdict: 'accepted' },
    ]);
    // Standings still show the solve from attempt 2 only.
    const before = computeStandings(await aggregates(), 20, OPENS);
    expect(before).toEqual([{ userId: 'u1', totalScore: 100, totalPenaltyMinutes: 1 }]);
  });

  it('(d) out-of-order completion -> leaderboard equals computeStandings over the same data', async () => {
    // u1: wrong at +10min, accept at +30min (80 pts, 50 min)
    // u2: accept at +20min (100 pts, 20 min)
    // u1's accept is judged BEFORE u1's wrong (out of order in time), and
    // u2's submissions interleave. Standings must not depend on judge order.
    const s1w = await addSubmission('u1', 'p1', new Date(OPENS.getTime() + 10 * 60_000));
    const s1a = await addSubmission('u1', 'p1', new Date(OPENS.getTime() + 30 * 60_000));
    const s2a = await addSubmission('u2', 'p1', new Date(OPENS.getTime() + 20 * 60_000));
    // Complete in scrambled order: u1 accept first, then u2 accept, then u1 wrong.
    await addAttempt(s1a, 1, 'completed', 'accepted');
    await addAttempt(s2a, 1, 'completed', 'accepted');
    await addAttempt(s1w, 1, 'completed', 'wrong_answer');
    // A judge_error attempt must never count: u2 also has a judge_error
    // attempt on a later submission — it must not create a wrong attempt.
    const s2e = await addSubmission('u2', 'p1', new Date(OPENS.getTime() + 25 * 60_000));
    await addAttempt(s2e, 1, 'completed', 'judge_error');
    const aggs = await aggregates();
    expect(aggs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: 'u1', problemId: 'p1', solved: true, wrongBeforeAccept: 1 }),
        expect.objectContaining({ userId: 'u2', problemId: 'p1', solved: true, wrongBeforeAccept: 0 }),
      ]),
    );
    const standings = computeStandings(aggs, 20, OPENS);
    expect(standings).toEqual([
      { userId: 'u2', totalScore: 100, totalPenaltyMinutes: 20 },
      { userId: 'u1', totalScore: 80, totalPenaltyMinutes: 50 },
    ]);
  });

  it('judge_error as the ONLY attempt leaves the problem unsolved with 0 points', async () => {
    const sub = await addSubmission('u1', 'p1', new Date(OPENS.getTime() + 5 * 60_000));
    await addAttempt(sub, 1, 'completed', 'judge_error');
    const standings = computeStandings(await aggregates(), 20, OPENS);
    expect(standings).toEqual([{ userId: 'u1', totalScore: 0, totalPenaltyMinutes: 0 }]);
  });
});

/* ------------------------------------------------------------------ */
/* B) Agent B integration — skipped unless the modules have landed.    */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* B) AGENT B INTEGRATION — real createWorker + DoubleRunner against   */
/*    a REAL PostgreSQL (DATABASE_URL). Skips gracefully when no DB is  */
/*    reachable; never fakes a pass.                                    */
/*                                                                      */
/*    Real interface (read from src/worker/worker.ts + runner.ts,      */
/*    landed 18 Nov 2026 ~21:05 IST):                                  */
/*      createWorker(db: DbPool, opts: WorkerOptions): WorkerHandle     */
/*        opts: workerId, mode, runner, concurrency, pollIntervalMs,   */
/*        heartbeatIntervalMs, reaperIntervalMs, staleAfterSeconds,     */
/*        maxRequeues, failpoint.                                      */
/*        events (EventEmitter): claim, judgeStart, judgeDone, ack,     */
/*        superseded, infraError, requeue, exhausted.                  */
/*      new DoubleRunner(behaviors?, defaultBehavior)                   */
/*        behaviors keyed by attemptId, then submissionId.             */
/*        setBehavior(key, behavior); setDefaultBehavior(behavior).    */
/*        behavior: { verdict?, reason?, cases?,                       */
/*          failpoint?: 'none'|'crash_before_verdict'|'hang'|           */
/*          'runner_crash', delayMs? }                                 */
/*        events: judgeStart / judgeDone.                              */
/*    Coordination uses event promises (barriers), NOT sleeps; the     */
/*    only polling is a bounded wait for final DB state.               */
/*                                                                      */
/*    NOTE on scenario (c): the brief requires a stale worker's late     */
/*    verdict update to affect 0 rows. That holds because rejudge       */
/*    (submissions.service.rejudge) marks any live prior attempt       */
/*    'superseded' in the same transaction that creates the new        */
/*    attempt, and APPLY_VERDICT_SQL requires status='running' — so   */
/*    the late write affects 0 rows and emits 'superseded'. Test (c)   */
/*    asserts exactly that, plus standings unchanged.                  */
/* ------------------------------------------------------------------ */
import { EventEmitter } from 'events';
import { createWorker, DoubleRunner, WorkerHandle } from '../../src/worker/index';
import { pool } from '../../src/db/pool';
import { migrate } from '../../src/db/migrate';
import { LEADERBOARD_SQL } from '../../scripts/leaderboard-sql';
import { isRealDbReachable, skipReason } from '../helpers/db';

const W_OPENS = new Date('2026-11-01T00:00:00.000Z');
const W_ORG = 'bbbbbbbb-1111-4111-8111-111111111111';
const W_CONTEST = 'bbbbbbbb-0001-4000-8000-000000000001';
const W_PROBLEM = 'bbbbbbbb-0001-4000-8000-0000000000a1';
const W_VERSION = 'bbbbbbbb-0001-4000-8000-0000000000b1';
const W_SUITE = 'bbbbbbbb-0001-4000-8000-0000000000c1';
const W_U1 = 'bbbbbbbb-0001-4000-8000-0000000000d1';
const W_U2 = 'bbbbbbbb-0001-4000-8000-0000000000d2';

async function seedWorkerFixtures(): Promise<void> {
  await pool.query(`TRUNCATE attempts, submissions, test_cases, test_suites, problem_versions, problems, contest_participants, contests, org_memberships, users, organizations CASCADE`);
  await pool.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Test Org', 'test-org')`, [W_ORG]);
  await pool.query(
    `INSERT INTO users (id, email, display_name) VALUES
       ($1, 'w1@example.com', 'W One'), ($2, 'w2@example.com', 'W Two')`,
    [W_U1, W_U2],
  );
  await pool.query(
    `INSERT INTO org_memberships (org_id, user_id, role) VALUES
       ($1, $2, 'participant'), ($1, $3, 'participant')`,
    [W_ORG, W_U1, W_U2],
  );
  await pool.query(
    `INSERT INTO contests (id, org_id, title, slug, status, opens_at, closes_at, penalty_per_wrong)
     VALUES ($1, $2, 'W Contest', 'w-contest', 'open', $3, $4, 20)`,
    [W_CONTEST, W_ORG, W_OPENS.toISOString(), new Date(OPENS.getTime() + 60 * 86400_000).toISOString()],
  );
  await pool.query(
    `INSERT INTO contest_participants (contest_id, user_id) VALUES ($1, $2), ($1, $3)`,
    [W_CONTEST, W_U1, W_U2],
  );
  await pool.query(
    `INSERT INTO problems (id, org_id, slug, title, statement, time_limit_ms, memory_mb)
     VALUES ($1, $2, 'add-two-numbers', 'Add Two Numbers', 'sum', 2000, 256)`,
    [W_PROBLEM, W_ORG],
  );
  await pool.query(
    `INSERT INTO problem_versions (id, problem_id, version, description) VALUES ($1, $2, 1, 'v1')`,
    [W_VERSION, W_PROBLEM],
  );
  await pool.query(
    `UPDATE problems SET current_version_id = $1 WHERE id = $2`,
    [W_VERSION, W_PROBLEM],
  );
  await pool.query(
    `INSERT INTO test_suites (id, problem_version_id, version) VALUES ($1, $2, 1)`,
    [W_SUITE, W_VERSION],
  );
  const cases: Array<[string, number, string, string, string, boolean]> = [
    ['bbbbbbbb-0001-4000-8000-0000000000e1', 0, 'sample', '2 3\n', '5\n', false],
    ['bbbbbbbb-0001-4000-8000-0000000000e2', 1, 'bigger', '10 20\n', '30\n', true],
    ['bbbbbbbb-0001-4000-8000-0000000000e3', 2, 'negative', '-5 7\n', '2\n', true],
  ];
  for (const [id, pos, name, input, expected, hidden] of cases) {
    await pool.query(
      `INSERT INTO test_cases (id, test_suite_id, position, name, input, expected_output, is_hidden)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, W_SUITE, pos, name, input, expected, hidden],
    );
  }
}

let wSubSeq = 0;
async function insertSubmission(
  authorId: string,
  createdAt: Date,
): Promise<{ submissionId: string; attemptId: string }> {
  wSubSeq += 1;
  const submissionId = `bbbbbbbb-0001-4000-8000-00000000f${String(wSubSeq).padStart(3, '0')}`;
  const attemptId = `bbbbbbbb-0001-4000-8000-00000000e${String(wSubSeq).padStart(3, '0')}`;
  await pool.query(
    `INSERT INTO submissions (id, contest_id, problem_id, problem_version_id, test_suite_id,
       author_id, code, code_hash, language, idempotency_key, status, current_attempt_no, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'print(1)', 'h', 'python', $7, 'queued', 1, $8)`,
    [submissionId, W_CONTEST, W_PROBLEM, W_VERSION, W_SUITE, authorId, `wkey-${wSubSeq}`, createdAt.toISOString()],
  );
  await pool.query(
    `INSERT INTO attempts (id, submission_id, attempt_no, problem_version_id, test_suite_id, status)
     VALUES ($1, $2, 1, $3, $4, 'queued')`,
    [attemptId, submissionId, W_VERSION, W_SUITE],
  );
  return { submissionId, attemptId };
}

/** Barrier: resolves on the first matching event, rejects on timeout. */
function onceEvent(
  emitter: EventEmitter,
  event: string,
  pred: (p: any) => boolean = () => true,
  timeoutMs = 20000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, handler);
      reject(new Error(`timeout waiting for event ${event}`));
    }, timeoutMs);
    const handler = (p: any) => {
      if (!pred(p)) return;
      clearTimeout(timer);
      emitter.off(event, handler);
      resolve(p);
    };
    emitter.on(event, handler);
  });
}

/** Bounded wait for a DB condition (final-state assertion only). */
async function waitForDb(
  fn: () => Promise<boolean>,
  timeoutMs = 20000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error('timeout waiting for DB condition');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Aggregates over the REAL database (part A's aggregates() uses pg-mem). */
async function aggregatesReal(): Promise<ProblemAggregate[]> {
  const r = await pool.query(AGGREGATES_SQL, [W_CONTEST]);
  return r.rows.map((row: any) => ({
    userId: String(row.userId),
    problemId: String(row.problemId),
    solved: Boolean(row.solved),
    firstAcceptAt: row.firstAcceptAt ? new Date(row.firstAcceptAt) : null,
    wrongBeforeAccept: Number(row.wrongBeforeAccept),
  }));
}

describe('worker double integration (Agent B, real PostgreSQL)', () => {
  let ready = false;
  let skipWhy = '';
  const workers: WorkerHandle[] = [];

  beforeAll(async () => {
    if (!(await isRealDbReachable())) {
      skipWhy = skipReason('worker double integration (needs real PostgreSQL)');
      return;
    }
    await migrate();
    await seedWorkerFixtures();
    ready = true;
  });

  beforeEach(async () => {
    if (!ready) return;
    await pool.query(`TRUNCATE attempts, submissions CASCADE`);
    wSubSeq = 0;
  });

  afterEach(async () => {
    for (const w of workers.splice(0)) {
      await w.stop().catch(() => undefined);
    }
  });

  afterAll(async () => {
    if (ready) await pool.end().catch(() => undefined);
  });

  const needReady = () => {
    if (!ready) {
      // eslint-disable-next-line no-console
      console.log(`SKIP (not ready): ${skipWhy}`);
    }
    return ready;
  };

  function startWorker(runner: DoubleRunner, workerId: string, extra: Record<string, unknown> = {}): WorkerHandle {
    const w = createWorker(pool as any, {
      workerId,
      mode: 'double',
      runner,
      concurrency: 2,
      pollIntervalMs: 50,
      heartbeatIntervalMs: 60000, // no heartbeat refresh during short tests
      reaperIntervalMs: 200,
      staleAfterSeconds: 1,
      maxRequeues: 3,
      ...extra,
    });
    workers.push(w);
    w.start();
    return w;
  }

  it('(a) two workers race for one queued attempt -> exactly one judges it', async () => {
    if (!needReady()) return;
    const { submissionId } = await insertSubmission(W_U1, new Date(W_OPENS.getTime() + 60_000));
    const r1 = new DoubleRunner();
    const r2 = new DoubleRunner();
    const w1 = startWorker(r1, 'w-a');
    const w2 = startWorker(r2, 'w-b');
    let acks = 0;
    w1.events.on('ack', () => { acks += 1; });
    w2.events.on('ack', () => { acks += 1; });
    await Promise.race([
      onceEvent(w1.events, 'ack'),
      onceEvent(w2.events, 'ack'),
    ]);
    await waitForDb(async () => {
      const r = await pool.query<{ status: string }>(
        `SELECT status FROM attempts WHERE submission_id = $1`,
        [submissionId],
      );
      return r.rows[0]?.status === 'completed';
    });
    expect(acks).toBe(1);
    const att = await pool.query<{ status: string; verdict: string; score: number }>(
      `SELECT status, verdict, score FROM attempts WHERE submission_id = $1`,
      [submissionId],
    );
    expect(att.rows).toHaveLength(1);
    expect(att.rows[0]).toEqual({ status: 'completed', verdict: 'accepted', score: 100 });
    const sub = await pool.query<{ status: string }>(
      `SELECT status FROM submissions WHERE id = $1`,
      [submissionId],
    );
    expect(sub.rows[0].status).toBe('completed');
  }, 30000);

  it("(b) crash_before_verdict -> reaper recovers, judged exactly once, no duplicate score", async () => {
    if (!needReady()) return;
    const { submissionId } = await insertSubmission(W_U1, new Date(W_OPENS.getTime() + 60_000));
    const runner = new DoubleRunner();
    // First run crashes after judging (runner failpoint, NOT the worker
    // failpoint — the worker-level one calls process.exit(1)).
    runner.setBehavior(submissionId, { failpoint: 'crash_before_verdict' });
    const w = startWorker(runner, 'w-crash');
    let acks = 0;
    let requeues = 0;
    w.events.on('ack', () => { acks += 1; });
    w.events.on('requeue', () => { requeues += 1; });
    // The worker reports the infra failure; on it, switch the behaviour
    // to a clean accept so the requeued attempt can complete.
    const crashed = onceEvent(w.events, 'infraError', (p) => p.submissionId === submissionId);
    await crashed;
    runner.setBehavior(submissionId, {});
    await onceEvent(w.events, 'requeue', (p) => p.submissionId === submissionId);
    await onceEvent(w.events, 'ack', (p) => p.submissionId === submissionId);
    expect(acks).toBe(1);
    expect(requeues).toBe(1);
    const att = await pool.query<{ status: string; verdict: string; score: number; detail: any }>(
      `SELECT status, verdict, score, detail FROM attempts WHERE submission_id = $1`,
      [submissionId],
    );
    expect(att.rows).toHaveLength(1);
    expect(att.rows[0].status).toBe('completed');
    expect(att.rows[0].verdict).toBe('accepted');
    expect(att.rows[0].score).toBe(100);
    // NOTE (observed): applyVerdict overwrites attempt.detail wholesale
    // with the AttemptDetail, so the reaper's requeue_count (set on the
    // queued row) does NOT survive into the final detail — the requeue
    // itself is proven by the 'requeue' event count above, not by detail.
    expect(att.rows[0].detail.mode).toBe('double');
    expect(att.rows[0].detail.reason).toBe('all_passed');
    const standings = computeStandings(await aggregatesReal(), 20, W_OPENS);
    expect(standings).toEqual([{ userId: W_U1, totalScore: 100, totalPenaltyMinutes: 1 }]);
  }, 30000);

  it("(c) rejudge: late attempt-1 result after attempt 2 completed -> standings unchanged", async () => {
    if (!needReady()) return;
    const { submissionId, attemptId } = await insertSubmission(W_U1, new Date(W_OPENS.getTime() + 60_000));
    const runner = new DoubleRunner();
    // Attempt 1 runs slowly (4 s) so attempt 2 can overtake it.
    // Stale threshold must exceed the judge delay (production: heartbeat
    // 15 s, stale 120 s) — with staleAfterSeconds=1 the reaper would
    // rightly requeue the still-running attempt mid-judge.
    runner.setBehavior(attemptId, { delayMs: 4000 });
    const w = startWorker(runner, 'w-rejudge', { staleAfterSeconds: 30, reaperIntervalMs: 30000 });
    await onceEvent(w.events, 'judgeStart', (p) => p.attemptId === attemptId);
    // Rejudge, exactly as submissions.service.rejudge does: attempt 2
    // queued + submission.current_attempt_no bumped + live attempt 1
    // superseded, so its late verdict must affect 0 rows.
    const attempt2Id = 'bbbbbbbb-0001-4000-8000-00000000e999';
    await pool.query(
      `INSERT INTO attempts (id, submission_id, attempt_no, problem_version_id, test_suite_id, status)
       VALUES ($1, $2, 2, $3, $4, 'queued')`,
      [attempt2Id, submissionId, W_VERSION, W_SUITE],
    );
    await pool.query(
      `UPDATE attempts SET status = 'superseded'
       WHERE submission_id = $1 AND attempt_no < 2 AND status IN ('queued', 'running')`,
      [submissionId],
    );
    await pool.query(
      `UPDATE submissions SET current_attempt_no = 2, status = 'queued', updated_at = now() WHERE id = $1`,
      [submissionId],
    );
    await onceEvent(w.events, 'ack', (p) => p.attemptId === attempt2Id);
    // Now attempt 1 finishes late: its conditional verdict update must
    // affect 0 rows (status is 'superseded', not 'running').
    await onceEvent(w.events, 'superseded', (p) => p.attemptId === attemptId);
    const rows = await pool.query<{ attempt_no: number; status: string; verdict: string | null }>(
      `SELECT attempt_no, status, verdict FROM attempts WHERE submission_id = $1 ORDER BY attempt_no`,
      [submissionId],
    );
    // Attempt 1's verdict is NOT written; standings use attempt 2 only.
    expect(rows.rows).toEqual([
      { attempt_no: 1, status: 'superseded', verdict: null },
      { attempt_no: 2, status: 'completed', verdict: 'accepted' },
    ]);
    const sub = await pool.query<{ status: string; current_attempt_no: number }>(
      `SELECT status, current_attempt_no FROM submissions WHERE id = $1`,
      [submissionId],
    );
    expect(sub.rows[0]).toEqual({ status: 'completed', current_attempt_no: 2 });
    const standings = computeStandings(await aggregatesReal(), 20, W_OPENS);
    expect(standings).toEqual([{ userId: W_U1, totalScore: 100, totalPenaltyMinutes: 1 }]);
  }, 30000);

  it('(d) out-of-order completion -> SQL leaderboard equals computeStandings', async () => {
    if (!needReady()) return;
    // u1: wrong at +10min, accept at +30min (80 pts, 50 min)
    // u2: accept at +20min (100 pts, 20 min)
    // Completion order is inverted with delays: u1-wrong first, then
    // u2-accept, then u1-accept last.
    const s1w = await insertSubmission(W_U1, new Date(W_OPENS.getTime() + 10 * 60_000));
    const s1a = await insertSubmission(W_U1, new Date(W_OPENS.getTime() + 30 * 60_000));
    const s2a = await insertSubmission(W_U2, new Date(W_OPENS.getTime() + 20 * 60_000));
    const s2e = await insertSubmission(W_U2, new Date(W_OPENS.getTime() + 25 * 60_000));
    const runner = new DoubleRunner();
    runner.setBehavior(s1w.submissionId, { verdict: 'wrong_answer', delayMs: 0 });
    runner.setBehavior(s2a.submissionId, { delayMs: 500 });
    runner.setBehavior(s1a.submissionId, { delayMs: 1500 });
    runner.setBehavior(s2e.submissionId, { verdict: 'judge_error' });
    // Stale threshold must exceed the longest judge delay (1.5 s); see (c).
    const w = startWorker(runner, 'w-order', { staleAfterSeconds: 30, reaperIntervalMs: 30000 });
    const done = new Promise<void>((resolve, reject) => {
      let n = 0;
      const timer = setTimeout(() => reject(new Error('timeout waiting for 4 acks')), 20000);
      w.events.on('ack', () => {
        n += 1;
        if (n === 4) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    await done;
    const aggs = await aggregatesReal();
    const standings = computeStandings(aggs, 20, W_OPENS);
    expect(standings).toEqual([
      { userId: W_U2, totalScore: 100, totalPenaltyMinutes: 20 },
      { userId: W_U1, totalScore: 80, totalPenaltyMinutes: 50 },
    ]);
    // Full SQL leaderboard (real PostgreSQL) must match computeStandings.
    const lbRes = await pool.query(LEADERBOARD_SQL, [W_CONTEST, 20, W_OPENS.toISOString()]);
    const sqlRows = lbRes.rows.map((r: any) => ({
      userId: String(r.userId),
      totalScore: Number(r.totalScore),
      totalPenaltyMinutes: Number(r.totalPenaltyMinutes),
    }));
    expect(sqlRows).toEqual(standings);
  }, 30000);
});
