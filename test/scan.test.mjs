import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { bucketsOfUsage, listSessionFiles, parseSessionFile, scanSessions, totalOfBuckets } from '../src/scan.mjs';

const event = (obj) => `${JSON.stringify(obj)}\n`;

function makeSessionsFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-meter-'));
  const sessDir = path.join(root, 'proj-a', 'session-1111');
  fs.mkdirSync(sessDir, { recursive: true });
  const lines = [
    event({ type: 'session', version: 4, id: 'session-1111', cwd: 'D:\\projects\\demo' }),
    event({ type: 'session/title', time: 1000, data: { title: '旧标题' } }),
    event({ type: 'session/title', time: 2000, data: { title: '接入 QQ 桥接插件' } }),
    event({ type: 'request/context', data: { provider: 'deepseek-v4-flash-vision-exp', model: 'DeepSeek-V4-Flash-Vision-Exp' } }),
    event({
      type: 'assistant/message',
      seq: 5,
      time: Date.parse('2026-10-26T01:30:00Z'),
      data: { turn: 1, step: 1, usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 50, totalTokens: 1050 } }
    }),
    event({
      type: 'assistant/message',
      seq: 6,
      time: Date.parse('2026-10-26T02:00:00Z'),
      data: { turn: 1, step: 2, usage: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0 } }
    }),
    event({ type: 'compaction/summary', seq: 7, time: Date.parse('2026-10-26T02:30:00Z'), data: { usage: { inputTokens: 20, cacheReadTokens: 30, outputTokens: 10 } } })
  ].join('');
  fs.writeFileSync(path.join(sessDir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(lines, 'utf8')));

  // 第二个会话：多帧（模拟追加写）
  const sess2 = path.join(root, 'proj-b', 'session-2222');
  fs.mkdirSync(sess2, { recursive: true });
  const parts = [
    event({ type: 'session', id: 'session-2222', cwd: 'C:\\other' }),
    event({ type: 'assistant/message', seq: 1, time: Date.parse('2026-10-27T03:00:00Z'), data: { turn: 1, step: 1, usage: { inputTokens: 1, cacheReadTokens: 2, outputTokens: 3 } } })
  ];
  const buf = Buffer.concat(parts.map((p) => zlib.zstdCompressSync(Buffer.from(p, 'utf8'))));
  fs.writeFileSync(path.join(sess2, 'session.v4.jsonl.zstd'), buf);

  // 纯 JSONL 也要能读
  const sess3 = path.join(root, 'proj-b', 'session-3333');
  fs.mkdirSync(sess3, { recursive: true });
  fs.writeFileSync(
    path.join(sess3, 'session.v4.jsonl'),
    event({ type: 'session', id: 'session-3333' }) +
      event({ type: 'assistant/message', seq: 1, time: Date.parse('2026-10-27T04:00:00Z'), data: { turn: 1, step: 1, usage: { outputTokens: 7 } } })
  );
  return root;
}

test('bucketsOfUsage：兼容两种键名，负数与非法值按 0 处理', () => {
  assert.deepEqual(bucketsOfUsage({ inputTokens: 5, cacheReadTokens: 6, cacheWriteTokens: 7, outputTokens: 8 }), {
    input: 5,
    cacheRead: 6,
    cacheWrite: 7,
    output: 8
  });
  assert.deepEqual(bucketsOfUsage({ cacheMiss: 1, cacheHit: 2, output: 3 }), { input: 1, cacheRead: 2, cacheWrite: 0, output: 3 });
  assert.deepEqual(bucketsOfUsage({ inputTokens: -5, outputTokens: 'x' }), { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
  assert.equal(totalOfBuckets({ input: 1, cacheRead: 2, cacheWrite: 3, output: 4 }), 10);
});

test('listSessionFiles：递归列出 .jsonl 与 .jsonl.zstd，忽略其它文件', () => {
  const root = makeSessionsFixture();
  fs.writeFileSync(path.join(root, 'proj-a', 'notes.txt'), 'ignore me');
  const files = listSessionFiles(root);
  assert.equal(files.length, 3);
  assert.ok(files.every((f) => /\.jsonl(\.zstd)?$/.test(f)));
});

test('parseSessionFile：取最后一条标题、模型、cwd，并丢弃全零 usage', () => {
  const root = makeSessionsFixture();
  const file = path.join(root, 'proj-a', 'session-1111', 'session.v4.jsonl.zstd');
  const parsed = parseSessionFile(file);
  assert.equal(parsed.sessionId, 'session-1111');
  assert.equal(parsed.project, 'proj-a');
  assert.equal(parsed.cwd, 'D:\\projects\\demo');
  assert.equal(parsed.title, '接入 QQ 桥接插件');
  assert.equal(parsed.records.length, 2, '全零 usage 的那条必须丢弃');
  assert.equal(parsed.records[0].provider, 'deepseek-v4-flash-vision-exp');
  assert.equal(parsed.records[0].model, 'DeepSeek-V4-Flash-Vision-Exp');
  assert.deepEqual(parsed.records[0].buckets, { input: 100, cacheRead: 900, cacheWrite: 0, output: 50 });
  assert.equal(parsed.records[1].kind, 'compaction/summary', 'compaction 也消耗 token，要计入');
});

test('scanSessions：多帧 zstd 与纯 JSONL 都被完整读出，且按时间排序', () => {
  const root = makeSessionsFixture();
  const scan = scanSessions(root);
  assert.equal(scan.files, 3);
  assert.equal(scan.sessions, 3);
  assert.equal(scan.records.length, 4);
  assert.deepEqual(scan.warnings, []);
  const times = scan.records.map((r) => r.t);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.equal(scan.records.at(-1).buckets.output, 7);
});

test('scanSessions：坏文件只记 warning，不中断整轮扫描', () => {
  const root = makeSessionsFixture();
  const bad = path.join(root, 'proj-c', 'session-4444');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'session.v4.jsonl.zstd'), Buffer.from([1, 2, 3, 4, 5]));
  const scan = scanSessions(root);
  assert.equal(scan.warnings.length, 1);
  assert.equal(scan.records.length, 4, '其余文件照常统计');
});
