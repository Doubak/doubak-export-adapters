/**
 * canonical → NeoDB 的 **NDJSON 归档**导入包。
 *
 * ## 为什么又多了一种 NeoDB 产出
 *
 * NeoDB 的维护者在 PR 里说得很直接：
 *
 * > 旧的CSV格式只是为了兼容NiceDB和Doufen，限制太多了。
 *
 * 也就是说 CSV 不只是「旧」，它是为了兼容另外两个工具留下的一层壳。而 NDJSON 是
 * NeoDB 自己导出、自己导入的格式，能装下 CSV **结构上装不下**的东西。拿真实的
 * 2950 条标记量过：
 *
 *   豆列 → Collection          CSV 没有这一档            6 份、134 条
 *   不挂作品的日记 → Article    CSV 的笔记必须挂条目       5 篇长文里的 3 篇
 *   状态历史 → ShelfLog        CSV 一条记录只有一行       3174 条带日期的事件
 *   每条记录各自的可见性        CSV 只有一个全局设置       1 份私密豆列
 *
 * 最后一样才是真正要紧的：豆瓣只存当前状态，**但广播是发出去那一刻就冻住的**，
 * 所以 3411 条广播里藏着一条 想看 → 在看 → 看过 的时间线，还带着当时打的星。
 * 2373 个作品有这样的历史，其中 678 个状态变过不止一次——**这是豆瓣自己都不再
 * 保留的东西**，而这个项目的导出路径里没有第二样能表达它。见 `--shelf-history`。
 *
 * ## 形状全部是读 `journal/importers/ndjson.py` 定的
 *
 * 老规矩：读导入器的源码，别读它的文档。下面五个坑每一个都是静默的——写错了照样
 * 是合法 JSON、照样解析通过、照样不报错，只是什么都没导进去。
 *
 * 1. **`ShelfLog` 的形状跟其他记录都不一样。** 它读顶层的 `item` / `status` /
 *    `timestamp`，不是 `content.withRegardTo` / `content.status` /
 *    `content.published`。其他每一种记录都是后者。
 * 2. **`ShelfMember` 上没有标签这一项。** CSV 是把标签挤在标记那一行里的，
 *    NDJSON 不从那儿读——`import_shelf_member` 只看 status / published /
 *    withRegardTo / progress。不单独出 `Tag` + `TagMember`，换个格式就等于
 *    丢掉 712 个标签，而且一声不吭。
 * 3. **`progress` 是三态的。** 键不在 = 不动，`null` = **清掉已有进度**，
 *    有值 = 恢复（`restore_progress` 的注释里写着为什么）。豆瓣不记「读到第几页」，
 *    所以这个键必须**整个不写**——写 `null` 会抹掉用户在 NeoDB 上手工填的进度。
 * 4. **这条路上没有 ISBN / IMDb 的 `info` 兜底。** `parse_catalog` 调的是
 *    `get_item_by_info_and_links("", "", links)`——标题空、info 空，只靠 URL。
 *    CSV 那边还能靠 `info` 列里的 `isbn:` 找回一本豆瓣页面已经没了的书，
 *    这边不能。**这是一处真实的倒退**，所以它写在报告里，也写在 README 里。
 * 5. **`_PREFERRED_SITES` 里 IMDb 排在豆瓣前面**，所以照旧把 IMDb 链接放进
 *    `external_resources`——既是提高匹配率，也是替「豆瓣哪天打不开」做准备。
 *
 * ## 三件故意不做的事
 *
 * - **不出 `actor.ndjson`。** `process_actor` 会拿归档里的名字和简介去覆盖目标
 *   账号的身份。带上它等于用豆瓣数据悄悄改写用户的 NeoDB 个人资料——一次导入的
 *   副作用不该是「你的昵称变了」。
 * - **不出 `attachments/`。** 图片字节在 WARC 里，这个工具只读 canonical 而且
 *   不联网。长文正文里的图片链接原样留着（指向豆瓣的 CDN），但没有随包搬运。
 * - **不写 `posts`。** 上游的 `import_post` 是个空函数，广播变不成嘟文。
 *
 * ## 可见性：NDJSON 这条路上表单里没有这个选项，所以只能写在文件里
 *
 * `import_*` 每一处都是 `data.get("visibility", self.metadata.get("visibility", 0))`
 * ——记录上没有这个键时，用的是任务上的那个。CSV 那边任务上的值来自上传表单里
 * 的三个单选框；**NDJSON 这边没有那三个单选框**：`data.html` 里检测到 ndjson 就把
 * `visibility_settings` 整个隐藏，于是 `request.POST.get("visibility", 0)` 恒为 0。
 *
 * 也就是说：什么都不写 = 全部公开，而且用户在界面上没有别的选择。所以这里给出
 * `--visibility`，把这个选择挪回文件里——**文件能表达表单表达不了的东西**，
 * 这跟私密豆列是同一条理由。
 *
 * 默认仍然是不写（= 公开）：豆瓣的标记本身没有可见性这一说，档案里也没有这个字段，
 * 替用户猜一个「仅关注者可见」出来是无中生有。唯一自己拿主意的地方是**私密豆列
 * → 2**（仅提及者可见，NeoDB 里最接近私密的一档）——那是档案确实知道的一件事，
 * 而且方向是收紧，不是放开。
 */

