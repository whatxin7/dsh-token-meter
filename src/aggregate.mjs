// 聚合层：把扫描出来的采样按「天 / 会话 / 项目目录 / 主题 / 模型」折叠，并折算金额。
//
// 两个必须分开的口径：
//
//   1. **官方峰谷口径**（默认）：按每条采样**自己的时间**判定高峰/空闲（高峰 = 2 倍价），
//      用 `model-prices.js` 的价目表折算。这是「实际花掉多少」的最佳估计。
//   2. **平价档位口径**（`flat`）：忽略峰谷，给定一组「输入 / 缓存命中 / 输出」单价直接乘。
//      用来回答「如果换成别家 / 别档位，这些 token 要多少钱」——同一份用量换价目表比较，
//      而不是换模型重跑。
//
// 主题归类是**启发式**（标题关键词 → 主题桶）。它是给人看的成本归属，不参与计费；
// 归不进任何桶的会话会落到「其他 / 未归类」，绝不静默丢样本。

import {
  DEFAULT_PRICE_TABLE,
  costOfBuckets,
  ratesAt,
  resolvePriceTable,
  totalTokensOf
} from './model-prices.js';
import { totalOfBuckets } from './scan.mjs';

/** 常用平价档位（元 / 百万 token）。labels 只用于报告表头。 */
export const FLAT_SCENARIOS = [
  { label: 'Flash 低价档', input: 0.5, cache: 0.15, output: 2 },
  { label: 'Flash 常见档', input: 1, cache: 0.2, output: 4 },
  { label: 'DeepSeek 官方档', input: 2, cache: 0.5, output: 8 },
  { label: 'GLM 类档', input: 4, cache: 1, output: 16 },
  { label: '缓存不打折', input: 2, cache: 2, output: 8 }
];

/**
 * 主题规则：标题关键词 → 主题桶。按顺序匹配，先命中先归属。
 * 这套桶不是分类学，而是「钱花在哪类活上」的账目口径。
 */
export const THEME_RULES = [
  {
    theme: '她在线聊天（bridge 自动起的会话）',
    project: /qq-bridge[\\/]state[\\/](agents|slang-agent)/i,
    keywords: []
  },
  {
    theme: '插件安装与桥接',
    keywords: ['插件', '桥接', 'bridge', 'onebot', 'snowluma', '安装', '接入', '部署', 'dsh 接入', '联调']
  },
  {
    theme: '好友 / 白名单 / 权限',
    keywords: ['好友', '白名单', '黑名单', '权限', 'allow', 'deny', '申请', '拉黑', '安全守卫']
  },
  {
    theme: '能力扩展（视觉 / 搜索 / 语感）',
    keywords: ['视觉', '图片', '搜索', '联网', 'mcp', '语感', '黑话', '表情识别', '多模态']
  },
  {
    theme: '人格 / 角色卡',
    keywords: ['人格', '角色卡', '人设', 'prompt', '提示词', '设定', '语气', '文案']
  },
  {
    theme: '群聊私聊行为调优',
    keywords: ['群聊', '私聊', '回复', '追问', '插话', '冷场', '潜水', '唤醒', '沉默', '节奏', '跨会话']
  },
  {
    theme: '形象与社交动作（头像 / 名片 / 动态 / 撤回）',
    keywords: ['头像', '名片', '昵称', '空间', '说说', '撤回', '点赞', '形象']
  },
  {
    theme: '语音 / 唱歌 / 音色',
    keywords: ['语音', '唱歌', '音色', 'tts', '音频', '歌本', '发声']
  },
  {
    theme: '表情包 / 斗图',
    keywords: ['表情', '斗图', 'face', 'sticker', '梗图']
  },
  {
    theme: '用量与成本核算',
    keywords: ['token', '用量', '花费', '成本', '计费', '账单', '核算', '价格']
  }
];

export const FALLBACK_THEME = '其他 / 未归类（排障类）';

/**
 * 把 DSH 的 provider / model 名归一成价目表里的键。
 * 价目表认的是 provider 风格的短名（`deepseek-flash`），而事件里两种都可能出现。
 * @param {string|null} provider
 * @param {string|null} model
 */
