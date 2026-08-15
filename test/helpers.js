/**
 * 测试用的工具。
 *
 * `parseCsv` 是**第二份实现**，故意的：拿写出器自己的逻辑去验写出器，
 * 等于问它「你觉得你写对了吗」。这一份是照 RFC 4180 单独写的，
 * 两边对不上的时候至少知道有一边错了。
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'canonical');

/**
 * RFC 4180 解析。返回二维数组（含表头行）。
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const push = () => { row.push(field); field = ''; };
  const endRow = () => { push(); rows.push(row); row = []; };

  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"' && field === '') { quoted = true; i += 1; continue; }
    if (c === ',') { push(); i += 1; continue; }
    if (c === '\r' && text[i + 1] === '\n') { endRow(); i += 2; continue; }
    if (c === '\n' || c === '\r') { endRow(); i += 1; continue; }
    field += c; i += 1;
  }
  if (field !== '' || row.length) endRow();
  return rows;
}

/**
 * 把一张 CSV 读成对象数组。**重复表头按「后一个赢」处理**——NeoDB 的
 * `csv.DictReader` 就是这么做的，而书评表里真的有两个 `title`。
 * @param {string} text
 * @returns {Record<string, string>[]}
 */
export function parseCsvObjects(text) {
  const [header, ...body] = parseCsv(text);
  return body.map((row) => {
    const o = {};
    header.forEach((h, i) => { o[h] = row[i] ?? ''; });
    return o;
  });
}

/** 从一组产出文件里按名字取一个。 */
export function fileNamed(files, name) {
  const f = files.find((x) => x.name === name);
  if (!f) throw new Error(`产出里没有 ${name}（有的是: ${files.map((x) => x.name).join(', ')}）`);
  return f;
}
