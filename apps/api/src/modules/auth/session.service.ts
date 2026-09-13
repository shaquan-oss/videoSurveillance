import { createHash, randomBytes } from 'node:crypto';
import { type AuthContext, type DbHandle, schema } from '@kh/server-core';
import type { Permission } from '@kh/shared';
import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { DB_TOKEN } from '../../database/database.module.ts';
import { RedisService } from '../../redis/redis.service.ts';

export const SESSION_COOKIE = 'khub_session';

interface SessionPayload {
  userId: string;
  account: string;
  createdAt: string;
}

/**
 * 登录会话。
 *
 * 两个设计决定：
 * 1. 会话存 Redis 而不是 Cookie 里塞 JWT —— 这样可以做到「管理员把某人停用后，其会话立即失效」
 * 2. 权限每次请求都从数据库重新加载，不缓存在会话里 —— 权限一改立即生效，
 *    避免「刚收回权限但他还能看」这种最尴尬的情况
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(DB_TOKEN) private readonly handle: DbHandle,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  private get db() {
    return this.handle.db;
  }

  private key(token: string): string {
    // 存哈希而不是明文 token：即使 Redis 被看到，也无法直接用来冒充登录
    return `khub:sess:${createHash('sha256').update(token).digest('hex')}`;
  }

  private ttlSeconds(): number {
    const hours = Number(process.env.SESSION_TTL_HOURS ?? '12');
    return Math.max(1, hours) * 3600;
  }

  async create(userId: string, account: string): Promise<{ token: string; expiresInSec: number }> {
    const token = randomBytes(32).toString('base64url');
    const payload: SessionPayload = { userId, account, createdAt: new Date().toISOString() };
    const ttl = this.ttlSeconds();
    await this.redis.setEx(this.key(token), ttl, JSON.stringify(payload));
    return { token, expiresInSec: ttl };
  }

  async destroy(token: string): Promise<void> {
    await this.redis.del(this.key(token));
  }

  /** 用 token 换取用户上下文（含权限）。返回 null 表示会话无效或已被停用 */
  async resolve(token: string): Promise<AuthContext | null> {
    const raw = await this.redis.get(this.key(token));
    if (!raw) return null;

    let payload: SessionPayload;
    try {
      payload = JSON.parse(raw) as SessionPayload;
    } catch {
      return null;
    }

    const users = await this.db.select().from(schema.users).where(eq(schema.users.id, payload.userId)).limit(1);
    const user = users[0];
    if (!user || !user.isActive || user.deletedAt) return null;

    const permissions = await this.loadPermissions(user.id);
    return { userId: user.id, userName: user.name, departmentId: user.departmentId, permissions };
  }

  private async loadPermissions(userId: string): Promise<Permission[]> {
    const rows = await this.db.select().from(schema.userRoles).where(eq(schema.userRoles.userId, userId));
    if (rows.length === 0) return [];
    const roleIds = rows.map((r) => r.roleId);
    const roleRows = await this.db.select().from(schema.roles).where(inArray(schema.roles.id, roleIds));
    const set = new Set<string>();
    for (const r of roleRows) {
      for (const p of r.permissions ?? []) set.add(p);
    }
    return [...set] as Permission[];
  }

  /** 续期：用户有操作时自动延长会话，避免写着东西突然被登出 */
  async touch(token: string): Promise<void> {
    await this.redis.raw.expire(this.key(token), this.ttlSeconds());
  }
}
