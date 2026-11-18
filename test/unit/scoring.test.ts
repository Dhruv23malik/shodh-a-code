/**
 * Unit tests for the canonical scoring in src/core/scoring.ts.
 * Pure functions — no database, no network.
 * Hand-computed cases, cross-checked against the rules in scoring.ts:
 *  - points = solved ? max(0, 100 - penaltyPerWrong * wrongBeforeAccept) : 0
 *  - penaltyMinutes = solved
 *      ? minutes(opensAt -> firstAcceptAt) + 20 * wrongBeforeAccept : 0
 *  - ranking: totalScore DESC, totalPenaltyMinutes ASC, userId ASC.
 */
import {
  computeStandings,
  penaltyMinutesForProblem,
  pointsForProblem,
  ProblemAggregate,
} from '../../src/core/scoring';

const opensAt = new Date('2026-11-18T10:00:00.000Z');
const at = (minutesAfterOpen: number) =>
  new Date(opensAt.getTime() + minutesAfterOpen * 60_000);

function agg(
  userId: string,
  problemId: string,
  solved: boolean,
  firstAcceptMinutes: number | null,
  wrongBeforeAccept: number,
): ProblemAggregate {
  return {
    userId,
    problemId,
    solved,
    firstAcceptAt: firstAcceptMinutes === null ? null : at(firstAcceptMinutes),
    wrongBeforeAccept,
  };
}

describe('pointsForProblem', () => {
  it('solved with 0 wrong attempts scores 100', () => {
    expect(pointsForProblem(20, true, 0)).toBe(100);
  });
  it('solved with 1 wrong attempt scores 80 (penalty 20)', () => {
    expect(pointsForProblem(20, true, 1)).toBe(80);
  });
  it('solved with 2 wrong attempts scores 60', () => {
    expect(pointsForProblem(20, true, 2)).toBe(60);
  });
  it('solved with 5 wrong attempts floors at 0, never negative', () => {
    expect(pointsForProblem(20, true, 5)).toBe(0);
    expect(pointsForProblem(20, true, 10)).toBe(0);
  });
  it('unsolved scores 0 regardless of wrong attempts', () => {
    expect(pointsForProblem(20, false, 0)).toBe(0);
    expect(pointsForProblem(20, false, 3)).toBe(0);
  });
  it('respects a different penaltyPerWrong', () => {
    expect(pointsForProblem(10, true, 2)).toBe(80);
    expect(pointsForProblem(0, true, 3)).toBe(100);
  });
});

describe('penaltyMinutesForProblem', () => {
  it('accept at +30 min, 0 wrong -> 30', () => {
    expect(penaltyMinutesForProblem(opensAt, true, at(30), 0)).toBe(30);
  });
  it('accept at +30 min, 1 wrong -> 30 + 20 = 50', () => {
    expect(penaltyMinutesForProblem(opensAt, true, at(30), 1)).toBe(50);
  });
  it('accept at +45 min, 2 wrong -> 45 + 40 = 85', () => {
    expect(penaltyMinutesForProblem(opensAt, true, at(45), 2)).toBe(85);
  });
  it('unsolved -> 0 even with a firstAcceptAt / wrong attempts', () => {
    expect(penaltyMinutesForProblem(opensAt, false, at(30), 2)).toBe(0);
  });
  it('solved but null firstAcceptAt -> 0', () => {
    expect(penaltyMinutesForProblem(opensAt, true, null, 0)).toBe(0);
  });
  it('accept before contest opens floors the elapsed part at 0', () => {
    const early = new Date(opensAt.getTime() - 5 * 60_000);
    expect(penaltyMinutesForProblem(opensAt, true, early, 1)).toBe(20);
  });
  it('sub-minute elapsed time floors to whole minutes', () => {
    const t = new Date(opensAt.getTime() + 90_000); // 1.5 min
    expect(penaltyMinutesForProblem(opensAt, true, t, 0)).toBe(1);
  });
});

describe('computeStandings', () => {
  it('sums points and penalty across problems for one user', () => {
    const rows = computeStandings(
      [
        agg('u1', 'p1', true, 30, 0), // 100 pts, 30 min
        agg('u1', 'p2', true, 60, 1), // 80 pts, 60+20=80 min
      ],
      20,
      opensAt,
    );
    expect(rows).toEqual([
      { userId: 'u1', totalScore: 180, totalPenaltyMinutes: 110 },
    ]);
  });

  it('unsolved problems contribute 0 points and 0 penalty', () => {
    const rows = computeStandings(
      [agg('u1', 'p1', false, null, 4), agg('u1', 'p2', true, 10, 0)],
      20,
      opensAt,
    );
    expect(rows).toEqual([
      { userId: 'u1', totalScore: 100, totalPenaltyMinutes: 10 },
    ]);
  });

  it('ranks by score desc', () => {
    const rows = computeStandings(
      [
        agg('u1', 'p1', true, 30, 0),
        agg('u2', 'p1', true, 30, 1),
        agg('u3', 'p1', false, null, 0),
      ],
      20,
      opensAt,
    );
    expect(rows.map((r) => r.userId)).toEqual(['u1', 'u2', 'u3']);
    expect(rows[0].totalScore).toBe(100);
    expect(rows[1].totalScore).toBe(80);
    expect(rows[2].totalScore).toBe(0);
  });

  it('breaks a score tie by lower penalty first', () => {
    const rows = computeStandings(
      [
        agg('u1', 'p1', true, 50, 0), // 100 pts, 50 min
        agg('u2', 'p1', true, 20, 0), // 100 pts, 20 min -> ahead
      ],
      20,
      opensAt,
    );
    expect(rows.map((r) => r.userId)).toEqual(['u2', 'u1']);
  });

  it('breaks a score+penalty tie by userId ascending (stable)', () => {
    const rows = computeStandings(
      [
        agg('u-b', 'p1', true, 30, 0),
        agg('u-a', 'p1', true, 30, 0),
        agg('u-c', 'p1', true, 30, 0),
      ],
      20,
      opensAt,
    );
    expect(rows.map((r) => r.userId)).toEqual(['u-a', 'u-b', 'u-c']);
  });

  it('a user with only unsolved problems still appears with 0/0', () => {
    const rows = computeStandings([agg('u1', 'p1', false, null, 2)], 20, opensAt);
    expect(rows).toEqual([{ userId: 'u1', totalScore: 0, totalPenaltyMinutes: 0 }]);
  });

  it('empty input -> empty standings', () => {
    expect(computeStandings([], 20, opensAt)).toEqual([]);
  });

  it('worked example: two users, two problems (hand-computed)', () => {
    // u1: p1 solved at +25min with 1 wrong (80 pts, 45 min),
    //     p2 solved at +70min with 0 wrong (100 pts, 70 min) -> 180 / 115
    // u2: p1 solved at +25min with 0 wrong (100 pts, 25 min),
    //     p2 unsolved (0 pts, 0 min) -> 100 / 25
    const rows = computeStandings(
      [
        agg('u1', 'p1', true, 25, 1),
        agg('u1', 'p2', true, 70, 0),
        agg('u2', 'p1', true, 25, 0),
        agg('u2', 'p2', false, null, 3),
      ],
      20,
      opensAt,
    );
    expect(rows).toEqual([
      { userId: 'u1', totalScore: 180, totalPenaltyMinutes: 115 },
      { userId: 'u2', totalScore: 100, totalPenaltyMinutes: 25 },
    ]);
  });
});
