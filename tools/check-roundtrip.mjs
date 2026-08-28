#!/usr/bin/env node
/**
 * 把导进去的那份跟 **NeoDB 自己导出来的那份** 对一遍。**导入之后跑。**
 *
 *   node tools/check-roundtrip.mjs <我们的 zip 或导出目录> <NeoDB 导出的 zip>
 *
 * NeoDB 的导出在「设置 → 数据 → 导出」，出来的也是同一套 NDJSON。
 *
 * ## 这跟 check-export.mjs 不是一回事
 *
 * `check-export.mjs` 问的是「我马上要传上去的这堆文件，跟我的档案对得上吗」，
 * 两边都是我们自己写的，**同一个 bug 会同时出现在两边**。
 *
 * 这个脚本问的是另一个问题：**传上去之后，服务器那边真的存成了我们写的样子吗。**
 * 中间隔着 `journal/importers/ndjson.py` 的每一个 `update_or_create`，而那一层的
 * 行为只能读源码猜——「`defaults` 是覆盖不是合并」「导标记本身就会生成一条历史」
 * 这两条，本地跑再多测试也测不出来，因为出错的那个环境在服务器上。
 *
 * 2026-08-25 第一次跑就是这么用的：46 条状态历史全部原样回来，元数据一个字不差，
 * 服务器多出来的 9 条正好等于「那天没有广播的标记」——`ensure_log_entry` 自己建的。
 * 修之前同一份包会撞出 38 条重复。
 *
 * ## 判据
 *
 * - 我们写的每一条，服务器上都要有，且字段一个字不差。
 * - 服务器多出来的状态历史，每一条都要能解释成「标记自己那条事件」。
 *   解释不了的就报出来——那多半是我们把一件事写成了两行。
 *
 * 退出码：0 全对，1 有对不上的。
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { unzip } from '../src/zip-node.js';

const [oursArg, theirsArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!oursArg || !theirsArg) {
  console.error('用法: node tools/check-roundtrip.mjs <我们的 zip 或导出目录> <NeoDB 导出的 zip>');
  process.exit(2);
}

/** 给的是目录就往里找那个 zip，给的是 zip 就直接用。 */
function resolveZip(p) {
  if (existsSync(p) && statSync(p).isDirectory()) {
    for (const c of [join(p, 'neodb', 'neodb-ndjson-import.zip'), join(p, 'neodb-ndjson-import.zip')]) {
      if (existsSync(c)) return c;
    }
    console.error(`${p} 里没找到 neodb-ndjson-import.zip`);
    process.exit(2);
  }
  if (!existsSync(p)) { console.error(`${p} 不存在`); process.exit(2); }
  return p;
}

/** @returns {{journal: any[], catalog: any[], hasActor: boolean}} */
async function readPackage(zipPath) {
  const files = await unzip(readFileSync(zipPath));
  const lines = (name) => (files.get(name) ?? '')
    .split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => JSON.parse(l));
  // 两边的第一行都是文件头（server / username / …），没有 `type` 也没有 `id`，
  // 按这个筛掉就行——`parse_catalog` 跳过没有 `id` 的行也是同一个道理。
  return {
    journal: lines('journal.ndjson').filter((d) => d.type),
    catalog: lines('catalog.ndjson').filter((d) => d.id),
    hasActor: files.has('actor.ndjson'),
  };
}

const ours = await readPackage(resolveZip(oursArg));
const theirs = await readPackage(resolveZip(theirsArg));

const problems = [];
const bad = (m) => problems.push(m);
const notes = [];

/**
 * 按显示宽度补空格。中日韩字符在终端里占两列，`padEnd` 按码位数补会歪。
 */
const pad = (s, width) => {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    const wide = c >= 0x1100 && (c <= 0x115f
      || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f)
      || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6));
    w += wide ? 2 : 1;
  }
  return s + ' '.repeat(Math.max(0, width - w));
};

