import { Injectable } from '@nestjs/common';
import { pool, query } from '../db/pool';
import { businessError, ERR } from '../core/errors';
import { AuthUser, PageQuery, Paged, pageMeta } from '../core/types';
import { AccessService } from './access.service';
import { CreateContestDto, UpdateContestDto } from './dto';
import { contestOut } from './serializers';
import { assertValidWindow } from './orgs.service';

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === '23505';
}

@Injectable()
export class ContestsService {
  constructor(private access: AccessService) {}

  async createContest(
    orgId: string,
    user: AuthUser,
    dto: CreateContestDto,
  ): Promise<Record<string, unknown>> {
    await this.access.requireOrganizer(orgId, user);
    assertValidWindow(dto.opensAt, dto.closesAt);
    let row: any;
    try {
      const res = await pool.query(
        `INSERT INTO contests (org_id, title, slug, opens_at, closes_at, penalty_per_wrong)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [
          orgId,
          dto.title,
          dto.slug,
          dto.opensAt,
          dto.closesAt,
          dto.penaltyPerWrong ?? 20,
        ],
      );
      row = res.rows[0];
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw businessError(409, 'SLUG_ALREADY_EXISTS', `contest slug '${dto.slug}' is already taken in this org`);
      }
      throw err;
    }
    return contestOut(row);
  }

  /** Allowed: draft->open, any->closed. Everything else -> 409. */
  async updateContest(
    orgId: string,
    contestId: string,
    user: AuthUser,
    dto: UpdateContestDto,
  ): Promise<Record<string, unknown>> {
    await this.access.requireOrganizer(orgId, user);
    const contest = await this.access.getContest(contestId);
    if (contest.org_id !== orgId) {
      throw businessError(404, ERR.NOT_FOUND, 'contest not found');
    }
    const from = contest.status;
    const to = dto.status;
    const allowed =
      (to === 'closed') || (from === 'draft' && to === 'open') || from === to;
    if (!allowed) {
      throw businessError(
        409,
        'INVALID_STATUS_TRANSITION',
        `cannot move contest from '${from}' to '${to}'`,
      );
    }
    const res = await query(
      'UPDATE contests SET status = $1 WHERE id = $2 RETURNING *',
      [to, contestId],
    );
    return contestOut(res.rows[0]);
  }

  async listContests(
    orgId: string,
    user: AuthUser,
    pq: PageQuery,
  ): Promise<Paged<Record<string, unknown>>> {
    await this.access.requireMember(orgId, user);
    const total = Number(
      (await query<{ count: string }>('SELECT COUNT(*)::text AS count FROM contests WHERE org_id = $1', [orgId])).rows[0].count,
    );
    const res = await query(
      `SELECT * FROM contests WHERE org_id = $1
       ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [orgId, pq.limit, (pq.page - 1) * pq.limit],
    );
    return { data: res.rows.map(contestOut), page: pageMeta(total, pq) };
  }

  async getContest(contestId: string, user: AuthUser): Promise<Record<string, unknown>> {
    const contest = await this.access.getContest(contestId);
    await this.access.requireContestMember(contest, user);
    return contestOut(contest);
  }

  async joinContest(
    contestId: string,
    user: AuthUser,
  ): Promise<{ row: Record<string, unknown>; created: boolean }> {
    const contest = await this.access.getContest(contestId);
    const role = await this.access.requireContestMember(contest, user);
    if (role === 'organizer') {
      throw businessError(
        409,
        ERR.ORGANIZER_CANNOT_PARTICIPATE,
        'organizers cannot participate in their own org contests',
      );
    }
    const existing = await query(
      'SELECT contest_id, user_id, joined_at FROM contest_participants WHERE contest_id = $1 AND user_id = $2',
      [contestId, user.id],
    );
    if (existing.rows.length > 0) {
      const r = existing.rows[0];
      return {
        row: { contestId: r.contest_id, userId: r.user_id, joinedAt: r.joined_at },
        created: false,
      };
    }
    const res = await query(
      'INSERT INTO contest_participants (contest_id, user_id) VALUES ($1, $2) RETURNING contest_id, user_id, joined_at',
      [contestId, user.id],
    );
    const r = res.rows[0];
    return {
      row: { contestId: r.contest_id, userId: r.user_id, joinedAt: r.joined_at },
      created: true,
    };
  }
}
