import type { ApiResponse } from '@kh/shared';
import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { map, type Observable } from 'rxjs';

/**
 * 统一响应结构：{ success, data, error, requestId }
 * 所有接口返回一致外形，前端只需要写一套处理逻辑。
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiResponse<T>> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiResponse<T>> {
    const req = context.switchToHttp().getRequest<Request & { requestId?: string }>();
    const requestId = req?.requestId;

    return next.handle().pipe(
      map((data) => ({
        success: true,
        data: data ?? null,
        error: null,
        ...(requestId ? { requestId } : {}),
      })),
    );
  }
}
