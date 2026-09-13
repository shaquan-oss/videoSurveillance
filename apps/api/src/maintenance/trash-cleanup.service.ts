import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { FilesService } from '../modules/files/files.service.ts';

/**
 * 回收站自动清理：定期把超过保留期（默认 7 天）的软删除文件真删。
 *
 * 用 setInterval 而不是 BullMQ：清理任务量小、用 DB 行级事务足够；
 * 引入 BullMQ 队列是为了阶段 2/3 的解析/向量化等任务，这里不重复造轮子。
 */
@Injectable()
export class TrashCleanupService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('TrashCleanup');
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(@Inject(FilesService) private readonly files: FilesService) {}

  onApplicationBootstrap(): void {
    // 启动后 30 秒跑一次（让 DB 连接、MinIO 客户端先就绪），然后每小时一次
    setTimeout(() => {
      void this.runOnce();
    }, 30 * 1000);
    const intervalMs = Number(process.env.TRASH_CLEANUP_INTERVAL_MS ?? '3600000'); // 1h
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async runOnce(): Promise<void> {
    try {
      const removed = await this.files.purgeOldTrash();
      if (removed > 0) this.logger.log(`回收站自动清理：永久删除了 ${removed} 个文件`);
    } catch (err) {
      this.logger.warn(`回收站清理失败：${(err as Error).message}`);
    }
  }
}
