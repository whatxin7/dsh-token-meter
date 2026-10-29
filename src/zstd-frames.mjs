// 多帧 zstd 解码。
//
// 为什么需要它：DSH 的会话日志是 **追加写** 的，每次落盘都会新起一个 zstd frame，
// 于是 `session.v4.jsonl.zstd` 是「多个 frame 首尾相接」的流，而不是单个 frame。
// `zlib.zstdDecompressSync()` 只解第一个 frame —— 实测一个 13.8 KB 的文件用它会得到
// 1 行（真正的日志有 20 行），因此直接用它统计 token 会**静默少算 95%**。
//
// Node 没有暴露 `ZSTD_findFrameCompressedSize`，所以这里的做法是：
//   1. 找出所有 frame magic（0x28 B5 2F FD）的位置，作为候选切点；
//   2. 从候选切点 i 开始，逐个尝试解到后面的切点 j（j 从 i+1 递增）；
//      第一次解成功就把这一段作为一帧，继续从 j 开始。
//   3. 全部候选都解不出来时跳过该切点（magic 可能是压缩体里偶然出现的字节）。
//
// 第 2 步决定了对「压缩体里恰好出现 magic」的情形是安全的：切开后解不出来，
// 就会自然向后合并，直到跨过那个假切点为止。文件里 frame 数量在几十到几百量级，
// 所以这个「向后试探」的代价可以忽略。

import zlib from 'node:zlib';

/** zstd frame magic（little-endian 写入的 0xFD2FB528）。 */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 判断一段 buffer 是否是 zstd（可能带 skippable frame，也可直接是 raw jsonl）。
 * @param {Buffer} buf
 */
export function looksLikeZstd(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return false;
  return buf.subarray(0, 4).equals(ZSTD_MAGIC);
}

/**
 * 解出多帧 zstd 的全部内容。
 * @param {Buffer|Uint8Array} input
 * @returns {Buffer} 所有 frame 解压后拼接的结果
 */
export function decodeZstdFrames(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error('当前 Node 缺少 zlib.zstdDecompressSync（需要 Node >= 22.15 或 >= 23）');
  }
  const starts = [];
  let at = buf.indexOf(ZSTD_MAGIC, 0);
  while (at !== -1) {
    starts.push(at);
    at = buf.indexOf(ZSTD_MAGIC, at + ZSTD_MAGIC.length);
  }
  if (!starts.length) return Buffer.alloc(0);
  if (starts[0] !== 0) starts.unshift(0);

  const out = [];
  let i = 0;
  while (i < starts.length) {
    let advanced = false;
    for (let j = i + 1; j <= starts.length; j += 1) {
      const end = j < starts.length ? starts[j] : buf.length;
      const chunk = buf.subarray(starts[i], end);
      if (chunk.length <= ZSTD_MAGIC.length) continue;
      try {
        out.push(zlib.zstdDecompressSync(chunk));
        i = j;
        advanced = true;
        break;
      } catch {
        // 这一刀切在了压缩体内部：继续向后合并。
      }
    }
    if (!advanced) i += 1; // 认不出的片段：跳过，别让解析卡死
  }
  return Buffer.concat(out);
}

/**
 * 把会话日志（单帧 zstd / 多帧 zstd / 纯 JSONL）统一解码成文本。
 * @param {Buffer} buf 原始文件内容
 * @param {string} [file] 仅用于报错信息
 */
export function decodeSessionBuffer(buf, file = '') {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const text = looksLikeZstd(buf) ? decodeZstdFrames(buf).toString('utf8') : buf.toString('utf8');
  if (!text && buf.length) {
    throw new Error(`无法解码会话文件${file ? ` ${file}` : ''}：解压结果为空（是否为未知压缩格式？）`);
  }
  return text;
}
