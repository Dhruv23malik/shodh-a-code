# AI-Assistance Disclosure

This system was built with **Muse** (Meta's AI agent) under the direction of **Dhruv Malik** on 18 Nov 2026, for the Shodh AI take-home assessment (deadline 18 Nov 2026, 11:59 PM IST). Dhruv reviewed the assessment brief, chose the stack direction (NestJS + PostgreSQL + Docker judge), and is responsible for understanding and verifying the implementation.

## What was AI-built

The Stage 4 verification deliverables in this repository — the test suites (`test/unit`, `test/double`, `test/api`), the scripts (`scripts/workload.ts`, `scripts/rebuild-standings.ts`, `scripts/openapi.ts`, `scripts/leaderboard-sql.ts`), migration `002_leaderboard_auth_attempts_idx.sql`, `docs/openapi.json`, `README.md`, `REPORT.md`, and this file — were written by Muse (Stage 4 agent) from the assessment brief and from reading the Stage 1–3 code as it landed (API, worker, runner, seed). Sibling agents built the API, worker, and judge in parallel; the Stage 4 agent read their code and wired its tests to the real interfaces (`createWorker`, `DoubleRunner`, the Nest controllers, `seed/IDENTITIES.md`).

## What was verified by running commands

- `npx tsc --noEmit` (clean) and `npm test` (48 passed, 0 failed, twice) against real PostgreSQL 16.15 on this machine.
- `scripts/rebuild-standings.ts` exit 0 via both the SQL fallback and the live HTTP leaderboard.
- Double-mode workload measured end to end (30 submissions, 0 errors; full numbers in `REPORT.md` and `results/results-double-*.json`).
- `EXPLAIN ANALYZE` before/after migration 002 on real PostgreSQL (`results/explain-*.txt`) — showing no measurable improvement at the tested scale, reported honestly.
- `npm run openapi` validation of `docs/openapi.json`; `npm run migrate` + `npm run seed` on real PostgreSQL.

## What could NOT be verified here

- **Docker / real runner:** the VM's Docker daemon failed to start, so `docker compose up --build`, the real sandboxed judge, and the real-mode workload were not run on this machine. They require the reviewer to run them with Docker available.
- **Migration 002's benefit:** no measured query-plan improvement at the tested data volume (see `REPORT.md` §5).
- The two divergences recorded in `REPORT.md` §6 (rejudge late-result semantics; `requeue_count` overwritten by the verdict write) were found by testing and are flagged for review, not fixed by the AI.
