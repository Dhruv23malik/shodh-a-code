import { Injectable } from '@nestjs/common';
import { query } from '../db/pool';
import { businessError, ERR } from '../core/errors';
import { AuthUser, OrgRole } from '../core/types';

export interface ContestRow {
  id: string;
  org_id: string;
  title: string;
  slug: string;
  status: string;
  opens_at: string;
  closes_at: string;
  penalty_per_wrong: number;
  created_at: string;
}

export interface ProblemRow {
  id: string;
  org_id: string;
  slug: string;
  title: string;
  statement: string;
  time_limit_ms: number;
  memory_mb: number;
  current_version_id: string | null;
  created_at: string;
}

/**
 * Shared membership / existence checks. Non-members (and missing resources)
 * always get 404 NOT_FOUND so existence is never leaked; members with the
 * wrong role get 403 FORBIDDEN.
 */
@Injectable()
export class AccessService {
  async getRole(orgId: string, userId: string): Promise<OrgRole | null> {
    const res = await query<{ role: OrgRole }>(
      'SELECT role FROM org_memberships WHERE org_id = $1 AND user_id = $2',
      [orgId, userId],
    );
    return res.rows[0]?.role ?? null;
  }

  async requireOrg(orgId: string): Promise<{ id: string; name: string; slug: string }> {
    const res = await query<{ id: string; name: string; slug: string }>(
      'SELECT id, name, slug FROM organizations WHERE id = $1',
      [orgId],
    );
    const row = res.rows[0];
    if (!row) throw businessError(404, ERR.NOT_FOUND, 'organization not found');
    return row;
  }

  async requireMember(orgId: string, user: AuthUser): Promise<OrgRole> {
    await this.requireOrg(orgId);
    const role = await this.getRole(orgId, user.id);
    if (!role) throw businessError(404, ERR.NOT_FOUND, 'organization not found');
    return role;
  }

  async requireOrganizer(orgId: string, user: AuthUser): Promise<void> {
    const role = await this.requireMember(orgId, user);
    if (role !== 'organizer') {
      throw businessError(403, ERR.FORBIDDEN, 'organizer role required');
    }
  }

  async getContest(contestId: string): Promise<ContestRow> {
    const res = await query<ContestRow>('SELECT * FROM contests WHERE id = $1', [
      contestId,
    ]);
    const row = res.rows[0];
    if (!row) throw businessError(404, ERR.NOT_FOUND, 'contest not found');
    return row;
  }

  /** Membership of the contest's org. Non-member -> 404. */
  async requireContestMember(
    contest: ContestRow,
    user: AuthUser,
  ): Promise<OrgRole> {
    return this.requireMember(contest.org_id, user);
  }

  async requireContestOrganizer(
    contest: ContestRow,
    user: AuthUser,
  ): Promise<void> {
    await this.requireOrganizer(contest.org_id, user);
  }

  async getProblem(problemId: string): Promise<ProblemRow> {
    const res = await query<ProblemRow>('SELECT * FROM problems WHERE id = $1', [
      problemId,
    ]);
    const row = res.rows[0];
    if (!row) throw businessError(404, ERR.PROBLEM_NOT_FOUND, 'problem not found');
    return row;
  }

  async isJoined(contestId: string, userId: string): Promise<boolean> {
    const res = await query<{ contest_id: string }>(
      'SELECT contest_id FROM contest_participants WHERE contest_id = $1 AND user_id = $2',
      [contestId, userId],
    );
    return res.rows.length > 0;
  }
}
