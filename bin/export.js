#!/usr/bin/env node
/**
 * canonical → NeoDB / Letterboxd / Goodreads 的导入文件。**不联网。**
 *
 *   node bin/export.js <canonical 目录> [输出目录] [--target=…] [--sample=N]
 *
 * 三个平台没有一个能收下整份档案，所以这个命令的产出里，
 * 「导不出去的是什么、有多少」跟「导出去的是什么」一样是正式产出。
 *
 * `--sample=N` 先切一小份。三个平台的导入都不好撤，而「格式对不对」只有真导
 * 一次才知道——手工验证的步骤见 `docs/manual-testing.md`。
 *
 * ## `neodb` 现在是 NDJSON，旧的那套 CSV 叫 `neodb_csv`
 *
 * NeoDB 的维护者说 CSV「只是为了兼容NiceDB和Doufen，限制太多了」。NDJSON 是它
 * 自己导出、自己导入的格式，装得下豆列、装得下不挂作品的日记、装得下状态历史。
 * 所以默认那一档换成了 NDJSON，CSV 留着但要显式要——**不默认两个都出**：
 * 同时递给用户两个 NeoDB 的 zip，只会让人站在上传页面前面猜该传哪个。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadCanonical } from '../src/canonical.js';
import { buildNeodb } from '../src/targets/neodb.js';
import { buildNeodbNdjson } from '../src/targets/neodb-ndjson.js';
import { buildLetterboxd } from '../src/targets/letterboxd.js';
import { buildGoodreads } from '../src/targets/goodreads.js';
import { instructions } from '../src/instructions.js';
import { sample } from '../src/sample.js';
import { zip } from '../src/zip.js';

const TARGETS = ['neodb', 'neodb_csv', 'letterboxd', 'goodreads'];
/** 不写 `--target` 时出这几个。`neodb_csv` 要显式要。 */
const DEFAULT_TARGETS = ['neodb', 'letterboxd', 'goodreads'];

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const [inDir, outDir = 'export-out'] = args.filter((a) => !a.startsWith('--'));

if (!inDir) {
  console.error('用法: node bin/export.js <canonical 目录> [输出目录] [--target=…] [--sample=N]');
  console.error(`  --target=  ${TARGETS.join(',')} 里挑，默认 ${DEFAULT_TARGETS.join(',')}`);
  console.error('             neodb 出 NDJSON；neodb_csv 是旧的那套 CSV，要显式要');
  console.error('  --sample=N 只切 N 条标记出来先试（按分类和状态轮着取，见 docs/manual-testing.md）');
  console.error('  --shelf-history  NeoDB NDJSON 里带上广播还原出来的状态历史（默认不带）');
  console.error('  --visibility=0|1|2  NDJSON 记录的可见性：0 公开(默认) / 1 仅关注者 / 2 仅提及者');
  process.exit(2);
}

const sampleSize = (() => {
  const f = flags.find((a) => a.startsWith('--sample='));
  if (!f) return null;
  const v = Number(f.slice('--sample='.length));
  if (!Number.isInteger(v) || v < 1) {
    console.error(`--sample 要一个正整数，收到 ${f.slice('--sample='.length)}`);
    process.exit(2);
  }
  return v;
})();

const shelfHistory = flags.includes('--shelf-history');

const visibility = (() => {
  const f = flags.find((a) => a.startsWith('--visibility='));
  if (!f) return 0;
  const v = Number(f.slice('--visibility='.length));
  if (![0, 1, 2].includes(v)) {
    console.error(`--visibility 只能是 0 / 1 / 2，收到 ${f.slice('--visibility='.length)}`);
    process.exit(2);
  }
  return v;
})();

const wanted = (() => {
  const f = flags.find((a) => a.startsWith('--target='));
  if (!f) return DEFAULT_TARGETS;
  const picked = f.slice('--target='.length).split(',').map((s) => s.trim()).filter(Boolean);
  const bad = picked.filter((p) => !TARGETS.includes(p));
  if (bad.length) {
    console.error(`不认识的目标: ${bad.join(', ')}（可选: ${TARGETS.join(', ')}）`);
    process.exit(2);
  }
  return picked;
})();

const whole = loadCanonical(inDir);
const data = sampleSize === null ? whole : sample(whole, sampleSize);
mkdirSync(outDir, { recursive: true });

