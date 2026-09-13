import type { AuthContext } from '@kh/server-core';
import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';

/** 标记接口无需登录（登录接口本身、健康检查） */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** 声明接口所需能力，由 PermissionGuard 校验 */
export const PERMISSION_KEY = 'requiredPermissions';
export const RequirePermission = (...permissions: string[]) => SetMetadata(PERMISSION_KEY, permissions);

/** 取当前登录用户（含权限），由 SessionGuard 挂到 request 上 */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<{ user?: AuthContext }>();
  if (!req.user) {
    throw new Error('CurrentUser 只能用于已通过 SessionGuard 的接口');
  }
  return req.user;
});

/** 取请求追踪 ID，写入审计与日志 */
export const RequestId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<{ requestId?: string }>();
  return req.requestId ?? '';
});

/** 取客户端信息，用于审计 */
export const ClientInfo = createParamDecorator((_data: unknown, ctx: ExecutionContext): { ip: string; userAgent: string } => {
  const req = ctx.switchToHttp().getRequest<{
    ip?: string;
    headers: Record<string, string | undefined>;
    socket?: { remoteAddress?: string };
  }>();
  const forwarded = req.headers['x-forwarded-for'];
  const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined) ?? req.ip ?? req.socket?.remoteAddress ?? '';
  return { ip, userAgent: (req.headers['user-agent'] ?? '').slice(0, 255) };
});
