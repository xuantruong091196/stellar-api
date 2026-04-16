import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request } from 'express';

/**
 * Query params that carry secrets and must be redacted from the access
 * log. The SSE notification stream passes its session token this way
 * because EventSource can't send headers; anyone with log access could
 * otherwise replay the token to subscribe to another user's stream.
 */
const SENSITIVE_QUERY_PARAMS = new Set([
  'token',
  'access_token',
  'api_key',
  'apikey',
  'password',
  'secret',
  'hmac',
  'code',
]);

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const { method, originalUrl } = req;
    const safeUrl = redactSensitiveQuery(originalUrl);
    const startTime = Date.now();

    return next.handle().pipe(
      tap(() => {
        const res = context.switchToHttp().getResponse();
        const duration = Date.now() - startTime;
        this.logger.log(`${method} ${safeUrl} ${res.statusCode} - ${duration}ms`);
      }),
    );
  }
}

/**
 * Replace the value of any sensitive query parameter with `[REDACTED]`.
 * Falls back to the raw URL if parsing fails (malformed input).
 */
function redactSensitiveQuery(url: string): string {
  if (!url.includes('?')) return url;
  try {
    // URL needs an origin to parse relative paths; the origin is discarded.
    const parsed = new URL(url, 'http://internal');
    let changed = false;
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.set(key, '[REDACTED]');
        changed = true;
      }
    }
    if (!changed) return url;
    return parsed.pathname + (parsed.search || '');
  } catch {
    return url;
  }
}
