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
      const rawMessage = exception.message;
      // Prisma error code can live on `exception.code` for PrismaClientKnownRequestError.
      const prismaCode = (exception as { code?: string }).code;

      // Prisma-specific: foreign key constraint
      if (prismaCode === 'P2003' || rawMessage.includes('Foreign key constraint')) {
        status = HttpStatus.CONFLICT;
        message = 'Cannot delete: this item is referenced by other records. Remove dependent items first.';
        error = 'Conflict';
      } else if (prismaCode === 'P2025' || rawMessage.includes('Record to update not found')) {
        // Prisma: record not found
        status = HttpStatus.NOT_FOUND;
        message = 'Record not found';
        error = 'Not Found';
      } else if (prismaCode === 'P2002' || rawMessage.includes('Unique constraint')) {
        // Prisma: unique constraint
        status = HttpStatus.CONFLICT;
        message = 'A record with this value already exists';
        error = 'Conflict';
      } else {
        // Unknown internal error — do NOT leak the raw message to the
        // client. Return a generic 500 and log the real details for ops.
        status = HttpStatus.INTERNAL_SERVER_ERROR;
        message = 'Internal server error';
        error = 'Internal Server Error';
      }
    }

    // Log server errors (5xx) with the real details; log 4xx at warn level.
    const logLine = `${request.method} ${request.url} → ${status}: ${
      exception instanceof Error ? exception.message : String(exception)
    }`;
    if (status >= 500) {
      this.logger.error(
        logLine,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(logLine);
    }

    response.status(status).json({
      status,
      message,
      error,
    });
  }
}
