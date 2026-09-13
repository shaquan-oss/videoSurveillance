import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

/**
 * 密码哈希：Node 内置 scrypt。
 * 选它而不是 argon2 是为了零原生依赖 —— 部署到 alpine 镜像时不需要编译工具链。
 * 参数封装在本文件内，将来若要换 argon2id，只改这里，调用方不动。
 */
const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(plain, salt, PARAMS.keylen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
  });
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), derived.toString('base64')].join('$');
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    const derived = await scrypt(plain, salt, expected.length, { N, r, p });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** 校验密码强度：至少 8 位且含字母与数字 */
export function isPasswordStrong(plain: string): boolean {
  return plain.length >= 8 && /[a-zA-Z]/.test(plain) && /[0-9]/.test(plain);
}
