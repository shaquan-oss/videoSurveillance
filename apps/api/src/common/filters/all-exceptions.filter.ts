import { type ApiResponse, AppError, ERROR_MESSAGE, ErrorCode } from '@kh/shared';
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * 统一异常处理。
 * 原则：对外的响应里绝不出现 SQL 报错、堆栈、内网地址这类内部细节。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { requestId?: string }>();
    const requestId = req?.requestId;

    let status = 500;
    let code: string = ErrorCode.INTERNAL;
    let message = ERROR_MESSAGE[ErrorCode.INTERNAL]!;
    let detail: unknown;

    if (AppError.isAppError(exception)) {
      status = exception.status;
      code = exception.code;
      message = exception.message;
      detail = exception.expose ? exception.detail : undefined;
      if (!exception.expose) {
        this.logger.error(`[${requestId}] ${exception.code} ${req?.method} ${req?.url} — ${exception.message}`, exception.stack);
      }
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      const raw = typeof body === 'string' ? body : ((body as { message?: unknown }).message ?? '');
      message = Array.isArray(raw) ? String(raw[0]) : String(raw || message);
      code = statusToCode(status);
    } else {
      // 未预期的异常：完整写日志，对外只给一句通用提示
      this.logger.error(`[${requestId}] 未处理异常 ${req?.method} ${req?.url}`, exception as Error);
    }

    const payload: ApiResponse<never> = {
      success: false,
      data: null,
      error: { code, message, ...(detail !== undefined ? { detail } : {}) },
      ...(requestId ? { requestId } : {}),
    };

    res.status(status).json(payload);
  }
}

function statusToCode(status: number): string {
  switch (status) {
    case 400:
      return ErrorCode.BAD_REQUEST;
    case 401:
      return ErrorCode.UNAUTHORIZED;
    case 403:
      return ErrorCode.FORBIDDEN;
    case 404:
      return ErrorCode.NOT_FOUND;
    case 409:
      return ErrorCode.CONFLICT;
    case 429:
      return ErrorCode.RATE_LIMITED;
    default:
      return ErrorCode.INTERNAL;
  }
}
