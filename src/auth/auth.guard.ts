import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { query } from '../db/pool';
import { AppError, ERR } from '../core/errors';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Dev auth fixture: `Authorization: Bearer dev:<user-uuid>` resolves the
 * user from the users table. Unknown or missing token -> 401 UNAUTHORIZED.
 * Authorization (membership / role) is enforced in services, never here
 * and never by trusting IDs from the client.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      IS_PUBLIC_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (isPublic) return true;
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers?.authorization;
    const m = /^Bearer dev:([0-9a-fA-F-]{36})$/.exec(header ?? '');
    if (!m) {
      throw new AppError(
        401,
        ERR.UNAUTHORIZED,
        'business',
        'missing or malformed dev bearer token',
      );
    }
    const res = await query<{ id: string; email: string; display_name: string }>(
      'SELECT id, email, display_name FROM users WHERE id = $1',
      [m[1]],
    );
    const row = res.rows[0];
    if (!row) {
      throw new AppError(401, ERR.UNAUTHORIZED, 'business', 'unknown user');
    }
    req.user = { id: row.id, email: row.email, displayName: row.display_name };
    return true;
  }
}
