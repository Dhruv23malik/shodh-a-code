/**
 * Test helpers.
 *
 * - pg-mem in-memory Postgres for contract-level tests. The real
 *   src/db/pool.ts always points at DATABASE_URL, so tests that need a
 *   database but must run without a server use pg-mem here instead.
 * - `isRealDbReachable()` for the suites that genuinely need the real
 *   server (API supertest suite, rebuild script): they SKIP with a printed
 *   reason when it is unreachable instead of failing.
 */
import { newDb } from 'pg-mem';

/** Minimal subset of migrations/001_init.sql, pg-mem compatible.
 *  No pgcrypto (gen_random_uuid) — tests pass explicit ids. */
export const MINIMAL_SCHEMA = `
CREATE TABLE contests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  opens_at TIMESTAMPTZ NOT NULL,
  closes_at TIMESTAMPTZ NOT NULL,
  penalty_per_wrong INT NOT NULL DEFAULT 20
);
CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  contest_id TEXT NOT NULL,
  problem_id TEXT NOT NULL,
  problem_version_id TEXT NOT NULL,
  test_suite_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  code TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'python',
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  current_attempt_no INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (contest_id, author_id, idempotency_key)
);
CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  attempt_no INT NOT NULL CHECK (attempt_no >= 1),
  problem_version_id TEXT NOT NULL,
  test_suite_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  verdict TEXT,
  score INT NOT NULL DEFAULT 0,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  worker_id TEXT,
  heartbeat_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (submission_id, attempt_no)
);
`;

export interface PgMemHandle {
  /** pg-compatible Pool (from pg-mem adapters). query(text, params) works. */
  pool: {
    query: <T = any>(text: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount: number }>;
    end: () => Promise<void>;
  };
  db: ReturnType<typeof newDb>;
}

export function createPgMem(): PgMemHandle {
  const db = newDb();
  const pg = db.adapters.createPg();
  const pool = new pg.Pool();
  return { pool: pool as unknown as PgMemHandle['pool'], db };
}

export async function applyMinimalSchema(pool: PgMemHandle['pool']): Promise<void> {
  await pool.query(MINIMAL_SCHEMA);
}

/** True when a real PostgreSQL answers at DATABASE_URL within the timeout. */
export async function isRealDbReachable(timeoutMs = 2000): Promise<boolean> {
  const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/shodh';
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Client } = require('pg') as typeof import('pg');
    const client = new Client({ connectionString: url, connectionTimeoutMillis: timeoutMs });
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
    return true;
  } catch {
    return false;
  }
}

/** Call at the top of a test that needs the real DB; logs + returns false to skip. */
export function skipReason(what: string): string {
  const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/shodh';
  const msg = `SKIP ${what}: no reachable PostgreSQL at DATABASE_URL=${url} (set DATABASE_URL or start Postgres; see README "Verified here vs requires reviewer Docker").`;
  // eslint-disable-next-line no-console
  console.log(msg);
  return msg;
}
