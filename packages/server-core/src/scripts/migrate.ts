import 'dotenv/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const { Pool } = pg;
const here = dirname(fileURLToPath(import.meta.url));

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('缺少 DATABASE_URL，请先复制 .env.example 为 .env');
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const db = drizzle(pool);

async function main() {
  console.log('▸ 连接数据库…');
  await db.execute(sql`SELECT 1`);
  console.log('  连接成功');

  // 1) 扩展必须在建表之前装好，因为 chunks 表用到 vector 类型
  console.log('▸ 安装扩展…');
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  const ext = await db.execute(sql`
    SELECT extname, extversion FROM pg_extension WHERE extname IN ('vector','pg_trgm') ORDER BY extname
  `);
  for (const row of ext.rows as { extname: string; extversion: string }[]) {
    console.log(`  ${row.extname} v${row.extversion}`);
  }

  // 2) 应用迁移文件
  console.log('▸ 应用迁移…');
  const folder = resolve(here, '../database/migrations');
  try {
    await migrate(db, { migrationsFolder: folder });
    console.log('  迁移已应用（无变更时会跳过）');
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('No migrations')) {
      console.log('  没有迁移文件，请先运行 pnpm db:generate');
    } else {
      throw err;
    }
  }

  // 3) 迁移之后才能建的索引：
  //    HNSW 用于向量近邻检索；gin_trgm 用于中文关键词兜底检索
  console.log('▸ 创建检索索引…');
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw
    ON chunks USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS chunks_content_trgm
    ON chunks USING gin (content gin_trgm_ops)
  `);
  console.log('  chunks_embedding_hnsw / chunks_content_trgm 就绪');

  // 4) 列出结果，便于确认
  const tables = await db.execute(sql`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
  `);
  console.log('▸ 当前数据表：');
  console.log('  ' + (tables.rows as { tablename: string }[]).map((r) => r.tablename).join(', '));

  await pool.end();
  console.log('\n完成。');
}

main().catch(async (err) => {
  console.error('迁移失败：', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
