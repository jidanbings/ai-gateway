/** 计费：按模型单价换算金额，并在上游未返回用量时做保守估算 */

import type { ModelRow } from '../types.js';

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 输入 token 中命中上游前缀缓存的部分（promptTokens 的子集），无缓存时为 0 */
  cachedTokens: number;
  estimated: boolean;
}

/** 空用量，用于上游未返回任何统计时的兜底 */
export function emptyUsage(estimated = true): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, estimated };
}

/**
 * 字符分类计数器：CJK 约 1 token/字，其余约 4 字符 1 token。
 *
 * 用 `charCodeAt` 逐位扫描，而不是 `for...of` + `codePointAt`：后者每个字符都要创建
 * 迭代结果与临时字符串，实测慢 5 倍以上（300 万字符要 22ms，而 Workers 免费版每次
 * 调用只有 10ms CPU 预算）。分类口径与改动前完全一致。
 */
export interface CharTally {
  cjk: number;
  other: number;
}

export function newTally(): CharTally {
  return { cjk: 0, other: 0 };
}

/** 把 text 的字符分类累加进 tally（可跨多次调用累计，便于分块处理） */
export function tallyChars(text: string, tally: CharTally): CharTally {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x2e80 && code <= 0x9fff) tally.cjk++;
    else if (code >= 0xf900 && code <= 0xfaff) tally.cjk++;
    else if (code >= 0xff00 && code <= 0xffef) tally.cjk++;
    else tally.other++;
  }
  return tally;
}

/** 由分类计数换算 token 数 */
export function tokensOfTally(tally: CharTally): number {
  return tally.cjk + Math.ceil(tally.other / 4);
}

/** 大文本抽样长度与触发阈值 */
const SAMPLE_CHARS = 65_536;
const SAMPLE_LIMIT = SAMPLE_CHARS * 4;

/**
 * 估算 token 数。
 *
 * 上游未返回 usage 时（部分平台的流式响应、部分自建网关）无法精确得知用量，
 * 这里按字符构成粗略折算：CJK 字符约 1 token，其余约 4 字符 1 token。
 * 该结果仅用于额度扣减，会在 usage_logs.estimated 中标记，便于事后核对。
 *
 * 超过 25 万字符的文本（通常是 1M 级上下文的请求体）改为抽样外推：全文精确扫描要花
 * 4ms 以上 CPU，而这条路径本身就是估算。抽样取前 6.4 万字符的比例再按长度外推 ——
 * 文本越长，开头样本的构成越接近整体，误差因此是有界的。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  if (text.length <= SAMPLE_LIMIT) return tokensOfTally(tallyChars(text, newTally()));

  const sample = tokensOfTally(tallyChars(text.slice(0, SAMPLE_CHARS), newTally()));
  return Math.max(1, Math.round((sample / SAMPLE_CHARS) * text.length));
}

// base64 内联载荷（data URL）：短于阈值的按普通文本计；命中时用占位文本替代，
// 保留「这里有一份二进制载荷」的信号但不把载荷算成 token
const INLINE_DATA_URL_MIN = 512;
const INLINE_DATA_URL_RE = /^data:[^,]{0,64},/;
const INLINE_DATA_PLACEHOLDER = 'data-url';

/**
 * 估算请求体的输入 token。
 *
 * 不构造序列化字符串，直接遍历对象累加 —— `JSON.stringify` 一份 1M 上下文的请求体实测
 * 约 7ms CPU，而估算只需要开头 6.4 万字符的构成与总长度。
 *
 * 两处与旧口径（`estimateTokens(JSON.stringify(body))`）有意的差异：
 *   1. 计原始文本长度而非 JSON 转义后的长度（`\n` 在 JSON 里占 2 字符、原文占 1）——
 *      模型分词的本来就是原文；
 *   2. `data:...;base64,` 内联载荷只按占位长度计，不再把整段 base64 算成 token。
 */
export function estimateTokensFromBody(body: unknown): number {
  const wide = newTally(); // 上限 SAMPLE_LIMIT，对应「小文本走全量」分支
  const narrow = newTally(); // 上限 SAMPLE_CHARS，对应「大文本走抽样」分支
  let wideRoom = SAMPLE_LIMIT;
  let narrowRoom = SAMPLE_CHARS;
  let total = 0;

  const feed = (s: string): void => {
    const n = s.length;
    if (n === 0) return;
    total += n;
    if (wideRoom > 0) {
      if (n <= wideRoom) {
        tallyChars(s, wide);
        wideRoom -= n;
      } else {
        tallyChars(s.slice(0, wideRoom), wide);
        wideRoom = 0;
      }
    }
    if (narrowRoom > 0) {
      if (n <= narrowRoom) {
        tallyChars(s, narrow);
        narrowRoom -= n;
      } else {
        tallyChars(s.slice(0, narrowRoom), narrow);
        narrowRoom = 0;
      }
    }
  };

  const walk = (node: unknown): void => {
    if (node === null) {
      feed('null');
      return;
    }
    switch (typeof node) {
      case 'string': {
        const s = node;
        feed('"');
        feed(s.length >= INLINE_DATA_URL_MIN && INLINE_DATA_URL_RE.test(s) ? INLINE_DATA_PLACEHOLDER : s);
        feed('"');
        return;
      }
      case 'number':
      case 'boolean':
        feed(String(node));
        return;
      case 'object': {
        if (Array.isArray(node)) {
          feed('[');
          for (let i = 0; i < node.length; i++) {
            if (i > 0) feed(',');
            walk(node[i]);
          }
          feed(']');
          return;
        }
        const obj = node as Record<string, unknown>;
        feed('{');
        let first = true;
        for (const k in obj) {
          if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
          if (!first) feed(',');
          first = false;
          feed('"');
          feed(k);
          feed('":');
          walk(obj[k]);
        }
        feed('}');
        return;
      }
      default:
        // undefined / function / symbol：JSON.stringify 会省略，这里按 null 占位
        feed('null');
    }
  };

  walk(body);

  if (total <= SAMPLE_LIMIT) return tokensOfTally(wide);
  return Math.max(1, Math.round((tokensOfTally(narrow) / SAMPLE_CHARS) * total));
}

