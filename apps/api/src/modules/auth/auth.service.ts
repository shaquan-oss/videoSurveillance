import { type AuthContext, type DbHandle, schema, verifyPassword } from '@kh/server-core';
import { AppError, ErrorCode, type Permission, type User } from '@kh/shared';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB_TOKEN } from '../../database/database.module.ts';
import { SessionService } from './session.service.ts';

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB_TOKEN) private readonly handle: DbHandle,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  private get db() {
    return this.handle.db;
  }

  async login(account: string, password: string): Promise<{ user: User; token: string; expiresInSec: number }> {
    const rows = await this.db.select().from(schema.users).where(eq(schema.users.account, account)).limit(1);
    const row = rows[0];

    // 账号不存在时也走一次哈希校验，避免通过响应时间判断账号是否存在
    const stored = row?.passwordHash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA';
    const ok = await verifyPassword(password, stored);

    if (!row || !ok) {
      throw new AppError(ErrorCode.LOGIN_FAILED);
    }
    if (!row.isActive || row.deletedAt) {
      throw new AppError(ErrorCode.ACCOUNT_DISABLED);
    }

    const { token, expiresInSec } = await this.sessions.create(row.id, row.account);
    await this.db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, row.id));

    const ctx = await this.sessions.resolve(token);
    const user = await this.toUser(row.id, row.departmentId, ctx?.permissions ?? []);
    return { user, token, expiresInSec };
  }

  async logout(token: string): Promise<void> {
    await this.sessions.destroy(token);
  }

  async me(ctx: AuthContext): Promise<User> {
    const rows = await this.db.select().from(schema.users).where(eq(schema.users.id, ctx.userId)).limit(1);
    const row = rows[0];
    if (!row) throw new AppError(ErrorCode.UNAUTHORIZED);
    return this.toUser(row.id, row.departmentId, ctx.permissions);
  }

  private async toUser(userId: string, departmentId: string | null, permissions: Permission[]): Promise<User> {
    const rows = await this.db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    const row = rows[0];
    if (!row) throw new AppError(ErrorCode.NOT_FOUND);

    let departmentName: string | null = null;
    if (departmentId) {
      const d = await this.db.select().from(schema.departments).where(eq(schema.departments.id, departmentId)).limit(1);
      departmentName = d[0]?.name ?? null;
    }

    const roleRows = await this.db.select().from(schema.userRoles).where(eq(schema.userRoles.userId, userId));
    const roleNames: string[] = [];
    const roleIds: string[] = [];
    for (const ur of roleRows) {
      roleIds.push(ur.roleId);
      const r = await this.db.select().from(schema.roles).where(eq(schema.roles.id, ur.roleId)).limit(1);
      if (r[0]) roleNames.push(r[0].name);
    }

    return {
      id: row.id,
      account: row.account,
      name: row.name,
      departmentId: row.departmentId,
      departmentName,
      email: row.email,
      phone: row.phone,
      roleIds,
      roleNames,
      permissions,
      isActive: row.isActive,
      createdAt: row.createdAt.toISOString(),
      lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
      avatarText: row.name.slice(0, 1),
    };
  }
}