export function normalizeModelKey(provider, model) {
  const raw = String(provider || model || '').trim().toLowerCase();
  if (!raw) return 'deepseek-flash';
  if (DEFAULT_PRICE_TABLE.models[raw]) return raw;
  if (/pro/.test(raw)) return 'deepseek-pro';
  if (/flash/.test(raw)) return 'deepseek-flash';
  return raw;
}

/** 标题 → 主题桶。 */
export function themeOf(record) {
  const project = String(record?.project ?? '');
  for (const rule of THEME_RULES) {
    if (rule.project && rule.project.test(project)) return rule.theme;
  }
  const title = String(record?.title ?? '');
  for (const rule of THEME_RULES) {
    if (!rule.keywords?.length) continue;
    if (rule.keywords.some((kw) => title.toLowerCase().includes(kw.toLowerCase()))) return rule.theme;
  }
  return FALLBACK_THEME;
}

/** 北京时间日期字符串（北京时间，不依赖本机时区）。 */
export function dateOf(ms) {
  const d = new Date(Number(ms) + 8 * 3600 * 1000);
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${m}-${day}`;
}

/** 北京时间 `YYYY-MM-DD HH:mm`。 */
export function clockOf(ms) {
  const d = new Date(Number(ms) + 8 * 3600 * 1000);
  return `${dateOf(ms)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

const emptyBuckets = () => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });

function addInto(target, buckets) {
  target.input += buckets.input;
  target.cacheRead += buckets.cacheRead;
  target.cacheWrite += buckets.cacheWrite;
  target.output += buckets.output;
  return target;
}

function costOf(buckets, { model, at, table }) {
  const rates = ratesAt(model, at, table);
  const ledgerBuckets = {
    cacheMiss: buckets.input,
    cacheHit: buckets.cacheRead,
    cacheWrite: buckets.cacheWrite,
    output: buckets.output
  };
  return { rates, cost: costOfBuckets(ledgerBuckets, rates) };
}

/**
 * 聚合。
 * @param {Array<object>} records `scanSessions()` 的 records
 * @param {object} [options]
 * @param {object} [options.priceTable] 价目表覆盖（`pricing` 配置段）
 * @param {Array<object>} [options.flatScenarios] 平价档位
 * @param {string} [options.model] 强制模型（缺省按每条采样自己的 provider/model）
 */
