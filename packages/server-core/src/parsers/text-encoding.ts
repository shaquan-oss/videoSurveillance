/**
 * 文本字节解码 —— txt / md / csv 的唯一入口。
 *
 * 为什么不直接用 TextDecoder('utf-8')：中文环境里这两种编码都很常见 ——
 * 办公软件导出的 txt/csv 多是 GBK，Web 与 Git 里的是 UTF-8。猜错的后果是
 * **静默坏掉**：乱码照样能入库、能算向量、能检索，只是永远搜不到，界面上也看不出异常。
 * （实测：234.csv 的「维尔人体」被按 cp1252 解码成 ç»´å°\u0094äººä½\u0093 入库。）
 *
 * 顺序不能反：GB18030 几乎能解码任意字节序列，先试它会把 UTF-8 的中文也解成乱码，
 * 所以先用严格模式的 UTF-8，只有它抛错才回退 GB18030。
 */
export function decodeTextBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('gb18030').decode(bytes);
  }
}
