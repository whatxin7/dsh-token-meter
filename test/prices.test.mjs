import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PRICE_TABLE,
  beijingParts,
  costOfBuckets,
  isPeakAt,
  normalizeUsage,
  ratesAt,
  resolvePriceTable
} from '../src/model-prices.js';

const utc = (iso) => Date.parse(iso);

test('beijingParts：不依赖本机时区地换算北京时间', () => {
  const p = beijingParts(utc('2026-10-26T01:30:00Z'));
  assert.equal(p.date, '2026-10-26');
  assert.equal(p.hour, 9);
  assert.equal(p.clock, '09:30');
  assert.equal(p.weekday, 1, '2026-10-26 是周一');
});

test('isPeakAt：高峰窗口是北京时间周一至周五 9-12、14-18', () => {
  assert.equal(isPeakAt(utc('2026-10-26T01:30:00Z')), true, '周一 09:30 高峰');
  assert.equal(isPeakAt(utc('2026-10-26T04:30:00Z')), false, '周一 12:30 午休空闲');
  assert.equal(isPeakAt(utc('2026-10-26T05:59:00Z')), false, '周一 13:59 空闲');
  assert.equal(isPeakAt(utc('2026-10-26T06:00:00Z')), true, '周一 14:00 高峰');
  assert.equal(isPeakAt(utc('2026-10-26T09:59:00Z')), true, '周一 17:59 高峰');
  assert.equal(isPeakAt(utc('2026-10-26T10:00:00Z')), false, '周一 18:00 结束');
  assert.equal(isPeakAt(utc('2026-10-24T02:00:00Z')), false, '周六全天空闲');
});

test('isPeakAt：法定节假日全天按空闲计价（否则静默高估一倍）', () => {
  assert.equal(isPeakAt(utc('2026-10-01T02:00:00Z')), false, '国庆 10-01 周四 10:00 仍空闲');
  assert.equal(isPeakAt(utc('2026-05-01T02:00:00Z')), false, '劳动节 05-01 周五 10:00 仍空闲');
});

test('ratesAt：高峰单价 = 空闲 × peakMultiplier，未知模型标 estimated', () => {
  const off = ratesAt('deepseek-flash', utc('2026-10-26T04:30:00Z'));
  const peak = ratesAt('deepseek-flash', utc('2026-10-26T01:30:00Z'));
  assert.equal(off.tier, 'off');
  assert.equal(peak.tier, 'peak');
  assert.equal(peak.cacheMiss, off.cacheMiss * DEFAULT_PRICE_TABLE.peakMultiplier);
  assert.equal(peak.output, off.output * DEFAULT_PRICE_TABLE.peakMultiplier);
  assert.equal(off.estimated, false);

  const unknown = ratesAt('some-unknown-model', utc('2026-10-26T04:30:00Z'));
  assert.equal(unknown.estimated, true);
  assert.equal(unknown.model, 'some-unknown-model');
});

test('costOfBuckets：三个输入桶分别计价，不能把 cacheRead 当 inputTokens', () => {
  const buckets = { cacheMiss: 1_000_000, cacheHit: 10_000_000, cacheWrite: 0, output: 1_000_000 };
  const rates = { unit: 1e6, cacheMiss: 1, cacheHit: 0.02, cacheWrite: 1, output: 4 };
  const cost = costOfBuckets(buckets, rates);
  assert.equal(cost.cacheMiss, 1);
  assert.ok(Math.abs(cost.cacheHit - 0.2) < 1e-9);
  assert.equal(cost.output, 4);
  assert.ok(Math.abs(cost.total - 5.2) < 1e-9);
});

test('normalizeUsage：同时接受 DSH 原始键名与账本键名', () => {
  const a = normalizeUsage({ inputTokens: 10, cacheReadTokens: 20, outputTokens: 30 });
  const b = normalizeUsage({ cacheMiss: 10, cacheHit: 20, output: 30 });
  assert.deepEqual({ ...a, reasoning: 0 }, { ...b, reasoning: 0 });
  assert.deepEqual(normalizeUsage(null), { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0 });
});

test('resolvePriceTable：用户覆盖项合并且非法值回落', () => {
  const table = resolvePriceTable({
    peakMultiplier: 3,
    models: { 'my-model': { label: '自定义', off: { cacheHit: 0.1, cacheMiss: 2, output: 8 } } }
  });
  assert.equal(table.peakMultiplier, 3);
  assert.equal(table.models['my-model'].off.output, 8);
  assert.equal(table.models['my-model'].off.cacheWrite, 2, '未写 cacheWrite 时跟随 cacheMiss');
  assert.equal(table.models['deepseek-flash'].off.output, 4, '内置档位仍在');

  const fallback = resolvePriceTable({ peakMultiplier: -1, unit: 'x' });
  assert.equal(fallback.peakMultiplier, 2);
  assert.equal(fallback.unit, 1e6);
});
