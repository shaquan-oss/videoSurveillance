/**
 * 本地确定性哈希向量 —— 外部向量模型不可用时的降级方案。
 *
 * 原理：把文本切成字符 trigram，哈希到 1024 维（与 pgvector 维度一致），
 * 再做 L2 归一化。共享越多 trigram 的文本，向量越接近，因此余弦相似度仍能
 * 反映「字面相近程度」。
 *
 * 用途：开发/演示环境没有 VPN 连不上聚智 embedding 接口时，让「纳入→检索」
 * 这条链路仍能端到端跑通。生产环境应使用真实向量模型，这里只做兜底。
 */

export function hashEmbedding(text: string, dim = 1024): number[] {
  const vec = new Array<number>(dim).fill(0);
  const normalized = text.toLowerCase().replace(/\s+/g, '');

  for (let i = 0; i < normalized.length - 2; i++) {
    const trigram = normalized.slice(i, i + 3);
    vec[fnv1a(trigram) % dim]! += 1;
  }
  // 兜底：极短文本没有 trigram，用单字符保证向量非零
  if (normalized.length < 3) {
    for (const ch of normalized) vec[fnv1a(ch) % dim]! += 1;
  }

  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

/** FNV-1a 32 位哈希，输入为短字符串 */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
