import { Global, Module } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_TOKEN, RedisService } from './redis.service.ts';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_TOKEN,
      useFactory: () =>
        new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
          maxRetriesPerRequest: 3,
          lazyConnect: false,
          // 启动时若 Redis 未就绪，先重试几次再让进程退出（避免容器编排顺序问题）
          retryStrategy: (times) => Math.min(times * 500, 5_000),
        }),
    },
    RedisService,
  ],
  exports: [RedisService, REDIS_TOKEN],
})
export class RedisModule {}
