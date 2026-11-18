import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { AuthUser } from '../core/types';
import { CurrentUser } from '../auth/current-user.decorator';
import { SubmissionsService } from './submissions.service';
import { RejudgeDto } from './dto';

@Controller('submissions')
export class SubmissionsController {
  constructor(private submissions: SubmissionsService) {}

  @Get(':submissionId')
  async getSubmission(
    @Param('submissionId') submissionId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.submissions.getSubmission(submissionId, user);
  }

  @Post(':submissionId/rejudge')
  async rejudge(
    @Param('submissionId') submissionId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: RejudgeDto,
  ) {
    return this.submissions.rejudge(submissionId, user, dto);
  }
}
