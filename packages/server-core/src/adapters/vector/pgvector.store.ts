import { type ChunkRecord, extractKeywords, type PermissionFilter, type RetrievedChunk, SecurityLevel, type VectorStore } from '@kh/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { Database } from '../../database/client.ts';

/**
 * pgvector 检索实现。
 *
 * 设计要点（这是整个知识库最要紧的一段代码）：
 * 权限过滤必须下推到 SQL 里，而不是「先查出结果再过滤」。
 * 这样无权内容从查询阶段就不会进入结果集，也就不可能被拼进模型上下文。
 *
 * 切片表冗余了 security_level / visible_dept_ids / owner_id 三个字段，
 * 所以相似度排序与权限判定能在同一条 SQL 完成，不需要 join 业务表。
 */
export class PgVectorStore implements VectorStore {
  constructor(private readonly db: Database) {}

  async upsert(records: ChunkRecord[]): Promise<void> {
    if (records.length === 0) return;
    const rows = records.map(
      (r) => sql`(
        ${r.id}::uuid, ${r.fileId}::uuid, ${r.kbId}::uuid, ${r.content},
        ${r.chunkIndex}, ${r.page ?? null}, ${toVectorLiteral(r.embedding)}::vector,
        ${r.securityLevel}, ${JSON.stringify(r.visibleDeptIds)}::jsonb, ${r.ownerId}::uuid
      )`,
    );
    await this.db.execute(sql`
      INSERT INTO chunks (id, file_id, kb_id, content, chunk_index, page, embedding, security_level, visible_dept_ids, owner_id)
      VALUES ${sql.join(rows, sql`, `)}
      ON CONFLICT (id) DO UPDATE SET
        content = EXCLUDED.content,
        embedding = EXCLUDED.embedding,
        security_level = EXCLUDED.security_level,
        visible_dept_ids = EXCLUDED.visible_dept_ids
    `);
  }

  async query(q: { embedding: number[]; filter: PermissionFilter; kbIds: string[]; topK: number }): Promise<RetrievedChunk[]> {
    const perm = buildPermissionCondition(q.filter);
    const scope = buildKbScope(q.kbIds);
    const vec = toVectorLiteral(q.embedding);

    const result = await this.db.execute(sql`
      SELECT
        c.id            AS chunk_id,
        c.file_id       AS file_id,
        c.kb_id         AS kb_id,
        c.content       AS content,
        c.chunk_index   AS chunk_index,
        c.page          AS page,
        f.name          AS file_name,
        1 - (c.embedding <=> ${vec}::vector) AS score
      FROM chunks c
      JOIN files f ON f.id = c.file_id
      WHERE f.deleted_at IS NULL
        AND c.embedding IS NOT NULL
        ${perm}
        ${scope}
      ORDER BY c.embedding <=> ${vec}::vector
      LIMIT ${q.topK}
    `);

    return (result.rows as Record<string, unknown>[]).map((row) => ({
      chunkId: String(row.chunk_id),
      fileId: String(row.file_id),
      kbId: String(row.kb_id),
      fileName: String(row.file_name),
      content: String(row.content),
      score: Number(row.score),
      chunkIndex: Number(row.chunk_index),
      page: row.page === null || row.page === undefined ? null : Number(row.page),
    }));
  }

  /**
   * 关键词检索。
   *
   * 这里曾经有个隐蔽的 bug：直接拿「整句查询」做子串匹配（content ILIKE '%住宿超标了怎么办%'），
   * 长查询永远匹配不到任何片段，等于关键词兜底完全失效。
   * 现在改为：先把查询拆成关键词（extractKeywords），任一命中即召回，
   * 分数按「命中关键词占比」算，并用 word_similarity 作为次序微调。
   */
  async keywordSearch(keyword: string, filter: PermissionFilter, kbIds: string[], limit: number): Promise<RetrievedChunk[]> {
    const keywords = extractKeywords(keyword);
    if (keywords.length === 0) return [];

    const perm = buildPermissionCondition(filter);
    const scope = buildKbScope(kbIds);
    const patterns = sql`ARRAY[${sql.join(
      keywords.map((k) => sql`${`%${k}%`}`),
      sql`, `,
    )}]::text[]`;

    const result = await this.db.execute(sql`
      WITH scored AS (
        SELECT
          c.id            AS chunk_id,
          c.file_id       AS file_id,
          c.kb_id         AS kb_id,
          c.content       AS content,
          c.chunk_index   AS chunk_index,
          c.page          AS page,
          f.name          AS file_name,
          (SELECT count(*) FROM unnest(${patterns}) AS p WHERE c.content ILIKE p) AS hits,
          word_similarity(${keyword}, c.content) AS wsim
        FROM chunks c
        JOIN files f ON f.id = c.file_id
        WHERE f.deleted_at IS NULL
          ${perm}
          ${scope}
      )
      SELECT
        chunk_id, file_id, kb_id, content, chunk_index, page, file_name,
        (hits::float / ${keywords.length}) * 0.8 + wsim * 0.2 AS score
      FROM scored
      WHERE hits > 0
      ORDER BY hits DESC, wsim DESC
      LIMIT ${limit}
    `);

    return (result.rows as Record<string, unknown>[]).map((row) => ({
      chunkId: String(row.chunk_id),
      fileId: String(row.file_id),
      kbId: String(row.kb_id),
      fileName: String(row.file_name),
      content: String(row.content),
      score: Number(row.score),
      chunkIndex: Number(row.chunk_index),
      page: row.page === null || row.page === undefined ? null : Number(row.page),
    }));
  }

  async removeByFile(fileId: string): Promise<void> {
    await this.db.execute(sql`DELETE FROM chunks WHERE file_id = ${fileId}::uuid`);
  }

  async countByKb(kbId: string): Promise<number> {
    const r = await this.db.execute(sql`SELECT COUNT(*)::int AS n FROM chunks WHERE kb_id = ${kbId}::uuid`);
    const row = (r.rows as Record<string, unknown>[])[0];
    return Number(row?.n ?? 0);
  }
}

/* ═══════════════ 权限条件拼装 ═══════════════
 * 这是「防止员工搜到无权限文件」的结构性保障：
 * 条件写进 WHERE，无权数据永远不进入结果集。
 * ═══════════════════════════════════════════ */

export function buildPermissionCondition(f: PermissionFilter): SQL {
  const depts = f.restrictToDepts ?? (f.departmentId ? [f.departmentId] : []);
  const deptArray = sql`ARRAY[${sql.join(
    depts.map((d) => sql`${d}`),
    sql`, `,
  )}]::text[]`;

  // 公开与内部：全公司可见
  // 部门：只要切片的可见部门包含我的部门之一即可
  // 私密：只有上传者本人可见
  // 跨部门检索权限：restrictToDepts 为 null 时，部门密级的文件也全部可见
  if (f.restrictToDepts === null) {
    return sql`AND (c.security_level IN ('public','internal','department') OR (c.security_level = 'private' AND c.owner_id = ${f.userId}::uuid))`;
  }

  return sql`AND (
    c.security_level IN ('public','internal')
    OR (c.security_level = 'department' AND c.visible_dept_ids ?| ${deptArray})
    OR (c.security_level = 'private' AND c.owner_id = ${f.userId}::uuid)
  )`;
}

function buildKbScope(kbIds: string[]): SQL {
  if (!kbIds || kbIds.length === 0) return sql``;
  return sql`AND c.kb_id IN (${sql.join(
    kbIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

/** 把 number[] 转成 pgvector 能识别的字面量 */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}