/**
 * 从上游返回的 usage 对象提取用量。
 *
 * 字段名兼容多种风格：
 *   输入   prompt_tokens（OpenAI/DeepSeek） / input_tokens（Anthropic）
 *   输出   completion_tokens / output_tokens
 *   缓存命中：
 *     prompt_cache_hit_tokens          —— DeepSeek
 *     prompt_tokens_details.cached_tokens —— OpenAI
 *     cache_read_input_tokens          —— Anthropic
 */
export function extractUsage(usage: unknown): TokenUsage | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const prompt = num(u.prompt_tokens ?? u.input_tokens);
  const completion = num(u.completion_tokens ?? u.output_tokens);
  const total = num(u.total_tokens) || prompt + completion;
  // 有些上游只回 total_tokens、不给 prompt/completion 拆分，此时无法计价。返回 null 走
  // 估算兜底；否则会被判定为「非估算」，按 0 token 算出 0 费用
  if (prompt === 0 && completion === 0) return null;

  const details = (u.prompt_tokens_details ?? u.input_tokens_details) as
    | Record<string, unknown>
    | undefined;
  let cached =
    num(u.prompt_cache_hit_tokens) ||
    num(details?.cached_tokens) ||
    num(u.cache_read_input_tokens);

  // 命中量不可能超过输入总量；上游若给出矛盾数据则以输入量为准
  if (cached > prompt) cached = prompt;

  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total || prompt + completion,
    cachedTokens: cached,
    estimated: false,
  };
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * 计算金额（美元）。单价单位为美元 / 1M token。
 *
 * 输入部分按是否命中缓存分别计价：命中走 cache_hit_price，未命中走 prompt_price。
 * cache_hit_price 为 null 表示不区分缓存，此时命中部分也按 prompt_price 计
 * ——这样未配置缓存价的模型行为与加入本功能之前完全一致。
 */
export function computeCost(model: ModelRow | null, usage: TokenUsage): number {
  if (!model) return 0;

  const cached = Math.min(usage.cachedTokens, usage.promptTokens);
  const uncached = Math.max(0, usage.promptTokens - cached);
  const cachePrice = model.cache_hit_price ?? model.prompt_price;

  const cost =
    (uncached / 1_000_000) * model.prompt_price +
    (cached / 1_000_000) * cachePrice +
    (usage.completionTokens / 1_000_000) * model.completion_price;

  // 保留 8 位小数，避免浮点尾数在累加时扩散
  return Math.round(cost * 1e8) / 1e8;
}

/** 请求没写 max_tokens 时，预扣输出费用所用的兜底上限 */
const DEFAULT_MAX_COMPLETION_TOKENS = 4096;

/**
 * 估算一次请求最多可能花多少，用于额度预扣。
 *
 * 输入按请求体估算；输出取请求里的 max_tokens / max_completion_tokens，缺失时按
 * DEFAULT_MAX_COMPLETION_TOKENS 兜底。预扣宁可多算一点 —— 多扣的部分会在结算时退回，
 * 而少扣会让并发请求都以为自己还付得起。
 */
export function estimateRequestCost(model: ModelRow | null, body: Record<string, unknown>): number {
  if (!model) return 0;
  const promptTokens = estimateTokensFromBody(body);
  const declaredMax = num(body.max_tokens) || num(body.max_completion_tokens);
  const completionTokens = declaredMax > 0 ? declaredMax : DEFAULT_MAX_COMPLETION_TOKENS;
  return computeCost(model, {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cachedTokens: 0,
    estimated: true,
  });
}

/** 从非流式响应体里提取模型返回的文本，用于估算 token */
export function extractTextFromCompletion(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const b = body as Record<string, any>;
  const choices = b.choices;
  if (!Array.isArray(choices)) return '';
  let out = '';
  for (const c of choices) {
    const msg = c?.message;
    if (msg) {
      out += typeof msg.content === 'string' ? msg.content : '';
      if (typeof msg.reasoning_content === 'string') out += msg.reasoning_content;
    }
    if (typeof c?.text === 'string') out += c.text;
  }
  return out;
}
