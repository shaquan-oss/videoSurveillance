import { AppError, ErrorCode } from '@kh/shared';
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { SESSION_COOKIE, SessionService } from '../../modules/auth/session.service.ts';
import { IS_PUBLIC_KEY } from '../decorators/index.ts';

/**
 * 会话守卫：全局生效，可通过 @Public() 跳过。
 * 校验通过后把用户上下文挂到 request.user，后续守卫与控制器直接用。
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: unknown }>();
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (!token) {
      throw new AppError(ErrorCode.UNAUTHORIZED, { message: '请先登录' });
    }

    const ctx = await this.sessions.resolve(token);
    if (!ctx) {
      throw new AppError(ErrorCode.SESSION_EXPIRED);
    }

    req.user = ctx;
    // 每次访问续期，让活跃用户的会话不会中途失效
    await this.sessions.touch(token).catch(() => undefined);
    return true;
  }
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}
