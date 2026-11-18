/**
 * API test bootstrap helper.
 *
 * Agent A's src/main.ts has no exported factory (bootstrap() only), so the
 * tests build the app the same way main.ts does: NestFactory.create(AppModule)
 * + the same global ValidationPipe and HttpExceptionFilter, then init()
 * without listening. Supertest drives the in-memory server.
 *
 * Requires a reachable PostgreSQL at DATABASE_URL (the app's pool connects
 * on first query) and the seed data from scripts/seed.ts.
 */
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { HttpExceptionFilter } from '../../src/api/http-exception.filter';

export async function createTestApp(): Promise<any> {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  return app;
}
