// 会话日志扫描：把 `<DSH_HOME>/sessions/**/session*.jsonl[.zstd]` 里的 provider usage
// 抽成一条条「计费采样」，并尽量把每条采样补上它所属的会话 / 项目目录 / 标题 / 模型。
//
// 口径（和 DSH 自己的 `dsh-token-meter` 投影一致）：
//   - 只认 `assistant/message` 事件里的 `data.usage`；`compaction/summary`
//     这类事件也带 usage，但它们同样是 token 消耗，所以一并计入（`kind` 里区分）。
//   - `inputTokens` 是**缓存未命中**的输入，不含 cacheReadTokens；
//     校验式：totalTokens = inputTokens + cacheReadTokens + outputTokens。
//   - usage 全零的事件（400 报错等）直接丢弃，否则会把「调用次数」算多。
//
// 抽出来的记录不含任何「可识别到人」的内容：只有时间、会话 id、目录名、标题、模型、token 桶。

import fs from 'node:fs';
import path from 'node:path';
import { decodeSessionBuffer } from './zstd-frames.mjs';

/** 会带 token 用量的事件类型。 */
export const USAGE_EVENT_TYPES = new Set(['assistant/message', 'assistant/attempt', 'compaction/summary']);

/** 从 usage 对象里取四个桶（兼容 DSH 原始键名与账本键名）。 */
export function bucketsOfUsage(usage) {
  const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
  if (!usage || typeof usage !== 'object') return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  return {
    input: num(usage.inputTokens ?? usage.cacheMiss ?? usage.uncachedInputTokens),
    cacheRead: num(usage.cacheReadTokens ?? usage.cacheHit),
    cacheWrite: num(usage.cacheWriteTokens ?? usage.cacheWrite),
    output: num(usage.outputTokens ?? usage.output)
  };
}

/** 四个桶之和。 */
export function totalOfBuckets(b) {
  return (b?.input ?? 0) + (b?.cacheRead ?? 0) + (b?.cacheWrite ?? 0) + (b?.output ?? 0);
}

/** 递归列出会话日志文件。 */
export function listSessionFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.jsonl(\.zstd)?$/i.test(entry.name)) out.push(full);
    }
  };
  walk(root);
  out.sort();
  return out;
}

/**
 * 解析一个会话文件。
 *
 * @param {string} file
 * @param {object} [opts]
 * @param {(ms:number)=>string} [opts.dateOf] 时间 → 日期字符串（默认按北京时间）
 * @returns {{
 *   file: string, sessionId: string, project: string, cwd: string|null, title: string|null,
 *   events: number, records: Array<object>
 * }}
 */
export function parseSessionFile(file) {
  const buf = fs.readFileSync(file);
  const text = decodeSessionBuffer(buf, file);
  const sessionDir = path.dirname(file);
  const projectDir = path.dirname(sessionDir);
  const result = {
    file,
    sessionId: path.basename(sessionDir),
    project: path.basename(projectDir),
    cwd: null,
    title: null,
    events: 0,
    records: []
  };

  let provider = null;
  let model = null;
  // 标题可能被反复改写（LLM 生成、用户手改），取**最后**一条。
  const titles = [];

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // 追加写被打断留下的半行：跳过
    }
    result.events += 1;
    const type = event?.type;
    if (type === 'session' && typeof event.cwd === 'string') result.cwd = event.cwd;
    if (type === 'session/title' && typeof event?.data?.title === 'string') titles.push(event.data.title);
    if (type === 'request/context' || type === 'request/header') {
      const cfg = event?.data?.header?.config ?? event?.data;
      if (cfg?.provider) provider = String(cfg.provider);
      if (cfg?.model) model = String(cfg.model);
    }
    if (!USAGE_EVENT_TYPES.has(type)) continue;
    const usage = event?.data?.usage;
    if (!usage || typeof usage !== 'object') continue;
    const buckets = bucketsOfUsage(usage);
    if (totalOfBuckets(buckets) === 0) continue; // 全零 = 报错/空回包
    const t = Number(event?.time);
    result.records.push({
      t: Number.isFinite(t) ? t : 0,
      sessionId: result.sessionId,
      project: result.project,
      file,
      kind: type,
      turn: Number.isFinite(Number(event?.data?.turn)) ? Number(event.data.turn) : null,
      step: Number.isFinite(Number(event?.data?.step)) ? Number(event.data.step) : null,
      provider,
      model,
      buckets
    });
  }

  if (titles.length) result.title = titles[titles.length - 1];
  for (const record of result.records) {
    record.title = result.title;
    record.cwd = result.cwd;
  }
  // 一个事件都没解析出来：要么压缩格式不认识，要么文件根本不是会话日志。
  // 静默返回 0 条会被当成「这个会话没花过 token」，所以必须报错让上层记 warning。
  if (result.events === 0 && text.trim()) {
    throw new Error('不是有效的会话日志：没有任何可解析的事件行（压缩格式或文件类型不对？）');
  }
  return result;
}

/**
 * 扫描整个 sessions 根目录。
 * @param {string} root `<DSH_HOME>/sessions`
 * @returns {{root: string, files: number, sessions: number, records: Array<object>, warnings: string[]}}
 */
export function scanSessions(root) {
  const files = listSessionFiles(root);
  const records = [];
  const warnings = [];
  const seen = new Set();
  for (const file of files) {
    try {
      const parsed = parseSessionFile(file);
      seen.add(parsed.sessionId);
      records.push(...parsed.records);
    } catch (error) {
      warnings.push(`${file}: ${error?.message ?? error}`);
    }
  }
  records.sort((a, b) => a.t - b.t || String(a.sessionId).localeCompare(String(b.sessionId)));
  return { root, files: files.length, sessions: seen.size, records, warnings };
}
