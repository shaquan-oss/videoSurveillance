import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppError, ErrorCode, type ReadableBody, type StorageAdapter } from '@kh/shared';

export interface S3StorageOptions {
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  forcePathStyle?: boolean;
  /** 预签名链接默认有效期（秒），建议 5~10 分钟 */
  presignTtlSec?: number;
}

/**
 * 基于 S3 协议的存储实现。
 *
 * 为什么只写这一个实现：MinIO（自购服务器）、移动云 EOS、阿里云 OSS、
 * 腾讯云 COS 都兼容 S3 协议，所以换存储供应商时不用改代码，只改 .env 里的端点与密钥。
 */
export class S3StorageAdapter implements StorageAdapter {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly presignTtlSec: number;
  private bucketReady = false;

  constructor(opts: S3StorageOptions) {
    this.bucket = opts.bucket;
    this.presignTtlSec = opts.presignTtlSec ?? 600;
    this.client = new S3Client({
      endpoint: opts.endpoint,
      region: opts.region,
      credentials: {
        accessKeyId: opts.accessKey,
        secretAccessKey: opts.secretKey,
      },
      // MinIO 与移动云 EOS 都需要 path-style 寻址
      forcePathStyle: opts.forcePathStyle ?? true,
    });
  }

  async ensureBucket(): Promise<void> {
    if (this.bucketReady) return;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      this.bucketReady = true;
      return;
    } catch (err: unknown) {
      const name = (err as { name?: string }).name;
      // 桶不存在时创建；其它错误（如权限不足）交给下面抛
      if (name !== 'NotFound' && name !== 'NoSuchBucket') {
        // 部分实现返回 404 而非 NotFound
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status !== 404) throw err;
      }
    }
    await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    this.bucketReady = true;
  }

  async put(key: string, body: ReadableBody, contentType?: string): Promise<void> {
    await this.ensureBucket();
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body as never,
          ContentType: contentType ?? 'application/octet-stream',
        }),
      );
    } catch (err) {
      throw new AppError(ErrorCode.STORAGE_WRITE_FAILED, {
        detail: (err as Error).message,
        expose: false,
      });
    }
  }

  async get(key: string): Promise<Uint8Array> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new AppError(ErrorCode.FILE_NOT_FOUND);
    const bytes = await res.Body.transformToByteArray();
    return bytes;
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /**
   * 签发临时访问链接 —— 文件下载的唯一出口。
   * 后端先校验权限，再签发短时效链接，浏览器凭链接直取，
   * 文件流不经过后端，避免下载把服务的内存与带宽压住。
   */
  async presignGet(
    key: string,
    expiresInSec?: number,
    downloadName?: string,
    disposition: 'inline' | 'attachment' = 'attachment',
  ): Promise<string> {
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(downloadName
        ? {
            // inline：浏览器直接渲染（图片/PDF/文本/视频预览）；attachment：强制下载
            ResponseContentDisposition: `${disposition}; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
          }
        : {}),
    });
    return getSignedUrl(this.client, cmd, {
      expiresIn: expiresInSec ?? this.presignTtlSec,
    });
  }

  /**
   * 存储健康。会先确保桶存在 ——
   * 这样在一台全新机器上首次部署时，健康检查会自动把桶建好，
   * 不需要人工登录 MinIO 控制台手工创建（这是很容易漏掉的一步）。
   */
  async health(): Promise<{
    ok: boolean;
    usedBytes?: number;
    latencyMs?: number;
    message?: string;
  }> {
    const started = Date.now();
    try {
      await this.ensureBucket();
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `桶「${this.bucket}」不可用：${(err as Error).message}`,
      };
    }
  }
}

/**
 * 按 .env 里的 S3_BUCKET_* 声明，把所有桶都建出来。
 * 应用启动时调用一次，让「换一台机器部署」少一个手工步骤。
 * 已存在的桶会被跳过，重复执行安全。
 */
export async function ensureAllBuckets(opts: {
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  buckets: string[];
  forcePathStyle?: boolean;
}): Promise<{ created: string[]; existing: string[] }> {
  const client = new S3Client({
    endpoint: opts.endpoint,
    region: opts.region,
    credentials: {
      accessKeyId: opts.accessKey,
      secretAccessKey: opts.secretKey,
    },
    forcePathStyle: opts.forcePathStyle ?? true,
  });

  const created: string[] = [];
  const existing: string[] = [];

  for (const bucket of opts.buckets) {
    if (!bucket) continue;
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      existing.push(bucket);
      continue;
    } catch (err: unknown) {
      const name = (err as { name?: string }).name;
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      const missing = name === 'NotFound' || name === 'NoSuchBucket' || status === 404;
      if (!missing) throw err;
    }
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    created.push(bucket);
  }

  return { created, existing };
}