// ── 条目对照 ─────────────────────────────────────────────────────────────
// 我们的条目 id 是豆瓣 URL，服务器上是它自己的 uuid URL，两边只能靠外部链接搭桥。
// 我们那条自己的 id（豆瓣 URL）也算一条链接——`parse_catalog` 就是拿它匹配的。
const linkToOurs = new Map();
for (const c of ours.catalog) {
  for (const u of [c.id, ...(c.external_resources ?? []).map((r) => r.url)]) {
    if (!linkToOurs.has(u)) linkToOurs.set(u, new Set());
    linkToOurs.get(u).add(c.id);
  }
}
/** 服务器条目 id → 我们的条目 id */
const theirsToOurs = new Map();
for (const c of theirs.catalog) {
  const votes = new Map();
  for (const r of c.external_resources ?? []) {
    for (const o of linkToOurs.get(r.url) ?? []) votes.set(o, (votes.get(o) ?? 0) + 1);
  }
  let best = null;
  for (const [o, n] of votes) if (!best || n > best[1]) best = [o, n];
  if (best) theirsToOurs.set(c.id, best[0]);
}
const resolved = new Set(theirsToOurs.values());
const missingItems = ours.catalog.filter((c) => !resolved.has(c.id));
if (missingItems.length) {
  bad(`条目：我们送了 ${ours.catalog.length} 个，服务器上认出 ${resolved.size} 个`);
  for (const c of missingItems.slice(0, 10)) bad(`  服务器上没有：${c.title ?? ''} ${c.id}`);
}
notes.push(`${pad('条目', 16)} 我们 ${String(ours.catalog.length).padStart(5)} 个 · 服务器 ${theirs.catalog.length} 个 · 对上 ${resolved.size} 个`);

// ── 时间 ─────────────────────────────────────────────────────────────────
// 服务器导出来是 UTC，中间还带个空格（`2023-10-14 16:00:00+00:00`）；
// 我们写的是 `+08:00`。比之前一律归成毫秒数，不比字符串。
const at = (s) => (s ? Date.parse(String(s).replace(' ', 'T')) : null);
/**
 * 归到 +08:00 的那一天。豆瓣的 `marked_at` 是那个时区的零点，日界线要按它划。
 * @param {number | null} ms 已经是毫秒数，不是字符串——这里传错过一次，
 *   `Date.parse` 拿到数字返回 NaN，`toISOString` 才抛出来。
 */
const day = (ms) => (Number.isFinite(ms) ? new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10) : null);

// ── 逐类对照 ─────────────────────────────────────────────────────────────
const of = (pkg, t) => pkg.journal.filter((d) => d.type === t);
/** 服务器那条记录指向的条目，翻译成我们的 id。翻不出来就留原样，好歹能看出是哪条。 */
const item = (d) => {
  const u = d.content?.withRegardTo ?? d.item;
  return theirsToOurs.get(u) ?? u;
};
// `visibility` 为 0 时我们整个键都不写——`import_*` 一律 `data.get("visibility", 0)`。
// 实测服务器导回来是 0，所以这里两边都按缺省 0 比。
const vis = (d) => d.visibility ?? 0;

/**
 * @param {string} label
 * @param {any[]} a 我们的
 * @param {any[]} b 服务器的
 * @param {(d: any) => string} key 同一条记录在两边算出来要一样
 * @param {(d: any, k: string) => Record<string, unknown>} val 要逐字比的字段
 */
function compare(label, a, b, key, val) {
  const A = new Map(a.map((d) => [key(d), d]));
  const B = new Map(b.map((d) => [key(d), d]));
  let same = 0;
  for (const [k, d] of A) {
    const o = B.get(k);
    if (!o) { bad(`${label}：我们送了 ${k}，服务器上没有`); continue; }
    const x = JSON.stringify(val(d, k));
    const y = JSON.stringify(val(o, k));
    if (x !== y) {
      bad(`${label}：${k} 存进去变了样`);
      bad(`  我们  ${x.slice(0, 200)}`);
      bad(`  服务器 ${y.slice(0, 200)}`);
    } else same += 1;
  }
  const extra = [...B.keys()].filter((k) => !A.has(k));
  // 多出来的只提一句。这个账号里本来就可能有别的东西，那不是我们的错；
  // 状态历史是唯一一处「多出来」有确定含义的，单独在下面处理。
  const tail = extra.length ? ` · 服务器上另有 ${extra.length} 条不是我们送的` : '';
  notes.push(`${pad(label, 16)} 我们 ${String(a.length).padStart(5)} 条 · 对上 ${same} 条${tail}`);
  return { extra: extra.map((k) => B.get(k)) };
}

