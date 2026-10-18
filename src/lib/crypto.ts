/**
 * 加密与随机数工具。
 *
 * 上游 API Key 用 AES-256-GCM 加密后存 D1：主密钥由 Worker 自己生成的
 * encryption_key（存在 settings 表，见 lib/bootstrap.ts）经 SHA-256 派生，
 * 每个密文使用独立随机 IV。密文格式为 `v1.<iv_b64>.<ct_b64>`。
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** base64url 编码，无填充 */
function toBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 生成 URL 安全的随机字符串 */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toBase64Url(buf);
}

/** 生成下游 API Key，形如 sk-<43 字符> */
export function generateApiKey(): string {
  return `sk-${randomToken(32)}`;
}

/** SHA-256 十六进制摘要；用于 Key 与会话令牌的不可逆存储 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 定长比较，避免按字符短路带来的时序差异 */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= (ab[i] as number) ^ (bb[i] as number);
  return diff === 0;
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptSecret(plaintext: string, masterKey: string): Promise<string> {
  const key = await deriveKey(masterKey);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext));
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ct))}`;
}

export async function decryptSecret(payload: string, masterKey: string): Promise<string> {
  const parts = payload.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') {
    throw new Error('密文格式无效');
  }
  const key = await deriveKey(masterKey);
  const iv = base64ToBytes(parts[1] as string);
  const data = base64ToBytes(parts[2] as string);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return decoder.decode(pt);
}
