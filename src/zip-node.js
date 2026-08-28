/**
 * `zip.js` 的 Node 绑定：把 `node:zlib` 接上去。
 *
 * 格式那一半在 `zip.js` 里，一个内建模块都不碰，因为扩展要原样拿去用。这里只补
 * 「怎么压」这一件事——Node 有 `deflateRawSync`，浏览器有
 * `CompressionStream('deflate-raw')`，两边不可能共用同一行代码。
 *
 * **压缩级别写死 9。** 产物要求逐字节可复现（见 `zip.js` 关于时间戳那一段），
 * 而 zlib 的默认级别是个可能随版本变的值。
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { zip as zipPure, unzip as unzipPure } from './zip.js';

/** @type {{deflateRaw: (b: Uint8Array) => Uint8Array, inflateRaw: (b: Uint8Array) => Uint8Array}} */
export const nodeCodec = {
  deflateRaw: (bytes) => new Uint8Array(deflateRawSync(bytes, { level: 9 })),
  inflateRaw: (bytes) => new Uint8Array(inflateRawSync(bytes)),
};

/** @param {{name: string, text: string}[]} files @returns {Promise<Uint8Array>} */
export const zip = (files) => zipPure(files, nodeCodec);

/** @param {Uint8Array} buf @returns {Promise<Map<string, string>>} */
export const unzip = (buf) => unzipPure(buf, nodeCodec);