const n = (x) => String(x);
const say = (...s) => console.log(...s);

say(`读到 标记 ${n(whole.marks.length)} 条 · 作品 ${n(whole.subjects.length)} 个 · `
  + `长文 ${n(whole.longform.length)} 篇 · 豆列 ${n(whole.doulists.length)} 份`);
if (sampleSize !== null) {
  // **小样是一份小样，不是一次导出。** 把它当全量传上去，用户会以为自己搬完了，
  // 而剩下的 2900 多条永远不会有人再想起来。
  say(`⚠ 小样模式：只切了 ${n(data.marks.length)} 条标记（长文和豆列没削）。`);
  say('  这不是完整导出。验完之后去掉 --sample 再跑一次，导到另一个目录。');
}
say('');

/** 写一组文件到子目录，返回写了几个。 */
function writeAll(sub, files) {
  const dir = join(outDir, sub);
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(join(dir, f.name), f.text);
  return dir;
}

const summary = { doulists: data.doulists.length, multiRevisionMarks: data.multiRevisionMarks };

if (wanted.includes('neodb')) {
  const { files, sidecars, report } = buildNeodbNdjson(data, { shelfHistory, visibility });
  summary.neodb = report;
  summary.shelfHistory = shelfHistory;
  const dir = join(outDir, 'neodb');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'neodb-ndjson-import.zip'), zip(files));
  // 旁挂文件不进 zip：它们是给人看的，不该被导入。
  for (const f of sidecars) writeFileSync(join(dir, f.name), f.text);

  const cats = Object.entries(report.byCategory)
    .map(([c, v]) => `${c} ${n(v.marks)}`)
    .join(' · ');
  say(`NeoDB  → ${join(dir, 'neodb-ndjson-import.zip')}  (NDJSON)`);
  say(`  标记 ${n(report.marks)} 条（${cats}）· 评分 ${n(report.ratings)} · 短评 ${n(report.comments)}`);
  say(`  标签 ${n(report.tags)} 个（贴了 ${n(report.tagMembers)} 次）· 书评影评 ${n(report.reviews)} 篇`
    + ` · 笔记 ${n(report.notes)} 篇`);
  // 这三样是 CSV 那条路上根本没有的，所以单独说，哪怕是 0。
  say(`  豆列 ${n(report.collections)} 份（${n(report.collectionItems)} 条）`
    + ` · 不挂作品的日记 ${n(report.articles)} 篇 · 条目 ${n(report.catalogItems)} 个`);
  if (shelfHistory) {
    say(`  状态历史 ${n(report.shelfLogs)} 条（从广播还原，豆瓣自己已经不显示了）`);
  } else if (data.broadcasts.length) {
    say(`  · 状态历史没有带上。加 --shelf-history 可以从 ${n(data.broadcasts.length)} 条广播里还原`
      + '出一条带日期的时间线');
  }
  if (visibility) {
    say(`  · 所有记录写了 visibility=${n(visibility)}（${visibility === 1 ? '仅关注者' : '仅提及者'}）`);
  }
  if (report.noDetailPage) {
    say(`  ⚠ ${n(report.noDetailPage)} 条没读到详情页，分不出电影还是剧集，按电影处理`);
  }
  if (report.noLink) {
    say(`  ⚠ ${n(report.noLink)} 条连豆瓣链接都没有（条目已被豆瓣删除），没有放进 zip——`
      + 'NDJSON 这条路只靠 URL 匹配，连 CSV 那边的 isbn 兜底都没有。见 neodb-needs-check.csv');
  }
  if (report.noMarkedAt) {
    say(`  ⚠ ${n(report.noMarkedAt)} 条没有标记日期，这几条不写 published，导入时会当成新记录`);
  }
  if (report.doulistEntriesDropped) {
    say(`  ⚠ 豆列里有 ${n(report.doulistEntriesDropped)} 条不是作品条目（影评/小组/人物/照片…），`
      + '收藏单装不下。见 neodb-doulist-needs-check.csv');
  }
  if (report.emptyCollections) {
    say(`  · 其中 ${n(report.emptyCollections)} 份豆列一条都没剩下——单子本身还在，里面是空的`);
  }
  say('');
}

