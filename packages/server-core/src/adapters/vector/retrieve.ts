import type { PermissionFilter, RetrievedChunk, VectorStore } from '@kh/shared';
import { getModelGateway } from '../model/index.ts';

/**
 * 相似度下限：低于它的片段一律不用。
 *
 * 为什么必须要有：向量检索一定会返回 topK 条结果，哪怕分数只有 0.04。
 * 这些片段会把无关内容喂给模型，还会让界面上出现一堆毫不相干的引用
 * （实测过：问「你好」也能检索出一份 xlsx，并把它显示成「依据」）。
 */
const MIN_SCORE = 0.15;

/**
 * 向量模型降级时的下限。
 *
 * 降级后用的是本地哈希向量，它的分数没有语义含义 —— 实测噪声能到 0.12，
 * 而真实命中的关键词召回在 0.2 以上。所以降级时只信关键词那一路。
 */
const MIN_SCORE_DEGRADED = 0.22;

/**
 * 统一检索入口：关键词检索 + 向量检索合并，去重后按分数降序取 topK。
 *
 * 为什么两条路都要走：向量模型降级到本地哈希向量时分数偏低，
 * 关键词检索对专有名词/原文短语更敏感，合并后召回更稳。
 *
 * 注意「宁可返回空」这个取向：没有把握就不要给模型塞上下文。
 * 返回空会走「资料里没找到」的分支，比拿无关片段硬答要好。
 */
export async function retrieve(opts: {
  store: VectorStore;
  query: string;
  filter: PermissionFilter;
  kbIds: string[];
  topK: number;
  minScore?: number;
}): Promise<RetrievedChunk[]> {
  const gateway = getModelGateway();

  /**
   * 向量模型不可用时只走关键词检索 —— 拿到了兜底向量也不去查：
   *
   * 本地哈希向量只是字符 trigram 的字面相似度，分数与语义无关。实测问「负面行为」时，
   * 一份内容完全无关的 CSV 也能拿到 0.177 并排进前列，最后被当成「依据」塞给模型，
   * 反而拉低准确率。MIN_SCORE_DEGRADED 的注释一直写着「降级时只信关键词那一路」，
   * 这里让实现和它一致。
   *
   * 顺序要紧：必须先调用 embed（它内部会按冷却间隔重试外部模型），再读降级状态。
   * 反过来写的话，降级一旦发生就再也没人触发重试，平台恢复了也永远用兜底。
   */
  const embedding = (await gateway.embed([opts.query]))[0]!;
  const degraded = gateway.isEmbedDegraded();

  const [vecHits, kwHits] = await Promise.all([
    degraded
      ? Promise.resolve<RetrievedChunk[]>([])
      : opts.store.query({
          embedding,
          filter: opts.filter,
          kbIds: opts.kbIds,
          topK: opts.topK,
        }),
    opts.store.keywordSearch(opts.query, opts.filter, opts.kbIds, opts.topK),
  ]);

  const seen = new Set<string>();
  const merged = [...kwHits, ...vecHits]
    .filter((h) => {
      if (seen.has(h.chunkId)) return false;
      seen.add(h.chunkId);
      return true;
    })
    .sort((a, b) => b.score - a.score);

  const minScore = opts.minScore ?? (degraded ? MIN_SCORE_DEGRADED : MIN_SCORE);
  const above = merged.filter((h) => h.score >= minScore);
  if (above.length > 0) return above.slice(0, opts.topK);

  // 全都低于阈值时，只保留「擦边」的那一条（不低于 MIN_SCORE）；
  // 明显不相关的（比如 0.04）宁可返回空，也别硬塞给模型当依据。
  const borderline = merged.filter((h) => h.score >= MIN_SCORE);
  return borderline.slice(0, 1);
}
