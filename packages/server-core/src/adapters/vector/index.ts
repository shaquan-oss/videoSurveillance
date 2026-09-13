import type { VectorStore } from '@kh/shared';
import type { Database } from '../../database/client.ts';
import { PgVectorStore } from './pgvector.store.ts';

let instance: VectorStore | null = null;

/**
 * 向量检索实例。
 * 留这一层工厂的意义：将来切片量超过 500 万需要换 Milvus/Qdrant 时，
 * 只在这里换实现，上层业务代码一行不动。
 */
export function getVectorStore(db: Database): VectorStore {
  if (!instance) instance = new PgVectorStore(db);
  return instance;
}

export { buildPermissionCondition, toVectorLiteral } from './pgvector.store.ts';
export { retrieve } from './retrieve.ts';
export { PgVectorStore };