// 档案里有些标记根本没有日期（豆瓣那一行就没写），我们**故意不写 `published`**——
// 编一个日期出来是替用户宣称他那天标记过。服务器于是拿导入那一刻当日期，
// 所以这几条的日期一定对不上，而且这不是错。实测全量 2943 条里有 8 条。
//
// 这类「一定会报、又永远修不掉」的条目必须挪出错误列表：**一个永远有内容的
// 失败清单，就是一个没人看的失败清单。** 8 条足够盖住第 9 条真的问题。
const undated = new Set(of(ours, 'ShelfMember')
  .filter((d) => !d.content.published)
  .map((d) => `${d.content.withRegardTo} ${d.content.status}`));

compare('标记', of(ours, 'ShelfMember'), of(theirs, 'ShelfMember'),
  (d) => `${item(d)} ${d.content.status}`,
  (d, k) => (undated.has(k)
    ? { visibility: vis(d) }
    : { published: at(d.content.published), visibility: vis(d) }));
if (undated.size) {
  notes.push(`${pad('', 16)}      其中 ${undated.size} 条档案里没有标记日期，服务器拿导入那一刻当日期（不比日期）`);
}

compare('评分', of(ours, 'Rating'), of(theirs, 'Rating'),
  (d) => item(d), (d) => ({ value: d.content.value, visibility: vis(d) }));

compare('短评', of(ours, 'Comment'), of(theirs, 'Comment'),
  (d) => item(d), (d) => ({ content: d.content.content, visibility: vis(d) }));

compare('标签', of(ours, 'Tag'), of(theirs, 'Tag'), (d) => d.name, () => ({}));

compare('标签关联', of(ours, 'TagMember'), of(theirs, 'TagMember'),
  (d) => `${d.content.tag} ${item(d)}`, () => ({}));

compare('书评影评', of(ours, 'Review'), of(theirs, 'Review'),
  (d) => `${item(d)} ${d.content.name}`,
  (d) => ({ content: d.content.content.trim(), visibility: vis(d) }));

compare('笔记', of(ours, 'Note'), of(theirs, 'Note'),
  (d) => `${item(d)} ${d.content.title}`,
  (d) => ({ content: d.content.content.trim(), visibility: vis(d) }));

// Article 的正文我们走 `source`（markdown），服务器存的时候会同时渲染出一份 html
// 放在 `content`，所以只比 `source` 那一份——比 `content` 等于在比 NeoDB 的渲染器。
compare('不挂作品的日记', of(ours, 'Article'), of(theirs, 'Article'),
  (d) => d.content.name,
  (d) => ({ source: (d.content.source?.content ?? '').trim(), visibility: vis(d) }));

// 豆列单独比：条目要翻译，而且**私密那份必须还是私密的**。
{
  const A = new Map(of(ours, 'Collection').map((d) => [d.content.name, d]));
  const B = new Map(of(theirs, 'Collection').map((d) => [d.content.name, d]));
  let same = 0;
  for (const [name, d] of A) {
    const o = B.get(name);
    if (!o) { bad(`豆列：「${name}」服务器上没有`); continue; }
    if (vis(d) !== vis(o)) {
      bad(`豆列：「${name}」可见性 ${vis(d)} 存成了 ${vis(o)}` + (vis(d) === 2 ? '——私密豆列变公开了' : ''));
      continue;
    }
    const mine = (d.items ?? []).map((x) => x.item).sort();
    const got = (o.items ?? []).map((x) => theirsToOurs.get(x.item) ?? x.item).sort();
    if (JSON.stringify(mine) !== JSON.stringify(got)) {
      bad(`豆列：「${name}」我们送了 ${mine.length} 条，服务器上是 ${got.length} 条`);
      const lost = mine.filter((x) => !got.includes(x));
      for (const x of lost.slice(0, 5)) bad(`  丢了：${x}`);
      continue;
    }
    same += 1;
  }
  notes.push(`${pad('豆列', 16)} 我们 ${String(A.size).padStart(5)} 份 · 对上 ${same} 份`);
}

