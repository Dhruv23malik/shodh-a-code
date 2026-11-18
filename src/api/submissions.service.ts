import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { query, withTx } from '../db/pool';
import { businessError, ERR, validationError } from '../core/errors';
import { AuthUser, PageQuery, Paged, pageMeta } from '../core/types';
import { AccessService } from './access.service';
import { CreateSubmissionDto, RejudgeDto } from './dto';
import { submissionOut } from './serializers';

/** Canonical JSON: recursively sorted keys, so semantically-equal configs compare equal. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

@Injectable()
export class SubmissionsService {
  constructor(private access: AccessService) {}

  /**
   * Creates a submission + attempt_no=1 pinned to the problem's CURRENT
   * version + its current test suite, in ONE transaction.
   * Idempotent on (contest_id, author_id, idempotency_key): a replay with
   * identical payload returns the existing submission (200); a payload
   * mismatch -> 409 IDEMPOTENCY_CONFLICT. Authorization runs BEFORE the
   * idempotency lookup so a key can never leak another user's submission.
   */
  async createSubmission(
    contestId: string,
    user: AuthUser,
    dto: CreateSubmissionDto,
  ): Promise<{ submission: Record<string, unknown>; created: boolean }> {
    const contest = await this.access.getContest(contestId);
    const role = await this.access.requireContestMember(contest, user);
    if (role === 'organizer') {
      throw businessError(
        409,
        ERR.ORGANIZER_CANNOT_PARTICIPATE,
        'organizers cannot submit to their own org contests',
      );
    }
    if (!(await this.access.isJoined(contestId, user.id))) {
      throw businessError(409, ERR.NOT_A_PARTICIPANT, 'join the contest before submitting');
    }
    const now = Date.now();
    const open =
      contest.status === 'open' &&
      now >= new Date(contest.opens_at).getTime() &&
      now <= new Date(contest.closes_at).getTime();
    if (!open) {
      throw businessError(
        409,
        ERR.CONTEST_NOT_OPEN,
        'contest is not open for submissions right now',
      );
    }
    const problem = await this.access.getProblem(dto.problemId);
    if (problem.org_id !== contest.org_id) {
      throw businessError(404, ERR.PROBLEM_NOT_FOUND, 'problem not found in this contest org');
    }
    if (!problem.current_version_id) {
      throw businessError(409, ERR.PROBLEM_NOT_FOUND, 'problem has no published version');
    }
    const suiteRes = await query<{ id: string }>(
      `SELECT id FROM test_suites WHERE problem_version_id = $1 ORDER BY version DESC LIMIT 1`,
      [problem.current_version_id],
    );
    const suite = suiteRes.rows[0];
    if (!suite) {
      throw businessError(409, ERR.PROBLEM_NOT_FOUND, 'problem version has no test suite');
    }

    const codeHash = sha256(dto.code);
    const language = dto.language ?? 'python';
    const runtimeConfig = dto.runtimeConfig ?? {};
    const runtimeCanonical = canonicalJson(runtimeConfig);

    const result = await withTx(async (client) => {
      const inserted = await client.query(
        `INSERT INTO submissions
           (contest_id, problem_id, problem_version_id, test_suite_id, author_id,
            code, code_hash, language, runtime_config, idempotency_key, status, current_attempt_no)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, 'queued', 1)
         ON CONFLICT (contest_id, author_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [
          contestId,
          dto.problemId,
          problem.current_version_id,
          suite.id,
          user.id,
          dto.code,
          codeHash,
          language,
          runtimeCanonical,
          dto.idempotencyKey,
        ],
      );
      if (inserted.rows.length > 0) {
        const sub = inserted.rows[0];
        await client.query(
          `INSERT INTO attempts (submission_id, attempt_no, problem_version_id, test_suite_id, status)
           VALUES ($1, 1, $2, $3, 'queued')`,
          [sub.id, problem.current_version_id, suite.id],
        );
        return { submission: sub, created: true };
      }
      // Idempotency replay: fetch the existing row and compare payload.
      const existing = await client.query(
        'SELECT * FROM submissions WHERE contest_id = $1 AND author_id = $2 AND idempotency_key = $3',
        [contestId, user.id, dto.idempotencyKey],
      );
      const sub = existing.rows[0];
      if (!sub) {
        throw businessError(409, ERR.IDEMPOTENCY_CONFLICT, 'idempotency conflict');
      }
      const same =
        sub.code_hash === codeHash &&
        sub.problem_version_id === problem.current_version_id &&
        sub.test_suite_id === suite.id &&
        sub.language === language &&
        canonicalJson(sub.runtime_config) === runtimeCanonical;
      if (!same) {
        throw businessError(
          409,
          ERR.IDEMPOTENCY_CONFLICT,
          'idempotency key already used with a different payload',
        );
      }
      return { submission: sub, created: false };
    });

    const attempt = await query<{ verdict: string | null; score: number }>(
      'SELECT verdict, score FROM attempts WHERE submission_id = $1 AND attempt_no = $2',
      [result.submission.id, result.submission.current_attempt_no],
    );
    const row = { ...result.submission, verdict: attempt.rows[0]?.verdict ?? null, score: attempt.rows[0]?.score ?? 0 };
    return { submission: submissionOut(row), created: result.created };
  }

  async listSubmissions(
    contestId: string,
    user: AuthUser,
    pq: PageQuery,
  ): Promise<Paged<Record<string, unknown>>> {
    const contest = await this.access.getContest(contestId);
    const role = await this.access.requireContestMember(contest, user);
    const isOrganizer = role === 'organizer';
    const where = isOrganizer
      ? 's.contest_id = $1'
      : 's.contest_id = $1 AND s.author_id = $2';
    const params: unknown[] = isOrganizer ? [contestId] : [contestId, user.id];
    const total = Number(
      (
        await query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM submissions s WHERE ${where}`,
          params,
        )
      ).rows[0].count,
    );
    const res = await query(
      `SELECT s.*, a.verdict, a.score FROM submissions s
       LEFT JOIN attempts a ON a.submission_id = s.id AND a.attempt_no = s.current_attempt_no
       WHERE ${where}
       ORDER BY s.created_at DESC, s.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pq.limit, (pq.page - 1) * pq.limit],
    );
    return { data: res.rows.map((r) => submissionOut(r)), page: pageMeta(total, pq) };
  }

  /**
   * Author or org organizer only. Anyone else (incl. cross-org) -> 404
   * NOT_FOUND, never 403, so existence is not leaked. Includes per-case
   * pass/fail from the current attempt; never test inputs/expected outputs,
   * never another participant's code.
   */
  async getSubmission(
    submissionId: string,
    user: AuthUser,
  ): Promise<Record<string, unknown>> {
    const res = await query(
      `SELECT s.*, a.verdict, a.score, a.detail FROM submissions s
       LEFT JOIN attempts a ON a.submission_id = s.id AND a.attempt_no = s.current_attempt_no
       WHERE s.id = $1`,
      [submissionId],
    );
    const row = res.rows[0];
    if (!row) throw businessError(404, ERR.NOT_FOUND, 'submission not found');
    const contest = await this.access.getContest(row.contest_id);
    const role = await this.access.getRole(contest.org_id, user.id);
    const isAuthor = row.author_id === user.id;
    const isOrganizer = role === 'organizer';
    if (!isAuthor && !isOrganizer) {
      throw businessError(404, ERR.NOT_FOUND, 'submission not found');
    }
    const detail = (row.detail ?? {}) as { cases?: unknown[] };
    const cases = Array.isArray(detail.cases) ? detail.cases : [];
    return submissionOut(row, { includeCode: isAuthor, cases });
  }

  /**
   * Organizer only. Versions must belong to the submission's problem else
   * 409 INVALID_VERSION. Creates attempt_no = current+1 pinned to those
   * versions and sets submission.current_attempt_no; the old attempt is
   * left untouched and stays authoritative until the new one completes.
   */
  async rejudge(
    submissionId: string,
    user: AuthUser,
    dto: RejudgeDto,
  ): Promise<Record<string, unknown>> {
    const subRes = await query(
      'SELECT * FROM submissions WHERE id = $1',
      [submissionId],
    );
    const sub = subRes.rows[0];
    if (!sub) throw businessError(404, ERR.NOT_FOUND, 'submission not found');
    const contest = await this.access.getContest(sub.contest_id);
    await this.access.requireContestOrganizer(contest, user);

    const versionRes = await query<{ problem_id: string }>(
      'SELECT problem_id FROM problem_versions WHERE id = $1',
      [dto.problemVersionId],
    );
    const version = versionRes.rows[0];
    if (!version || version.problem_id !== sub.problem_id) {
      throw businessError(
        409,
        ERR.INVALID_VERSION,
        'problem version does not belong to this submission problem',
      );
    }
    const suiteRes = await query<{ problem_version_id: string }>(
      'SELECT problem_version_id FROM test_suites WHERE id = $1',
      [dto.testSuiteId],
    );
    const suite = suiteRes.rows[0];
    if (!suite || suite.problem_version_id !== dto.problemVersionId) {
      throw businessError(
        409,
        ERR.INVALID_VERSION,
        'test suite does not belong to the given problem version',
      );
    }

    const out = await withTx(async (client) => {
      const nextAttemptNo = Number(sub.current_attempt_no) + 1;
      await client.query(
        `INSERT INTO attempts (submission_id, attempt_no, problem_version_id, test_suite_id, status)
         VALUES ($1, $2, $3, $4, 'queued')`,
        [submissionId, nextAttemptNo, dto.problemVersionId, dto.testSuiteId],
      );
      // Supersede any live prior attempt: a stale worker's late verdict
      // must affect 0 rows (applyVerdict requires status='running').
      // Completed attempts are history and stay untouched; the
      // authoritative-attempt rule (latest completed non-judge_error
      // attempt) still governs standings.
      await client.query(
        `UPDATE attempts SET status = 'superseded'
         WHERE submission_id = $1 AND attempt_no < $2
           AND status IN ('queued', 'running')`,
        [submissionId, nextAttemptNo],
      );
      const updated = await client.query(
        `UPDATE submissions SET current_attempt_no = $1, status = 'queued', updated_at = now()
         WHERE id = $2 RETURNING *`,
        [nextAttemptNo, submissionId],
      );
      return { submission: updated.rows[0], attemptNo: nextAttemptNo };
    });
    return {
      ...submissionOut({ ...out.submission, verdict: null, score: 0 }),
      attemptNo: out.attemptNo,
    };
  }
}
