import { Injectable } from '@nestjs/common';
import { query } from '../db/pool';
import { AuthUser, PageQuery, Paged, pageMeta, WRONG_VERDICTS } from '../core/types';
import { AccessService } from './access.service';

/**
 * Leaderboard SQL implementing src/core/scoring.ts EXACTLY:
 *  - authoritative attempt per submission = latest completed attempt with
 *    verdict <> 'judge_error' (DISTINCT ON (submission_id) ORDER BY
 *    submission_id, attempt_no DESC).
 *  - solved = any authoritative 'accepted' for (user, problem).
 *  - wrongBeforeAccept = authoritative wrong-verdict submissions created
 *    before the first accepted submission's created_at.
 *  - points = solved ? max(0, 100 - penalty_per_wrong * wrongBeforeAccept) : 0
 *  - penaltyMinutes = solved
 *      ? floor(minutes(opens_at -> first accept)) + 20 * wrongBeforeAccept : 0
 *  - rank: totalScore DESC, totalPenaltyMinutes ASC, userId ASC.
 * Every joined participant appears, even with zero solves.
 */
@Injectable()
export class LeaderboardService {
  constructor(private access: AccessService) {}

  async getLeaderboard(
    contestId: string,
    user: AuthUser,
    pq: PageQuery,
  ): Promise<Paged<Record<string, unknown>>> {
    const contest = await this.access.getContest(contestId);
    await this.access.requireContestMember(contest, user);

    const total = Number(
      (
        await query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM contest_participants WHERE contest_id = $1',
          [contestId],
        )
      ).rows[0].count,
    );

    const res = await query(
      `WITH auth AS (
         SELECT DISTINCT ON (a.submission_id) a.submission_id, a.verdict
         FROM attempts a
         WHERE a.status = 'completed' AND a.verdict IS NOT NULL AND a.verdict <> 'judge_error'
         ORDER BY a.submission_id, a.attempt_no DESC
       ),
       sub AS (
         SELECT s.id, s.author_id, s.problem_id, s.created_at, auth.verdict
         FROM submissions s JOIN auth ON auth.submission_id = s.id
         WHERE s.contest_id = $1
       ),
       accepts AS (
         SELECT author_id, problem_id, MIN(created_at) AS first_accept_at
         FROM sub WHERE verdict = 'accepted'
         GROUP BY author_id, problem_id
       ),
       agg AS (
         SELECT a.author_id, a.problem_id, a.first_accept_at,
           COUNT(*) FILTER (WHERE s.verdict = ANY($3::text[]) AND s.created_at < a.first_accept_at) AS wrong_before
         FROM accepts a
         LEFT JOIN sub s ON s.author_id = a.author_id AND s.problem_id = a.problem_id
         GROUP BY a.author_id, a.problem_id, a.first_accept_at
       ),
       per_user AS (
         SELECT cp.user_id,
           COALESCE(SUM(GREATEST(0, 100 - $2 * agg.wrong_before)), 0)::int AS total_score,
           COALESCE(SUM(FLOOR(GREATEST(0, EXTRACT(EPOCH FROM (agg.first_accept_at - c.opens_at)) / 60)) + 20 * agg.wrong_before), 0)::int AS total_penalty,
           COUNT(agg.problem_id)::int AS problems_solved
         FROM contest_participants cp
         JOIN contests c ON c.id = cp.contest_id
         LEFT JOIN agg ON agg.author_id = cp.user_id
         WHERE cp.contest_id = $1
         GROUP BY cp.user_id
       ),
       ranked AS (
         SELECT pu.*, u.display_name,
           ROW_NUMBER() OVER (ORDER BY pu.total_score DESC, pu.total_penalty ASC, pu.user_id ASC) AS rank
         FROM per_user pu JOIN users u ON u.id = pu.user_id
       )
       SELECT user_id, display_name, total_score, total_penalty, problems_solved, rank
       FROM ranked ORDER BY rank ASC LIMIT $4 OFFSET $5`,
      [contestId, contest.penalty_per_wrong, WRONG_VERDICTS, pq.limit, (pq.page - 1) * pq.limit],
    );

    const data = res.rows.map((r: any) => ({
      rank: Number(r.rank),
      userId: r.user_id,
      displayName: r.display_name,
      totalScore: Number(r.total_score),
      totalPenaltyMinutes: Number(r.total_penalty),
      problemsSolved: Number(r.problems_solved),
    }));
    return { data, page: pageMeta(total, pq) };
  }
}
