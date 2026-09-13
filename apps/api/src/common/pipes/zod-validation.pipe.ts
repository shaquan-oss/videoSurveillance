import { AppError, ErrorCode } from '@kh/shared';
import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * 用 shared 里的 Zod schema 做参数校验。
 * 前后端引用同一份规则，所以这里的报错信息与前端提示天然一致。
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const first = result.error.issues[0];
      const path = first?.path?.join('.') ?? '';
      const message = first?.message ?? '参数格式不正确';
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: path ? `${path}：${message}` : message,
        detail: result.error.issues.slice(0, 5),
      });
    }
    return result.data;
  }
}

/** 便捷工厂：new ZodBody(schema) */
export function zodPipe<T>(schema: ZodType<T>): ZodValidationPipe<T> {
  return new ZodValidationPipe<T>(schema);
}
