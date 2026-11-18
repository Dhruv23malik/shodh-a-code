/**
 * Deterministic scoring — the single canonical definition, used by the
 * leaderboard SQL (API) and by the standalone rebuild script (scripts/).
 * Both paths MUST implement exactly this math; the rebuild test asserts
 * equality between them.
 *
 * Per (contest, user, problem):
 *  - A problem is SOLVED iff some submission by the user for that problem in
 *    that contest has an authoritative attempt with verdict 'accepted'.
 *    The authoritative attempt of a submission is its latest completed
 *    attempt whose verdict is not 'judge_error' (an infra failure never
 *    reduces a score, and a later rejudge supersedes earlier attempts).
 *  - wrongBeforeAccept = number of submissions for that problem whose
 *    authoritative verdict is a wrong verdict (wrong_answer / compile_error /
 *    runtime_error / time_limit) AND whose created_at is earlier than the
 *    first accepted submission's created_at.
 *  - points = solved ? max(0, 100 - penaltyPerWrong * wrongBeforeAccept) : 0
 *  - penaltyMinutes = solved
 *      ? minutes(contest.opensAt -> firstAcceptAt) + 20 * wrongBeforeAccept
 *      : 0
 *
 * Ranking: totalScore DESC, totalPenaltyMinutes ASC, userId ASC (stable).
 */
import { WRONG_VERDICTS, Verdict } from './types';

export interface ProblemAggregate {
  userId: string;
  problemId: string;
  solved: boolean;
  firstAcceptAt: Date | null;
  wrongBeforeAccept: number;
}

export interface StandingRow {
  userId: string;
  totalScore: number;
  totalPenaltyMinutes: number;
}

export function pointsForProblem(
  penaltyPerWrong: number,
  solved: boolean,
  wrongBeforeAccept: number,
): number {
  if (!solved) return 0;
  return Math.max(0, 100 - penaltyPerWrong * wrongBeforeAccept);
}

export function penaltyMinutesForProblem(
  contestOpensAt: Date,
  solved: boolean,
  firstAcceptAt: Date | null,
  wrongBeforeAccept: number,
): number {
  if (!solved || !firstAcceptAt) return 0;
  const minutes = Math.max(
    0,
    Math.floor(
      (firstAcceptAt.getTime() - contestOpensAt.getTime()) / 60_000,
    ),
  );
  return minutes + 20 * wrongBeforeAccept;
}

/**
 * Pure leaderboard computation over per-(user, problem) aggregates.
 * The SQL leaderboard must return the same rows in the same order.
 */
export function computeStandings(
  aggregates: ProblemAggregate[],
  penaltyPerWrong: number,
  contestOpensAt: Date,
): StandingRow[] {
  const byUser = new Map<string, StandingRow>();
  for (const a of aggregates) {
    const row =
      byUser.get(a.userId) ??
      ({ userId: a.userId, totalScore: 0, totalPenaltyMinutes: 0 } as StandingRow);
    row.totalScore += pointsForProblem(
      penaltyPerWrong,
      a.solved,
      a.wrongBeforeAccept,
    );
    row.totalPenaltyMinutes += penaltyMinutesForProblem(
      contestOpensAt,
      a.solved,
      a.firstAcceptAt,
      a.wrongBeforeAccept,
    );
    byUser.set(a.userId, row);
  }
  return [...byUser.values()].sort(
    (x, y) =>
      y.totalScore - x.totalScore ||
      x.totalPenaltyMinutes - y.totalPenaltyMinutes ||
      (x.userId < y.userId ? -1 : x.userId > y.userId ? 1 : 0),
  );
}

export function isWrongVerdict(v: Verdict | null): boolean {
  return v !== null && (WRONG_VERDICTS as Verdict[]).includes(v);
}
