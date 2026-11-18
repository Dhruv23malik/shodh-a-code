import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AccessService } from './access.service';
import { OrgsService } from './orgs.service';
import { ContestsService } from './contests.service';
import { ProblemsService } from './problems.service';
import { SubmissionsService } from './submissions.service';
import { LeaderboardService } from './leaderboard.service';
import { RequestIdMiddleware } from './request-id.middleware';
import {
  HealthController,
  OrgsController,
} from './orgs.controller';
import { ContestsController } from './contests.controller';
import { SubmissionsController } from './submissions.controller';

@Module({
  controllers: [
    HealthController,
    OrgsController,
    ContestsController,
    SubmissionsController,
  ],
  providers: [
    AccessService,
    OrgsService,
    ContestsService,
    ProblemsService,
    SubmissionsService,
    LeaderboardService,
  ],
})
export class ApiModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
