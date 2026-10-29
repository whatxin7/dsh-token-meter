// Markdown 报告生成。报告只描述「用量与花费」，不含任何聊天内容。

import { clockOf, dateOf } from './aggregate.mjs';

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const money = (n) => `¥${(Number(n) || 0).toFixed(2)}`;
const pct = (v) => `${((Number(v) || 0) * 100).toFixed(2)}%`;
const short = (v, n = 10) => (String(v ?? '').length > n ? `${String(v).slice(0, n)}…` : String(v ?? ''));

/**
 * 生成报告。
 * @param {object} agg `aggregate()` 的结果
 * @param {object} [meta] 附加元信息（扫描根目录、文件数、警告）
 * @returns {string}
 */
export function renderReport(agg, meta = {}) {
  const lines = [];
  const sym = agg.symbol ?? '¥';
  const range = agg.firstAt && agg.lastAt ? `${clockOf(agg.firstAt)} → ${clockOf(agg.lastAt)}` : '无采样';

  lines.push('# DSH Token 用量与费用核算', '');
  lines.push(`- 统计范围：\`${meta.root ?? '<未指定>'}\`${meta.files ? `（${fmt(meta.files)} 个会话日志文件，${fmt(agg.sessions)} 个会话）` : ''}`);
  lines.push(`- 时间跨度：${range}`);
  lines.push(`- 计费采样：${fmt(agg.calls)} 次 provider 调用；价目表版本 \`${agg.priceVersion}\``);
  if (agg.cost.estimated) lines.push('- ⚠️ 含未知模型：已按兜底价（flash）折算，金额标为估算');
  lines.push('');

  lines.push('## 总量', '');
  lines.push('| 项目 | Tokens |');
  lines.push('|---|---:|');
  lines.push(`| 输入（缓存未命中） | ${fmt(agg.tokens.input)} |`);
  lines.push(`| 输入（缓存命中 cacheRead） | ${fmt(agg.tokens.cacheRead)} |`);
  lines.push(`| 输入（缓存写入 cacheWrite） | ${fmt(agg.tokens.cacheWrite)} |`);
  lines.push(`| 输出（含推理） | ${fmt(agg.tokens.output)} |`);
  lines.push(`| **合计** | **${fmt(agg.tokens.total)}** |`);
  lines.push('');
  lines.push(
    `缓存命中占输入的 **${pct(agg.cacheHitRate)}**；平均每次调用上下文 ${fmt(Math.round(agg.avgContextPerCall))} tokens，平均输出 ${fmt(Math.round(agg.avgOutputPerCall))} tokens。`,
    ''
  );

  lines.push('## 费用（官方峰谷口径）', '');
  lines.push('| 档位 | 金额 |');
  lines.push('|---|---:|');
  lines.push(`| 高峰时段（2×） | ${money(agg.cost.peak)} |`);
  lines.push(`| 空闲时段 | ${money(agg.cost.off)} |`);
  lines.push(`| **合计** | **${money(agg.cost.total)}** |`);
  lines.push('');
  lines.push('高峰 = 北京时间周一至周五 09:00–12:00、14:00–18:00 且非法定节假日；其余为空闲（单价折半）。', '');

  lines.push('## 换价目表对比（同一份用量）', '');
  lines.push(`| 价目档位（输入 / 缓存 / 输出，元每百万） | 合计 |`);
  lines.push('|---|---:|');
  for (const f of agg.flat) {
    lines.push(`| ${f.label}（${f.input} / ${f.cache} / ${f.output}） | ${sym}${f.cost.toFixed(2)} |`);
  }
  lines.push('');

  lines.push('## 每日用量', '');
  lines.push('| 日期 | 调用 | 输入 | 缓存命中 | 输出 | 合计 tokens | 费用 |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const d of agg.daily) {
    lines.push(
      `| ${d.date} | ${fmt(d.calls)} | ${fmt(d.tokens.input)} | ${fmt(d.tokens.cacheRead)} | ${fmt(d.tokens.output)} | ${fmt(
        d.tokens.input + d.tokens.cacheRead + d.tokens.cacheWrite + d.tokens.output
      )} | ${money(d.cost)} |`
    );
  }
  lines.push('');

  if (agg.sessionsRank.length) {
    lines.push('## 用量最大的会话', '');
    lines.push('| # | 会话 | 标题 | 调用 | Tokens | 费用 | 时间跨度 |');
    lines.push('|---:|---|---|---:|---:|---:|---|');
    for (const s of agg.sessionsRank.slice(0, 10)) {
      lines.push(
        `| ${s.rank} | \`${short(s.sessionId, 22)}\` | ${short(s.title ?? '—', 24)} | ${fmt(s.calls)} | ${fmt(
          s.tokens.total
        )} | ${money(s.cost)} | ${dateOf(s.firstAt)} → ${dateOf(s.lastAt)} |`
      );
    }
    lines.push('');
  }

  if (agg.projects.length) {
    lines.push('## 按项目目录分布', '');
    lines.push('| 会话目录 | 会话 | 调用 | Tokens | 占比 |');
    lines.push('|---|---:|---:|---:|---:|');
    const total = agg.tokens.total || 1;
    for (const p of agg.projects) {
      lines.push(
        `| \`${short(p.project, 40)}\` | ${fmt(p.sessionCount)} | ${fmt(p.calls)} | ${fmt(p.tokens.total)} | ${pct(
          p.tokens.total / total
        )} |`
      );
    }
    lines.push('');
  }

  if (agg.themes.length) {
    lines.push('## 按功能主题分布', '');
    lines.push('| 主题 | 会话 | 调用 | Tokens | 占比 | 费用 |');
    lines.push('|---|---:|---:|---:|---:|---:|');
    for (const t of agg.themes) {
      lines.push(
        `| ${t.theme} | ${fmt(t.sessionCount)} | ${fmt(t.calls)} | ${fmt(t.tokens.total)} | ${pct(t.share)} | ${money(t.cost)} |`
      );
    }
    lines.push('');
    lines.push('主题按会话标题关键词归类，一个会话只进一个桶；它是成本归属口径，不参与计费。', '');
  }

  if (agg.models.length) {
    lines.push('## 按模型分布', '');
    lines.push('| 模型（归一后） | 调用 | Tokens | 费用 |');
    lines.push('|---|---:|---:|---:|');
    for (const m of agg.models) {
      lines.push(`| \`${m.model}\` | ${fmt(m.calls)} | ${fmt(m.tokens.total ?? 0)} | ${money(m.cost)} |`);
    }
    lines.push('');
  }

  lines.push('## 口径与校验', '');
  lines.push('- 数据源：会话日志里 `assistant/message` / `assistant/attempt` / `compaction/summary` 事件的 `data.usage`。');
  lines.push('- `inputTokens` 是**缓存未命中**的输入，缓存命中单独走 `cacheReadTokens`，两者互不重叠。');
  lines.push('- 全零 usage（400 报错、空回包）不计入调用次数。');
  lines.push('- 多帧 zstd 会话日志按 frame 逐帧解码；只解第一帧会漏掉绝大多数事件。');
  lines.push('- 时间一律按北京时间判定峰谷，不依赖运行机器的本地时区。');
  if (meta.warnings?.length) {
    lines.push('', `⚠️ 有 ${meta.warnings.length} 个文件解析失败（已跳过）：`, '');
    for (const w of meta.warnings.slice(0, 10)) lines.push(`- ${w}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** 生成 JSON（给控制台/二次开发用）。 */
export function renderJson(agg, meta = {}) {
  return JSON.stringify(
    {
      generatedAt: new Date(agg.generatedAt).toISOString(),
      root: meta.root ?? null,
      files: meta.files ?? null,
      warnings: meta.warnings ?? [],
      priceVersion: agg.priceVersion,
      currency: agg.currency,
      calls: agg.calls,
      sessions: agg.sessions,
      firstAt: agg.firstAt,
      lastAt: agg.lastAt,
      tokens: agg.tokens,
      cacheHitRate: agg.cacheHitRate,
      avgContextPerCall: agg.avgContextPerCall,
      avgOutputPerCall: agg.avgOutputPerCall,
      cost: agg.cost,
      daily: agg.daily,
      sessionsRank: agg.sessionsRank,
      projects: agg.projects,
      themes: agg.themes,
      models: agg.models,
      flat: agg.flat
    },
    null,
    2
  );
}
