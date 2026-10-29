import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, dateOf, normalizeModelKey, themeOf, FALLBACK_THEME } from '../src/aggregate.mjs';
import { renderJson, renderReport } from '../src/report.mjs';

const rec = (over = {}) => ({
  t: Date.parse('2026-10-26T01:30:00Z'),
  sessionId: 'session-a',
  project: 'proj',
  title: '接入 QQ 桥接插件',
  provider: 'deepseek-flash',
  model: 'DeepSeek-V4-Flash-Vision-Exp',
  buckets: { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 1_000_000 },
  ...over
});

test('normalizeModelKey：provider 短名优先，其次按 flash/pro 兜底', () => {
  assert.equal(normalizeModelKey('deepseek-flash', 'whatever'), 'deepseek-flash');
  assert.equal(normalizeModelKey('deepseek-v4-pro', 'DeepSeek-V4-Pro'), 'deepseek-v4-pro');
  assert.equal(normalizeModelKey(null, 'DeepSeek-V4-Flash-Vision-Exp'), 'deepseek-v4-flash-vision-exp');
  assert.equal(normalizeModelKey(null, 'Some-Pro-Model'), 'deepseek-pro');
  assert.equal(normalizeModelKey(null, null), 'deepseek-flash');
});

test('themeOf：按标题关键词与项目目录归类，归类不了落到兜底桶', () => {
  assert.equal(themeOf({ title: '接入 QQ 桥接插件', project: 'p' }), '插件安装与桥接');
  assert.equal(themeOf({ title: '好友申请与白名单', project: 'p' }), '好友 / 白名单 / 权限');
  assert.equal(themeOf({ title: '语音唱歌音色', project: 'p' }), '语音 / 唱歌 / 音色');
  assert.equal(themeOf({ title: '表情包斗图', project: 'p' }), '表情包 / 斗图');
  assert.equal(themeOf({ title: '随手一问', project: 'qq-bridge/state/agents' }), '她在线聊天（bridge 自动起的会话）');
  assert.equal(themeOf({ title: '随手一问', project: 'p' }), FALLBACK_THEME);
});

test('dateOf：按北京时间切日，跨零点不串天', () => {
  assert.equal(dateOf(Date.parse('2026-10-26T15:59:00Z')), '2026-10-26');
  assert.equal(dateOf(Date.parse('2026-10-26T16:00:00Z')), '2026-10-27');
});

test('aggregate：高峰时段按 2 倍计价，合计 = 各档位之和', () => {
  const agg = aggregate([rec()]);
  assert.equal(agg.calls, 1);
  assert.equal(agg.tokens.total, 2_000_000);
  // 高峰：输入 1×2=2 元/百万，输出 4×2=8 元/百万 → 2 + 8 = 10
  assert.ok(Math.abs(agg.cost.total - 10) < 1e-9);
  assert.ok(Math.abs(agg.cost.peak - 10) < 1e-9);
  assert.equal(agg.cost.off, 0);
});

test('aggregate：同一天的高峰与空闲分别累计，日表按日期升序', () => {
  const agg = aggregate([
    rec({ t: Date.parse('2026-10-26T01:30:00Z') }), // 周一 09:30 高峰
    rec({ t: Date.parse('2026-10-26T04:30:00Z'), sessionId: 'session-b' }) // 周一 12:30 空闲
  ]);
  assert.equal(agg.daily.length, 1);
  assert.equal(agg.daily[0].calls, 2);
  assert.ok(Math.abs(agg.cost.off - 5) < 1e-9, '空闲档：1×1 + 1×4 = 5');
  assert.ok(Math.abs(agg.cost.total - 15) < 1e-9);
});

test('aggregate：主题/项目/模型三个维度都聚合到，且占比自洽', () => {
  const agg = aggregate([
    rec(),
    rec({ sessionId: 'session-c', title: '语音唱歌', t: Date.parse('2026-10-27T04:00:00Z') })
  ]);
  assert.equal(agg.sessions, 2);
  const themes = agg.themes.map((t) => t.theme);
  assert.deepEqual(themes.sort(), ['插件安装与桥接', '语音 / 唱歌 / 音色'].sort());
  const shareSum = agg.themes.reduce((s, t) => s + t.share, 0);
  assert.ok(Math.abs(shareSum - 1) < 1e-9);
  assert.equal(agg.projects[0].project, 'proj');
  assert.equal(agg.models[0].model, 'deepseek-flash');
  assert.ok(Math.abs(agg.cacheHitRate - 0) < 1e-9);
});

test('aggregate：换价目表口径 = 输入(含 cacheWrite)×P_in + 缓存×P_cache + 输出×P_out', () => {
  const agg = aggregate([rec({ buckets: { input: 2_000_000, cacheRead: 10_000_000, cacheWrite: 0, output: 1_000_000 } })]);
  const flat = agg.flat.find((f) => f.label === 'Flash 常见档');
  // 2×1 + 10×0.2 + 1×4 = 8
  assert.ok(Math.abs(flat.cost - 8) < 1e-9);
});

test('renderReport / renderJson：报告含关键段落，JSON 可被解析', () => {
  const agg = aggregate([rec(), rec({ sessionId: 'session-b', title: '好友白名单' })]);
  const md = renderReport(agg, { root: '/tmp/sessions', files: 2, warnings: [] });
  for (const heading of ['# DSH Token 用量与费用核算', '## 总量', '## 费用（官方峰谷口径）', '## 每日用量', '## 按功能主题分布', '## 口径与校验']) {
    assert.ok(md.includes(heading), `缺少段落：${heading}`);
  }
  assert.ok(md.includes('session-a'));
  const json = JSON.parse(renderJson(agg, { root: '/tmp/sessions', files: 2 }));
  assert.equal(json.calls, 2);
  assert.equal(json.tokens.total, 4_000_000);
  assert.ok(Array.isArray(json.themes));
});
