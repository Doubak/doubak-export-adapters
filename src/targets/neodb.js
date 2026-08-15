/**
 * canonical → NeoDB 的 CSV 导入包。
 *
 * ## 为什么是 CSV，不是 API
 *
 * 项目里原先写着「NeoDB 适配器卡在要先跟维护者谈」——那是把 API 当成唯一入口时的
 * 判断。NeoDB 还收一种**用户自己上传的 zip**（`journal/importers/csv.py`），
 * 于是这条路上：不用 OAuth、不用 key、没有速率限制、**不需要任何人批准**，
 * 而且没有给这个项目新添一个活的外部依赖。
 *
 * 后一点是硬约束，不是偏好：整个 doubak 的前提是「丢掉全部派生数据，离线重建」。
 * 一个要联网才能产出的导出器，等于把刚拆掉的依赖又装回去。这里产出的是一个文件，
 * 用户什么时候上传、上不上传，都不影响档案。
 *
 * ## 列的形状是读源码定的，不是读文档定的
 *
 * 标记：`title, info, links, timestamp, status, rating, comment, tags`
 * 书评：`title, info, links, timestamp, title, content`  ← **表头里有两个 `title`**
 * 笔记：`title, info, links, timestamp, progress, title, content`  ← 同上
 *
 * 那个重复的表头不是笔误，是必须原样照抄的：NeoDB 用 `csv.DictReader` 读，重复键
 * **后一个赢**，所以 `row["title"]` 拿到的是第 5（或第 6）列的**书评标题**；
 * 而第 1 列的作品名压根没参与匹配（`get_item_by_info_and_links` 收下 title 之后
 * 从没用过它）。照「看起来对」的写法把重复表头去掉，书评就全部变成无标题。
 *
 * ## 匹配靠 `links`，而豆瓣链接本身就是能匹配上的
 *
 * `importers/base.py` 把 `links` 里每个 URL 丢给 `SiteManager.get_site_by_url`，
 * 而 NeoDB 注册了豆瓣的 movie / book / music / game / drama 五种站点。逐条核对过
 * 它们的 `URL_PATTERNS` 与档案里的真实 URL：五种全部匹配（舞台剧那条尤其要核，
 * `DoubanDramaVersion` 要求 URL 带 `#` 片段，`DoubanDrama` 才是我们这种）。
 * NeoDB 库里没有的条目，它会自己去豆瓣抓一份建出来。
 *
 * 一个顺带查出来的事实：**文件名里的分类不参与匹配。** `run()` 只拿分类去拼文件名，
 * 拼到了就整张表交给 `import_mark`，而 `import_mark` 从没看过这一行是从哪个文件读来的。
 * 所以「电影还是剧集」分错桶在这边没有后果——真正要紧的只是文件名必须是那七个之一，
 * 否则整张表不会被读。（Letterboxd 那边就不是这样，见 `letterboxd.js`。）
 *
 * 有 IMDb 的时候一并把 IMDb 链接写进去，因为 NeoDB 的偏好次序里 IMDB 排在豆瓣
 * 前面——**这条也是替豆瓣哪天打不开做的准备**：条目在豆瓣被删掉之后，
 * 豆瓣链接就抓不出东西了，IMDb 链接还在。
 *
 * ## 导不出去的东西，一件一件说出来
 *
 * - **豆列**：CSV 导入里根本没有「收藏单」这一档，Collection 只存在于 NeoDB 自己的
 *   NDJSON 归档格式里，而那个格式要两遍扫描、要先解析出条目表，是它的内部实现细节。
 *   与其照着猜一个出来，不如明说这一路没做。
 * - **不挂在作品上的日记**：NeoDB 的笔记必须挂一个条目。实测 5 篇长文里 3 篇
 *   （都是日记）没有 `subject_url`，那 3 篇没有去处。
 * - **修订历史**：见 `canonical.js`。
 */

import { csv } from '../csv.js';
import { fieldsOf } from '../canonical.js';
import { classify, identifiers } from '../classify.js';

const MARK_HEADER = ['title', 'info', 'links', 'timestamp', 'status', 'rating', 'comment', 'tags'];
const REVIEW_HEADER = ['title', 'info', 'links', 'timestamp', 'title', 'content'];
const NOTE_HEADER = ['title', 'info', 'links', 'timestamp', 'progress', 'title', 'content'];

/** canonical 的状态 → NeoDB 的 ShelfType。豆瓣没有「弃了」，所以 dropped 用不上。 */
const SHELF = { wish: 'wishlist', doing: 'progress', done: 'complete' };

