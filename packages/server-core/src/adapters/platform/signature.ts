/**
 * 聚智平台 OpenAPI 鉴权共用工件。
 *
 * 三个调用方都用同一套签名规则：
 *   - LLM 推理（jiutian.provider）：POST /openapi/flames/api/v1/openai/chat
 *   - 远程智能体：POST /openapi/flames/api/v1/chat?assistantCode=xxx
 *   - 知识库文档上传：POST /openapi/flames/api/v1/knowledge/document/upload
 *
 * 三处签名只差「额外字段」不同（model / assistantCode 等），其它都一致。
 * 把这部分抽出来，省得三处各自实现又各自踩坑：
 *   1. 签名字串里的 host 不带端口号，但请求地址要带端口
 *   2. auth 串里参数之间必须是「逗号 + 空格」，用纯空格网关判「认证信息格式不正确」
 *   3. extra 字段顺序在 signature 前后都可，只要保持和签名 headers 的拆字段一致
 *
 * 这里只关心「怎么签」，不关心请求体和超时策略 —— 那些由各家 client 自己拼。
 */
import { createHmac, randomUUID } from 'node:crypto';

export interface AuthInputs {
  /** 形如 10.0.0.1:30000，仅计算签名用 host 时取前半段 */
  host: string;
  /** 请求方法，目前所有平台接口都是 POST */
  method: 'POST';
  /** 路径，必须包含 /openapi 前缀，传到网关的就是这个 */
  path: string;
  appId: string;
  appSecret: string;
  /**
   * 额外的鉴权字段。会以 `key="value"` 的形式拼到 auth 串里，逗号空格分隔。
   * 模型调用方传 `modelId / modelSource`；智能体调用方传 `assistantCode`。
   */
  extra?: Record<string, string>;
}

/**
 * 构造完整的 `Authorization: Bearer xxx` 值。
 * 返回字符串已经带了 `Bearer ` 前缀，直接当 header 值塞进去即可。
 */
export function buildBearerAuth(opts: AuthInputs): string {
  const host = opts.host.split(':')[0];
  const date = new Date().toUTCString();
  const requestLine = `${opts.method} ${opts.path} HTTP/1.1`;
  const traceId = randomUUID();

  const signingString = `host: ${host}\ndate: ${date}\n${requestLine}`;
  const signature = createHmac('sha256', opts.appSecret).update(signingString).digest('base64');

  const pairs = [
    `hmac api_key="${opts.appId}"`,
    `algorithm="hmac-sha256"`,
    `headers="host date request-line"`,
    `signature="${signature}"`,
    ...Object.entries(opts.extra ?? {}).map(([k, v]) => `${k}="${escapeAttr(v)}"`),
    `traceId="${traceId}"`,
    `host="${host}"`,
    `date="${date}"`,
    `request-line="${requestLine}"`,
  ];

  return `Bearer ${Buffer.from(pairs.join(', '), 'utf8').toString('base64')}`;
}

/**
 * 构造一组带 auth 的 headers。
 * 仅仅是 buildBearerAuth + 常用 Content-Type；具体 content-type 由各 client 按需覆盖。
 */
export function authHeaders(opts: AuthInputs, contentType = 'application/json'): Record<string, string> {
  return {
    Authorization: buildBearerAuth(opts),
    'Content-Type': contentType,
  };
}

/**
 * 平台鉴权串里所有 key="value" 都是双引号串接。
 * 极少会遇到 value 里嵌引号 / 换行的场景（assistantCode 这种都是纯英数），但守住边界。
 */
function escapeAttr(v: string): string {
  return v.replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
}
