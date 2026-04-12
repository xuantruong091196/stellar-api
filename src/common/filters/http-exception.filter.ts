import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

/**
 * Global exception filter — ensures ALL errors return a consistent format:
 * { status: number, message: string, error: string }
 *
 * No more raw NestJS stack traces or Prisma error codes leaking to clients.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let error = 'Internal Server Error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exResponse = exception.getResponse();

      if (typeof exResponse === 'string') {
        message = exResponse;
      } else if (typeof exResponse === 'object' && exResponse !== null) {
        const r = exResponse as Record<string, unknown>;
        message = (r.message as string) || exception.message;
        error = (r.error as string) || exception.name;

        // NestJS validation pipe returns message as array
        if (Array.isArray(r.message)) {
          message = (r.message as string[]).join('; ');
        }
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      error = exception.name || 'Error';

      // Prisma-specific: foreign key constraint
      if (message.includes('Foreign key constraint') || message.includes('P2003')) {
        status = HttpStatus.CONFLICT;
        message = 'Cannot delete: this item is referenced by other records. Remove dependent items first.';
        error = 'Conflict';
      }

      // Prisma: record not found
      if (message.includes('Record to update not found') || message.includes('P2025')) {
        status = HttpStatus.NOT_FOUND;
        message = 'Record not found';
        error = 'Not Found';
      }

      // Prisma: unique constraint
      if (message.includes('Unique constraint') || message.includes('P2002')) {
        status = HttpStatus.CONFLICT;
        message = 'A record with this value already exists';
        error = 'Conflict';
      }
    }

    // Log server errors (5xx)
    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} → ${status}: ${message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(
        `${request.method} ${request.url} → ${status}: ${message}`,
      );
    }

    response.status(status).json({
      status,
      message,
      error,
    });
  }
}
