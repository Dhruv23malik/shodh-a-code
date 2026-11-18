/** Row -> API response mappers. All timestamps are ISO strings. */

export function orgOut(r: any): Record<string, unknown> {
  return { id: r.id, name: r.name, slug: r.slug, createdAt: r.created_at };
}

export function memberOut(r: any): Record<string, unknown> {
  return {
    orgId: r.org_id,
    userId: r.user_id,
    role: r.role,
    createdAt: r.created_at,
  };
}

export function contestOut(r: any): Record<string, unknown> {
  return {
    id: r.id,
    orgId: r.org_id,
    title: r.title,
    slug: r.slug,
    status: r.status,
    opensAt: r.opens_at,
    closesAt: r.closes_at,
    penaltyPerWrong: r.penalty_per_wrong,
    createdAt: r.created_at,
  };
}

export interface CaseView {
  position: number;
  name: string;
  isHidden: boolean;
  input?: string;
}

/**
 * Participant view: position/name/is_hidden only — NEVER input or
 * expected_output. Organizer view: may include input, still NEVER
 * expected_output (cases are managed via create payloads, not reads).
 */
export function problemOut(
  r: any,
  cases: CaseView[],
  version: number | null,
): Record<string, unknown> {
  return {
    id: r.id,
    orgId: r.org_id,
    slug: r.slug,
    title: r.title,
    statement: r.statement,
    timeLimitMs: r.time_limit_ms,
    memoryMb: r.memory_mb,
    currentVersionId: r.current_version_id,
    currentVersion: version,
    createdAt: r.created_at,
    testCases: cases,
  };
}

export function submissionOut(
  r: any,
  opts: { includeCode?: boolean; cases?: unknown[] } = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: r.id,
    contestId: r.contest_id,
    problemId: r.problem_id,
    problemVersionId: r.problem_version_id,
    testSuiteId: r.test_suite_id,
    authorId: r.author_id,
    language: r.language,
    status: r.status,
    verdict: r.verdict ?? null,
    score: r.score ?? 0,
    currentAttemptNo: r.current_attempt_no,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (opts.includeCode) out.code = r.code;
  if (opts.cases !== undefined) out.cases = opts.cases;
  return out;
}
