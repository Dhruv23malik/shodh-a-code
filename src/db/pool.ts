/**
 * PostgreSQL access. One shared Pool for the API and the worker processes.
 * All SQL goes through `query` / `withTx` here so timeouts and error
 * mapping stay in one place. No SQL string is ever built from untrusted
 * input without parameters.
 */
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { infraError } from '../core/errors';

export const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/shodh';

export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  statement_timeout: 10_000,
});

pool.on('error', (err) => {
  // Never crash the process on an idle-client error; log it.
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'pg pool error', error: String(err) }));
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  try {
    return await pool.query<T>(text, params as never[]);
  } catch (err) {
    throw infraError(`database query failed: ${(err as Error).message}`);
  }
}

export async function withTx<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof Error && (err as { code?: string }).code === '23505') {
      throw err; // unique-violation: caller decides (idempotency paths)
    }
    throw err;
  } finally {
    client.release();
  }
}
