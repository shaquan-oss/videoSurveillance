import type { AuthContext } from '@kh/server-core';
import { type LoginInput, loginSchema } from '@kh/shared';
import { Body, Controller, Get, Headers, Inject, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, Public, RequestId } from '../../common/decorators/index.ts';
import { readCookie } from '../../common/guards/session.guard.ts';
import { zodPipe } from '../../common/pipes/zod-validation.pipe.ts';
import { AuditService } from '../audit/audit.service.ts';
import { AuthService } from './auth.service.ts';
import { SESSION_COOKIE, SessionService } from './session.service.ts';

@ApiTags('认证')
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Public()
  @Post('login')
  @ApiOperation({ summary: '登录' })
  async login(
    @Body(zodPipe(loginSchema)) body: LoginInput,
    @Res({ passthrough: true }) res: Response,
    @Headers('user-agent') userAgent: string,
    @Headers('x-forwarded-for') forwarded: string,
  ) {
    try {
      const { user, token, expiresInSec } = await this.auth.login(body.account, body.password);
      res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        // 生产环境走 HTTPS 时必须开启 secure
        secure: (process.env.NODE_ENV ?? 'development') === 'production',
        maxAge: expiresInSec * 1000,
        path: '/',
      });
      await this.audit.write({
        action: 'auth.login',
        actorId: user.id,
        actorName: user.name,
        ip: forwarded,
        userAgent,
        success: true,
      });
      return { user, expiresInSec };
    } catch (err) {
      await this.audit.write({
        action: 'auth.login_failed',
        actorName: body.account,
        ip: forwarded,
        userAgent,
        success: false,
        detail: { reason: (err as Error).message },
      });
      throw err;
    }
  }

  @Public()
  @Post('logout')
  @ApiOperation({ summary: '退出登录' })
  async logout(
    @Headers('cookie') cookie: string | undefined,
    @Res({ passthrough: true }) res: Response,
    @CurrentUser() user?: AuthContext,
  ) {
    const token = readCookie(cookie, SESSION_COOKIE);
    if (token) await this.sessions.destroy(token);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    if (user) {
      await this.audit.write({
        action: 'auth.logout',
        actorId: user.userId,
        actorName: user.userName,
        success: true,
      });
    }
    return { ok: true };
  }

  @Get('me')
  @ApiOperation({ summary: '当前登录用户与权限' })
  async me(@CurrentUser() ctx: AuthContext) {
    return this.auth.me(ctx);
  }
}
