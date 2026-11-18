import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { AuthUser, parsePageQuery } from '../core/types';
import { CurrentUser } from '../auth/current-user.decorator';
import { ContestsService } from './contests.service';
import { SubmissionsService } from './submissions.service';
import { LeaderboardService } from './leaderboard.service';
import { CreateSubmissionDto } from './dto';

@Controller('contests')
export class ContestsController {
  constructor(
    private contests: ContestsService,
    private submissions: SubmissionsService,
    private leaderboard: LeaderboardService,
  ) {}

  @Get(':contestId')
  async getContest(@Param('contestId') contestId: string, @CurrentUser() user: AuthUser) {
    return this.contests.getContest(contestId, user);
  }

  @Post(':contestId/join')
  async join(
    @Param('contestId') contestId: string,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: any,
  ) {
    const { row, created } = await this.contests.joinContest(contestId, user);
    res.status(created ? 201 : 200);
    return row;
  }

  @Post(':contestId/submissions')
  async createSubmission(
    @Param('contestId') contestId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateSubmissionDto,
    @Res({ passthrough: true }) res: any,
  ) {
    const { submission, created } = await this.submissions.createSubmission(
      contestId,
      user,
      dto,
    );
    // New submission -> 202 (judging is async); idempotent replay -> 200.
    res.status(created ? 202 : 200);
    return submission;
  }

  @Get(':contestId/submissions')
  async listSubmissions(
    @Param('contestId') contestId: string,
    @CurrentUser() user: AuthUser,
    @Query() q: Record<string, unknown>,
  ) {
    return this.submissions.listSubmissions(contestId, user, parsePageQuery(q));
  }

  @Get(':contestId/leaderboard')
  async getLeaderboard(
    @Param('contestId') contestId: string,
    @CurrentUser() user: AuthUser,
    @Query() q: Record<string, unknown>,
  ) {
    return this.leaderboard.getLeaderboard(contestId, user, parsePageQuery(q));
  }
}
