/**
 * Leaderboard SQL — shared by scripts/rebuild-standings.ts and the
 * pg-mem leaderboard-equality tests.
 *
 * Both queries implement EXACTLY the rules in src/core/scoring.ts:
 *  - authoritative attempt of a submission = its latest COMPLETED attempt
 *    whose verdict is not 'judge_error' (highest attempt_no among those).
 *  - solved iff some submission has authoritative verdict 'accepted'.
 *  - wrongBeforeAccept = submissions whose authoritative verdict is a wrong
 *    verdict AND whose created_at is earlier than the first accepted
 *    submission's created_at.
 *  - points / penalty are computed by computeStandings in TypeScript from
 *    the aggregates; LEADERBOARD_SQL below is the pure-SQL rendering of the
 *    same math, used as the "serving leaderboard" fallback in the rebuild
 *    script. It must return the same rows, in the same order, as
 *    computeStandings(aggregates, penaltyPerWrong, opensAt).
 *
 * NOTE (18 Nov 2026, updated after Agent A landed): the API leaderboard
 * query was read in src/api/leaderboard.service.ts. It implements the same
 * rules via DISTINCT ON (submission_id) ... ORDER BY attempt_no DESC for
 * the authoritative attempt, and only solved (user, problem) pairs reach
 * its `agg` CTE (unsolved participants appear via LEFT JOIN with 0s).
 * AGGREGATES_SQL here derives the same per-(user, problem) aggregates via
 * MAX(attempt_no) among completed non-judge_error attempts — equivalent,
 * and the HTTP path of this script compares against the live endpoint, so
 * any divergence between the two renderings surfaces as a mismatch.
 */

export const AGGREGATES_SQL = `
WITH auth AS (
  SELECT a.submission_id, a.verdict
  FROM attempts a
  JOIN (
    SELECT submission_id, MAX(attempt_no) AS max_no
    FROM attempts
    WHERE status = 'completed' AND verdict IS NOT NULL AND verdict <> 'judge_error'
    GROUP BY submission_id
  ) m ON m.submission_id = a.submission_id AND m.max_no = a.attempt_no
),
per_sub AS (
  SELECT s.id AS submission_id, s.author_id, s.problem_id, s.created_at,
         auth.verdict AS verdict
  FROM submissions s
  LEFT JOIN auth ON auth.submission_id = s.id
  WHERE s.contest_id = $1
),
first_accept AS (
  SELECT author_id, problem_id, MIN(created_at) AS first_accept_at
  FROM per_sub
  WHERE verdict = 'accepted'
  GROUP BY author_id, problem_id
)
SELECT ps.author_id AS "userId",
       ps.problem_id AS "problemId",
       (fa.first_accept_at IS NOT NULL) AS solved,
       fa.first_accept_at AS "firstAcceptAt",
       SUM(CASE WHEN ps.verdict IN ('wrong_answer', 'compile_error', 'runtime_error', 'time_limit')
           AND fa.first_accept_at IS NOT NULL
           AND ps.created_at < fa.first_accept_at THEN 1 ELSE 0 END) AS "wrongBeforeAccept"
-- NOTE: SUM(CASE...) rather than COUNT(*) FILTER — same result on real
-- PostgreSQL, and pg-mem (used by the Stage 4 tests) mishandles FILTER.
FROM per_sub ps
LEFT JOIN first_accept fa
  ON fa.author_id = ps.author_id AND fa.problem_id = ps.problem_id
GROUP BY ps.author_id, ps.problem_id, fa.first_accept_at
`;

export const LEADERBOARD_SQL = `
WITH aggregates AS (${AGGREGATES_SQL})
SELECT a."userId" AS "userId",
       SUM(CASE WHEN a.solved THEN GREATEST(0, 100 - $2 * a."wrongBeforeAccept") ELSE 0 END)::int AS "totalScore",
       SUM(CASE WHEN a.solved THEN
           GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (a."firstAcceptAt" - $3::timestamptz)) / 60))::int
           + 20 * a."wrongBeforeAccept"
         ELSE 0 END)::int AS "totalPenaltyMinutes"
FROM aggregates a
GROUP BY a."userId"
ORDER BY "totalScore" DESC, "totalPenaltyMinutes" ASC, "userId" ASC
`;
