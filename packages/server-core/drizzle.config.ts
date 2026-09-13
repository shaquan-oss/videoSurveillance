import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

// 配置集中在仓库根目录的 .env，这里显式指定，避免因工作目录不同而读不到
config({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env'),
});

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/database/schema/index.ts',
  out: './src/database/migrations',
  dialect: 'postgresql',
  casing: 'snake_case',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://khub:khub_dev_pwd@127.0.0.1:5432/knowledge_hub',
  },
  verbose: true,
  strict: false,
});
