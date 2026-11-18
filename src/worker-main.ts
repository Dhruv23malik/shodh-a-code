/**
 * Worker entry point: `node dist/worker-main.js` (npm run start:worker).
 *
 * Runs migrations, then starts the judge worker (claim loop + reaper).
 * Mode and limits come from the environment (see .env.example).
 *
 * Graceful shutdown (SIGTERM / SIGINT): stop claiming and abort
 * in-flight runs; in-flight attempts are NOT marked failed — they stay
 * 'running' in the database with a stale heartbeat, and the reaper
 * (this process on restart, or any other worker) requeues them. A
 * shutdown therefore never loses or corrupts a verdict.
 */
import { migrate } from './db/migrate';
import { pool } from './db/pool';
import { log } from './core/logger';
import { createWorker } from './worker/worker';

async function main(): Promise<void> {
  const applied = await migrate();
  log.info('worker migrations applied', { count: applied.length });

  const worker = createWorker(pool);
  worker.start();
  log.info('worker started', {
    workerId: worker.workerId,
    mode: process.env.JUDGE_MODE ?? 'real',
    image: process.env.JUDGE_IMAGE ?? 'shodh-runner:latest',
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('worker shutting down', { signal, workerId: worker.workerId });
    try {
      await worker.stop();
    } finally {
      await pool.end();
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  log.error('worker fatal', { error: String(err) });
  process.exit(1);
});
