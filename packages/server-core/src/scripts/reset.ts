import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('缺少 DATABASE_URL');
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const db = drizzle(pool);

/**
 * 开发环境专用：清空所有业务表（保留结构与扩展）。
 * 生产环境禁止执行 —— 这里有一道显式确认。
 */
async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('生产环境禁止执行重置');
    process.exit(1);
  }
  if (process.env.CONFIRM_RESET !== 'yes') {
    console.error('这会清空所有业务数据。确认请加环境变量：CONFIRM_RESET=yes');
    process.exit(1);
  }

  console.log('▸ 清空业务表…');
  await db.execute(sql`
    TRUNCATE TABLE
      notifications, audit_logs, messages, conversations,
      chunks, kb_folders, knowledge_bases,
      upload_sessions, file_versions, files, folders,
      user_roles, roles, users, departments
    RESTART IDENTITY CASCADE
  `);
  console.log('  完成（表结构保留）');
  await pool.end();
}

main().catch(async (err) => {
  console.error('重置失败：', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
