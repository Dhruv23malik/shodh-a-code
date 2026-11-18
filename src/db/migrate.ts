/**
 * Migration runner. Applies migrations/*.sql in filename order, one
 * transaction per file, recording each in schema_migrations. Safe to run
 * concurrently: a transaction-scoped advisory lock serializes runners, and
 * re-running is a no-op for already-applied files.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { pool } from './pool';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

export async function migrate(): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize concurrent migrators (api + worker both run this on boot).
    await client.query('SELECT pg_advisory_xact_lock(727271)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const applied = new Set(
      (await client.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map(
        (r) => r.filename,
      ),
    );
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const newlyApplied: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      newlyApplied.push(file);
    }
    await client.query('COMMIT');
    return newlyApplied;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