import { csv } from '../csv.js';
import { fieldsOf } from '../canonical.js';
import { classify, identifiers } from '../classify.js';

/** canonical 的状态 → NeoDB 的 ShelfType。豆瓣没有「弃了」，所以 dropped 用不上。 */
const SHELF = { wish: 'wishlist', doing: 'progress', done: 'complete' };

/**
 * 目标分类 → NeoDB 条目的 AP 类型名（`Item.ap_object_type` 就是类名）。
 *
 * 导入器**不读这个字段**——`parse_catalog` 只看 `id` 和 `external_resources`。
 * 写它是为了 2040 年有人 `jq` 这个文件的时候看得懂，这就是整个项目的前提。
 */
const AP_TYPE = {
  book: 'Edition',
  movie: 'Movie',
  tv: 'TVShow',
  music: 'Album',
  game: 'Game',
  performance: 'Performance',
};

/** NeoDB 的五个豆瓣站点规则认得的 URL 形状（逐条核对过 `catalog/sites/douban_*.py`）。 */
const RESOLVABLE = [
  /^https?:\/\/movie\.douban\.com\/subject\/\d+\/?$/,
  /^https?:\/\/book\.douban\.com\/subject\/\d+\/?$/,
  /^https?:\/\/music\.douban\.com\/subject\/\d+\/?$/,
  /^https?:\/\/www\.douban\.com\/game\/\d+\/?$/,
  /^https?:\/\/www\.douban\.com\/location\/drama\/\d+\/?[^#]*$/,
];

/**
 * 广播的 `target_type` → canonical 的 medium。别的值（doulist / sns / ilmen / rec /
 * fav / app / board）不是作品，直接跳过。
 *
 * **舞台剧那一档叫 `loc`，不叫 `drama`。** 是量出来的：3411 条广播里
 * `target_type` 一共出现 12 种值，其中根本没有 `drama`，而 `loc` 那 6 条指的是
 * `www.douban.com/location/drama/` 下面的条目（第一条是「音乐剧《剧院魅影》25周年
 * 纪念演出」）。照着 medium 的名字去猜键名，这 6 条会一声不吭地全部漏掉。
 */
const BROADCAST_MEDIUM = {
  movie: 'movie', book: 'book', music: 'music', game: 'game', loc: 'drama', drama: 'drama',
};

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

/** 一行 NDJSON。`undefined` 的键不会进 JSON，正好用来表达「这个键不写」。 */
function line(obj) {
  return `${JSON.stringify(obj)}\n`;
}

/**
 * canonical → NeoDB NDJSON 包。
 *
 * @param {ReturnType<import('../canonical.js').loadCanonical>} data
 * @param {{shelfHistory?: boolean, visibility?: number, generator?: string}} [options]
 *   `shelfHistory` 默认关：见 `--shelf-history` 的说明。
 *   `visibility` 默认 0（不写这个键，服务端就是公开）；1 = 仅关注者，2 = 仅提及者。
 * @returns {{files: {name: string, text: string}[],
 *            sidecars: {name: string, text: string}[], report: object}}
 *   `files` 进 zip，`sidecars` 写在 zip 旁边——后者是给人看的，不会被导入。
 */
export function buildNeodbNdjson(data, options = {}) {
  const { shelfHistory = false, visibility = 0, generator = 'doubak-export-adapters' } = options;
  if (![0, 1, 2].includes(visibility)) {
    throw new Error(`visibility 只能是 0（公开）/ 1（仅关注者）/ 2（仅提及者），收到 ${visibility}`);
  }
  /** 0 的时候不写这个键：少一个键，服务端的默认就是公开，两边意思一样。 */
  const vis = visibility === 0 ? undefined : visibility;

  const report = {
    marks: 0,
    ratings: 0,
    comments: 0,
    tags: 0, // 不同的标签名有几个
    tagMembers: 0, // 标签贴在作品上有几次
    reviews: 0,
    notes: 0,
    articles: 0, // 不挂作品的长文，CSV 那边没有去处
    collections: 0,
    collectionItems: 0,
    emptyCollections: 0, // 整份豆列一条都没剩下（里面全是评论/小组之类）
    shelfLogs: 0,
    catalogItems: 0,
    noLink: 0, // 作品在豆瓣被删掉，canonical 里连 URL 都没有
    noDetailPage: 0, // 没读到详情页，电影/剧集分不开，按电影处理
    noMarkedAt: 0, // 没有标记日期，`published` 整个不写
    noStatus: 0, // 状态认不出来，不替用户猜成「想看」
    emptyTags: 0, // 空标签，写进去会变成一个叫「_」的标签
    duplicateTags: 0, // 同一条标记上重复的标签
    privateCollections: 0,
    doulistEntriesDropped: 0, // 不是条目（评论 / 小组 / 人物 / 照片…），收藏单装不下
    doulistEntriesOutsideArchive: 0, // 是条目，但档案里没有——交给 NeoDB 自己去抓
    byCategory: {},
  };

  // ---- catalog 登记处 ------------------------------------------------------
  //
  // 每条 journal 记录靠 `withRegardTo` 指向这里的 `id`，而 `parse_catalog` 把
  // `id` 本身也当成一条匹配用的链接。所以 id 直接用豆瓣 URL：既是键，又是线索。

  /** @type {Map<string, {id: string, type?: string, title?: string, external_resources?: {url: string}[]}>} */
  const catalog = new Map();

  /**
   * 登记一个条目，返回它的 catalog id（也就是那个 URL）。
   * @param {string} url
   * @param {{category?: string, title?: string, imdb?: string|null}} [meta]
   */
  const ref = (url, meta = {}) => {
    if (!catalog.has(url)) {
      const entry = { id: url };
      if (meta.category && AP_TYPE[meta.category]) entry.type = AP_TYPE[meta.category];
      if (meta.title) entry.title = meta.title;
      if (meta.imdb) entry.external_resources = [{ url: `https://www.imdb.com/title/${meta.imdb}/` }];
      catalog.set(url, entry);
    }
    return url;
  };

  const byUrl = new Map();
  for (const s of data.subjects) if (s.url) byUrl.set(s.url, s);
  /** 豆瓣的 subject id 在不同 medium 下会撞号，所以按 id 查只在唯一命中时才算数。 */
  const byId = new Map();
  for (const s of data.subjects) {
    if (!byId.has(s.id)) byId.set(s.id, []);
    byId.get(s.id).push(s);
  }

  // ---- 标记 ---------------------------------------------------------------

  const marksOut = [];
  const ratingsOut = [];
  const commentsOut = [];
  const tagMembersOut = [];
  /** 标签名 → 第一次用到它的时间，用来给 `Tag` 记录一个稳定的次序。 */
  const tagNames = new Set();
  /** 出现在 zip 里的作品，`--shelf-history` 只给这些作品写历史。 */
  const markedItems = new Map();

  /** 一条链接都没有的那些。写在 zip 外面——它们不该被导入，只该被看见。 */
  const noLink = [];

  for (const mark of data.marks) {
    const f = fieldsOf(mark);
    const subject = data.subjectOf(mark);
    const sf = subject ? fieldsOf(subject) : null;
    const { category, guessed } = classify(mark.medium, sf);
    if (guessed) report.noDetailPage += 1;

    const url = mark.subject?.url ?? subject?.url ?? null;
    if (!url) {
      // 一条链接都没有 = 作品在豆瓣被删掉，canonical 里连 URL 都没留下。
      // 这一行**注定失败**：NDJSON 这条路只靠 URL 匹配，连 CSV 那边的
      // `info: isbn:…` 兜底都没有，所以比 CSV 更没救。
      //
      // 不再把它塞进 zip：**一条永远会失败的记录，代价不是那一行本身，
      // 是它教会用户忽略失败清单。**
      report.noLink += 1;
      noLink.push([mark.medium, mark.subject?.id ?? '', sf?.title ?? '（档案里也没有标题）',
        SHELF[f.status] ?? '', '条目已被豆瓣删除，canonical 里没有链接，NeoDB 无从定位']);
      continue;
    }

    // 状态是这条记录的全部内容，没有状态就没有东西可写。
    // `import_shelf_member` 自己会把缺失的 status 当成 wishlist，但**替用户
    // 宣称他想看一部作品，跟漏掉这一条不是一个量级的错**——所以挑出来给人看。
    // 实测这份档案 2950 条里 0 条命中，这一条是给别人的档案留的。
    const shelf = SHELF[f.status];
    if (!shelf) {
      report.noStatus += 1;
      noLink.push([mark.medium, mark.subject?.id ?? '', sf?.title ?? '（档案里也没有标题）',
        '', `状态是 ${JSON.stringify(f.status ?? null)}，认不出来；不替你猜一个`]);
      continue;
    }

    const ids = identifiers(sf);
    const item = ref(url, { category, title: sf?.title ?? undefined, imdb: ids.imdb });
    const published = f.marked_at?.iso ?? undefined;
    if (!published) report.noMarkedAt += 1;

    marksOut.push(line({
      type: 'ShelfMember',
      visibility: vis,
      metadata: {},
      content: {
        type: 'Status',
        status: shelf,
        published,
        withRegardTo: item,
      },
      // `progress` 故意不写。它是三态的，`null` 是「清掉已有进度」——
      // 豆瓣不记进度，我们无话可说，那就一个字都别说。
    }));
    report.marks += 1;
    markedItems.set(`${mark.medium}:${mark.subject?.id}`, item);

    const cat = report.byCategory[category] ?? (report.byCategory[category] = { marks: 0 });
    cat.marks += 1;

    if (f.rating) {
      ratingsOut.push(line({
        type: 'Rating',
        visibility: vis,
        metadata: {},
        // 豆瓣 1–5 星 → NeoDB 1–10 分。**永远不写 0**：「没打分」和「打了 0 分」
        // 是两件事，而且 `import_rating` 把 0 当成删除评分。
        content: { type: 'Rating', best: 10, worst: 1, value: f.rating * 2, published, withRegardTo: item },
      }));
      report.ratings += 1;
    }

    if (f.comment) {
      commentsOut.push(line({
        type: 'Comment',
        visibility: vis,
        metadata: {},
        content: { type: 'Comment', content: f.comment, published, withRegardTo: item },
      }));
      report.comments += 1;
    }

    const seenTags = new Set();
    for (const tag of f.tags ?? []) {
      // 标签走独立记录，所以 CSV 那边「标签里有 `|` 会被拆成两个」的问题
      // 在这条路上根本不存在——那是 `parse_tags` 按竖线切造成的。
      //
      // 空标签丢掉：`Tag.cleanup_title` 会把空串变成字面量 `_`，
      // 于是档案里多出一个叫「_」的标签，而它在豆瓣上并不存在。
      // 同一条标记上重复的标签也只写一次——`update_or_create` 那边虽然幂等，
      // 但产出里出现两条一模一样的记录，只会让人以为数据有问题。
      if (!tag || !tag.trim() || seenTags.has(tag)) {
        if (tag && seenTags.has(tag)) report.duplicateTags += 1;
        else report.emptyTags += 1;
        continue;
      }
      seenTags.add(tag);
      tagNames.add(tag);
      tagMembersOut.push(line({
        type: 'TagMember',
        visibility: vis,
        metadata: {},
        content: { type: 'Tag', tag, published, withRegardTo: item },
      }));
      report.tagMembers += 1;
    }
  }

  const tagsOut = [...tagNames].map((name) => line({ type: 'Tag', name, visibility: vis, pinned: false }));
  report.tags = tagNames.size;

  // ---- 长文：挂作品的进 Review / Note，不挂的进 Article ---------------------

  const reviewsOut = [];
  const notesOut = [];
  const articlesOut = [];

  for (const piece of data.longform) {
    const f = fieldsOf(piece);
    const published = f.published_at?.iso ?? undefined;
    const url = f.subject_url ?? null;
    const subject = url ? byUrl.get(url) ?? null : null;

    if (!url) {
      // CSV 那边这 3 篇日记是**直接丢掉的**——NeoDB 的笔记必须挂一个条目。
      // NDJSON 有 Article，不挂条目的长文终于有了去处。
      articlesOut.push(line({
        type: 'Article',
        visibility: vis,
        metadata: {},
        cover: null,
        content: {
          type: 'Article',
          name: f.title ?? '',
          summary: '',
          sensitive: false,
          tag: [],
          // 正文是 markdown（解析器对长文开着 preserveListMarkers），
          // 所以走 `source`；`import_article` 只在没有 source 的时候才退回 content。
          source: { content: f.body ?? '', mediaType: 'text/markdown' },
          published,
        },
      }));
      report.articles += 1;
      continue;
    }

    const category = subject
      ? classify(subject.medium, fieldsOf(subject)).category
      : categoryFromUrl(url);
    const ids = identifiers(subject ? fieldsOf(subject) : null);
    const item = ref(url, {
      category: category ?? undefined,
      title: subject ? fieldsOf(subject).title ?? undefined : undefined,
      imdb: ids.imdb,
    });

    if (piece.kind === 'review') {
      reviewsOut.push(line({
        type: 'Review',
        visibility: vis,
        metadata: {},
        content: {
          type: 'Review',
          name: f.title ?? '',
          content: f.body ?? '',
          mediaType: 'text/markdown',
          published,
          withRegardTo: item,
        },
      }));
      report.reviews += 1;
    } else {
      notesOut.push(line({
        type: 'Note',
        visibility: vis,
        metadata: {},
        content: {
          type: 'Note',
          title: f.title ?? '',
          content: f.body ?? '',
          sensitive: false,
          published,
          withRegardTo: item,
          // progress 同样不写：豆瓣不记「读到第几页」，编一个出来就是无中生有。
        },
      }));
      report.notes += 1;
    }
  }

  // ---- 豆列 → Collection ---------------------------------------------------
  //
  // CSV 那边这一档整个不存在，README 里写着「与其照着猜一个出来，不如明说这一路
  // 没做」。NDJSON 里它是一等公民，于是这句话可以撤了。

  const collectionsOut = [];
  const dropped = [];

  for (const doulist of data.doulists) {
    const f = fieldsOf(doulist);
    const items = [];
    for (const entry of f.items ?? []) {
      const resolved = resolveDoulistEntry(entry, { byUrl, byId });
      if (!resolved) {
        report.doulistEntriesDropped += 1;
        dropped.push([f.title ?? '', entry.category ?? '', entry.url ?? '',
          entry.title ?? '', '不是作品条目，NeoDB 的收藏单装不下']);
        continue;
      }
      if (!resolved.inArchive) report.doulistEntriesOutsideArchive += 1;
      const item = ref(resolved.url, {
        category: resolved.category ?? undefined,
        title: resolved.title ?? undefined,
      });
      // `append_item` 的 docstring 说具名字段要直接传、不要塞进 metadata dict，
      // 照着读会以为这条路不通。但 NeoDB 自己的测试
      // （`test_ndjson_member_note_edit_reindexes_collection`）就是拿
      // `append_item(item, metadata={"note": …})` 写、再读出 `member.note` 的——
      // metadata 这条路正是它自己在用的那条。**又一次：读源码，别读文档。**
      items.push(entry.comment ? { item, metadata: { note: entry.comment } } : { item, metadata: {} });
      report.collectionItems += 1;
    }

    const isPrivate = f.visibility && f.visibility !== 'public';
    if (isPrivate) report.privateCollections += 1;
    // 一条都没剩下的豆列照样写出去：这份单子存在过、叫什么、简介是什么，
    // 本身就是内容。但要数出来——**一个空收藏单看起来像出了错**，
    // 而它其实是「里面 43 项全是别人的影评，收藏单装不下」。
    if (items.length === 0) report.emptyCollections += 1;

    collectionsOut.push(line({
      type: 'Collection',
      // 只有这一处写 visibility：私密豆列 → 2（仅提及者可见）。
      // 档案知道、而上传表单表达不了，而且方向是收紧。
      visibility: isPrivate ? 2 : vis,
      metadata: {},
      collaborative: 0,
      query: null,
      cover: null,
      content: {
        name: f.title ?? '',
        content: f.description ?? '',
        published: latestObservedAt(doulist),
      },
      items,
    }));
    report.collections += 1;
  }

  // ---- 状态历史（`--shelf-history`） ---------------------------------------

  const shelfLogsOut = [];
  if (shelfHistory) {
    // 只给 zip 里真的有标记的作品写历史。既是为了 `--sample` 切出来的那份还是
    // 自洽的（`sample()` 不削广播），也是因为**给一个不在这份导出里的作品写历史
    // 是没有意义的**——导入时它连条目都定位不到。
    const seen = new Set();
    for (const b of data.broadcasts) {
      const f = fieldsOf(b);
      if (!f.status || !SHELF[f.status]) continue;
      const medium = BROADCAST_MEDIUM[f.target_type];
      if (!medium) continue; // doulist / sns / ilmen…——不是作品
      const item = markedItems.get(`${medium}:${f.target_id}`);
      if (!item) continue;
      const timestamp = f.posted_at?.iso;
      if (!timestamp) continue;

      // `import_shelf_log` 是按 (owner, item, shelf_type, timestamp) 做
      // update_or_create 的，重复本来无害；这边照样先去重，产出干净一点。
      const key = `${item}|${SHELF[f.status]}|${timestamp}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const metadata = {};
      // 广播是**发出去那一刻冻住的**，所以这颗星是「你那天打的分」，
      // 跟标记上那颗（豆瓣每次编辑都覆盖、不留历史）不是同一件事。
      if (f.rating) metadata.rating_grade = f.rating * 2;
      if (f.text) metadata.comment_text = f.text;

      shelfLogsOut.push(line({
        // 注意形状：顶层的 item / status / timestamp。
        // 其他每一种记录都是 content.withRegardTo / content.published。
        type: 'ShelfLog',
        item,
        status: SHELF[f.status],
        timestamp,
        metadata,
        // `posts` 不写：上游的 import_post 是空函数。
      }));
      report.shelfLogs += 1;
    }
  }

  // ---- 组文件 --------------------------------------------------------------

  report.catalogItems = catalog.size;

  // 表头行。**里面不许有墙上时钟**——`zip.js` 把时间戳钉在 1980-01-01 就是为了
  // 「同一份 canonical 导两次，产物逐字节相同」，表头里塞个 now() 会把这条毁掉。
  // `parse_header` 只要求 `server` 非空，其余它只拿去打日志。
  const header = {
    server: 'doubak.com',
    generator,
    username: data.account?.username ?? '',
    user_id: data.account?.user_id ?? '',
  };

  const catalogText = line(header) + [...catalog.values()].map(line).join('');
  // 次序照 `import_funcs` 的次序写。`process_journal` 先按 type 分桶，所以次序
  // 对导入没影响——是为了这个文件 diff 起来能读。
  const journalText = line(header) + [
    ...tagsOut, ...tagMembersOut, ...ratingsOut, ...commentsOut, ...marksOut,
    ...reviewsOut, ...notesOut, ...collectionsOut, ...shelfLogsOut, ...articlesOut,
  ].join('');

  const files = [
    { name: 'catalog.ndjson', text: catalogText },
    { name: 'journal.ndjson', text: journalText },
  ];

  const sidecars = [];
  if (noLink.length) {
    sidecars.push({
      name: 'neodb-needs-check.csv',
      text: csv(['medium', 'subject_id', 'title', 'status', 'why'], noLink),
    });
  }
  if (dropped.length) {
    sidecars.push({
      name: 'neodb-doulist-needs-check.csv',
      text: csv(['doulist', 'category', 'url', 'title', 'why'], dropped),
    });
  }

  return { files, sidecars, report };
}

/**
 * 一条豆列条目能不能变成 NeoDB 收藏单里的一项。
 *
 * 实测这份档案 6 份豆列共 134 条：58 条压根不是条目（43 篇评论、5 个小组、
 * 5 篇日记、2 个人物、1 张照片、2 个站点），剩下的里只有 7 条能直接对上档案里的
 * 作品 URL。差距几乎全在游戏上：
 *
 * **分类 3114、写成 `www.douban.com/subject/<id>/` 的条目其实是游戏**，而
 * `DoubanGame.URL_PATTERNS` 不认这个形状，它要 `www.douban.com/game/<id>/`。
 * 这个改写是量出来的不是猜的：31 条 id 在档案里的条目里，30 条是游戏、1 条是电影，
 * 而那 30 条在档案里存的 URL 全部是 `www.douban.com/game/<id>/`。
 *
 * 对不上档案、但 URL 形状是 NeoDB 认得的，照样出一行 catalog——NeoDB 会自己去
 * 豆瓣抓，跟它处理没见过的标记是同一套。
 *
 * @param {{url?: string, category?: string, title?: string}} entry
 * @param {{byUrl: Map<string, object>, byId: Map<string, object[]>}} index
 * @returns {{url: string, category: string|null, title: string|null, inArchive: boolean}|null}
 */
function resolveDoulistEntry(entry, { byUrl, byId }) {
  const url = entry.url ?? '';
  if (!url) return null;

  const known = byUrl.get(url);
  if (known) {
    const kf = fieldsOf(known);
    return { url, category: classify(known.medium, kf).category, title: kf.title ?? null, inArchive: true };
  }

  const m = /\/(?:subject|game)\/(\d+)\/?$/.exec(url);
  if (!m) return null;

  // 档案里按 id 唯一命中：直接用档案里存的那个 URL，那是**查出来的**，不是推的。
  const hits = byId.get(m[1]) ?? [];
  if (hits.length === 1 && hits[0].url) {
    const hf = fieldsOf(hits[0]);
    return {
      url: hits[0].url,
      category: classify(hits[0].medium, hf).category,
      title: hf.title ?? null,
      inArchive: true,
    };
  }

  // 档案里没有。分类 3114 + `www.douban.com/subject/` 是游戏，改写成游戏的 URL。
  if (entry.category === '3114' && /^https?:\/\/www\.douban\.com\/subject\/\d+\/?$/.test(url)) {
    return { url: `https://www.douban.com/game/${m[1]}/`, category: 'game', title: entry.title ?? null, inArchive: false };
  }

  // 形状本来就是 NeoDB 认得的，原样交给它。
  if (RESOLVABLE.some((p) => p.test(url))) {
    return { url, category: categoryFromUrl(url), title: entry.title ?? null, inArchive: false };
  }
  return null;
}

/**
 * 一条记录最后一次被看见的时间。豆列没有「创建时间」这个字段——豆瓣页面上不给，
 * 所以拿观测时间当 `published`，而不是编一个。
 * @param {{revisions?: {last_observed_at?: string}[]}} record
 */
function latestObservedAt(record) {
  let best;
  for (const r of record.revisions ?? []) {
    if (!best || (r.last_observed_at ?? '') > best) best = r.last_observed_at;
  }
  return best ?? undefined;
}
