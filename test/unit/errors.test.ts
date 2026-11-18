/**
 * Unit tests for src/core/errors.ts and the pagination helpers in
 * src/core/types.ts. Pure functions — no database, no network.
 */
import { AppError, businessError, ERR, infraError, validationError } from '../../src/core/errors';
import { pageMeta, parsePageQuery } from '../../src/core/types';

describe('errors', () => {
  it('validationError is a 400 VALIDATION_ERROR', () => {
    const e = validationError('bad input');
    expect(e).toBeInstanceOf(AppError);
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(400);
    expect(e.code).toBe('VALIDATION_ERROR');
    expect(e.kind).toBe('validation');
    expect(e.message).toBe('bad input');
  });

  it('businessError carries the given status and stable code', () => {
    const e = businessError(409, ERR.IDEMPOTENCY_CONFLICT, 'same key, different code');
    expect(e.status).toBe(409);
    expect(e.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(e.kind).toBe('business');
  });

  it('businessError supports 403 and 404', () => {
    expect(businessError(403, ERR.FORBIDDEN, 'no').status).toBe(403);
    expect(businessError(404, ERR.NOT_FOUND, 'no').status).toBe(404);
  });

  it('infraError is a 503 INFRA_ERROR', () => {
    const e = infraError('db down');
    expect(e.status).toBe(503);
    expect(e.code).toBe('INFRA_ERROR');
    expect(e.kind).toBe('infra');
  });

  it('stable error codes are the documented strings', () => {
    expect(ERR.CONTEST_NOT_OPEN).toBe('CONTEST_NOT_OPEN');
    expect(ERR.NOT_A_PARTICIPANT).toBe('NOT_A_PARTICIPANT');
    expect(ERR.ORGANIZER_CANNOT_PARTICIPATE).toBe('ORGANIZER_CANNOT_PARTICIPATE');
    expect(ERR.IDEMPOTENCY_CONFLICT).toBe('IDEMPOTENCY_CONFLICT');
    expect(ERR.FORBIDDEN).toBe('FORBIDDEN');
    expect(ERR.NOT_FOUND).toBe('NOT_FOUND');
    expect(ERR.SUBMISSION_NOT_FOUND).toBe('SUBMISSION_NOT_FOUND');
  });
});

describe('parsePageQuery', () => {
  it('defaults to page 1, limit 20', () => {
    expect(parsePageQuery({})).toEqual({ page: 1, limit: 20 });
  });

  it('parses numeric strings', () => {
    expect(parsePageQuery({ page: '3', limit: '10' })).toEqual({ page: 3, limit: 10 });
  });

  it('clamps limit to a maximum of 100', () => {
    expect(parsePageQuery({ limit: 500 })).toEqual({ page: 1, limit: 100 });
    expect(parsePageQuery({ limit: 100 })).toEqual({ page: 1, limit: 100 });
    expect(parsePageQuery({ limit: 101 })).toEqual({ page: 1, limit: 100 });
  });

  it('floors page at 1 and limit at the 20 default for invalid values', () => {
    expect(parsePageQuery({ page: 0 })).toEqual({ page: 1, limit: 20 });
    expect(parsePageQuery({ page: -2 })).toEqual({ page: 1, limit: 20 });
    expect(parsePageQuery({ page: 'abc' })).toEqual({ page: 1, limit: 20 });
    expect(parsePageQuery({ limit: 0 })).toEqual({ page: 1, limit: 20 });
    expect(parsePageQuery({ limit: -5 })).toEqual({ page: 1, limit: 20 });
    expect(parsePageQuery({ limit: 'xyz' })).toEqual({ page: 1, limit: 20 });
  });

  it('floors fractional values', () => {
    expect(parsePageQuery({ page: 2.9, limit: 7.8 })).toEqual({ page: 2, limit: 7 });
  });

  it('accepts limit 1 (minimum valid)', () => {
    expect(parsePageQuery({ limit: 1 })).toEqual({ page: 1, limit: 1 });
  });
});

describe('pageMeta', () => {
  it('hasNext is true only when more pages remain', () => {
    expect(pageMeta(100, { page: 1, limit: 20 })).toEqual({
      page: 1, limit: 20, total: 100, hasNext: true,
    });
    expect(pageMeta(40, { page: 2, limit: 20 })).toEqual({
      page: 2, limit: 20, total: 40, hasNext: false,
    });
    expect(pageMeta(41, { page: 2, limit: 20 })).toEqual({
      page: 2, limit: 20, total: 41, hasNext: true,
    });
    expect(pageMeta(0, { page: 1, limit: 20 })).toEqual({
      page: 1, limit: 20, total: 0, hasNext: false,
    });
  });
});
