#!/usr/bin/env node
/**
 * canonical → NeoDB / Letterboxd / Goodreads 的导入文件。**不联网。**
 *
 *   node bin/export.js <canonical 目录> [输出目录] [--account=<uid>] [--all-accounts] [--target=…] [--sample=N]
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
import { join, basename } from 'node:path';
import { loadCanonical, findCanonicalDirs, accountsInCanonical } from '../src/canonical.js';
import { buildNeodb } from '../src/targets/neodb.js';
import { buildNeodbNdjson, FEEDBACK_URL } from '../src/targets/neodb-ndjson.js';
import { buildLetterboxd } from '../src/targets/letterboxd.js';
import { buildGoodreads } from '../src/targets/goodreads.js';
import { instructions } from '../src/instructions.js';
import { sample } from '../src/sample.js';
import { zip } from '../src/zip-node.js';

const TARGETS = ['neodb', 'neodb_csv', 'letterboxd', 'goodreads'];
/** 不写 `--target` 时出这几个。`neodb_csv` 要显式要。 */
const DEFAULT_TARGETS = ['neodb', 'letterboxd', 'goodreads'];

const args = process.argv.slice(2);
let targetAccount = null;
let allAccounts = false;
const rawFlags = [];
const positionals = [];

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--account') {
    targetAccount = args[++i];
    if (!targetAccount || targetAccount.startsWith('--')) {
      console.error('--account 需要一个账号 UID');
      process.exit(2);
    }
  } else if (a.startsWith('--account=')) {
    targetAccount = a.slice('--account='.length);
    if (!targetAccount) {
      console.error('--account 需要一个账号 UID');
      process.exit(2);
    }
  } else if (a === '--all-accounts') {
    allAccounts = true;
    rawFlags.push(a);
  } else if (a.startsWith('--')) {
    rawFlags.push(a);
  } else {
    positionals.push(a);
  }
}

if (targetAccount && allAccounts) {
  console.error('--account 与 --all-accounts 不能同时使用');
  process.exit(2);
}

const [inDir, outDir = 'export-out'] = positionals;

if (!inDir) {
  console.error('用法: node bin/export.js <canonical 目录> [输出目录] [--account=<uid>] [--all-accounts] [--target=…] [--sample=N]');
  console.error('  --account=<uid>     只导出指定账号的数据（防止多账号混合污染）');
  console.error('  --all-accounts      自动按账号分流，分别导出到 <输出目录>/<uid>/');
  console.error(`  --target=  ${TARGETS.join(',')} 里挑，默认 ${DEFAULT_TARGETS.join(',')}`);
  console.error('             neodb 出 NDJSON；neodb_csv 是旧的那套 CSV，要显式要');
  console.error('  --sample=N 只切 N 条标记出来先试（按分类和状态轮着取，见 docs/manual-testing.md）');
  console.error('  --no-shelf-history  不要从广播还原状态历史（默认是要的）');
  console.error('  --visibility=0|1|2  NDJSON 记录的可见性：0 公开(默认) / 1 仅关注者 / 2 仅提及者');
  console.error('  --notes-visibility=0|1|2    日记这一档：0 跟 --visibility 走(默认，即公开)');
  console.error('             / 1 仅关注者 / 2 仅提及者。**只管日记，影评书评不在内**');
  console.error('  --unknown-visibility=0|1|2  其中看不出公不公开的那几篇：2 仅提及者(默认)');
  console.error('             / 1 仅关注者 / 0 跟 --notes-visibility 走');
  console.error('             三级只收紧不放松；**作者自己设成私密的三个都动不了**');
  process.exit(2);
}

// 拼错的开关必须报错，不能静默忽略。`--no-shelf-history` 是**负向**的：
// 打成 `--no-shelf-histroy` 的话，静默忽略等于拿到跟本意相反的结果。
{
  const KNOWN = ['--no-shelf-history', '--shelf-history', '--all-accounts'];
  const KNOWN_PREFIX = ['--sample=', '--visibility=', '--notes-visibility=',
    '--unknown-visibility=', '--target='];
  const bad = rawFlags.filter((f) => !KNOWN.includes(f)
    && !KNOWN_PREFIX.some((p) => f.startsWith(p)));
  if (bad.length) {
    console.error(`不认识这些开关：${bad.join(' ')}`);
    console.error('能用的：' + [...KNOWN, ...KNOWN_PREFIX.map((p) => `${p}…`), '--account=<uid>'].join(' / '));
    process.exit(2);
  }
}

