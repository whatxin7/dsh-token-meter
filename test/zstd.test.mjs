import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { decodeSessionBuffer, decodeZstdFrames, looksLikeZstd } from '../src/zstd-frames.mjs';

const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'));

test('decodeZstdFrames：多帧首尾相接必须全部解开（只解首帧会漏掉 95% 的日志）', () => {
  const chunks = ['{"type":"session"}\n', '{"type":"user/message"}\n', '{"type":"assistant/message"}\n'];
  const buf = Buffer.concat(chunks.map(frame));
  const text = decodeZstdFrames(buf).toString('utf8');
  assert.equal(text, chunks.join(''));
  assert.equal(text.split('\n').filter(Boolean).length, 3);
});

test('decodeZstdFrames：压缩体里出现 magic 字节也不会被切坏', () => {
  // 强制正文里带 zstd magic：反复构造随机内容直到压缩结果包含该 4 字节，
  // 否则这个用例会静默退化成"只要解得出就行"。
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  let payload = null;
  let compressed = null;
  for (let i = 0; i < 4000; i += 1) {
    const text = `{"pad":"${'x'.repeat(40)}${i}","magic":-1812598487}`;
    const c = zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
    if (c.includes(magic)) {
      payload = text;
      compressed = c;
      break;
    }
  }
  assert.ok(compressed, '构造样本失败：压缩结果里没有出现 magic');
  const buf = Buffer.concat([frame('{"a":1}\n'), compressed, frame('{"b":2}\n')]);
  const text = decodeZstdFrames(buf).toString('utf8');
  assert.equal(text, `{"a":1}\n${payload}{"b":2}\n`);
});

test('decodeSessionBuffer：纯 JSONL 原样返回，zstd 自动识别', () => {
  const plain = Buffer.from('{"type":"session"}\n');
  assert.equal(decodeSessionBuffer(plain), '{"type":"session"}\n');

  const packed = frame('{"type":"session"}\n');
  assert.equal(looksLikeZstd(packed), true);
  assert.equal(decodeSessionBuffer(packed), '{"type":"session"}\n');
});

test('decodeSessionBuffer：空文件不报错，非 zstd 内容按文本返回（由上层判定是否合法）', () => {
  assert.equal(decodeSessionBuffer(Buffer.alloc(0)), '');
  // 不是 zstd 就当文本读；「这不是会话日志」由 parseSessionFile 用事件数判定并抛错，
  // 免得把「压缩格式不认识」和「文件类型不对」混成一个静默的空结果。
  assert.equal(decodeSessionBuffer(Buffer.from([1, 2, 3, 4])).length, 4);
});
