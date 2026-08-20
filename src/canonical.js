/**
 * 读 canonical，压成「当前状态」。
 *
 * ## 导出是有损的，而且损失的正是这个项目的卖点
 *
 * canonical 是一份**事件日志**：一条标记带着若干 revision，每条 revision 记着
 * 是哪个 `parser_version` 在什么时候看见了什么。NeoDB 的 CSV、Letterboxd 的
 * CSV、Goodreads 的 CSV——三个都只收「现在是什么样」，一条记录一行。
 *
 * 所以这里做的事只有一件：**取最后一条 revision，其余全部丢掉。**
 *
 * 这是对外适配器该有的方向。三个目标平台都是「向外」的出口，不是储存格式——
 * 档案本身留在 canonical 里，导出的那份丢了随时能重出一份。反过来就是灾难：
 * 拿 NeoDB 的形状当储存格式，等于把版本历史、每字段摘要、回指 WARC 的
 * `capture_ids` 一次性删干净，而且不可逆。
 *
 * 实测这份档案 2950 条标记里有 8 条带多次 revision，也就是 8 条的历史会在导出里
 * 消失。数字小不代表可以不说——**恰恰因为小，用户不会自己发现。**
 * 所以 `bin/export.js` 会把它打出来。
 *
 * ## 「最后一条」按 `last_observed_at` 取，不按数组下标
 *
 * 解析器是按顺序追加的，下标取最后一条今天就是对的。但那是解析器的实现细节，
 * 不是 canonical 规定的次序；照下标取等于把一条没写进 spec 的保证当成保证。
 * 按时间取多花不了什么，而且错了会明显（时间倒退），不会静默。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** canonical 目录里可能有的文件。缺哪个都不算错——豆列是后加的，老目录里没有。 */
const FILES = {
  marks: 'marks.ndjson',
  subjects: 'subjects.ndjson',
  longform: 'longform.ndjson',
  doulists: 'doulists.ndjson',
  broadcasts: 'broadcasts.ndjson',
};

/**
 * 读一个 ndjson 文件。
 * @param {string} path
 * @returns {object[]}
 */
function readNdjson(path) {
  if (!existsSync(path)) return [];
  const rows = [];
  const text = readFileSync(path, 'utf8');
  let lineNo = 0;
  for (const line of text.split('\n')) {
    lineNo += 1;
    const s = line.trim();
    if (!s) continue;
    try {
      rows.push(JSON.parse(s));
    } catch (e) {
      throw new Error(`${path} 第 ${lineNo} 行不是合法 JSON: ${e.message}`);
    }
  }
  return rows;
}

/**
 * 取一条记录的当前状态（最后一次观测到的那条 revision）。
 * @param {{revisions?: object[]}} record
 * @returns {object|null} revision，没有 revision 时是 null
 */
export function latest(record) {
  const revs = record?.revisions;
  if (!Array.isArray(revs) || revs.length === 0) return null;
  let best = revs[0];
  for (const r of revs) {
    if ((r.last_observed_at ?? '') >= (best.last_observed_at ?? '')) best = r;
  }
  return best;
}

/** 当前状态的 `fields`，永远返回一个对象，省得每个调用点都判空。 */
export function fieldsOf(record) {
  return latest(record)?.fields ?? {};
}

/**
 * 读整个 canonical 目录。
 * @param {string} dir
 * @returns {{marks: object[], subjects: object[], longform: object[], doulists: object[],
 *            broadcasts: object[], subjectOf: (mark: object) => object,
 *            multiRevisionMarks: number, account: {user_id?: string, username?: string}|null}}
 */
export function loadCanonical(dir) {
  const out = /** @type {any} */ ({});
  for (const [key, name] of Object.entries(FILES)) out[key] = readNdjson(join(dir, name));

  if (out.marks.length === 0 && out.subjects.length === 0) {
    throw new Error(`${dir} 看着不像 canonical 目录（marks.ndjson / subjects.ndjson 都没有）`);
  }

  // 作品数据是按 (medium, id) 定位的：豆瓣的 subject id 在不同 medium 下会撞号。
  const byKey = new Map();
  for (const s of out.subjects) byKey.set(`${s.medium}:${s.id}`, s);
  out.subjectOf = (mark) => byKey.get(`${mark.medium}:${mark.subject?.id}`) ?? null;

  out.multiRevisionMarks = out.marks.filter((m) => (m.revisions?.length ?? 0) > 1).length;
  out.account = out.marks[0]?.account ?? out.doulists[0]?.account ?? null;

  return out;
}
