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
import { zip } from '../src/zip-node.js';

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
  console.error('  --no-shelf-history  不要从广播还原状态历史（默认是要的）');
  console.error('  --visibility=0|1|2  NDJSON 记录的可见性：0 公开(默认) / 1 仅关注者 / 2 仅提及者');
  process.exit(2);
}

// 拼错的开关必须报错，不能静默忽略。`--no-shelf-history` 是**负向**的：
// 打成 `--no-shelf-histroy` 的话，静默忽略等于拿到跟本意相反的结果。
{
  const KNOWN = ['--no-shelf-history', '--shelf-history'];
  const KNOWN_PREFIX = ['--sample=', '--visibility=', '--target='];
  const bad = flags.filter((f) => !KNOWN.includes(f)
    && !KNOWN_PREFIX.some((p) => f.startsWith(p)));
  if (bad.length) {
    console.error(`不认识这些开关：${bad.join(' ')}`);
    console.error('能用的：' + [...KNOWN, ...KNOWN_PREFIX.map((p) => `${p}…`)].join(' / '));
    process.exit(2);
  }
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

// 默认带上。这段历史豆瓣自己已经不留了，不带走就是永久丢掉；而写错的代价是
// NeoDB 上多几行日期不对的历史，不动标记、不发时间线、也不联邦。
// **不对称**，所以默认站在「带走」那一边。`--shelf-history` 留着当兼容写法。
const shelfHistory = !flags.includes('--no-shelf-history');

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

const summary = {
  doulists: data.doulists.length,
  multiRevisionMarks: data.multiRevisionMarks,
  reMarkedSuperseded: data.reMarkedSuperseded,
};

if (wanted.includes('neodb')) {
  const { files, sidecars, report } = buildNeodbNdjson(data, { shelfHistory, visibility });
  summary.neodb = report;
  summary.shelfHistory = shelfHistory;
  const dir = join(outDir, 'neodb');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'neodb-ndjson-import.zip'), await zip(files));
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
    // NeoDB 导标记时自己会建一条历史，所以「标记本身那件事」不另开一行，而是并到
    // 那一行上、顺手补进当时那颗星和那段短评。不说的话产出比广播数少，看着像漏了。
    if (report.shelfLogsMerged || report.shelfLogsMergedEmpty) {
      say(`  · 其中 ${n(report.shelfLogsMerged)} 条是并进标记那一行的（标记本身那件事，`
        + `NeoDB 导标记时自己就会建一行，我们只把当时的星和短评补上去）`);
    }
    if (report.shelfLogsMergedEmpty) {
      say(`  · 另有 ${n(report.shelfLogsMergedEmpty)} 条广播什么都没冻住（没星也没字），整条略过`);
    }
  } else if (data.broadcasts.length) {
    say(`  ⚠ 状态历史**被 --no-shelf-history 关掉了**，${n(data.broadcasts.length)} 条广播里那条`
      + '带日期的时间线不会带走。豆瓣自己已经不显示它了。');
  }
  if (visibility) {
    say(`  · 所有记录写了 visibility=${n(visibility)}（${visibility === 1 ? '仅关注者' : '仅提及者'}）`);
  }
  if (report.restricted?.length) {
    // **两边分开说，因为处置正好相反。** 「仅自己可见」有两个成因：作者自己藏的，
    // 和豆瓣锁掉的。合成一句话就是拿豆瓣的审查冒充用户的意愿。
    const 锁 = report.restricted.filter((x) => x.by === 'platform');
    const 藏 = report.restricted.filter((x) => x.by !== 'platform');
    if (锁.length) {
      say(`  · ${n(锁.length)} 篇日记是**被豆瓣锁成「仅自己可见」的**，这一份里**按公开导入**`
        + '——它本来就是公开的，是豆瓣把它关掉的');
      for (const x of 锁) say(`      · ${x.title}`);
      say('    ⚠ NeoDB 的 Article 会联邦出去，**这一步撤不回来**。要收起来：--visibility=2');
    }
    if (藏.length) {
      const 名 = {
        author: '你自己设的',
        unsure: '这份 canonical 没有可见性字段（旧档案），重跑一次解析器就有了',
      };
      say(`  · ${n(藏.length)} 篇日记在豆瓣上不公开，写成 visibility=2（仅提及者）`
        + '——**东西照样在你账号里**，只是不对外');
      for (const x of 藏) {
        say(`      · ${x.title}（${名[x.by] ?? x.by}）`);
        // 认不出来那一栏的下一步是去看那一页，所以把网址给出来。
        if (x.by === 'unsure' && x.url) say(`        ${x.url}`);
      }
    }
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
  writeFileSync(join(dir, 'neodb-import.zip'), await zip(files));
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
if (data.reMarkedSuperseded) {
  // **不能不说。** 这是把两条真实的记录压成一条，而压掉的那条在 canonical 里还
  // 在——与「有几条标记改过」是同一类：数字小到用户自己不会发现，所以得由这里说。
  say(`注意：${n(data.reMarkedSuperseded)} 个作品在豆瓣上被删掉后重新标记过，`
    + '导出的是现存的那一条（更早那次的短评与标签留在 canonical 里，导出装不下）。');
}
if (data.multiRevisionMarks) {
  say(`注意：${n(data.multiRevisionMarks)} 条标记在档案里有不止一次修订，导出的是最后一次。`);
  say('     修订历史留在 canonical 里，三个平台都收不下——这也是别拿导出文件当备份的原因。');
}
