/**
 * 跟产出文件一起写出去的一份说明。
 *
 * 三个平台的上传入口都藏在设置里的不同地方，而且 Letterboxd 是**两次**上传
 * （看过一次、想看一次）——只给一堆 CSV 不说去哪儿传，等于没做完。
 *
 * 说明里带着这一次的真实条数。「导出成功」这四个字什么也没说，
 * 「看过 952 部、想看 508 部、剧集 639 部没导」才说明白了发生过什么。
 */

/** @param {{neodb?: object, letterboxd?: object, goodreads?: object, doulists: number, multiRevisionMarks: number}} r */
export function instructions(r) {
  const L = [];
  L.push('# 怎么把这些文件导进去');
  L.push('');
  L.push('这几个文件是从档案里现算出来的。**它们不是备份**——备份是 WARC 和 canonical，');
  L.push('删掉这个目录随时能重出一份一模一样的。');
  L.push('');

  if (r.neodb) {
    L.push('## NeoDB');
    L.push('');
    L.push('设置 → 数据 → 导入 → **CSV**，上传 `neodb/neodb-import.zip`（整个 zip，不用解压）。');
    L.push('');
    L.push(`这一次带了 **${r.neodb.marks} 条标记**、${r.neodb.reviews} 篇书评影评、${r.neodb.notes} 篇笔记。`);
    L.push('NeoDB 是按 zip 里的豆瓣链接找条目的，它库里没有的会自己去豆瓣抓一份建出来，');
    L.push('所以第一次导会慢，而且要挂着。');
    L.push('');
    if (r.doulists) {
      L.push(`⚠ **${r.doulists} 份豆列没有导出。** NeoDB 的 CSV 导入里没有「收藏单」这一档，`);
      L.push('它的收藏单只在 NeoDB 自己的 NDJSON 归档格式里有。豆列还在 canonical 里，');
      L.push('也在生成的站点里。');
      L.push('');
    }
    if (r.neodb.noLink) {
      L.push(`⚠ **${r.neodb.noLink} 条没有放进 zip**：这些作品豆瓣已经删掉了，`);
      L.push('档案里连链接都没有，NeoDB 无从定位。它们列在 `neodb/neodb-needs-check.csv` 里，');
      L.push('那个文件**不要上传**——放进去只会固定报几个失败，把真出问题的那条盖住。');
      L.push('');
    }
    if (r.neodb.unattachedLongform) {
      L.push(`⚠ **${r.neodb.unattachedLongform} 篇日记没有导出**，因为它们不挂在任何作品上，`);
      L.push('而 NeoDB 的笔记必须挂一个条目。');
      L.push('');
    }
  }

  if (r.letterboxd) {
    L.push('## Letterboxd');
    L.push('');
    L.push('**要传两次**，两个入口不一样：');
    L.push('');
    L.push(`1. 看过的 ${r.letterboxd.watched} 部 —— Settings → Import & Export → Import your data，`);
    L.push('   上传 `letterboxd/letterboxd-watched.csv`。它会一部一部让你确认匹配结果。');
    L.push(`2. 想看的 ${r.letterboxd.watchlist} 部 —— 到 Watchlist 页面，用那里的导入，`);
    L.push('   上传 `letterboxd/letterboxd-watchlist.csv`。');
    L.push('');
    L.push('两个分开是有意的：混在一起的话，想看的片子会变成「看过但没写日期」，');
    L.push('那是**替你宣称你看过没看过的电影**。');
    L.push('');
    L.push(`⚠ Letterboxd 只收电影。剧集 ${r.letterboxd.skippedTv} 部、`);
    L.push(`非影视 ${r.letterboxd.skippedOther} 条，一条都没导。`);
    if (r.letterboxd.skippedUnknown) {
      L.push(`另有 ${r.letterboxd.skippedUnknown} 条没读到详情页、分不清是电影还是剧集，也没导。`);
    }
    L.push('');
    if (r.letterboxd.noImdb) {
      L.push(`⚠ ${r.letterboxd.noImdb} 部**没有 IMDb 号**，见 \`letterboxd-needs-check.csv\`。`);
      L.push('它们照样写进上面两个文件了，只是匹配全靠标题和年份，多半要手工挑。');
      L.push('');
    }
  }

  if (r.goodreads) {
    L.push('## Goodreads');
    L.push('');
    L.push('My Books → Import and export → Import Books，上传 `goodreads/goodreads.csv`。');
    L.push('');
    L.push(`这一次带了 **${r.goodreads.books} 本书**`
      + `（读过 ${r.goodreads.read} · 在读 ${r.goodreads.reading} · 想读 ${r.goodreads.toRead}）。`);
    L.push('Goodreads 的匹配基本只认 ISBN——书名和作者名都是中文，帮不上忙。');
    if (r.goodreads.noIsbn) {
      L.push(`⚠ ${r.goodreads.noIsbn} 本没有 ISBN，见 \`goodreads-needs-check.csv\`。`);
    }
    L.push('');
  }

  L.push('## 有一样东西三个平台都收不下');
  L.push('');
  L.push('canonical 里一条标记记的是**一串观测**：哪个版本的解析器、在什么时候、看见了什么。');
  L.push('三个平台都只收「现在是什么样」，一条记录一行。');
  if (r.multiRevisionMarks) {
    L.push('');
    L.push(`这份档案里有 **${r.multiRevisionMarks} 条标记改过**，导出的是最后一次。`);
  }
  L.push('');
  L.push('这是对外导出该有的方向，但反过来不成立：**别把这些 CSV 当成你的档案。**');
  L.push('');
  return L.join('\n');
}
