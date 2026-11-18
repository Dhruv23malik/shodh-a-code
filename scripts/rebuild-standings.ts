/**
 * rebuild-standings.ts — standalone leaderboard verification.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx ts-node -T scripts/rebuild-standings.ts --contest <contest-id>
 *   [--api-base-url http://localhost:3000]
 *
 * 1. Reads submissions + attempts for the contest from DATABASE_URL.
 * 2. Derives per-(user, problem) aggregates with the SQL in
 *    scripts/leaderboard-sql.ts (which implements src/core/scoring.ts
 *    exactly) and computes standings with the CANONICAL computeStandings.
 * 3. Fetches the serving leaderboard: via the API HTTP endpoint if it
 *    answers (GET {api-base-url}/contests/:id/leaderboard), otherwise via
 *    the same SQL the API uses (LEADERBOARD_SQL in leaderboard-sql.ts).
 *    NOTE (18 Nov 2026): the API leaderboard query was read in
 *    src/api/leaderboard.service.ts (DISTINCT ON authoritative attempt,
 *    same points/penalty math). The SQL fallback here is the Stage 4
 *    rendering of scoring.ts, equivalent by construction and pinned by
 *    the pg-mem equality test; the HTTP path is the authoritative
 *    comparison when the API is up.
 * 4. Prints both standings, exits 0 if identical, 1 with a diff otherwise,
 *    2 if the database is unreachable.
 */
import { Client } from 'pg';
import { computeStandings, ProblemAggregate, StandingRow } from '../src/core/scoring';
import { AGGREGATES_SQL, LEADERBOARD_SQL } from './leaderboard-sql';

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function same(a: StandingRow[], b: StandingRow[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (row, i) =>
      row.userId === b[i].userId &&
      row.totalScore === b[i].totalScore &&
      row.totalPenaltyMinutes === b[i].totalPenaltyMinutes,
  );
}

function printStandings(title: string, rows: StandingRow[]): void {
  // eslint-disable-next-line no-console
  console.log(`\n== ${title} (${rows.length} rows) ==`);
  for (const r of rows) {
    // eslint-disable-next-line no-console
    console.log(`  ${r.userId}  score=${r.totalScore}  penalty=${r.totalPenaltyMinutes}`);
  }
}

async function fetchHttpLeaderboard(baseUrl: string, contestId: string): Promise<StandingRow[] | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/contests/${contestId}/leaderboard`);
    if (!res.ok) return null;
    const body: any = await res.json();
    const rows = Array.isArray(body) ? body : body.data ?? body.leaderboard ?? null;
    if (!Array.isArray(rows)) return null;
    return rows.map((r: any) => ({
      userId: String(r.userId ?? r.user_id),
      totalScore: Number(r.totalScore ?? r.total_score ?? r.score),
      totalPenaltyMinutes: Number(r.totalPenaltyMinutes ?? r.total_penalty_minutes ?? r.penalty),
    }));
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const contestId = arg('--contest');
  if (!contestId) {
    // eslint-disable-next-line no-console
    console.error('usage: rebuild-standings.ts --contest <contest-id> [--api-base-url <url>]');
    return 2;
  }
  const apiBaseUrl = arg('--api-base-url', process.env.API_BASE_URL ?? 'http://localhost:3000');
  const databaseUrl = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/shodh';

  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`cannot reach PostgreSQL at DATABASE_URL=${databaseUrl}: ${(err as Error).message}`);
    return 2;
  }
  try {
    const contest = await client.query<{ opens_at: Date; penalty_per_wrong: number }>(
      'SELECT opens_at, penalty_per_wrong FROM contests WHERE id = $1',
      [contestId],
    );
    if (contest.rows.length === 0) {
      // eslint-disable-next-line no-console
      console.error(`contest not found: ${contestId}`);
      return 2;
    }
    const { opens_at, penalty_per_wrong } = contest.rows[0];

    const aggRes = await client.query(AGGREGATES_SQL, [contestId]);
    const aggregates: ProblemAggregate[] = aggRes.rows.map((r: any) => ({
      userId: String(r.userId),
      problemId: String(r.problemId),
      solved: Boolean(r.solved),
      firstAcceptAt: r.firstAcceptAt ? new Date(r.firstAcceptAt) : null,
      wrongBeforeAccept: Number(r.wrongBeforeAccept),
    }));
    const rebuilt = computeStandings(aggregates, penalty_per_wrong, new Date(opens_at));

    let serving: StandingRow[] | null = await fetchHttpLeaderboard(apiBaseUrl, contestId);
    let servingSource = `HTTP ${apiBaseUrl}/contests/${contestId}/leaderboard`;
    if (!serving) {
      const lbRes = await client.query(LEADERBOARD_SQL, [
        contestId,
        penalty_per_wrong,
        new Date(opens_at).toISOString(),
      ]);
      serving = lbRes.rows.map((r: any) => ({
        userId: String(r.userId),
        totalScore: Number(r.totalScore),
        totalPenaltyMinutes: Number(r.totalPenaltyMinutes),
      }));
      servingSource = 'SQL fallback (LEADERBOARD_SQL — API endpoint unreachable)';
    }

    printStandings(`rebuilt (computeStandings, ${aggregates.length} aggregates)`, rebuilt);
    printStandings(`serving (${servingSource})`, serving);

    if (same(rebuilt, serving)) {
      // eslint-disable-next-line no-console
      console.log('\nOK: rebuilt standings identical to serving leaderboard.');
      return 0;
    }
    // eslint-disable-next-line no-console
    console.log('\nMISMATCH: rebuilt != serving');
    const max = Math.max(rebuilt.length, serving.length);
    for (let i = 0; i < max; i++) {
      const a = rebuilt[i];
      const b = serving[i];
      if (!a || !b || a.userId !== b.userId || a.totalScore !== b.totalScore || a.totalPenaltyMinutes !== b.totalPenaltyMinutes) {
        // eslint-disable-next-line no-console
        console.log(`  rank ${i + 1}: rebuilt=${a ? `${a.userId} ${a.totalScore}/${a.totalPenaltyMinutes}` : '-'}  serving=${b ? `${b.userId} ${b.totalScore}/${b.totalPenaltyMinutes}` : '-'}`);
      }
    }
    return 1;
  } finally {
    await client.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(2);
  });
