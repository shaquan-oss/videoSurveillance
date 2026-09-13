import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type Redis from 'ioredis';

export const REDIS_TOKEN = 'REDIS_CLIENT';

/**
 * Redis 客户端。
 * 用途：登录会话、限流计数、以及供 worker 消费的任务队列。
 */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  constructor(@Inject(REDIS_TOKEN) private readonly client: Redis) {}

  get raw(): Redis {
    return this.client;
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async setEx(key: string, ttlSeconds: number, value: string): Promise<void> {
    await this.client.set(key, value, 'EX', ttlSeconds);
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length) await this.client.del(...keys);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.client.exists(key)) === 1;
  }

  /** 自增并设置过期，用于简单的限流 */
  async incrWithTtl(key: string, ttlSeconds: number): Promise<number> {
    const n = await this.client.incr(key);
    if (n === 1) await this.client.expire(key, ttlSeconds);
    return n;
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }
}
