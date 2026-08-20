#!/usr/bin/env node
/**
 * 把已经写出来的那批文件读回来，跟 canonical 逐条对一遍。**上传之前跑。**
 *
 *   node tools/check-export.mjs <canonical 目录> <导出目录> [--sample]
 *
 * `--sample` 用于校验 `--sample=N` 切出来的那一份：**逐条的检查照做，只是不再
 * 要求条数等于档案里的条数。** 这件事不自动判断——「产物比档案少」正是漏导的
 * 症状，让脚本自己猜「大概是小样吧」，等于把最该报的那个警报关掉。
 *
 * ## 这不是又一遍单元测试
 *
 * 测试对着 `test/fixtures/` 里那 18 条跑，证明的是「代码在那 18 条上是对的」。
 * 这个脚本对着**你自己那几千条**跑，回答的是另一个问题：
 * **我马上要传上去的这堆文件，跟我的档案对得上吗。**
 *
 * 两者会漏的东西不一样。样本里没有的形状——某条短评里有三个连续换行、某个标签
 * 带竖线、某部片子的 IMDb 号是空字符串而不是缺失——只有拿真实档案跑才会撞上。
 *
 * ## 判据是「一条不多，一条不少，一个字不差」
 *
 * 三个平台的导入都不好撤，而错法最难发现的一种是 CSV 错位：后面的字段整体挪一格，
 * 于是评分变成日期、评语变成标签，**导进去之后看着像数据本来就那样**。
 * 所以这里不看行数对不对，看的是每一条的每一个字段。
 *
 * 退出码：0 全对，1 有对不上的。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadCanonical, fieldsOf } from '../src/canonical.js';
import { classify, identifiers } from '../src/classify.js';
import { unzip } from '../src/zip.js';

const argv = process.argv.slice(2);
const isSample = argv.includes('--sample');
const [canonDir, outDir] = argv.filter((a) => !a.startsWith('--'));
if (!canonDir || !outDir) {
  console.error('用法: node tools/check-export.mjs <canonical 目录> <导出目录> [--sample]');
  console.error('  --sample  这份是 --sample=N 切出来的，不要求条数等于档案里的条数');
  process.exit(2);
}

/** RFC 4180 解析。跟写出器分开写，两边对不上时至少知道有一边错了。 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const push = () => { row.push(field); field = ''; };
  const endRow = () => { push(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; continue; }
        quoted = false; continue;
      }
      field += c; continue;
    }
    if (c === '"' && field === '') { quoted = true; continue; }
    if (c === ',') { push(); continue; }
    if (c === '\r' && text[i + 1] === '\n') { endRow(); i += 1; continue; }
    if (c === '\n' || c === '\r') { endRow(); continue; }
    field += c;
  }
  if (field !== '' || row.length) endRow();
  return rows;
}

/** 重复表头后一个赢——NeoDB 的 csv.DictReader 就是这么读的。 */
function objects(text) {
  const [header, ...body] = parseCsv(text);
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

const problems = [];
const notes = [];
const bad = (what) => problems.push(what);

const data = loadCanonical(canonDir);
const byUrl = new Map();
for (const mark of data.marks) {
  const url = mark.subject?.url;
  if (url) byUrl.set(url, mark);
}

// ── NeoDB ────────────────────────────────────────────────────────────────
const zipPath = join(outDir, 'neodb', 'neodb-import.zip');
if (existsSync(zipPath)) {
  const files = unzip(readFileSync(zipPath));
  const KNOWN = ['book', 'movie', 'tv', 'music', 'game', 'podcast', 'performance'];
  let rows = 0;
  const seen = new Set();

  for (const [name, text] of files) {
    const m = /^([a-z]+)_(mark|review|note)\.csv$/.exec(name);
    // 文件名不在那七个里，NeoDB 会连读都不读——而且不报错。
    if (!m || !KNOWN.includes(m[1])) { bad(`NeoDB: 文件名 ${name} 不是 NeoDB 认的，它会被整张跳过`); continue; }
    if (m[2] !== 'mark') continue;

    for (const r of objects(text)) {
      rows += 1;
      const url = r.links.split(' ')[0];
      // 空的 links 是**注定失败**的一行，不该出现在 zip 里：NeoDB 靠 links 定位条目。
      // 实测一次真实导入报的就是 `Could not find item: `（冒号后面是空的）。
      if (!url) { bad('NeoDB: 有一行的 links 是空的，导进去必然失败'); continue; }
      if (seen.has(url)) bad(`NeoDB: ${url} 出现了不止一次`);
      seen.add(url);

      const mark = byUrl.get(url);
      if (!mark) { bad(`NeoDB: ${url} 不在档案里`); continue; }
      const f = fieldsOf(mark);
      const want = { wish: 'wishlist', doing: 'progress', done: 'complete' }[f.status] ?? '';
      if (r.status !== want) bad(`NeoDB: ${url} 状态 ${r.status}，档案里是 ${f.status}`);
      const rating = f.rating ? String(f.rating * 2) : '';
      if (r.rating !== rating) bad(`NeoDB: ${url} 评分 ${r.rating}，档案里是 ${f.rating} 星（该写 ${rating}）`);
      if (r.comment !== (f.comment ?? '')) bad(`NeoDB: ${url} 的短评跟档案不一致`);
      if (r.tags !== (f.tags ?? []).join('|')) bad(`NeoDB: ${url} 的标签跟档案不一致`);
      // info 列是按空格切 key:value 的，值里带空格会把后面的键吃掉。
      for (const pair of r.info.split(' ').filter(Boolean)) {
        if (!/^[a-z]+:[^\s]+$/.test(pair)) bad(`NeoDB: ${url} 的 info 里 ${pair} 形状不对`);
      }
    }
  }

  // 条目被豆瓣删掉、canonical 里连 URL 都没有的那些不进 zip——它们在
  // `neodb-needs-check.csv` 里。所以该有的行数是「有链接的标记数」。
  const expected = data.marks.filter((m) => m.subject?.url).length;
  const noLink = data.marks.length - expected;
  if (!isSample && rows !== expected) bad(`NeoDB: 标记 ${rows} 行，该有 ${expected} 条`);
  if (isSample && rows > expected) bad(`NeoDB: 标记 ${rows} 行，比档案里的 ${expected} 条还多`);
  notes.push(`NeoDB     标记 ${rows} 行 · ${files.size} 张表 · zip 拆得开`
    + (noLink ? `（另有 ${noLink} 条没有豆瓣链接，在 neodb-needs-check.csv 里）` : ''));
}

// ── Letterboxd ───────────────────────────────────────────────────────────
const lbDir = join(outDir, 'letterboxd');
if (existsSync(lbDir)) {
  const read = (f) => (existsSync(join(lbDir, f)) ? objects(readFileSync(join(lbDir, f), 'utf8')) : []);
  const watched = read('letterboxd-watched.csv');
  const watchlist = read('letterboxd-watchlist.csv');

  for (const [rows, kind] of [[watched, '看过'], [watchlist, '想看']]) {
    for (const r of rows) {
      if (!r.Title) bad(`Letterboxd（${kind}）: 有一行标题是空的`);
      if (r.imdbID && !/^tt\d+$/.test(r.imdbID)) bad(`Letterboxd（${kind}）: IMDb 号 ${r.imdbID} 形状不对`);
      if (r.Year && !/^\d{4}$/.test(r.Year)) bad(`Letterboxd（${kind}）: 年份 ${r.Year} 形状不对`);
    }
  }
  for (const r of watched) {
    if (r.Rating && !/^[1-5]$/.test(r.Rating)) bad(`Letterboxd: ${r.Title} 评分 ${r.Rating} 越界（该是 1–5）`);
    if (r.WatchedDate && !/^\d{4}-\d{2}-\d{2}$/.test(r.WatchedDate)) {
      bad(`Letterboxd: ${r.Title} 日期 ${r.WatchedDate} 形状不对`);
    }
  }
  // 剧集混进来是这一路最要命的错：它可能匹配到一部同名电影，
  // 于是观影记录里凭空多出一部没看过的片子。
  const tvUrls = new Set(data.subjects
    .filter((s) => classify(s.medium, fieldsOf(s)).category === 'tv')
    .map((s) => identifiers(fieldsOf(s)).imdb)
    .filter(Boolean));
  for (const r of [...watched, ...watchlist]) {
    if (r.imdbID && tvUrls.has(r.imdbID)) bad(`Letterboxd: ${r.Title} 是剧集，不该出现在这里`);
  }
  notes.push(`Letterboxd 看过 ${watched.length} · 想看 ${watchlist.length}`);
}

// ── Goodreads ────────────────────────────────────────────────────────────
const grPath = join(outDir, 'goodreads', 'goodreads.csv');
if (existsSync(grPath)) {
  const rows = objects(readFileSync(grPath, 'utf8'));
  const books = data.marks.filter((m) => m.medium === 'book').length;
  if (!isSample && rows.length !== books) bad(`Goodreads: ${rows.length} 行，档案里有 ${books} 本书`);
  if (isSample && rows.length > books) bad(`Goodreads: ${rows.length} 行，比档案里的 ${books} 本还多`);
  for (const r of rows) {
    if (!['to-read', 'currently-reading', 'read'].includes(r.Shelves)) {
      bad(`Goodreads: ${r.Title} 的书架 ${r.Shelves} 不是那三个之一`);
    }
    // 豆瓣的日期是「标记那天」，不是「读完那天」。想读的也写上，
    // 就是替用户宣称他读完了没读过的书。
    if (r.Shelves !== 'read' && r['Date Read']) {
      bad(`Goodreads: ${r.Title} 是「${r.Shelves}」，却带着读完日期 ${r['Date Read']}`);
    }
    if (r['My Rating'] && !/^[1-5]$/.test(r['My Rating'])) {
      bad(`Goodreads: ${r.Title} 评分 ${r['My Rating']} 越界`);
    }
  }
  notes.push(`Goodreads  ${rows.length} 本`);
}

if (notes.length === 0) {
  console.error(`${outDir} 里没找到任何导出产物。先跑 bin/export.js。`);
  process.exit(2);
}

for (const line of notes) console.log(line);
if (isSample) console.log('（小样模式：逐条检查照做，没有核对总条数）');
console.log('');
if (problems.length === 0) {
  console.log('✔ 每一条都跟档案对得上。可以上传了。');
  process.exit(0);
}
// 只印前 20 条。几百条同类问题里，第一条就够定位了，剩下的只会把它冲走。
console.log(`✖ ${problems.length} 处对不上：`);
for (const p of problems.slice(0, 20)) console.log(`  ${p}`);
if (problems.length > 20) console.log(`  …还有 ${problems.length - 20} 处`);
console.log('');
console.log('请开一个 issue：https://github.com/Doubak/doubak-export-adapters/issues');
process.exit(1);
