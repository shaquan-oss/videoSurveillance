import { closeDb, createDb, type DbHandle } from '@kh/server-core';
import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';

export const DB_TOKEN = 'DATABASE_HANDLE';

/**
 * 数据库模块：全应用共用一个连接池。
 * 标记为 @Global，业务模块直接注入，不必每个模块都 import。
 */
@Global()
@Module({
  providers: [
    {
      provide: DB_TOKEN,
      useFactory: (): DbHandle => {
        const url = process.env.DATABASE_URL;
        if (!url) throw new Error('缺少 DATABASE_URL');
        return createDb(url);
      },
    },
  ],
  exports: [DB_TOKEN],
})
export class DatabaseModule implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    // 优雅关闭：先停止接单，再断开数据库连接
    await closeDb().catch(() => undefined);
  }
}