if (wanted.includes('neodb_csv')) {
  const { files, sidecars, report } = buildNeodb(data);
  summary.neodbCsv = report;
  const dir = join(outDir, 'neodb_csv');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'neodb-import.zip'), zip(files));
  for (const f of sidecars) writeFileSync(join(dir, f.name), f.text);

  const cats = Object.entries(report.byCategory)
    .map(([c, v]) => `${c} ${n(v.marks)}`)
    .join(' · ');
  say(`NeoDB  → ${join(dir, 'neodb-import.zip')}  (CSV，旧格式)`);
  say(`  标记 ${n(report.marks)} 条（${cats}）· 书评影评 ${n(report.reviews)} 篇 · 笔记 ${n(report.notes)} 篇`);
  if (report.noDetailPage) {
    say(`  ⚠ ${n(report.noDetailPage)} 条没读到详情页，分不出电影还是剧集，按电影处理`);
  }
  if (report.noLink) {
    say(`  ⚠ ${n(report.noLink)} 条连豆瓣链接都没有（条目已被豆瓣删除），没有放进 zip——`
      + '没有链接 NeoDB 就无从定位，导进去只会固定报几个失败，'
      + '把真出问题的那条盖住。见 neodb-needs-check.csv');
  }
  if (report.unattachedLongform) {
    say(`  ⚠ ${n(report.unattachedLongform)} 篇长文不挂在作品上（日记），NeoDB 的 CSV 导入没有地方放`);
  }
  if (report.tagsWithPipe) say(`  ⚠ ${n(report.tagsWithPipe)} 条的标签里有「|」，NeoDB 会把它拆成两个标签`);
  if (data.doulists.length) {
    say(`  · 豆列 ${n(data.doulists.length)} 份没有导出：NeoDB 的 CSV 导入里没有「收藏单」这一档`);
  }
  say('');
}

if (wanted.includes('letterboxd')) {
  const { files, report } = buildLetterboxd(data);
  summary.letterboxd = report;
  const dir = writeAll('letterboxd', files);
  say(`Letterboxd → ${dir}/`);
  say(`  看过 ${n(report.watched)} 部 · 想看 ${n(report.watchlist)} 部（含在看 ${n(report.watching)} 部）`);
  say(`  跳过 剧集 ${n(report.skippedTv)} · 非影视 ${n(report.skippedOther)}（Letterboxd 只收电影）`);
  if (report.skippedUnknown) {
    say(`  ⚠ ${n(report.skippedUnknown)} 条没读到详情页，分不清是电影还是剧集，没有导出——`
      + '把剧集当电影送出去，可能给你添一部没看过的片子');
  }
  if (report.noImdb) say(`  ⚠ ${n(report.noImdb)} 部没有 IMDb 号，见 letterboxd-needs-check.csv`);
  if (report.tagsWithComma) {
    say(`  ⚠ ${n(report.tagsWithComma)} 条的标签里有逗号，Letterboxd 会按逗号拆成多个标签`);
  }
  say('');
}

if (wanted.includes('goodreads')) {
  const { files, report } = buildGoodreads(data);
  summary.goodreads = report;
  const dir = writeAll('goodreads', files);
  say(`Goodreads → ${dir}/`);
  say(`  图书 ${n(report.books)} 本（读过 ${n(report.read)} · 在读 ${n(report.reading)} · 想读 ${n(report.toRead)}）`);
  say(`  跳过 非图书 ${n(report.skippedOther)}`);
  if (report.noIsbn) say(`  ⚠ ${n(report.noIsbn)} 本没有 ISBN，见 goodreads-needs-check.csv`);
  say('');
}

// 三个平台的上传入口藏在设置里三个不同地方，Letterboxd 还要传两次。
// 只给一堆 CSV 不说去哪儿传，等于没做完。
writeFileSync(join(outDir, '怎么导入.md'), instructions(summary));
say(`说明 → ${join(outDir, '怎么导入.md')}`);
say('');

// **这一条对每个目标都成立，所以单独说一次。** 导出是当前状态的快照：
// canonical 里一条标记可能有好几次修订，导出只留最后一次。
if (data.multiRevisionMarks) {
  say(`注意：${n(data.multiRevisionMarks)} 条标记在档案里有不止一次修订，导出的是最后一次。`);
  say('     修订历史留在 canonical 里，三个平台都收不下——这也是别拿导出文件当备份的原因。');
}
