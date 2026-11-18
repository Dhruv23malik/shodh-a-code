-- 002_leaderboard_auth_attempts_idx.sql — partial index for the leaderboard's
-- authoritative-attempt lookup.
--
-- WHY (hypothesis, NOT yet measured on real PostgreSQL — see REPORT.md):
-- src/api/leaderboard.service.ts resolves the authoritative attempt per
-- submission with DISTINCT ON (submission_id) ... WHERE status='completed'
-- AND verdict IS NOT NULL AND verdict <> 'judge_error' ORDER BY
-- submission_id, attempt_no DESC. The existing indexes do not match that
-- predicate: idx_attempts_submission (submission_id, attempt_no) covers the
-- ordering but not the filter, idx_attempts_queue covers only queued rows,
-- idx_attempts_heartbeat covers only running rows. As attempts grow, the
-- leaderboard's auth CTE must scan + filter + sort the whole attempts table
-- (or per-submission index scans with a filter). This partial index matches
-- the predicate exactly, so the planner can serve the DISTINCT ON from an
-- index scan and skip judge_error / non-completed rows entirely.
--
-- STATUS 18 Nov 2026: UNVERIFIED on real PostgreSQL — no server was
-- reachable on this VM (apt install of postgresql still running at
-- authoring time). The statement was syntax-checked by applying it in
-- pg-mem (see results/pgmem-benchmark-*.json), which does NOT model index
-- scans, so no before/after timing is claimed here. Before relying on it,
-- run EXPLAIN ANALYZE on the leaderboard query before/after applying this
-- file (commands in REPORT.md § Performance evidence).
--
-- NOTE: plain CREATE INDEX, not CONCURRENTLY — src/db/migrate.ts applies
-- each file inside a single transaction, and CONCURRENTLY cannot run in one.
CREATE INDEX IF NOT EXISTS idx_attempts_auth_leaderboard
  ON attempts (submission_id, attempt_no DESC)
  WHERE status = 'completed' AND verdict IS NOT NULL AND verdict <> 'judge_error';
