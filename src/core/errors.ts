/**
 * Error taxonomy. The brief requires business-rule failures to be separated
 * from request-validation errors and infrastructure failures.
 *
 * - ValidationError (400): malformed input, failed DTO validation.
 * - BusinessError (409 / 403 / 404): the request is well-formed but a domain
 *   rule refuses it (contest not open, not a participant, idempotency
 *   conflict, role denial, cross-org access). The `code` is stable and
 *   documented in the README so clients can branch on it.
 * - InfraError (500 / 503): the database, the judge or another dependency
 *   failed. Never surfaced as a student error.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly kind: 'validation' | 'business' | 'infra';

  constructor(
    status: number,
    code: string,
    kind: 'validation' | 'business' | 'infra',
    message: string,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.kind = kind;
  }
}

export function validationError(message: string): AppError {
  return new AppError(400, 'VALIDATION_ERROR', 'validation', message);
}

export function businessError(
  status: 403 | 404 | 409,
  code: string,
  message: string,
): AppError {
  return new AppError(status, code, 'business', message);
}

export function infraError(message: string): AppError {
  return new AppError(503, 'INFRA_ERROR', 'infra', message);
}

/** Stable business error codes (documented in README). */
export const ERR = {
  CONTEST_NOT_OPEN: 'CONTEST_NOT_OPEN',
  CONTEST_NOT_FOUND: 'CONTEST_NOT_FOUND',
  NOT_A_PARTICIPANT: 'NOT_A_PARTICIPANT',
  ORGANIZER_CANNOT_PARTICIPATE: 'ORGANIZER_CANNOT_PARTICIPATE',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  PROBLEM_NOT_FOUND: 'PROBLEM_NOT_FOUND',
  SUBMISSION_NOT_FOUND: 'SUBMISSION_NOT_FOUND',
  INVALID_VERSION: 'INVALID_VERSION',
  UNAUTHORIZED: 'UNAUTHORIZED',
} as const;
