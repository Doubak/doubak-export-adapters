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
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadCanonical } from '../src/canonical.js';
import { buildNeodb } from '../src/targets/neodb.js';
import { buildLetterboxd } from '../src/targets/letterboxd.js';
import { buildGoodreads } from '../src/targets/goodreads.js';
import { instructions } from '../src/instructions.js';
import { sample } from '../src/sample.js';
import { zip } from '../src/zip.js';

const TARGETS = ['neodb', 'letterboxd', 'goodreads'];

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const [inDir, outDir = 'export-out'] = args.filter((a) => !a.startsWith('--'));

if (!inDir) {
  console.error('用法: node bin/export.js <canonical 目录> [输出目录] [--target=…] [--sample=N]');
  console.error('  --target=  neodb,letterboxd,goodreads 里挑，默认三个都出');
  console.error('  --sample=N 只切 N 条标记出来先试（按分类和状态轮着取，见 docs/manual-testing.md）');
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

const wanted = (() => {
  const f = flags.find((a) => a.startsWith('--target='));
  if (!f) return TARGETS;
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
  const { files, report } = buildNeodb(data);
  summary.neodb = report;
  const dir = join(outDir, 'neodb');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'neodb-import.zip'), zip(files));

  const cats = Object.entries(report.byCategory)
    .map(([c, v]) => `${c} ${n(v.marks)}`)
    .join(' · ');
  say(`NeoDB  → ${join(dir, 'neodb-import.zip')}`);
  say(`  标记 ${n(report.marks)} 条（${cats}）· 书评影评 ${n(report.reviews)} 篇 · 笔记 ${n(report.notes)} 篇`);
  if (report.noDetailPage) {
    say(`  ⚠ ${n(report.noDetailPage)} 条没读到详情页，分不出电影还是剧集，按电影处理`);
  }
  if (report.noLink) say(`  ⚠ ${n(report.noLink)} 条连豆瓣链接都没有（条目已被删），NeoDB 匹配不上`);
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
