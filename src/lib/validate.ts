/** 入参校验辅助 */

import { badRequest } from './errors.js';

export function asString(value: unknown, field: string, opts: { max?: number; required?: boolean } = {}): string {
  const { max = 500, required = true } = opts;
  if (value == null || value === '') {
    if (required) throw badRequest(`缺少必填字段 ${field}`, field);
    return '';
  }
  if (typeof value !== 'string') throw badRequest(`字段 ${field} 必须是字符串`, field);
  const trimmed = value.trim();
  if (required && trimmed === '') throw badRequest(`字段 ${field} 不能为空`, field);
  if (trimmed.length > max) throw badRequest(`字段 ${field} 长度不能超过 ${max}`, field);
  return trimmed;
}

export function asOptionalString(value: unknown, field: string, max = 500): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw badRequest(`字段 ${field} 必须是字符串`, field);
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > max) throw badRequest(`字段 ${field} 长度不能超过 ${max}`, field);
  return trimmed;
}

export function asNumber(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number; fallback?: number } = {},
): number {
  const { min = 0, max = Number.MAX_SAFE_INTEGER, fallback } = opts;
  if (value == null || value === '') {
    if (fallback != null) return fallback;
    throw badRequest(`缺少必填字段 ${field}`, field);
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw badRequest(`字段 ${field} 必须是数字`, field);
  if (n < min || n > max) throw badRequest(`字段 ${field} 必须在 ${min} 与 ${max} 之间`, field);
  return n;
}

export function asBool(value: unknown, fallback = false): boolean {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

export function asEnum<T extends string>(value: unknown, field: string, allowed: readonly T[], fallback?: T): T {
  if (value == null || value === '') {
    if (fallback != null) return fallback;
    throw badRequest(`缺少必填字段 ${field}`, field);
  }
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw badRequest(`字段 ${field} 只能是 ${allowed.join(' / ')}`, field);
  }
  return value as T;
}

export function asId(value: unknown, field = 'id'): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`字段 ${field} 必须是正整数`, field);
  return n;
}

/** 解析模型映射：{ 下游模型名: 上游模型名 } */
export function asModelMapping(value: unknown): Record<string, string> {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('字段 models 必须是对象', 'models');
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = k.trim();
    if (key === '' || key.length > 200) throw badRequest('模型名不能为空且长度不超过 200', 'models');
    if (typeof v !== 'string' || v.trim() === '') {
      throw badRequest(`模型「${key}」的上游名称必须是非空字符串`, 'models');
    }
    if (v.trim().length > 200) throw badRequest(`模型「${key}」的上游名称过长`, 'models');
    out[key] = v.trim();
  }
  return out;
}

/** 校验 JSON 对象字符串（用于 extra_headers） */
export function asJsonObjectString(value: unknown, field: string): string {
  if (value == null || value === '') return '{}';
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw badRequest(`字段 ${field} 必须是 JSON 对象`, field);
      }
      return JSON.stringify(parsed);
    } catch {
      throw badRequest(`字段 ${field} 不是合法 JSON`, field);
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) return JSON.stringify(value);
  throw badRequest(`字段 ${field} 必须是 JSON 对象`, field);
}
