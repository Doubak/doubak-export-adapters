/**
 * canonical → Letterboxd 的导入 CSV。
 *
 * ## Letterboxd 只收电影，而豆瓣的「电影」里三成是剧集
 *
 * 实测这份档案：1465 部电影、638 部剧集。剧集导进 Letterboxd 有两种下场，
 * 第二种更糟——匹配不上（用户会看见），或者**匹配到一部同名电影上**
 * （用户不会看见，而且是错的）。所以这里只出 `category === 'movie'` 的，
 * 剧集的条数单独报出来，让用户知道少了什么、少了多少。
 *
 * ## 标题用原名，不用中文名
 *
 * Letterboxd 的库里没有中文条目。`重返寂静岭` 匹配不到任何东西，
 * `Return to Silent Hill` 能。解析器把豆瓣的 `<h1>` 存成 `中文名 / 原名`，
 * 这里取斜杠后面那半。实测 2107 部电影里 1779 部有原名。
 *
 * ## 导演列不写
 *
 * Letterboxd 允许用 Title + Year + Directors 做模糊匹配，但档案里的导演名是中文
 * （`克里斯托夫·甘斯`），跟它库里的 `Christophe Gans` 对不上。**给一个对不上的
 * 导演名，比不给更糟**：它会把本来靠标题能猜中的那几条也否掉。
 *
 * 真正干活的是 `imdbID`，实测 1423/1465 部电影有（97%）。
 *
 * ## 「想看」是另一个文件，不是同一个文件里的一种状态
 *
 * Letterboxd 的观影记录和想看清单是两份东西，导入也是两次上传。混在一起的话，
 * 513 部想看的片子会变成 513 条「看过但没写日期」的记录——**那是在替用户宣称
 * 他看过没看过的电影。**
 *
 * 「在看」（豆瓣的在看）Letterboxd 没有对应状态。放进想看清单里：不声称看过、
 * 不写日期、不写评分，是三个选项里唯一不伪造事实的。这份档案里在看的电影是 0 部
 * （17 部在看全是剧集），但另一个人的档案里不会是 0。
 *
 * ## 没读到详情页的，一条都不往外送
 *
 * 分不出电影还是剧集，只能退回默认值「电影」——**而这里是唯一一个「猜错要付代价」
 * 的地方。** 一部剧集当电影送进 Letterboxd，最好的结果是匹配不上，最坏的结果是
 * 匹配到一部同名电影，于是用户的观影记录里凭空多出一部他没看过的片子。
 *
 * 这跟 NeoDB 那边不一样：NeoDB 的 CSV 是靠 `links` 里的豆瓣链接定位条目的，
 * 文件名里的分类根本不参与匹配（`import_mark` 收下一行之后从没看过它是从哪个文件
 * 读来的），所以那边分错桶没有后果。
 *
 * 所以：`guessed` 的一律不进两个导入文件，改列进 `letterboxd-needs-check.csv`。
 * 代价是详情页一张都没抓过的人会导出一个空文件——但那件事是真的，
 * **报告里会把条数说出来**，而不是给他一份看起来正常、实则一半是假的观影记录。
 */

import { csv } from '../csv.js';
import { fieldsOf } from '../canonical.js';
import { classify, identifiers, splitTitle } from '../classify.js';

const WATCHED_HEADER = ['Title', 'Year', 'imdbID', 'Rating', 'WatchedDate', 'Tags', 'Review'];
const WATCHLIST_HEADER = ['Title', 'Year', 'imdbID'];
const CHECK_HEADER = ['Title', 'Year', 'DoubanURL', 'Why'];

/** `marked_at` → `YYYY-MM-DD`。豆瓣本来就是这个格式，这里只做防御。 */
function watchedDate(markedAt) {
  const raw = markedAt?.raw ?? markedAt?.iso ?? '';
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(raw));
  return m ? m[1] : '';
}

/**
 * @param {ReturnType<import('../canonical.js').loadCanonical>} data
 * @returns {{files: {name: string, text: string}[], report: object}}
 */
export function buildLetterboxd(data) {
  const watched = [];
  const watchlist = [];
  const needsCheck = [];
  const report = {
    watched: 0,
    watchlist: 0,
    watching: 0, // 在看，放进了想看清单
    skippedTv: 0,
    skippedOther: 0, // 图书 / 音乐 / 游戏 / 舞台剧，Letterboxd 根本不收
    skippedUnknown: 0, // 没读到详情页，电影剧集分不开，不敢往外送
    noImdb: 0,
    noOriginalTitle: 0,
    tagsWithComma: 0,
  };

  for (const mark of data.marks) {
    const subject = data.subjectOf(mark);
    const sf = subject ? fieldsOf(subject) : null;
    const { category, guessed } = classify(mark.medium, sf);
    if (category === 'tv') {
      report.skippedTv += 1;
      continue;
    }
    if (category !== 'movie') {
      report.skippedOther += 1;
      continue;
    }

    const f = fieldsOf(mark);
    const ids = identifiers(sf);
    const { local, original } = splitTitle(sf?.title ?? null);
    const title = original ?? local;
    if (!original) report.noOriginalTitle += 1;

    if (guessed) {
      report.skippedUnknown += 1;
      needsCheck.push([
        title,
        ids.year ?? '',
        mark.subject?.url ?? '',
        '没读到详情页，分不清是电影还是剧集，没有导出',
      ]);
      continue;
    }

    if (!ids.imdb) {
      report.noImdb += 1;
      needsCheck.push([
        title,
        ids.year ?? '',
        mark.subject?.url ?? '',
        original ? '没有 IMDb 号，只能靠标题+年份猜' : '没有 IMDb 号，标题还是中文，几乎猜不中',
      ]);
    }

    if (f.status === 'done') {
      const tags = f.tags ?? [];
      if (tags.some((t) => t.includes(','))) report.tagsWithComma += 1;
      watched.push([
        title,
        ids.year ?? '',
        ids.imdb ?? '',
        f.rating ?? '', // 豆瓣 1–5 星 = Letterboxd 1–5 星，不换算
        watchedDate(f.marked_at),
        tags.join(','),
        f.comment ?? '',
      ]);
      report.watched += 1;
    } else {
      if (f.status === 'doing') report.watching += 1;
      watchlist.push([title, ids.year ?? '', ids.imdb ?? '']);
      report.watchlist += 1;
    }
  }

  const files = [];
  if (watched.length) files.push({ name: 'letterboxd-watched.csv', text: csv(WATCHED_HEADER, watched) });
  if (watchlist.length) files.push({ name: 'letterboxd-watchlist.csv', text: csv(WATCHLIST_HEADER, watchlist) });
  // 这份单子里有两种东西，`Why` 那一列分得开：
  //   · 没 IMDb 号的**照样写进了上面两个文件**——Letterboxd 导入时会一条条让人确认，
  //     匹配不上顶多是跳过，没有代价。
  //   · 没读到详情页的**没有写进去**，因为把剧集当电影送出去是有代价的。
  if (needsCheck.length) files.push({ name: 'letterboxd-needs-check.csv', text: csv(CHECK_HEADER, needsCheck) });

  return { files, report };
}
