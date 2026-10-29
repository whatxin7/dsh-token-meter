import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTokenLedger } from '../src/token-ledger.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'token-ledger-')), 'usage.jsonl');
const at = (iso) => Date.parse(iso);

const messageEvent = (seq, over = {}) => ({
  type: 'assistant/message',
  seq,
  time: at('2026-10-26T01:30:00Z'),
  data: {
    turn: 1,
    step: 1,
    model: 'deepseek-flash',
    usage: { inputTokens: 10, cacheReadTokens: 90, outputTokens: 5 },
    ...over
  }
});

test('createTokenLedger：同一 (turn, step, retry) 重复重放只计一次（幂等）', () => {
  const ledger = createTokenLedger({ file: tmpFile() });
  const sid = 'session-x';
  assert.equal(ledger.ingestEvent({ sessionId: sid, event: messageEvent(5) }), true);
  assert.equal(ledger.ingestEvent({ sessionId: sid, event: messageEvent(5) }), false, '同 seq 重放必须被丢弃');
  const summary = ledger.summary();
  assert.equal(summary.totals.totalTokens, 105);
  assert.equal(summary.totals.steps, 1);
});

test('createTokenLedger：llm/retry-started 之后的重试另算一次请求', () => {
  const ledger = createTokenLedger({ file: tmpFile() });
  const sid = 'session-y';
  ledger.ingestEvent({ sessionId: sid, event: messageEvent(5) });
  ledger.ingestEvent({ sessionId: sid, event: { type: 'llm/retry-started', seq: 6, data: { turn: 1, step: 1, retry: 1 } } });
  ledger.ingestEvent({ sessionId: sid, event: messageEvent(7) });
  const summary = ledger.summary();
  assert.equal(summary.totals.totalTokens, 210, '重试的第二次请求要单独计费');
  assert.equal(summary.totals.steps, 2);
});

test('createTokenLedger：投影基线 + 基线之后的采样 = 会话总量，基线重发不重复计', () => {
  const ledger = createTokenLedger({ file: tmpFile() });
  const sid = 'session-z';
  const projection = { asOfSeq: 10, values: { tokenUsage: { inputTokens: 1000, cacheReadTokens: 9000, outputTokens: 500 } } };
  assert.equal(ledger.ingestBaseline({ sessionId: sid, projection }), true);
  assert.equal(ledger.ingestBaseline({ sessionId: sid, projection }), false, '内容与 seq 都没变的基线不再落盘');
  ledger.ingestEvent({ sessionId: sid, event: messageEvent(11) });
  const total = ledger.summary().totals.totalTokens;
  assert.equal(total, 10500 + 105);
});

test('createTokenLedger：压缩上限触发淘汰时，累计总量不缩水', () => {
  const ledger = createTokenLedger({ file: tmpFile(), maxLines: 3 });
  for (let i = 0; i < 12; i += 1) {
    ledger.ingestEvent({
      sessionId: 'session-evict',
      event: { type: 'assistant/message', seq: i, time: at('2026-10-26T01:30:00Z'), data: { turn: 1, step: i, usage: { inputTokens: 10 } } }
    });
  }
  const summary = ledger.summary();
  assert.equal(summary.totals.totalTokens, 120, '淘汰的是明细，不是总量');
  assert.ok(ledger.stats().samples <= 3);
});

test('createTokenLedger：reset() 之后账本归零（含被淘汰的累计）', () => {
  const file = tmpFile();
  const ledger = createTokenLedger({ file, maxLines: 2 });
  for (let i = 0; i < 5; i += 1) {
    ledger.ingestEvent({
      sessionId: 's',
      event: { type: 'assistant/message', seq: i, time: at('2026-10-26T01:30:00Z'), data: { turn: 1, step: i, usage: { inputTokens: 10 } } }
    });
  }
  assert.ok(ledger.summary().totals.totalTokens > 0);
  ledger.reset();
  assert.equal(ledger.summary().totals.totalTokens, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), '');
});
