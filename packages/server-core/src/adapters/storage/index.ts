import type { StorageAdapter } from '@kh/shared';
import { ensureAllBuckets, S3StorageAdapter, type S3StorageOptions } from './s3-storage.adapter.ts';

let instance: StorageAdapter | null = null;

/** 从环境变量装配存储适配器（换存储供应商时只改 .env） */
export function createStorageFromEnv(): StorageAdapter {
  const opts: S3StorageOptions = {
    endpoint: required('S3_ENDPOINT'),
    region: process.env.S3_REGION ?? 'us-east-1',
    accessKey: required('S3_ACCESS_KEY'),
    secretKey: required('S3_SECRET_KEY'),
    bucket: process.env.S3_BUCKET_ORIGINALS ?? 'originals',
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') !== 'false',
    presignTtlSec: Number(process.env.S3_PRESIGN_TTL_SEC ?? '600'),
  };
  return new S3StorageAdapter(opts);
}

export function getStorage(): StorageAdapter {
  if (!instance) instance = createStorageFromEnv();
  return instance;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`缺少环境变量 ${name}`);
  return v;
}

export type { S3StorageOptions };
export { ensureAllBuckets, S3StorageAdapter };
