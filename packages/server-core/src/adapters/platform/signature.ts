/**
 * 聚智平台 OpenAPI 鉴权共用工件。
 *
 * ⚠️ 平台上有**两套并存且不可混用**的鉴权方式（实测结论，2026-09-13）：
 *
 * A. Bearer 头 —— `buildBearerAuth()`，仅用于 openai 兼容的模型推理接口
 *      POST /openapi/flames/api/v1/openai/chat
 *      Authorization: Bearer base64(`hmac api_key="…", algorithm=…, …, traceId/host/date/request-line`)
 *
 * B. URL 查询参数 —— `buildQueryAuth()`，用于智能体与知识库接口
 *      POST /openapi/flames/api/v1/chat?assistantCode=xxx
 *      POST /openapi/flames/api/v1/knowledge/document/upload
 *      查询串带 host / date / authorization / [assistantCode]
 *
 * 用错位置的后果（同一套凭证实测）：
 *   - 智能体接口用 Bearer   → 401「签名参数为空」（平台完全没读到签名）
 *   - 智能体接口用 URL 参数 → 通过（401「请求接口未授权或不存在」＝签名已过，只差有效 assistantCode）
 *   - 知识库接口用 Bearer   → 401「签名参数为空」
 *   - 知识库接口用 URL 参数 → 通过（进到业务层）
 *
 * 两条硬约束：
 *   1. 签名字串里的 host 不带端口号，但请求地址要带端口
 *   2. URL 参数方式的 authorization **只能**含 api_key / algorithm / headers / signature
 *      四个字段；多塞 assistantCode / traceId 之类会报「认证信息格式不正确」
 *
 * 这里只关心「怎么签」，不关心请求体与超时 —— 那些由各家 client 自己拼。
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

export interface QueryAuthInputs {
  /** 形如 10.0.0.1:30000，签名时只取前半段 */
  host: string;
  /** 目前需要 URL 参数签名的接口都是 POST */
  method: 'POST';
  /** 签名用的路径，**不含查询串** */
  path: string;
  appId: string;
  appSecret: string;
  /** 智能体接口必填（应用关联的智能体编码）；知识库接口不传 */
  assistantCode?: string;
}

/**
 * 构造 URL 查询参数形式的鉴权（智能体 / 知识库接口专用）。
 *
 * 返回的对象直接拼进请求 URL 的查询串即可。**切勿**再设 `Authorization` 头 ——
 * 这两个接口不认，平台会回 401「签名参数为空」。
 */
export function buildQueryAuth(opts: QueryAuthInputs): Record<string, string> {
  const host = opts.host.split(':')[0];
  const date = new Date().toUTCString();
  const requestLine = `${opts.method} ${opts.path} HTTP/1.1`;

  const signingString = `host: ${host}\ndate: ${date}\n${requestLine}`;
  const signature = createHmac('sha256', opts.appSecret).update(signingString).digest('base64');

  // 只能含这 4 个字段：多塞 assistantCode / traceId / host / date 会报「认证信息格式不正确」
  const authOrigin = `hmac api_key="${opts.appId}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;

  const params: Record<string, string> = {
    host,
    date,
    authorization: Buffer.from(authOrigin, 'utf8').toString('base64'),
  };
  if (opts.assistantCode) params.assistantCode = opts.assistantCode;
  return params;
}

/**
 * 平台鉴权串里所有 key="value" 都是双引号串接。
 * 极少会遇到 value 里嵌引号 / 换行的场景（assistantCode 这种都是纯英数），但守住边界。
 */
function escapeAttr(v: string): string {
  return v.replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
}
