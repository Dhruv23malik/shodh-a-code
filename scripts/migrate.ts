import { migrate } from '../src/db/migrate';
import { pool } from '../src/db/pool';
import { log } from '../src/core/logger';

async function main(): Promise<void> {
  try {
    const applied = await migrate();
    log.info('migrations applied', { applied });
    await pool.end();
    process.exit(0);
  } catch (err) {
    log.error('migrate failed', { error: String(err) });
    await pool.end().catch(() => undefined);
    process.exit(1);
  }
}

void main();
