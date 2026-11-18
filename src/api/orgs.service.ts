import { Injectable } from '@nestjs/common';
import { pool, query } from '../db/pool';
import { businessError, ERR, validationError } from '../core/errors';
import { AuthUser } from '../core/types';
import { AccessService } from './access.service';
import { AddMemberDto, CreateOrgDto } from './dto';
import { memberOut, orgOut } from './serializers';

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === '23505';
}

@Injectable()
export class OrgsService {
  constructor(private access: AccessService) {}

  async createOrg(user: AuthUser, dto: CreateOrgDto): Promise<Record<string, unknown>> {
    let orgId: string;
    try {
      const res = await pool.query<{ id: string }>(
        'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id',
        [dto.name, dto.slug],
      );
      orgId = res.rows[0].id;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw businessError(409, 'SLUG_ALREADY_EXISTS', `org slug '${dto.slug}' is already taken`);
      }
      throw err;
    }
    await query(
      'INSERT INTO org_memberships (org_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (org_id, user_id) DO NOTHING',
      [orgId, user.id, 'organizer'],
    );
    const row = await this.access.requireOrg(orgId);
    return orgOut(row);
  }

  async addMember(
    orgId: string,
    user: AuthUser,
    dto: AddMemberDto,
  ): Promise<{ member: Record<string, unknown>; created: boolean }> {
    await this.access.requireOrganizer(orgId, user);
    const target = await query<{ id: string }>('SELECT id FROM users WHERE id = $1', [
      dto.userId,
    ]);
    if (target.rows.length === 0) {
      throw businessError(404, ERR.NOT_FOUND, 'user not found');
    }
    const existing = await query<{ role: string; created_at: string }>(
      'SELECT role, created_at FROM org_memberships WHERE org_id = $1 AND user_id = $2',
      [orgId, dto.userId],
    );
    if (existing.rows.length > 0) {
      // Update role if it changed; return the existing row.
      const res = await query(
        `INSERT INTO org_memberships (org_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role
         RETURNING org_id, user_id, role, created_at`,
        [orgId, dto.userId, dto.role],
      );
      return { member: memberOut(res.rows[0]), created: false };
    }
    const res = await query(
      'INSERT INTO org_memberships (org_id, user_id, role) VALUES ($1, $2, $3) RETURNING org_id, user_id, role, created_at',
      [orgId, dto.userId, dto.role],
    );
    return { member: memberOut(res.rows[0]), created: true };
  }
}

export function assertValidWindow(opensAt: string, closesAt: string): void {
  if (new Date(closesAt).getTime() <= new Date(opensAt).getTime()) {
    throw validationError('closesAt must be after opensAt');
  }
}
