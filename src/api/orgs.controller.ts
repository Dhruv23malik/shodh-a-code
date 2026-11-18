import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { AuthUser, parsePageQuery } from '../core/types';
import { CurrentUser } from '../auth/current-user.decorator';
import { Public } from '../auth/public.decorator';
import { OrgsService } from './orgs.service';
import { ContestsService } from './contests.service';
import { ProblemsService } from './problems.service';
import {
  AddMemberDto,
  CreateContestDto,
  CreateOrgDto,
  CreateProblemDto,
  CreateVersionDto,
  UpdateContestDto,
} from './dto';

@Controller()
export class HealthController {
  @Public()
  @Get('health')
  health(): Record<string, string> {
    return { status: 'ok' };
  }
}

@Controller('orgs')
export class OrgsController {
  constructor(
    private orgs: OrgsService,
    private contests: ContestsService,
    private problems: ProblemsService,
  ) {}

  @Post()
  async createOrg(@CurrentUser() user: AuthUser, @Body() dto: CreateOrgDto) {
    return this.orgs.createOrg(user, dto);
  }

  @Post(':orgId/members')
  async addMember(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: AddMemberDto,
  ) {
    const { member } = await this.orgs.addMember(orgId, user, dto);
    return member;
  }

  @Post(':orgId/contests')
  async createContest(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateContestDto,
  ) {
    return this.contests.createContest(orgId, user, dto);
  }

  @Patch(':orgId/contests/:contestId')
  async updateContest(
    @Param('orgId') orgId: string,
    @Param('contestId') contestId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateContestDto,
  ) {
    return this.contests.updateContest(orgId, contestId, user, dto);
  }

  @Get(':orgId/contests')
  async listContests(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthUser,
    @Query() q: Record<string, unknown>,
  ) {
    return this.contests.listContests(orgId, user, parsePageQuery(q));
  }

  @Post(':orgId/problems')
  async createProblem(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateProblemDto,
  ) {
    return this.problems.createProblem(orgId, user, dto);
  }

  @Post(':orgId/problems/:problemId/versions')
  async createVersion(
    @Param('orgId') orgId: string,
    @Param('problemId') problemId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateVersionDto,
  ) {
    return this.problems.createVersion(orgId, problemId, user, dto);
  }

  @Get(':orgId/problems/:problemId')
  async getProblem(
    @Param('orgId') orgId: string,
    @Param('problemId') problemId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.problems.getProblem(orgId, problemId, user);
  }
}
