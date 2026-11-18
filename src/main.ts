import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './api/http-exception.filter';
import { migrate } from './db/migrate';
import { log } from './core/logger';

async function bootstrap(): Promise<void> {
  // Run migrations on boot (safe to run concurrently; advisory lock).
  const applied = await migrate();
  log.info('migrations applied', { applied });
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  log.info('api listening', { port });
}

bootstrap().catch((err) => {
  log.error('boot failed', { error: String(err) });
  process.exit(1);
});
