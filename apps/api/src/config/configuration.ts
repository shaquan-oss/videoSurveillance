/**
 * 配置集中在这里读取与校验。
 * 启动时若缺少必需变量会直接失败 —— 让问题在启动时暴露，而不是在用户点下按钮时。
 */

export interface AppConfig {
  env: string;
  apiPort: number;
  corsOrigins: string[];
  sessionSecret: string;
  sessionTtlHours: number;
  databaseUrl: string;
  redisUrl: string;
  maxUploadBytes: number;
  chunkSizeBytes: number;
  modelTimeoutMs: number;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`缺少必需的环境变量 ${name}。请检查仓库根目录的 .env 文件。`);
  }
  return v;
}

function toInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`环境变量 ${name} 应为数字，当前值：${v}`);
  return n;
}

export function loadConfig(): AppConfig {
  const sessionSecret = required('SESSION_SECRET');
  if (sessionSecret.length < 16) {
    throw new Error('SESSION_SECRET 太短，请使用至少 32 位随机串（openssl rand -hex 32）');
  }

  return {
    env: process.env.NODE_ENV ?? 'development',
    apiPort: toInt('API_PORT', 3001),
    corsOrigins: (process.env.CORS_ORIGINS ?? 'http://127.0.0.1:3000,http://localhost:3000')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    sessionSecret,
    sessionTtlHours: toInt('SESSION_TTL_HOURS', 12),
    databaseUrl: required('DATABASE_URL'),
    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    maxUploadBytes: toInt('MAX_UPLOAD_MB', 200) * 1024 * 1024,
    chunkSizeBytes: toInt('CHUNK_SIZE_MB', 5) * 1024 * 1024,
    modelTimeoutMs: toInt('MODEL_TIMEOUT_MS', 60_000),
  };
}

export const CONFIG_TOKEN = 'APP_CONFIG';