export function aggregate(records, { priceTable, flatScenarios = FLAT_SCENARIOS, model: forcedModel } = {}) {
  const table = resolvePriceTable(priceTable);
  const totals = {
    calls: 0,
    tokens: emptyBuckets(),
    cost: 0,
    peakCost: 0,
    offCost: 0,
    estimated: false
  };
  const daily = new Map();
  const bySession = new Map();
  const byProject = new Map();
  const byTheme = new Map();
  const byModel = new Map();
  let first = Infinity;
  let last = -Infinity;

  for (const record of records) {
    const buckets = record.buckets ?? emptyBuckets();
    const tokens = totalOfBuckets(buckets);
    if (!tokens) continue;
    const at = Number(record.t) || 0;
    const key = forcedModel ?? normalizeModelKey(record.provider, record.model);
    const { rates, cost } = costOf(buckets, { model: key, at: at || Date.now(), table });
    const date = dateOf(at);
    const theme = themeOf(record);

    totals.calls += 1;
    addInto(totals.tokens, buckets);
    totals.cost += cost.total;
    if (rates.tier === 'peak') totals.peakCost += cost.total;
    else totals.offCost += cost.total;
    totals.estimated ||= rates.estimated;
    if (at < first) first = at;
    if (at > last) last = at;

    const d = daily.get(date) ?? { date, calls: 0, tokens: emptyBuckets(), cost: 0 };
    d.calls += 1;
    addInto(d.tokens, buckets);
    d.cost += cost.total;
    daily.set(date, d);

    const sKey = `${record.sessionId}`;
    const s = bySession.get(sKey) ?? {
      sessionId: record.sessionId,
      title: record.title ?? null,
      project: record.project,
      cwd: record.cwd ?? null,
      calls: 0,
      tokens: emptyBuckets(),
      cost: 0,
      firstAt: at,
      lastAt: at,
      models: new Set()
    };
    s.calls += 1;
    addInto(s.tokens, buckets);
    s.cost += cost.total;
    if (at < s.firstAt) s.firstAt = at;
    if (at > s.lastAt) s.lastAt = at;
    s.models.add(key);
    if (record.title) s.title = record.title;
    bySession.set(sKey, s);

    const p = byProject.get(record.project) ?? {
      project: record.project,
      sessions: new Set(),
      calls: 0,
      tokens: emptyBuckets(),
      cost: 0
    };
    p.sessions.add(record.sessionId);
    p.calls += 1;
    addInto(p.tokens, buckets);
    p.cost += cost.total;
    byProject.set(record.project, p);

    const th = byTheme.get(theme) ?? { theme, sessions: new Set(), calls: 0, tokens: emptyBuckets(), cost: 0 };
    th.sessions.add(record.sessionId);
    th.calls += 1;
    addInto(th.tokens, buckets);
    th.cost += cost.total;
    byTheme.set(theme, th);

    const m = byModel.get(key) ?? { model: key, calls: 0, tokens: emptyBuckets(), cost: 0 };
    m.calls += 1;
    addInto(m.tokens, buckets);
    m.cost += cost.total;
    byModel.set(key, m);
  }

  const totalTokens = totalTokensOf({
    cacheMiss: totals.tokens.input,
    cacheHit: totals.tokens.cacheRead,
    cacheWrite: totals.tokens.cacheWrite,
    output: totals.tokens.output
  });
  const inputTotal = totals.tokens.input + totals.tokens.cacheRead + totals.tokens.cacheWrite;

  const flat = flatScenarios.map((s) => {
    // 输入价只作用于**缓存未命中**的输入（含 cacheWrite），缓存命中单独按缓存价：
    // 若把 cacheRead 也算进输入价，同一批 token 会被计两次价。
    const missInput = totals.tokens.input + totals.tokens.cacheWrite;
    const cost = (missInput / 1e6) * s.input + (totals.tokens.cacheRead / 1e6) * s.cache + (totals.tokens.output / 1e6) * s.output;
    return { ...s, cost };
  });

  const sessionRows = [...bySession.values()]
    .map((s) => ({ ...s, models: [...s.models], tokens: { ...s.tokens, total: totalOfBuckets(s.tokens) } }))
    .sort((a, b) => b.tokens.total - a.tokens.total || b.cost - a.cost)
    .map((s, index) => ({ ...s, rank: index + 1 }));

  const projectRows = [...byProject.values()]
    .map((p) => ({
      ...p,
      sessionCount: p.sessions.size,
      tokens: { ...p.tokens, total: totalOfBuckets(p.tokens) }
    }))
    .sort((a, b) => b.tokens.total - a.tokens.total);

  const themeRows = [...byTheme.values()]
    .map((t) => ({
      ...t,
      sessionCount: t.sessions.size,
      tokens: { ...t.tokens, total: totalOfBuckets(t.tokens) },
      share: totalTokens > 0 ? totalOfBuckets(t.tokens) / totalTokens : 0
    }))
    .sort((a, b) => b.tokens.total - a.tokens.total);

  return {
    generatedAt: Date.now(),
    firstAt: Number.isFinite(first) ? first : null,
    lastAt: Number.isFinite(last) ? last : null,
    priceVersion: table.version,
    currency: table.currency,
    symbol: table.symbol,
    calls: totals.calls,
    sessions: bySession.size,
    tokens: { ...totals.tokens, total: totalTokens, inputTotal },
    cacheHitRate: inputTotal > 0 ? totals.tokens.cacheRead / inputTotal : 0,
    avgContextPerCall: totals.calls > 0 ? totalTokens / totals.calls : 0,
    avgOutputPerCall: totals.calls > 0 ? totals.tokens.output / totals.calls : 0,
    cost: { total: totals.cost, peak: totals.peakCost, off: totals.offCost, estimated: totals.estimated },
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    sessionsRank: sessionRows,
    projects: projectRows,
    themes: themeRows,
    models: [...byModel.values()]
      .map((m) => ({ ...m, tokens: { ...m.tokens, total: totalOfBuckets(m.tokens) } }))
      .sort((a, b) => b.tokens.total - a.tokens.total),
    flat
  };
}
