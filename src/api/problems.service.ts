import { Injectable } from '@nestjs/common';
import { query, withTx } from '../db/pool';
import { businessError, ERR } from '../core/errors';
import { AuthUser } from '../core/types';
import { AccessService } from './access.service';
import { CreateProblemDto, CreateVersionDto, TestCaseDto } from './dto';
import { CaseView, problemOut } from './serializers';

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === '23505';
}

@Injectable()
export class ProblemsService {
  constructor(private access: AccessService) {}

  /** Creates problem + version 1 + test suite v1 + cases in ONE transaction. */
  async createProblem(
    orgId: string,
    user: AuthUser,
    dto: CreateProblemDto,
  ): Promise<Record<string, unknown>> {
    await this.access.requireOrganizer(orgId, user);
    const created = await withTx(async (client) => {
      let problemRow: any;
      try {
        const res = await client.query(
          `INSERT INTO problems (org_id, slug, title, statement, time_limit_ms, memory_mb)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [
            orgId,
            dto.slug,
            dto.title,
            dto.statement ?? '',
            dto.timeLimitMs ?? 2000,
            dto.memoryMb ?? 256,
          ],
        );
        problemRow = res.rows[0];
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw businessError(409, 'SLUG_ALREADY_EXISTS', `problem slug '${dto.slug}' is already taken in this org`);
        }
        throw err;
      }
      const versionRow = (
        await client.query(
          'INSERT INTO problem_versions (problem_id, version, description) VALUES ($1, 1, $2) RETURNING *',
          [problemRow.id, ''],
        )
      ).rows[0];
      const suiteRow = (
        await client.query(
          'INSERT INTO test_suites (problem_version_id, version) VALUES ($1, 1) RETURNING *',
          [versionRow.id],
        )
      ).rows[0];
      await this.insertCases(client, suiteRow.id, dto.testCases);
      await client.query('UPDATE problems SET current_version_id = $1 WHERE id = $2', [
        versionRow.id,
        problemRow.id,
      ]);
      problemRow.current_version_id = versionRow.id;
      return { problem: problemRow, version: 1, suiteId: suiteRow.id };
    });
    return this.getProblemView(orgId, created.problem.id, 'organizer');
  }

  /** New immutable version + new suite; sets current_version_id. */
  async createVersion(
    orgId: string,
    problemId: string,
    user: AuthUser,
    dto: CreateVersionDto,
  ): Promise<Record<string, unknown>> {
    await this.access.requireOrganizer(orgId, user);
    const problem = await this.access.getProblem(problemId);
    if (problem.org_id !== orgId) {
      throw businessError(404, ERR.NOT_FOUND, 'problem not found');
    }
    await withTx(async (client) => {
      const maxRes = await client.query<{ max: number | null }>(
        'SELECT MAX(version) AS max FROM problem_versions WHERE problem_id = $1',
        [problemId],
      );
      const nextVersion = (maxRes.rows[0].max ?? 0) + 1;
      const versionRow = (
        await client.query(
          'INSERT INTO problem_versions (problem_id, version, description) VALUES ($1, $2, $3) RETURNING *',
          [problemId, nextVersion, dto.description ?? ''],
        )
      ).rows[0];
      const suiteRow = (
        await client.query(
          'INSERT INTO test_suites (problem_version_id, version) VALUES ($1, 1) RETURNING *',
          [versionRow.id],
        )
      ).rows[0];
      await this.insertCases(client, suiteRow.id, dto.testCases);
      await client.query('UPDATE problems SET current_version_id = $1 WHERE id = $2', [
        versionRow.id,
        problemId,
      ]);
    });
    return this.getProblemView(orgId, problemId, 'organizer');
  }

  async getProblem(
    orgId: string,
    problemId: string,
    user: AuthUser,
  ): Promise<Record<string, unknown>> {
    const role = await this.access.requireMember(orgId, user);
    return this.getProblemView(orgId, problemId, role);
  }

  private async getProblemView(
    orgId: string,
    problemId: string,
    role: 'organizer' | 'participant',
  ): Promise<Record<string, unknown>> {
    const problem = await this.access.getProblem(problemId);
    if (problem.org_id !== orgId) {
      throw businessError(404, ERR.NOT_FOUND, 'problem not found');
    }
    let version: number | null = null;
    if (problem.current_version_id) {
      const v = await query<{ version: number }>(
        'SELECT version FROM problem_versions WHERE id = $1',
        [problem.current_version_id],
      );
      version = v.rows[0]?.version ?? null;
    }
    // Organizer view may include inputs; participant view never does.
    // Neither view ever returns expected_output.
    const casesRes = problem.current_version_id
      ? role === 'organizer'
        ? await query(
            `SELECT tc.position, tc.name, tc.input, tc.is_hidden FROM test_cases tc
             JOIN test_suites ts ON ts.id = tc.test_suite_id
             WHERE ts.problem_version_id = $1 ORDER BY tc.position ASC`,
            [problem.current_version_id],
          )
        : await query(
            `SELECT tc.position, tc.name, tc.is_hidden FROM test_cases tc
             JOIN test_suites ts ON ts.id = tc.test_suite_id
             WHERE ts.problem_version_id = $1 ORDER BY tc.position ASC`,
            [problem.current_version_id],
          )
      : { rows: [] };
    const cases: CaseView[] = casesRes.rows.map((r: any) => ({
      position: r.position,
      name: r.name,
      isHidden: r.is_hidden,
      ...(role === 'organizer' ? { input: r.input } : {}),
    }));
    return problemOut(problem, cases, version);
  }

  private async insertCases(
    client: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> },
    suiteId: string,
    cases: TestCaseDto[],
  ): Promise<void> {
    for (const c of cases) {
      await client.query(
        `INSERT INTO test_cases (test_suite_id, position, name, input, expected_output, is_hidden)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [suiteId, c.position, c.name, c.input, c.expectedOutput, c.isHidden ?? true],
      );
    }
  }
}
