import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import { AppError } from '../core/errors';
import { log } from '../core/logger';

/**
 * Maps AppError -> {error:{code,message}} with its status.
 * ValidationPipe failures -> 400 VALIDATION_ERROR.
 * Anything else -> 500 INFRA_ERROR (never leak internals).
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    const req = ctx.getRequest();
    const requestId =
      req?.requestId ??
      (typeof req?.headers?.['x-request-id'] === 'string'
        ? req.headers['x-request-id']
        : undefined);

    let status = 500;
    let code = 'INFRA_ERROR';
    let message = 'internal error';

    if (exception instanceof AppError) {
      status = exception.status;
      code = exception.code;
      message = exception.message;
    } else if (exception instanceof BadRequestException) {
      status = 400;
      code = 'VALIDATION_ERROR';
      const body = exception.getResponse() as
        | string
        | { message?: string | string[] };
      if (typeof body === 'string') message = body;
      else if (Array.isArray(body.message)) message = body.message.join('; ');
      else if (typeof body.message === 'string') message = body.message;
      else message = 'validation failed';
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = status === 404 ? 'NOT_FOUND' : 'INFRA_ERROR';
      const body = exception.getResponse() as
        | string
        | { message?: string | string[] };
      if (typeof body === 'string') message = body;
      else if (typeof body.message === 'string') message = body.message;
      else if (Array.isArray(body.message)) message = body.message.join('; ');
    }

    if (status >= 500) {
      log.error('request failed', {
        requestId,
        status,
        code,
        error: String(exception),
      });
    }
    res.status(status).json({ error: { code, message } });
  }
}
