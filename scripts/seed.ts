/**
 * Seed script — idempotent (safe to re-run). Uses fixed UUIDs so dev bearer
 * tokens are stable; see seed/IDENTITIES.md.
 *
 * Run: npm run seed   (requires a reachable Postgres + applied migrations)
 */
import { pool } from '../src/db/pool';
import { log } from '../src/core/logger';

const ACME_ORG = '11111111-1111-4111-8111-111111111111';
const VERTEX_ORG = '22222222-2222-4222-8222-222222222222';

const USERS = [
  { id: 'aaaaaaaa-0001-4000-8000-000000000001', email: 'ana@acme.example', name: 'Ana Sharma' },
  { id: 'aaaaaaaa-0002-4000-8000-000000000002', email: 'vikram@vertex.example', name: 'Vikram Rao' },
  { id: 'aaaaaaaa-0003-4000-8000-000000000003', email: 'priya@example.com', name: 'Priya Nair' },
  { id: 'aaaaaaaa-0004-4000-8000-000000000004', email: 'arjun@example.com', name: 'Arjun Mehta' },
  { id: 'aaaaaaaa-0005-4000-8000-000000000005', email: 'meera@example.com', name: 'Meera Iyer' },
  { id: 'aaaaaaaa-0006-4000-8000-000000000006', email: 'kabir@example.com', name: 'Kabir Singh' },
] as const;

const ACME_CONTEST = 'c0000000-0001-4000-8000-000000000001';
const VERTEX_CONTEST = 'c0000000-0002-4000-8000-000000000002';

interface SeedCase {
  id: string;
  position: number;
  name: string;
  input: string;
  expectedOutput: string;
  isHidden: boolean;
}

interface SeedProblem {
  id: string;
  versionId: string;
  suiteId: string;
  slug: string;
  title: string;
  statement: string;
  cases: SeedCase[];
}

const PROBLEMS: SeedProblem[] = [
  {
    id: '10000000-0001-4000-8000-000000000001',
    versionId: '20000000-0001-4000-8000-000000000001',
    suiteId: '30000000-0001-4000-8000-000000000001',
    slug: 'add-two-numbers',
    title: 'Add Two Numbers',
    statement:
      'Read two integers from standard input (space-separated) and print their sum.',
    cases: [
      { id: '40000000-0001-4000-8000-000000000001', position: 0, name: 'sample', input: '2 3\n', expectedOutput: '5\n', isHidden: false },
      { id: '40000000-0002-4000-8000-000000000002', position: 1, name: 'bigger', input: '10 20\n', expectedOutput: '30\n', isHidden: true },
      { id: '40000000-0003-4000-8000-000000000003', position: 2, name: 'negative', input: '-5 7\n', expectedOutput: '2\n', isHidden: true },
    ],
  },
  {
    id: '10000000-0002-4000-8000-000000000002',
    versionId: '20000000-0002-4000-8000-000000000002',
    suiteId: '30000000-0002-4000-8000-000000000002',
    slug: 'fizzbuzz-lite',
    title: 'FizzBuzz Lite',
    statement:
      'Read an integer n. For each i from 1 to n, print "FizzBuzz" if i is divisible by 15, "Fizz" if divisible by 3, "Buzz" if divisible by 5, otherwise print i. One value per line.',
    cases: [
      { id: '40000000-0004-4000-8000-000000000004', position: 0, name: 'sample', input: '3\n', expectedOutput: '1\n2\nFizz\n', isHidden: false },
      { id: '40000000-0005-4000-8000-000000000005', position: 1, name: 'five', input: '5\n', expectedOutput: '1\n2\nFizz\n4\nBuzz\n', isHidden: true },
      { id: '40000000-0006-4000-8000-000000000006', position: 2, name: 'fifteen', input: '15\n', expectedOutput: '1\n2\nFizz\n4\nBuzz\nFizz\n7\n8\nFizz\nBuzz\n11\nFizz\n13\n14\nFizzBuzz\n', isHidden: true },
    ],
  },
  {
    id: '10000000-0003-4000-8000-000000000003',
    versionId: '20000000-0003-4000-8000-000000000003',
    suiteId: '30000000-0003-4000-8000-000000000003',
    slug: 'sort-numbers',
    title: 'Sort Numbers',
    statement:
      'Read space-separated integers from standard input and print them sorted in ascending order, space-separated, on one line.',
    cases: [
      { id: '40000000-0007-4000-8000-000000000007', position: 0, name: 'sample', input: '3 1 2\n', expectedOutput: '1 2 3\n', isHidden: false },
      { id: '40000000-0008-4000-8000-000000000008', position: 1, name: 'reverse', input: '5 4 3 2 1\n', expectedOutput: '1 2 3 4 5\n', isHidden: true },
      { id: '40000000-0009-4000-8000-000000000009', position: 2, name: 'single', input: '42\n', expectedOutput: '42\n', isHidden: true },
    ],
  },
];

