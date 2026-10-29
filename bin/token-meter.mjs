#!/usr/bin/env node
// dsh-token-meter CLI。
//
//   token-meter scan    [--root DIR] [--json] [--limit N]
//   token-meter report  [--root DIR] [--out FILE] [--format md|json]
//   token-meter cost    --in P --cache P --out P    # 给定单价折算总量
//   token-meter prices                              # 打印内置价目表
//
// 默认 root：`$DSH_HOME/sessions`，其次 `~/.dsh/sessions`。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanSessions } from '../src/scan.mjs';
import { aggregate, FLAT_SCENARIOS, clockOf } from '../src/aggregate.mjs';
import { renderJson, renderReport } from '../src/report.mjs';
import { DEFAULT_PRICE_TABLE, ratesAt } from '../src/model-prices.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[name] = true;
    else {
      args[name] = next;
      i += 1;
    }
  }
  return args;
}

function defaultRoot() {
  if (process.env.DSH_HOME) return path.join(process.env.DSH_HOME, 'sessions');
  return path.join(os.homedir(), '.dsh', 'sessions');
}

function usage() {
  return [
    '用法：',
    '  token-meter scan   [--root DIR] [--json] [--limit N]',
    '  token-meter report [--root DIR] [--out FILE] [--format md|json]',
    '  token-meter cost   --in P --cache P --output P   （元/百万 tokens）',
    '  token-meter prices',
    '',
    `默认 root：${defaultRoot()}`
  ].join('\n');
}

function run() {
  const argv = parseArgs(process.argv.slice(2));
  const cmd = argv._[0] ?? 'report';
  const root = String(argv.root ?? defaultRoot());
  const priceTable = fs.existsSync(String(argv.config ?? ''))
    ? JSON.parse(fs.readFileSync(String(argv.config), 'utf8'))?.pricing
    : undefined;

  if (cmd === 'prices') {
    const table = DEFAULT_PRICE_TABLE;
    console.log(`价目表版本 ${table.version}（${table.currency} / 百万 tokens；高峰 ×${table.peakMultiplier}）`);
    console.log(`高峰窗口（北京时间小时，半开区间）：${table.peakWindows.map(([a, b]) => `${a}-${b}`).join(', ')}`);
    console.log(`高峰星期：${table.peakWeekdays.join(',')}；法定节假日 ${table.holidays.length} 天`);
    for (const [name, entry] of Object.entries(table.models)) {
      const off = entry.off;
      console.log(
        `  ${name.padEnd(32)} 空闲 输入 ${off.cacheMiss} / 缓存 ${off.cacheHit} / 输出 ${off.output}   高峰 输入 ${off.cacheMiss * 2} / 缓存 ${off.cacheHit * 2} / 输出 ${off.output * 2}`
      );
    }
    const now = ratesAt(undefined, Date.now(), table);
    console.log(`\n现在（${clockOf(Date.now())}）属于：${now.tierLabel}`);
    return 0;
  }

  if (cmd === 'cost') {
    const pin = Number(argv.in ?? argv.input);
    const pcache = Number(argv.cache);
    const pout = Number(argv.out ?? argv.output);
    if (![pin, pcache, pout].every((v) => Number.isFinite(v))) {
      console.error('需要 --in / --cache / --output 三个单价（元/百万 tokens）');
      return 2;
    }
    const scan = scanSessions(root);
    const agg = aggregate(scan.records, { priceTable });
    const inputTotal = agg.tokens.inputTotal;
    const total = (inputTotal / 1e6) * pin + (agg.tokens.cacheRead / 1e6) * pcache + (agg.tokens.output / 1e6) * pout;
    console.log(`调用 ${agg.calls.toLocaleString('en-US')} | 会话 ${agg.sessions} | ${clockOf(agg.firstAt)} → ${clockOf(agg.lastAt)}`);
    console.log(`输入 ${inputTotal.toLocaleString('en-US')} | 缓存命中 ${agg.tokens.cacheRead.toLocaleString('en-US')} | 输出 ${agg.tokens.output.toLocaleString('en-US')}`);
    console.log(`按 ${pin}/${pcache}/${pout}（元每百万）折算：¥${total.toFixed(2)}`);
    if (FLAT_SCENARIOS.length) {
      console.log('\n参考档位：');
      for (const s of agg.flat) console.log(`  ${s.label.padEnd(14)} ¥${s.cost.toFixed(2)}`);
    }
    return 0;
  }

  if (cmd === 'scan') {
    const scan = scanSessions(root);
    const agg = aggregate(scan.records, { priceTable });
    if (argv.json) {
      console.log(renderJson(agg, { root: scan.root, files: scan.files, warnings: scan.warnings }));
      return 0;
    }
    const limit = Number(argv.limit ?? 10);
    console.log(`文件 ${scan.files} | 会话 ${agg.sessions} | 采样 ${agg.calls.toLocaleString('en-US')} | 区间 ${clockOf(agg.firstAt)} → ${clockOf(agg.lastAt)}`);
    console.log(`Tokens ${agg.tokens.total.toLocaleString('en-US')}（缓存命中 ${(agg.cacheHitRate * 100).toFixed(2)}%）| 费用 ${agg.symbol}${agg.cost.total.toFixed(2)}`);
    console.log('\nTop 会话：');
    for (const s of agg.sessionsRank.slice(0, limit)) {
      console.log(`  ${String(s.rank).padStart(2)}. ${s.sessionId.slice(0, 26)}  ${String(s.tokens.total).padStart(14)}  ${s.title ?? ''}`);
    }
    if (scan.warnings.length) console.log(`\n⚠️ ${scan.warnings.length} 个文件解析失败`);
    return 0;
  }

  if (cmd === 'report') {
    const scan = scanSessions(root);
    if (!scan.files) {
      console.error(`没有在 ${root} 下找到会话日志（可用 --root 指定）`);
      return 1;
    }
    const agg = aggregate(scan.records, { priceTable });
    const format = String(argv.format ?? 'md');
    const text = format === 'json'
      ? renderJson(agg, { root: scan.root, files: scan.files, warnings: scan.warnings })
      : renderReport(agg, { root: scan.root, files: scan.files, warnings: scan.warnings });
    if (argv.out) {
      fs.mkdirSync(path.dirname(path.resolve(String(argv.out))), { recursive: true });
      fs.writeFileSync(String(argv.out), text, 'utf8');
      console.log(`已写入 ${path.resolve(String(argv.out))}`);
    } else {
      console.log(text);
    }
    return 0;
  }

  console.error(usage());
  return 2;
}

process.exitCode = run();