// ── 状态历史 ─────────────────────────────────────────────────────────────
// 这一段是这个脚本存在的理由。导一条标记，NeoDB 自己就会 `ensure_log_entry()`
// 建一行历史，再把标记**当前**的星和短评写进去。所以服务器上比我们送的多，是正常的；
// **多出来的每一行都必须能解释成「某条标记自己那件事」**。解释不了的那一行，
// 十有八九是我们把同一件事写成了两行——2026-08-24 那个 bug 就是这么来的。
{
  const marks = new Map();
  for (const d of of(ours, 'ShelfMember')) {
    marks.set(`${item(d)} ${d.content.status}`, at(d.content.published));
  }
  // 没有标记日期那几条，服务器是拿导入那一刻当日期建的行，所以「标记本身那件事」
  // 的时间戳只有服务器知道。拿它那一份补上，否则这几行会被当成解释不了的多余行。
  for (const d of of(theirs, 'ShelfMember')) {
    const k = `${item(d)} ${d.content.status}`;
    if (undated.has(k)) marks.set(k, at(d.content.published));
  }
  const A = new Map();
  for (const d of of(ours, 'ShelfLog')) A.set(`${item(d)} ${d.status} ${at(d.timestamp)}`, d);
  const B = new Map();
  for (const d of of(theirs, 'ShelfLog')) B.set(`${item(d)} ${d.status} ${at(d.timestamp)}`, d);

  let same = 0;
  for (const [k, d] of A) {
    const o = B.get(k);
    if (!o) { bad(`状态历史：我们送了 ${k}，服务器上没有`); continue; }
    // 只比我们写进去的那几个键。服务器还会往 metadata 里塞 `posts`（时间线的 id），
    // 那是它自己的东西，比它等于在比 NeoDB 的实现细节。
    const mine = d.metadata ?? {};
    const got = o.metadata ?? {};
    const diff = Object.keys(mine).filter((f) => JSON.stringify(mine[f]) !== JSON.stringify(got[f]));
    if (diff.length) {
      bad(`状态历史：${k} 的 ${diff.join('、')} 存进去变了样`);
      bad(`  我们  ${JSON.stringify(mine).slice(0, 200)}`);
      bad(`  服务器 ${JSON.stringify(got).slice(0, 200)}`);
    } else same += 1;
  }

  let auto = 0;
  const unexplained = [];
  for (const [k, d] of B) {
    if (A.has(k)) continue;
    const mk = `${item(d)} ${d.status}`;
    const markAt = marks.get(mk);
    if (markAt !== undefined && markAt === at(d.timestamp)) { auto += 1; continue; }
    unexplained.push(d);
  }
  for (const d of unexplained) {
    const markAt = marks.get(`${item(d)} ${d.status}`);
    if (markAt !== undefined && day(markAt) === day(at(d.timestamp))) {
      // 同一天、同一个状态、时间戳不同 —— 这正是撞成两行的症状。
      bad(`状态历史：${item(d)} 的 ${d.status} 在服务器上有两行（标记 ${new Date(markAt).toISOString()} 和 ${new Date(at(d.timestamp)).toISOString()}），是同一件事`);
    } else {
      bad(`状态历史：服务器上多出一行 ${item(d)} ${d.status} ${d.timestamp}，解释不了`);
    }
  }
  notes.push(`${pad('状态历史', 16)} 我们 ${String(A.size).padStart(5)} 条 · 对上 ${same} 条`
    + ` · 服务器自己建的 ${auto} 条（导标记时顺带的）`);
  if (unexplained.length === 0 && A.size) {
    notes.push(`${pad('', 16)}      多出来的 ${auto} 条都对得上标记本身那件事，没有一条是重复的`);
  }
}

if (theirs.hasActor) {
  notes.push('');
  notes.push('⚠ NeoDB 导出的 actor.ndjson 里有这个身份的**私钥**。');
  notes.push('  这份 zip 不要提交进仓库、不要贴进 issue，也不要当测试样本留着。');
}

console.log('');
for (const l of notes) console.log(l);
console.log('');
if (problems.length === 0) {
  console.log('✔ 送上去的每一条都原样存住了，服务器上没有一条多余的。');
  process.exit(0);
}
console.log(`✖ ${problems.length} 处对不上：`);
for (const p of problems.slice(0, 30)) console.log(`  ${p}`);
if (problems.length > 30) console.log(`  …还有 ${problems.length - 30} 处`);
console.log('');
console.log('请开一个 issue：https://github.com/Doubak/doubak-export-adapters/issues');
process.exit(1);
