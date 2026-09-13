import { ensureAllBuckets } from '@kh/server-core';
import { Global, Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';

/**
 * 存储启动引导。
 *
 * 做一件很小但很值钱的事：应用启动时把 .env 里声明的桶都建出来。
 * 这样在全新环境部署时不会再出现「服务起来了但对象存储不可用」——
 * 那个问题通常要等到用户第一次上传文件才暴露，排查一次要花不少时间。
 */
@Global()
@Module({})
export class StorageModule implements OnApplicationBootstrap {
  private readonly logger = new Logger('Storage');

  async onApplicationBootstrap(): Promise<void> {
    const endpoint = process.env.S3_ENDPOINT;
    const accessKey = process.env.S3_ACCESS_KEY;
    const secretKey = process.env.S3_SECRET_KEY;

    if (!endpoint || !accessKey || !secretKey) {
      this.logger.warn('未配置对象存储（S3_ENDPOINT / S3_ACCESS_KEY / S3_SECRET_KEY），跳过桶初始化');
      return;
    }

    const buckets = [
      process.env.S3_BUCKET_ORIGINALS,
      process.env.S3_BUCKET_DERIVED,
      process.env.S3_BUCKET_SKILLS,
      process.env.S3_BUCKET_EXPORTS,
    ].filter((b): b is string => !!b);

    try {
      const { created, existing } = await ensureAllBuckets({
        endpoint,
        region: process.env.S3_REGION ?? 'us-east-1',
        accessKey,
        secretKey,
        buckets,
        forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') !== 'false',
      });

      if (created.length) this.logger.log(`已创建存储桶：${created.join(', ')}`);
      if (existing.length) this.logger.log(`存储桶已存在：${existing.join(', ')}`);
    } catch (err) {
      // 不阻断启动：存储暂时不可用时，接口服务仍应能起来并提供登录、模型清单等能力，
      // 否则一个依赖没就绪就会让整个系统不可用，运维排查时也更难判断问题在哪一层。
      this.logger.error(`存储桶初始化失败（服务继续启动）：${(err as Error).message}`);
    }
  }
}
