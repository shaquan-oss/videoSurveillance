import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.ts';

const { Pool } = pg;

export type Database = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  pool: pg.Pool;
  close: () => Promise<void>;
}

let cached: DbHandle | null = null;

/**
 * 创建数据库连接（连接池）。
 * 连接池大小按几十人规模配置：10 个连接足够，避免压垮 Postgres。
 */
export function createDb(connectionString: string, options?: { max?: number }): DbHandle {
  const pool = new Pool({
    connectionString,
    max: options?.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
  });

  const db = drizzle(pool, { schema, casing: 'snake_case' });

  return {
    db,
    pool,
    close: async () => {
      await pool.end();
    },
  };
}

/** 单例获取（服务内复用同一个连接池） */
export function getDb(connectionString?: string): DbHandle {
  if (cached) return cached;
  const url = connectionString ?? process.env.DATABASE_URL;
  if (!url) throw new Error('缺少 DATABASE_URL 环境变量');
  cached = createDb(url);
  return cached;
}

export async function closeDb(): Promise<void> {
  if (cached) {
    await cached.close();
    cached = null;
  }
}

export { schema };
export type Schema = typeof schema;