/** 长文指向的 URL → 分类，只在那个作品不在档案里时用。 */
function categoryFromUrl(url) {
  if (!url) return null;
  if (url.includes('book.douban.com')) return 'book';
  if (url.includes('music.douban.com')) return 'music';
  if (url.includes('/game/')) return 'game';
  if (url.includes('/location/drama/')) return 'performance';
  if (url.includes('movie.douban.com')) return 'movie'; // 剧集判不了，退回电影
  return null;
}

/** `info` 列：空格分隔的 `key:value`。值里不能有空格，这几个字段都没有。 */
function infoColumn(ids) {
  const bits = [];
  if (ids.imdb) bits.push(`imdb:${ids.imdb}`);
  if (ids.isbn) bits.push(`isbn:${ids.isbn}`);
  if (ids.year) bits.push(`year:${ids.year}`);
  return bits.join(' ');
}

/**
 * @param {ReturnType<import('../canonical.js').loadCanonical>} data
 * @returns {{files: {name: string, text: string}[], report: object}}
 */
export function buildNeodb(data) {
  /** @type {Map<string, {marks: unknown[][], reviews: unknown[][], notes: unknown[][]}>} */
  const buckets = new Map();
  const bucket = (category) => {
    if (!buckets.has(category)) buckets.set(category, { marks: [], reviews: [], notes: [] });
    return buckets.get(category);
  };

  const report = {
    marks: 0,
    reviews: 0,
    notes: 0,
    noLink: 0, // 作品在豆瓣被删掉，canonical 里连 URL 都没有
    noDetailPage: 0, // 没读到详情页，电影/剧集分不开，按电影处理
    unattachedLongform: 0, // 日记不挂作品，NeoDB 没地方放
    tagsWithPipe: 0, // 标签里有 `|`，会被 NeoDB 拆成两个
    byCategory: {},
  };

  const byUrl = new Map();
  for (const s of data.subjects) if (s.url) byUrl.set(s.url, s);

  for (const mark of data.marks) {
    const f = fieldsOf(mark);
    const subject = data.subjectOf(mark);
    const sf = subject ? fieldsOf(subject) : null;
    const { category, guessed } = classify(mark.medium, sf);
    if (guessed) report.noDetailPage += 1;

    const ids = identifiers(sf);
    const links = [];
    const url = mark.subject?.url ?? subject?.url ?? null;
    if (url) links.push(url);
    if (ids.imdb) links.push(`https://www.imdb.com/title/${ids.imdb}/`);
    if (links.length === 0) report.noLink += 1;

    const tags = f.tags ?? [];
    if (tags.some((t) => t.includes('|'))) report.tagsWithPipe += 1;

    bucket(category).marks.push([
      sf?.title ?? '',
      infoColumn(ids),
      links.join(' '),
      f.marked_at?.iso ?? '',
      SHELF[f.status] ?? '',
      f.rating ? f.rating * 2 : '', // 豆瓣 1–5 星 → NeoDB 1–10 分
      f.comment ?? '',
      tags.join('|'),
    ]);
    report.marks += 1;
  }

  for (const item of data.longform) {
    const f = fieldsOf(item);
    const url = f.subject_url ?? null;
    if (!url) {
      report.unattachedLongform += 1;
      continue;
    }
    const subject = byUrl.get(url) ?? null;
    const category = subject
      ? classify(subject.medium, fieldsOf(subject)).category
      : categoryFromUrl(url);
    if (!category) {
      report.unattachedLongform += 1;
      continue;
    }
    const ids = identifiers(subject ? fieldsOf(subject) : null);
    const head = [
      subject ? (fieldsOf(subject).title ?? '') : '',
      infoColumn(ids),
      url,
      f.published_at?.iso ?? '',
    ];
    if (item.kind === 'review') {
      bucket(category).reviews.push([...head, f.title ?? '', f.body ?? '']);
      report.reviews += 1;
    } else {
      // 读书笔记这类挂在作品上的长文。progress 留空——豆瓣不记「读到第几页」，
      // 编一个出来就是无中生有。
      bucket(category).notes.push([...head, '', f.title ?? '', f.body ?? '']);
      report.notes += 1;
    }
  }

  // 文件名就是分类，NeoDB 是按文件名分桶的。空的那一档不写文件——
  // 一个 0 行的 `podcast_mark.csv` 只会让人以为漏抓了播客。
  const files = [];
  for (const [category, b] of [...buckets].sort()) {
    report.byCategory[category] = { marks: b.marks.length, reviews: b.reviews.length, notes: b.notes.length };
    if (b.marks.length) files.push({ name: `${category}_mark.csv`, text: csv(MARK_HEADER, b.marks) });
    if (b.reviews.length) files.push({ name: `${category}_review.csv`, text: csv(REVIEW_HEADER, b.reviews) });
    if (b.notes.length) files.push({ name: `${category}_note.csv`, text: csv(NOTE_HEADER, b.notes) });
  }

  return { files, report };
}
