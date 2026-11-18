import { Injectable, NestMiddleware } from '@nestjs/common';
import { newRequestId } from '../core/logger';

/** Accepts X-Request-Id or generates one; echoes it on the response. */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: any, res: any, next: () => void): void {
    const incoming = req.headers?.['x-request-id'];
    const id =
      typeof incoming === 'string' && incoming.length > 0
        ? incoming
        : newRequestId();
    req.requestId = id;
    res.setHeader('X-Request-Id', id);
    next();
  }
}
