import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { ALL_PERMISSIONS, BUILTIN_ROLES, PERMISSIONS, type Permission } from '@kh/shared';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '../database/schema/index.ts';
import { hashPassword } from '../utils/password.ts';

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('缺少 DATABASE_URL');
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const db = drizzle(pool, { schema, casing: 'snake_case' });

/** 管理员初始密码 —— 首次登录后请立即修改 */
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'Admin@2026';
const DEMO_PASSWORD = 'Test@2026';

async function main() {
  console.log('▸ 写入初始数据…');

  /* ── 1. 部门 ── */
  const deptDefs = [
    { key: 'hq', name: '综合部', maxSecurityLevel: 'private' as const },
    { key: 'tech', name: '技术部', maxSecurityLevel: 'internal' as const },
    { key: 'finance', name: '财务部', maxSecurityLevel: 'department' as const },
    { key: 'market', name: '市场部', maxSecurityLevel: 'internal' as const },
  ];

  const deptIds: Record<string, string> = {};
  for (const [i, d] of deptDefs.entries()) {
    const existed = await db.select().from(schema.departments).where(eq(schema.departments.name, d.name)).limit(1);
    if (existed[0]) {
      deptIds[d.key] = existed[0].id;
      continue;
    }
    const id = randomUUID();
    await db.insert(schema.departments).values({
      id,
      name: d.name,
      parentId: null,
      maxSecurityLevel: d.maxSecurityLevel,
      sortOrder: i * 10,
    });
    deptIds[d.key] = id;
  }
  console.log(`  部门 ${deptDefs.length} 个`);

  /* ── 2. 角色与能力 ── */
  const allPerms = ALL_PERMISSIONS as Permission[];
  const roleDefs: {
    key: string;
    name: string;
    description: string;
    permissions: string[];
  }[] = [
    {
      key: BUILTIN_ROLES.SYSTEM_ADMIN,
      name: '系统管理员',
      description: '拥有全部能力，负责人员、权限、模型与系统设置',
      permissions: allPerms,
    },
    {
      key: BUILTIN_ROLES.KB_ADMIN,
      name: '知识库管理员',
      description: '管理知识库内容与检索策略，可跨部门检索',
      permissions: [
        PERMISSIONS.FILE_UPLOAD,
        PERMISSIONS.FILE_DOWNLOAD,
        PERMISSIONS.FILE_DELETE,
        PERMISSIONS.FILE_SECURITY_SET,
        PERMISSIONS.KB_VIEW,
        PERMISSIONS.KB_CROSS_DEPT_SEARCH,
        PERMISSIONS.KB_INGEST,
        PERMISSIONS.KB_MANAGE,
        PERMISSIONS.AGENT_USE,
        PERMISSIONS.AGENT_CREATE,
        PERMISSIONS.SKILL_UPLOAD,
        PERMISSIONS.ANALYTICS_VIEW,
      ],
    },
    {
      key: BUILTIN_ROLES.DEPT_MANAGER,
      name: '部门主管',
      description: '可见本部门全部文件，可审核本部门成员的权限申请',
      permissions: [
        PERMISSIONS.FILE_UPLOAD,
        PERMISSIONS.FILE_DOWNLOAD,
        PERMISSIONS.FILE_DELETE,
        PERMISSIONS.FILE_SECURITY_SET,
        PERMISSIONS.KB_VIEW,
        PERMISSIONS.KB_INGEST,
        PERMISSIONS.AGENT_USE,
        PERMISSIONS.AGENT_CREATE,
        PERMISSIONS.KB_APPLY_PERMISSION,
      ],
    },
    {
      key: BUILTIN_ROLES.MEMBER,
      name: '普通成员',
      description: '上传下载自己的文件，检索有权限的知识库',
      permissions: [
        PERMISSIONS.FILE_UPLOAD,
        PERMISSIONS.FILE_DOWNLOAD,
        PERMISSIONS.KB_VIEW,
        PERMISSIONS.AGENT_USE,
        PERMISSIONS.KB_APPLY_PERMISSION,
      ],
    },
  ];

  const roleIds: Record<string, string> = {};
  for (const r of roleDefs) {
    const existed = await db.select().from(schema.roles).where(eq(schema.roles.key, r.key)).limit(1);
    if (existed[0]) {
      await db.update(schema.roles).set({ permissions: r.permissions, updatedAt: new Date() }).where(eq(schema.roles.id, existed[0].id));
      roleIds[r.key] = existed[0].id;
      continue;
    }
    const id = randomUUID();
    await db.insert(schema.roles).values({
      id,
      key: r.key,
      name: r.name,
      description: r.description,
      permissions: r.permissions,
      isBuiltin: true,
    });
    roleIds[r.key] = id;
  }
  console.log(`  角色 ${roleDefs.length} 个`);

  /* ── 3. 用户 ── */
  const userDefs = [
    {
      account: 'admin',
      name: '郭工',
      dept: 'hq',
      role: BUILTIN_ROLES.SYSTEM_ADMIN,
      password: ADMIN_PASSWORD,
    },
    {
      account: 'finance01',
      name: '张敏',
      dept: 'finance',
      role: BUILTIN_ROLES.DEPT_MANAGER,
      password: DEMO_PASSWORD,
    },
    {
      account: 'tech01',
      name: '王涛',
      dept: 'tech',
      role: BUILTIN_ROLES.MEMBER,
      password: DEMO_PASSWORD,
    },
  ];

  for (const u of userDefs) {
    const existed = await db.select().from(schema.users).where(eq(schema.users.account, u.account)).limit(1);
    if (existed[0]) {
      console.log(`  用户 ${u.account} 已存在，跳过`);
      continue;
    }
    const id = randomUUID();
    await db.insert(schema.users).values({
      id,
      account: u.account,
      name: u.name,
      passwordHash: await hashPassword(u.password),
      departmentId: deptIds[u.dept] ?? null,
      isActive: true,
    });
    await db.insert(schema.userRoles).values({ userId: id, roleId: roleIds[u.role]! });
  }
  console.log(`  用户 ${userDefs.length} 个`);

  /* ── 4. 一个团队知识库与默认文件夹 ── */
  const adminRow = (await db.select().from(schema.users).where(eq(schema.users.account, 'admin')).limit(1))[0];
  if (adminRow) {
    let kbRow = (await db.select().from(schema.knowledgeBases).where(eq(schema.knowledgeBases.name, '报账知识库')).limit(1))[0];
    if (!kbRow) {
      const kbId = randomUUID();
      await db.insert(schema.knowledgeBases).values({
        id: kbId,
        name: '报账知识库',
        description: '报销、差旅、票据相关制度与模板',
        ownerId: adminRow.id,
        departmentId: deptIds.finance ?? null,
        securityLevel: 'internal',
        visibleDeptIds: [],
        isTeamSpace: true,
      });
      kbRow = (await db.select().from(schema.knowledgeBases).where(eq(schema.knowledgeBases.id, kbId)).limit(1))[0];
      console.log('  知识库「报账知识库」已创建');
    }
    if (kbRow) {
      for (const [i, name] of ['制度文件', '表单模板', '常见问题'].entries()) {
        const existed = await db
          .select()
          .from(schema.kbFolders)
          .where(sql`${schema.kbFolders.kbId} = ${kbRow.id} AND ${schema.kbFolders.name} = ${name}`)
          .limit(1);
        if (!existed[0]) {
          await db.insert(schema.kbFolders).values({
            id: randomUUID(),
            kbId: kbRow.id,
            name,
            parentId: null,
            sortOrder: i * 10,
          });
        }
      }
      console.log('  默认文件夹：制度文件 / 表单模板 / 常见问题');
    }
  }

  await pool.end();

  console.log('\n初始数据完成。可用账号：');
  console.log(`  系统管理员  admin      / ${ADMIN_PASSWORD}`);
  console.log(`  财务部主管  finance01  / ${DEMO_PASSWORD}`);
  console.log(`  技术部成员  tech01     / ${DEMO_PASSWORD}`);
  console.log('\n提示：首次登录后请立即修改管理员密码。');
}

main().catch(async (err) => {
  console.error('写入初始数据失败：', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
