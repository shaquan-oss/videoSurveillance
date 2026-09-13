import type { AuthContext } from '@kh/server-core';
import { AppError, ErrorCode, type Permission } from '@kh/shared';
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSION_KEY } from '../decorators/index.ts';

/**
 * 能力守卫：读取 @RequirePermission(...) 声明的能力并校验。
 * 权限判断统一走 server-core 的规则，这里只做「有没有这个能力」的粗筛。
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSION_KEY, [context.getHandler(), context.getClass()]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<{ user?: AuthContext }>();
    const user = req.user;
    if (!user) throw new AppError(ErrorCode.UNAUTHORIZED);

    const missing = required.filter((p) => !user.permissions.includes(p as Permission));
    if (missing.length > 0) {
      throw new AppError(ErrorCode.FORBIDDEN, { message: '你没有执行该操作的权限' });
    }
    return true;
  }
}