async function main(): Promise<void> {
  // Orgs
  await pool.query(
    `INSERT INTO organizations (id, name, slug) VALUES
       ($1, 'Acme University', 'acme'),
       ($2, 'Vertex College', 'vertex')
     ON CONFLICT (id) DO NOTHING`,
    [ACME_ORG, VERTEX_ORG],
  );

  // Users
  for (const u of USERS) {
    await pool.query(
      'INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [u.id, u.email, u.name],
    );
  }

  // Memberships: organizers + participants (all 4 participants in acme;
  // meera + kabir also in vertex).
  const memberships: Array<[string, string, string]> = [
    [ACME_ORG, USERS[0].id, 'organizer'],
    [VERTEX_ORG, USERS[1].id, 'organizer'],
    [ACME_ORG, USERS[2].id, 'participant'],
    [ACME_ORG, USERS[3].id, 'participant'],
    [ACME_ORG, USERS[4].id, 'participant'],
    [ACME_ORG, USERS[5].id, 'participant'],
    [VERTEX_ORG, USERS[4].id, 'participant'],
    [VERTEX_ORG, USERS[5].id, 'participant'],
  ];
  for (const [orgId, userId, role] of memberships) {
    await pool.query(
      'INSERT INTO org_memberships (org_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (org_id, user_id) DO NOTHING',
      [orgId, userId, role],
    );
  }

  // Contests (open, 2026-11-01 .. 2026-12-31, penalty 20)
  await pool.query(
    `INSERT INTO contests (id, org_id, title, slug, status, opens_at, closes_at, penalty_per_wrong) VALUES
       ($1, $3, 'Acme Weekly #1', 'acme-weekly-1', 'open', '2026-11-01T00:00:00Z', '2026-12-31T23:59:59Z', 20),
       ($2, $4, 'Vertex Sprint', 'vertex-sprint', 'open', '2026-11-01T00:00:00Z', '2026-12-31T23:59:59Z', 20)
     ON CONFLICT (id) DO NOTHING`,
    [ACME_CONTEST, VERTEX_CONTEST, ACME_ORG, VERTEX_ORG],
  );

  // Contest participants
  const joins: Array<[string, string]> = [
    [ACME_CONTEST, USERS[2].id],
    [ACME_CONTEST, USERS[3].id],
    [VERTEX_CONTEST, USERS[4].id],
    [VERTEX_CONTEST, USERS[5].id],
  ];
  for (const [contestId, userId] of joins) {
    await pool.query(
      'INSERT INTO contest_participants (contest_id, user_id) VALUES ($1, $2) ON CONFLICT (contest_id, user_id) DO NOTHING',
      [contestId, userId],
    );
  }

  // Problems (org acme): problem + version 1 + suite v1 + 3 cases each.
  for (const p of PROBLEMS) {
    await pool.query(
      `INSERT INTO problems (id, org_id, slug, title, statement, time_limit_ms, memory_mb)
       VALUES ($1, $2, $3, $4, $5, 2000, 256) ON CONFLICT (id) DO NOTHING`,
      [p.id, ACME_ORG, p.slug, p.title, p.statement],
    );
    await pool.query(
      'INSERT INTO problem_versions (id, problem_id, version, description) VALUES ($1, $2, 1, $3) ON CONFLICT (id) DO NOTHING',
      [p.versionId, p.id, 'v1'],
    );
    await pool.query(
      'INSERT INTO test_suites (id, problem_version_id, version) VALUES ($1, $2, 1) ON CONFLICT (id) DO NOTHING',
      [p.suiteId, p.versionId],
    );
    for (const c of p.cases) {
      await pool.query(
        `INSERT INTO test_cases (id, test_suite_id, position, name, input, expected_output, is_hidden)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
        [c.id, p.suiteId, c.position, c.name, c.input, c.expectedOutput, c.isHidden],
      );
    }
    await pool.query('UPDATE problems SET current_version_id = $1 WHERE id = $2', [
      p.versionId,
      p.id,
    ]);
  }

  log.info('seed complete', {});
  await pool.end();
}

main().catch(async (err) => {
  log.error('seed failed', { error: String(err) });
  await pool.end().catch(() => undefined);
  process.exit(1);
});
