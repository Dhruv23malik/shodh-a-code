/**
 * workload.ts — repeatable concurrent workload + latency measurement.
 *
 * Usage (double mode, no Docker):
 *   # terminal 1: JUDGE_MODE=double npm run dev:api        (Agent A)
 *   # terminal 2: JUDGE_MODE=double npm run start:worker   (Agent B)
 *   npx ts-node -T scripts/workload.ts --mode double --users 10 --subs 30 --concurrency 5
 *
 * Usage (real mode, Docker):
 *   docker compose up --build -d
 *   npx ts-node -T scripts/workload.ts --mode real --users 20 --subs 60 --concurrency 10
 *
 * Mix (defaults): for a seeded open contest (SEED_CONTEST_ID /
 * SEED_PROBLEM_ID, or --contest/--problem — defaults are the seed data in
 * seed/IDENTITIES.md: Acme Weekly #1 / Add Two Numbers, participants Priya
 * + Arjun), N participants each submit the sample programs (correct /
 * wrong / runtime-error, cycled) overlapping with M leaderboard reads, at
 * concurrency C. Measures, separately:
 *   - API latency percentiles (p50/p95/p99) for submit / status / leaderboard
 *   - throughput (req/s), error count by code
 *   - queue delay: submit accepted -> attempt completed (from timestamps)
 *   - program execution time separately: attempt detail runtimeMs
 *     (API overhead vs judge execution are reported in different columns)
 * Writes results/results-<mode>-<ISO timestamp>.json with commit hash,
 * config, data version, execution mode and all measured numbers, and prints
 * a human summary. Exits 1 if the API base URL is unreachable (no fake
 * numbers are ever written).
 */
import { execSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

interface Args {
  baseUrl: string;
  mode: 'real' | 'double';
  users: number;
  subs: number;
  concurrency: number;
  contestId: string;
  problemId: string;
  dataset: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string, fallback: string): string => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const mode = get('--mode', 'double');
  if (mode !== 'real' && mode !== 'double') throw new Error('--mode must be real|double');
  return {
    baseUrl: get('--base-url', process.env.API_BASE_URL ?? 'http://localhost:3000'),
    mode,
    users: Number(get('--users', '10')),
    subs: Number(get('--subs', '30')),
    concurrency: Number(get('--concurrency', '5')),
    contestId: get('--contest', process.env.SEED_CONTEST_ID ?? 'c0000000-0001-4000-8000-000000000001'),
    problemId: get('--problem', process.env.SEED_PROBLEM_ID ?? '10000000-0001-4000-8000-000000000001'),
    dataset: get('--dataset', 'seed default: Acme Weekly #1 / Add Two Numbers (seed/IDENTITIES.md)'),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

interface OpStats {
  count: number;
  errors: number;
  latenciesMs: number[];
}

function summarize(op: OpStats) {
  const s = [...op.latenciesMs].sort((a, b) => a - b);
  return {
    count: op.count,
    errors: op.errors,
    p50Ms: percentile(s, 50),
    p95Ms: percentile(s, 95),
    p99Ms: percentile(s, 99),
    meanMs: s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0,
    maxMs: s.length ? s[s.length - 1] : 0,
  };
}

const SAMPLES: { name: string; file: string }[] = [
  { name: 'correct', file: 'correct.py' },
  { name: 'wrong', file: 'wrong.py' },
  { name: 'runtime_error', file: 'runtime_error.py' },
];

function loadSamples(): { name: string; code: string }[] {
  return SAMPLES.map((s) => ({
    name: s.name,
    code: readFileSync(join(__dirname, '..', 'sample-programs', s.file), 'utf8'),
  }));
}

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = process.hrtime.bigint();
  const result = await fn();
  return { result, ms: Number(process.hrtime.bigint() - start) / 1e6 };
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.contestId || !args.problemId) {
    throw new Error(
      'missing contest/problem: pass --contest <id> --problem <id> or set SEED_CONTEST_ID / SEED_PROBLEM_ID (see seed/IDENTITIES.md once Agent A writes it)',
    );
  }
  const base = args.baseUrl.replace(/\/$/, '');
  const startedAt = new Date();

  // Liveness probe — fail loudly instead of recording zeros.
  // /health is the only public endpoint (auth.guard: everything else needs
  // Bearer dev:<uuid>).
  let probe: Response;
  try {
    probe = await fetch(`${base}/health`);
  } catch (err) {
    throw new Error(`API unreachable at ${base}: ${(err as Error).message}. Start the API first (see README). No results file written.`);
  }
  if (!probe.ok) {
    throw new Error(`API probe failed at ${base}: HTTP ${probe.status}. No results file written.`);
  }

  const samples = loadSamples();
  // Seeded acme participants (seed/IDENTITIES.md). Override with
  // SEED_USER_<n>_ID env vars for other contests.
  const defaultUsers = [
    'aaaaaaaa-0003-4000-8000-000000000003', // Priya Nair
    'aaaaaaaa-0004-4000-8000-000000000004', // Arjun Mehta
  ];
  const userIds = Array.from({ length: args.users }, (_, i) =>
    process.env[`SEED_USER_${i + 1}_ID`] ?? defaultUsers[i % defaultUsers.length],
  );
  const submitStats: OpStats = { count: 0, errors: 0, latenciesMs: [] };
  const statusStats: OpStats = { count: 0, errors: 0, latenciesMs: [] };
  const lbStats: OpStats = { count: 0, errors: 0, latenciesMs: [] };
  const errorsByCode: Record<string, number> = {};
  const queueDelaysMs: number[] = [];
  const judgeRuntimeMs: number[] = [];
  const submissionIds: string[] = [];

  const recordError = (stats: OpStats, code: string) => {
    stats.errors += 1;
    errorsByCode[code] = (errorsByCode[code] ?? 0) + 1;
  };

  const t0 = Date.now();
  let nextSub = 0;
  const totalOps = args.subs + args.subs; // submits + leaderboard reads

  async function workerTask(): Promise<void> {
    for (;;) {
      const n = nextSub;
      nextSub += 1;
      if (n >= args.subs) return;
      const user = userIds[n % userIds.length];
      const sample = samples[n % samples.length];
      const acceptedAt = Date.now();
      const { result: subRes, ms } = await timed(() =>
        fetch(`${base}/contests/${args.contestId}/submissions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer dev:${user}` },
          body: JSON.stringify({ problemId: args.problemId, code: sample.code, language: 'python', idempotencyKey: `wl-${startedAt.getTime()}-${n}` }),
        }),
      );
      submitStats.count += 1;
      submitStats.latenciesMs.push(ms);
      if (!subRes.ok) {
        recordError(submitStats, `submit:${subRes.status}`);
        continue;
      }
      const subBody: any = await subRes.json();
      const submissionId = subBody.id ?? subBody.submission?.id;
      if (!submissionId) {
        recordError(submitStats, 'submit:no-id');
        continue;
      }
      submissionIds.push(submissionId);
      // Poll status until terminal (bounded), measuring status latency.
      let status = subBody.status;
      let completedAt: number | null = null;
      let detail: any = null;
      for (let i = 0; i < 60 && status !== 'completed' && status !== 'failed'; i++) {
        const { result: stRes, ms: stMs } = await timed(() =>
          fetch(`${base}/submissions/${submissionId}`, { headers: { Authorization: `Bearer dev:${user}` } }),
        );
        statusStats.count += 1;
        statusStats.latenciesMs.push(stMs);
        if (!stRes.ok) {
          recordError(statusStats, `status:${stRes.status}`);
          break;
        }
        const stBody: any = await stRes.json();
        status = stBody.status;
        // submissionOut: cases come from the current attempt's detail.
        detail = { cases: stBody.cases ?? [] };
        if (status === 'completed' || status === 'failed') {
          completedAt = Date.now();
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (completedAt !== null) queueDelaysMs.push(completedAt - acceptedAt);
      if (detail?.cases) {
        for (const c of detail.cases) if (typeof c.runtimeMs === 'number') judgeRuntimeMs.push(c.runtimeMs);
      }
      // Interleaved leaderboard read.
      const { result: lbRes, ms: lbMs } = await timed(() =>
        fetch(`${base}/contests/${args.contestId}/leaderboard`, { headers: { Authorization: `Bearer dev:${user}` } }),
      );
      lbStats.count += 1;
      lbStats.latenciesMs.push(lbMs);
      if (!lbRes.ok) recordError(lbStats, `leaderboard:${lbRes.status}`);
    }
  }

  const workers = Array.from({ length: Math.max(1, args.concurrency) }, () => workerTask());
  await Promise.all(workers);
  const elapsedSec = (Date.now() - t0) / 1000;
  const totalReqs = submitStats.count + statusStats.count + lbStats.count;

  let commit = 'unknown (not a git repository)';
  try {
    commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    /* keep placeholder */
  }
  let migrationVersion = 'unknown';
  try {
    migrationVersion = execSync('ls migrations/*.sql | sort | tail -1', { encoding: 'utf8' }).trim();
  } catch {
    /* keep placeholder */
  }

  const result = {
    generatedAt: new Date().toISOString(),
    commit,
    config: {
      baseUrl: args.baseUrl,
      mode: args.mode,
      users: args.users,
      submissions: args.subs,
      concurrency: args.concurrency,
      dataset: args.dataset,
      contestId: args.contestId,
      problemId: args.problemId,
      mix: 'sample programs cycled correct/wrong/runtime_error + 1 leaderboard read per submission + status polling to terminal',
    },
    dataVersion: { seed: args.dataset, migration: migrationVersion },
    executionMode: args.mode,
    durationSec: Number(elapsedSec.toFixed(2)),
    throughputReqPerSec: Number((totalReqs / elapsedSec).toFixed(2)),
    totalRequests: totalReqs,
    errorsByCode,
    totalErrors: Object.values(errorsByCode).reduce((a, b) => a + b, 0),
    submit: summarize(submitStats),
    status: summarize(statusStats),
    leaderboard: summarize(lbStats),
    queueDelayMs: {
      count: queueDelaysMs.length,
      p50Ms: percentile([...queueDelaysMs].sort((a, b) => a - b), 50),
      p95Ms: percentile([...queueDelaysMs].sort((a, b) => a - b), 95),
      maxMs: queueDelaysMs.length ? Math.max(...queueDelaysMs) : 0,
    },
    judgeRuntimeMs: {
      // Program execution time, reported separately from API latency.
      count: judgeRuntimeMs.length,
      p50Ms: percentile([...judgeRuntimeMs].sort((a, b) => a - b), 50),
      p95Ms: percentile([...judgeRuntimeMs].sort((a, b) => a - b), 95),
      maxMs: judgeRuntimeMs.length ? Math.max(...judgeRuntimeMs) : 0,
    },
  };

  const dir = join(__dirname, '..', 'results');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = join(dir, `results-${args.mode}-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2));

  // eslint-disable-next-line no-console
  console.log(`\nWorkload complete (${args.mode} mode) — ${outPath}`);
  // eslint-disable-next-line no-console
  console.log(`  duration ${result.durationSec}s, ${totalReqs} requests, ${result.throughputReqPerSec} req/s, ${result.totalErrors} errors`);
  // eslint-disable-next-line no-console
  console.log(`  submit      p50=${result.submit.p50Ms.toFixed(1)}ms p95=${result.submit.p95Ms.toFixed(1)}ms p99=${result.submit.p99Ms.toFixed(1)}ms errors=${result.submit.errors}`);
  // eslint-disable-next-line no-console
  console.log(`  status      p50=${result.status.p50Ms.toFixed(1)}ms p95=${result.status.p95Ms.toFixed(1)}ms p99=${result.status.p99Ms.toFixed(1)}ms errors=${result.status.errors}`);
  // eslint-disable-next-line no-console
  console.log(`  leaderboard p50=${result.leaderboard.p50Ms.toFixed(1)}ms p95=${result.leaderboard.p95Ms.toFixed(1)}ms p99=${result.leaderboard.p99Ms.toFixed(1)}ms errors=${result.leaderboard.errors}`);
  // eslint-disable-next-line no-console
  console.log(`  queue delay (submit->completed) p50=${result.queueDelayMs.p50Ms}ms p95=${result.queueDelayMs.p95Ms}ms max=${result.queueDelayMs.maxMs}ms (n=${result.queueDelayMs.count})`);
  // eslint-disable-next-line no-console
  console.log(`  judge runtime (program execution, excl. API) p50=${result.judgeRuntimeMs.p50Ms}ms p95=${result.judgeRuntimeMs.p95Ms}ms (n=${result.judgeRuntimeMs.count})`);
  if (result.totalErrors > 0) {
    // eslint-disable-next-line no-console
    console.log(`  errors by code: ${JSON.stringify(errorsByCode)}`);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`workload failed: ${(err as Error).message}`);
  process.exit(1);
});
