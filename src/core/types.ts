/**
 * Shared domain types for Shodh a Code.
 * These are the contract between the API (Stage 1), the judge worker
 * (Stages 2–3) and the tests/workload (Stage 4). Do not change names or
 * semantics without updating every consumer.
 */

export type OrgRole = 'organizer' | 'participant';
export type ContestStatus = 'draft' | 'open' | 'closed';
export type SubmissionStatus = 'queued' | 'running' | 'completed' | 'failed';
export type AttemptStatus = 'queued' | 'running' | 'completed' | 'failed' | 'superseded';
export type Verdict =
  | 'accepted'
  | 'wrong_answer'
  | 'compile_error'
  | 'runtime_error'
  | 'time_limit'
  | 'judge_error';

/** Verdicts that count as a wrong attempt for scoring (before first accept). */
export const WRONG_VERDICTS: Verdict[] = [
  'wrong_answer',
  'compile_error',
  'runtime_error',
  'time_limit',
];

/** A verdict of judge_error is an infrastructure failure: it must never
 *  reduce a student's score, so it is excluded from authoritative attempts. */
export function isAuthoritativeVerdict(v: Verdict | null): boolean {
  return v !== null && v !== 'judge_error';
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
}

export interface PageQuery {
  page: number;
  limit: number;
}

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  hasNext: boolean;
}

export interface Paged<T> {
  data: T[];
  page: PageMeta;
}

export function parsePageQuery(q: Record<string, unknown>): PageQuery {
  const rawPage = Number(q.page ?? 1);
  const rawLimit = Number(q.limit ?? 20);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const limit =
    Number.isFinite(rawLimit) && rawLimit >= 1
      ? Math.min(100, Math.floor(rawLimit))
      : 20;
  return { page, limit };
}

export function pageMeta(total: number, q: PageQuery): PageMeta {
  return {
    page: q.page,
    limit: q.limit,
    total,
    hasNext: q.page * q.limit < total,
  };
}

/** Per-test-case judge outcome. Must NEVER contain test inputs or expected outputs. */
export interface CaseResult {
  position: number;
  name: string;
  passed: boolean;
  /** 'ok' | 'wrong_output' | 'runtime_error' | 'time_limit' | 'output_limit' */
  outcome: string;
  runtimeMs: number;
  /** First line of the program's own stderr/stdout diff context (capped). Never expected output. */
  detail?: string;
}

/** Stored in attempts.detail. Never contains hidden test data or student code. */
export interface AttemptDetail {
  mode: 'real' | 'double';
  language: string;
  cases: CaseResult[];
  /** Machine-readable reason, e.g. 'all_passed', 'wrong_output', 'timeout', 'runner_crash'. */
  reason: string;
  maxOutputBytes: number;
}