const sampleSize = (() => {
  const f = rawFlags.find((a) => a.startsWith('--sample='));
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
const shelfHistory = !rawFlags.includes('--no-shelf-history');

const visibility = (() => {
  const f = rawFlags.find((a) => a.startsWith('--visibility='));
  if (!f) return undefined;
  const v = Number(f.slice('--visibility='.length));
  if (![0, 1, 2].includes(v)) {
    console.error(`--visibility 只能是 0 / 1 / 2，收到 ${f.slice('--visibility='.length)}`);
    process.exit(2);
  }
  return v;
})();

const notesVisibility = (() => {
  const f = rawFlags.find((a) => a.startsWith('--notes-visibility='));
  if (!f) return undefined;
  const raw = f.slice('--notes-visibility='.length);
  const v = Number(raw);
  if (![0, 1, 2].includes(v)) {
    console.error(`--notes-visibility 只能是 0 / 1 / 2，收到 ${raw}`);
    process.exit(2);
  }
  return v;
})();

const unknownVisibility = (() => {
  const f = rawFlags.find((a) => a.startsWith('--unknown-visibility='));
  if (!f) return undefined;
  const raw = f.slice('--unknown-visibility='.length);
  const v = Number(raw);
  if (![0, 1, 2].includes(v)) {
    console.error(`--unknown-visibility 只能是 0 / 1 / 2，收到 ${raw}`);
    process.exit(2);
  }
  return v;
})();

const wanted = (() => {
  const f = rawFlags.find((a) => a.startsWith('--target='));
  if (!f) return DEFAULT_TARGETS;
  const picked = f.slice('--target='.length).split(',').map((s) => s.trim()).filter(Boolean);
  const bad = picked.filter((p) => !TARGETS.includes(p));
  if (bad.length) {
    console.error(`不认识的目标: ${bad.join(', ')}（可选: ${TARGETS.join(', ')}）`);
    process.exit(2);
  }
  return picked;
})();

const n = (x) => String(x);
const say = (...s) => console.log(...s);

async function exportOne(whole, targetOutDir) {
  const data = sampleSize === null ? whole : sample(whole, sampleSize);
  mkdirSync(targetOutDir, { recursive: true });

  say(`读到 标记 ${n(whole.marks.length)} 条 · 作品 ${n(whole.subjects.length)} 个 · `
    + `长文 ${n(whole.longform.length)} 篇 · 豆列 ${n(whole.doulists.length)} 份`);
  if (sampleSize !== null) {
    say(`⚠ 小样模式：只切了 ${n(data.marks.length)} 条标记（长文和豆列没削）。`);
    say('  这不是完整导出。验完之后去掉 --sample 再跑一次，导到另一个目录。');
  }
  say('');

  function writeAll(sub, files) {
    const dir = join(targetOutDir, sub);
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
    const { files, sidecars, report } = buildNeodbNdjson(data, { shelfHistory, visibility, notesVisibility, unknownVisibility });
    summary.neodb = report;
    summary.shelfHistory = shelfHistory;
    const dir = join(targetOutDir, 'neodb');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'neodb-ndjson-import.zip'), await zip(files));
    for (const f of sidecars) writeFileSync(join(dir, f.name), f.text);

    const cats = Object.entries(report.byCategory)
      .map(([c, v]) => `${c} ${n(v.marks)}`)
      .join(' · ');
    say(`NeoDB  → ${join(dir, 'neodb-ndjson-import.zip')}  (NDJSON)`);
    say(`  标记 ${n(report.marks)} 条（${cats}）· 评分 ${n(report.ratings)} · 短评 ${n(report.comments)}`);
    say(`  标签 ${n(report.tags)} 个（贴了 ${n(report.tagMembers)} 次）· 书评影评 ${n(report.reviews)} 篇`
      + ` · 笔记 ${n(report.notes)} 篇`);
    say(`  豆列 ${n(report.collections)} 份（${n(report.collectionItems)} 条）`
      + ` · 不挂作品的日记 ${n(report.articles)} 篇 · 条目 ${n(report.catalogItems)} 个`);
    if (shelfHistory) {
      say(`  状态历史 ${n(report.shelfLogs)} 条（从广播还原，豆瓣自己已经不显示了）`);
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
    if (report.notesVisibility) {
      say(`  · 日记这一档写了 visibility=${n(report.notesVisibility)}`
        + `（${report.notesVisibility === 1 ? '仅关注者' : '仅提及者'}），影评书评不在内`);
    }
    if (report.restricted?.length) {
      const 锁 = report.restricted.filter((x) => x.by === 'platform');
      const 藏 = report.restricted.filter((x) => x.by !== 'platform');
      if (锁.length) {
        const 公开着 = !report.notesVisibility && !visibility;
        say(`  · ${n(锁.length)} 篇日记是**被豆瓣锁成「仅自己可见」的**，`
          + (公开着 ? '这一份里**按公开导入**——它本来就是公开的，是豆瓣把它关掉的'
            : `这一份里跟日记那一档一起写成 visibility=${n(report.notesVisibility || visibility)}`
              + '——它本来是公开的（豆瓣把它关掉的），想重新公开就别收紧日记那一档'));
        for (const x of 锁) say(`      · ${x.title}`);
        if (公开着) {
          say('    ⚠ NeoDB 的 Article 会联邦出去，**这一步撤不回来**。'
            + '要收起来：--notes-visibility=2（只收日记）或 --visibility=2（全收）');
        }
      }
      if (藏.length) {
        const 作者藏的 = 藏.filter((x) => x.by === 'author');
        const 说不准 = 藏.filter((x) => x.by !== 'author');
        if (作者藏的.length) {
          say(`  · ${n(作者藏的.length)} 篇日记是**你自己设成「仅自己可见」的**，写成 visibility=2`
            + '（仅提及者）——**东西照样在你账号里**，只是不对外');
          for (const x of 作者藏的) say(`      · ${x.title}`);
        }
        if (说不准.length) {
          say(`  · ${n(说不准.length)} 篇日记**看不出是平台锁的还是作者藏的**，`
            + `写成 visibility=${n(report.unknownVisibility)}（${report.unknownVisibility === 2 ? '仅提及者' : '仅关注者'}）`
            + '——默认收紧，要按公开导入：--unknown-visibility=0');
          for (const x of 说不准) say(`      · ${x.title}`);
        }
      }
    }
    say('');
  }

  if (wanted.includes('neodb_csv')) {
    const { files, sidecars, report } = buildNeodb(data);
    summary.neodbCsv = report;
    const dir = join(targetOutDir, 'neodb_csv');
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

  writeFileSync(join(targetOutDir, '怎么导入.md'), instructions(summary));
  say(`说明 → ${join(targetOutDir, '怎么导入.md')}`);
  say('');

  if (data.reMarkedSuperseded) {
    say(`注意：${n(data.reMarkedSuperseded)} 个作品在豆瓣上被删掉后重新标记过，`
      + '导出的是现存的那一条（更早那次的短评与标签留在 canonical 里，导出装不下）。');
  }
  if (data.multiRevisionMarks) {
    say(`注意：${n(data.multiRevisionMarks)} 条标记在档案里有不止一次修订，导出的是最后一次。`);
    say('     修订历史留在 canonical 里，三个平台都收不下——这也是别拿导出文件当备份的原因。');
  }
}

const canonDirs = findCanonicalDirs(inDir);
if (canonDirs.length === 0) {
  console.error(`${inDir} 看着不像 canonical 目录（所有已知 NDJSON 都没有记录）`);
  process.exit(1);
}

if (canonDirs.length === 1) {
  const canonDir = canonDirs[0];
  if (canonDir !== inDir) {
    say(`ℹ 自动定位到子目录中的 canonical 存档：${canonDir}`);
  }

  if (targetAccount) {
    let whole;
    try {
      whole = loadCanonical(canonDir, { account: targetAccount });
    } catch (err) {
      console.error(`\n✖ ${err.message}`);
      process.exit(1);
    }
    await exportOne(whole, outDir);
  } else if (allAccounts) {
    let wholeAll;
    try {
      wholeAll = loadCanonical(canonDir, { allAccounts: true });
    } catch (err) {
      console.error(`\n✖ ${err.message}`);
      process.exit(1);
    }
    const accountsMap = accountsInCanonical(wholeAll);
    const uids = [...accountsMap.keys()].filter((k) => k && k !== 'unknown');
    if (uids.length <= 1) {
      await exportOne(wholeAll, outDir);
    } else {
      say(`\n发现 ${uids.length} 个账号的数据（${uids.join('、')}），按账号分流导出：`);
      for (const uid of uids) {
        const accOutDir = join(outDir, uid);
        say(`\n========================================`);
        say(`正在导出账号 ${uid} → ${accOutDir}/`);
        say(`========================================`);
        const accWhole = loadCanonical(canonDir, { account: uid });
        await exportOne(accWhole, accOutDir);
      }
    }
  } else {
    let whole;
    try {
      whole = loadCanonical(canonDir);
    } catch (err) {
      console.error(`\n✖ ${err.message}`);
      process.exit(1);
    }
    await exportOne(whole, outDir);
  }
} else {
  // 发现多个子目录均包含 canonical
  if (targetAccount) {
    let matchedDir = null;
    let matchedWhole = null;
    for (const d of canonDirs) {
      try {
        const w = loadCanonical(d, { account: targetAccount });
        matchedDir = d;
        matchedWhole = w;
        break;
      } catch {}
    }
    if (!matchedDir) {
      console.error(`\n✖ 在发现的 ${canonDirs.length} 个 canonical 子目录中均未找到账号 ${targetAccount}。`);
      process.exit(1);
    }
    say(`ℹ 锁定到匹配账号 ${targetAccount} 的子目录：${matchedDir}`);
    await exportOne(matchedWhole, outDir);
  } else if (allAccounts) {
    say(`\n发现 ${canonDirs.length} 个包含 canonical 存档的子目录，按账号分流导出：`);
    for (const d of canonDirs) {
      const w = loadCanonical(d, { allAccounts: true });
      const uid = w.account?.user_id ?? basename(d);
      const accOutDir = join(outDir, uid);
      say(`\n========================================`);
      say(`正在导出 ${d}（账号 ${uid}）→ ${accOutDir}/`);
      say(`========================================`);
      await exportOne(w, accOutDir);
    }
  } else {
    console.error(`✖ 发现多个子目录包含 canonical 存档（${canonDirs.join('、')}）。`);
    console.error('  直接导出可能导致第三方平台数据交叉污染。');
    console.error('  请使用 --account <uid> 指定账号，或使用 --all-accounts 批量导出。');
    process.exit(1);
  }
}
