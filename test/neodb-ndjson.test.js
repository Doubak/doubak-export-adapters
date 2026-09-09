import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCanonical, fieldsOf } from '../src/canonical.js';
import { buildNeodbNdjson, UNKNOWN_VISIBILITY_DEFAULT } from '../src/targets/neodb-ndjson.js';
import { buildNeodb } from '../src/targets/neodb.js';
import { sample } from '../src/sample.js';
import { FIXTURE, fileNamed, parseCsvObjects } from './helpers.js';

const data = loadCanonical(FIXTURE);
// 默认**带**状态历史，所以「不带」得显式说。这一行以前是 `buildNeodbNdjson(data)`，
// 默认翻过来之后它就不再是「不带」的那一份了。
const plain = buildNeodbNdjson(data, { shelfHistory: false });
const withHistory = buildNeodbNdjson(data, { shelfHistory: true });

/** 一份产出里的 journal 记录（跳过表头行）。 */
function journal({ files }) {
  return fileNamed(files, 'journal.ndjson').text
    .split('\n').filter(Boolean).slice(1).map((l) => JSON.parse(l));
}
/** catalog 里的 id 集合。 */
function catalogIds({ files }) {
  return new Set(fileNamed(files, 'catalog.ndjson').text
    .split('\n').filter(Boolean).slice(1).map((l) => JSON.parse(l).id));
}
const of = (records, type) => records.filter((r) => r.type === type);

// ── 形状契约 ──────────────────────────────────────────────────────────────

/**
 * 从 `journal/importers/ndjson.py` 一行一行抄下来的：每种记录，导入器**在哪一层**
 * 读哪些键。
 *
 * 这张表存在的理由跟扩展那边 `offscreen-contract.test.js` 一样：真正会出事的环境
 * （一个跑着的 NeoDB）这边任何测试都进不去，所以检查只能是静态的。而这一路最容易
 * 犯、也最难发现的错就是**把键写在错的那一层**——`ShelfLog` 读顶层的
 * `item` / `status` / `timestamp`，其他每一种记录读的都是 `content.withRegardTo` /
 * `content.status` / `content.published`。写反了照样是合法 JSON、照样解析通过、
 * 照样一条不导，而且不报错。
 */
const CONTRACT = {
  Tag: { top: ['name', 'visibility', 'pinned'], content: [] },
  TagMember: { top: ['visibility', 'metadata'], content: ['tag', 'published', 'withRegardTo'] },
  Rating: {
    top: ['visibility', 'metadata'],
    content: ['value', 'published', 'updated', 'withRegardTo'],
  },
  Comment: {
    top: ['visibility', 'metadata'],
    content: ['content', 'published', 'updated', 'withRegardTo'],
  },
  ShelfMember: {
    top: ['visibility', 'metadata', 'progress'],
    content: ['status', 'published', 'updated', 'withRegardTo'],
  },
  Review: {
    top: ['visibility', 'metadata', 'images'],
    content: ['name', 'content', 'published', 'updated', 'withRegardTo'],
  },
  Note: {
    top: ['visibility', 'metadata', 'attachments'],
    content: ['title', 'content', 'sensitive', 'progress', 'published', 'updated', 'withRegardTo'],
  },
  Collection: {
    top: ['visibility', 'metadata', 'collaborative', 'query', 'cover', 'items', 'images'],
    content: ['name', 'content', 'published', 'updated'],
  },
  Article: {
    top: ['visibility', 'metadata', 'cover', 'images'],
    content: [
      'name', 'summary', 'sensitive', 'tag', 'source', 'content', 'published', 'updated',
    ],
  },
  ShelfLog: {
    top: ['item', 'status', 'timestamp', 'metadata', 'posts'],
    content: [],
    // ShelfLog 上出现这几个键，就说明写的人把它当成了别的记录。
    forbidden: ['content', 'withRegardTo', 'published'],
  },
};

test('每种记录的键都写在导入器读它的那一层上', () => {
  const records = journal(withHistory);
  let checked = 0;
  const types = new Set();
  for (const r of records) {
    const c = CONTRACT[r.type];
    assert.ok(c, `产出里出现了契约表里没有的记录类型 ${r.type}`);
    types.add(r.type);

    for (const k of c.forbidden ?? []) {
      assert.ok(!(k in r), `${r.type} 上不该有 ${k}——那是别的记录的形状`);
    }
    // `type` 两层都可以有：顶层是导入器分桶用的，content 里那个是照抄 ap_object。
    // `content` 在顶层是那个信封本身，跟 `content.content`（正文）同名但不是一回事——
    // ShelfLog 上不许有它，那一条在上面的 forbidden 里单独管。
    const onlyContent = c.content.filter((k) => !c.top.includes(k));
    for (const k of Object.keys(r)) {
      if (k === 'type' || k === 'content') continue;
      assert.ok(!onlyContent.includes(k), `${r.type} 把 ${k} 写在了顶层，导入器只从 content 里读它`);
    }
    const onlyTop = c.top.filter((k) => !c.content.includes(k));
    for (const k of Object.keys(r.content ?? {})) {
      if (k === 'type') continue;
      assert.ok(!onlyTop.includes(k), `${r.type} 把 ${k} 写在了 content 里，导入器只从顶层读它`);
    }
    checked += 1;
  }
  // 正则/循环写坏了会让这个检查永远绿着——所以它必须证明自己真的扫到了东西。
  assert.ok(checked >= 50, `只核了 ${checked} 条记录，样本太小`);
  assert.ok(types.size >= 8, `只核到 ${types.size} 种记录类型，样本太小`);
});

test('ShelfLog 用顶层的 item / status / timestamp，不是 content.withRegardTo', () => {
  // 单独再写一遍，因为这是这条路上唯一一处形状不一致的地方。
  const logs = of(journal(withHistory), 'ShelfLog');
  assert.ok(logs.length > 0);
  for (const l of logs) {
    assert.equal(typeof l.item, 'string');
    assert.ok(l.status);
    assert.ok(l.timestamp);
    assert.ok(!l.content, 'ShelfLog 不该有 content');
  }
});

// ── 引用完整性 ────────────────────────────────────────────────────────────

test('每一个引用都能在 catalog 里找到——对不上就是一条静默导不进去的记录', () => {
  for (const built of [plain, withHistory]) {
    const ids = catalogIds(built);
    let refs = 0;
    for (const r of journal(built)) {
      const list = [];
      if (r.content?.withRegardTo) list.push(r.content.withRegardTo);
      if (r.type === 'ShelfLog') list.push(r.item);
      for (const m of r.items ?? []) list.push(m.item);
      for (const u of list) {
        assert.ok(ids.has(u), `${u} 不在 catalog.ndjson 里`);
        refs += 1;
      }
    }
    assert.ok(refs >= 50, `只核了 ${refs} 处引用，样本太小`);
  }
});

test('上传页面靠这两个文件名认格式，所以名字不能动', () => {
  // `data.html` 里那段 JSZip 找的就是 journal.ndjson / catalog.ndjson，
  // 而且是在 zip 根目录下——认不出就只能显示「未知格式」，连传都传不上去。
  assert.deepEqual(plain.files.map((f) => f.name).sort(), ['catalog.ndjson', 'journal.ndjson']);
});

// ── 标记、评分、短评、标签 ─────────────────────────────────────────────────

test('标记只出 ShelfMember，一个作品一条', () => {
  const marks = of(journal(plain), 'ShelfMember');
  assert.equal(marks.length, plain.report.marks);
  const seen = new Set(marks.map((m) => m.content.withRegardTo));
  assert.equal(seen.size, marks.length);
  for (const m of marks) {
    assert.ok(['wishlist', 'progress', 'complete'].includes(m.content.status));
  }
});

test('ShelfMember 上一个 progress 键都不能有', () => {
  // 三态：键不在 = 不动，null = **清掉用户在 NeoDB 上手工填的进度**。
  // 豆瓣不记「读到第几页」，所以只能一个字都不说。
  for (const m of of(journal(withHistory), 'ShelfMember')) {
    assert.ok(!('progress' in m), '写了 progress 键，null 会抹掉用户自己填的进度');
  }
});

test('豆瓣 1–5 星换成 NeoDB 的 1–10 分，而且永远不写 0', () => {
  // 0 不是「没打分」——`import_rating` 把 0 当成删除评分。
  const ratings = of(journal(plain), 'Rating');
  assert.equal(ratings.length, plain.report.ratings);
  for (const r of ratings) {
    assert.ok(r.content.value > 0 && r.content.value <= 10 && r.content.value % 2 === 0,
      `评分 ${r.content.value} 不对`);
  }
  const byUrl = new Map(ratings.map((r) => [r.content.withRegardTo, r.content.value]));
  let checked = 0;
  for (const mark of data.marks) {
    const url = mark.subject?.url;
    const f = fieldsOf(mark);
    if (!url) continue;
    if (f.rating) { assert.equal(byUrl.get(url), f.rating * 2); checked += 1; } else {
      assert.ok(!byUrl.has(url), `${url} 档案里没打分，产物里却有 Rating`);
    }
  }
  assert.ok(checked >= 10, `只核了 ${checked} 条评分`);
});

test('标签走 Tag + TagMember——ShelfMember 上根本没有标签这一项', () => {
  // 照 CSV 的想法把标签挤进标记那一行，NDJSON 这边会一声不吭地全部丢掉。
  const records = journal(plain);
  const names = of(records, 'Tag').map((t) => t.name);
  assert.equal(names.length, new Set(names).size, 'Tag 不该重复');
  assert.equal(names.length, plain.report.tags);
  assert.equal(of(records, 'TagMember').length, plain.report.tagMembers);
  for (const m of of(records, 'ShelfMember')) {
    assert.ok(!('tags' in m.content), 'ShelfMember 上写 tags 没有任何作用');
  }
  // 每个 TagMember 用到的名字，都得有一条对应的 Tag。
  const known = new Set(names);
  for (const tm of of(records, 'TagMember')) assert.ok(known.has(tm.content.tag));
});

test('标签里的竖线原样留着——CSV 那边会被拆成两个，这边不会', () => {
  // `parse_tags` 是按 `|` 切的，那是 CSV 那条路专有的问题。
  const marks = new Map();
  for (const m of data.marks) if (m.subject?.url) marks.set(m.subject.url, fieldsOf(m).tags ?? []);
  const got = new Map();
  for (const tm of of(journal(plain), 'TagMember')) {
    if (!got.has(tm.content.withRegardTo)) got.set(tm.content.withRegardTo, []);
    got.get(tm.content.withRegardTo).push(tm.content.tag);
  }
  let checked = 0;
  for (const [url, want] of marks) {
    if (!want.length) continue;
    assert.deepEqual(got.get(url), want, `${url} 的标签跟档案不一致`);
    checked += 1;
  }
  assert.ok(checked >= 10, `只核了 ${checked} 条标记的标签`);
});

test('用户写的字一个不少地过去了', () => {
  const byUrl = new Map(of(journal(plain), 'Comment').map((c) => [c.content.withRegardTo, c.content.content]));
  let checked = 0;
  for (const mark of data.marks) {
    const url = mark.subject?.url;
    const want = fieldsOf(mark).comment;
    if (!url || !want) continue;
    assert.equal(byUrl.get(url), want);
    checked += 1;
  }
  assert.ok(checked >= 10, `只核了 ${checked} 条短评`);
});

test('没有标记日期的那条不写 published，而不是编一个', () => {
  const marks = of(journal(plain), 'ShelfMember');
  const without = marks.filter((m) => !('published' in m.content));
  assert.equal(without.length, plain.report.noMarkedAt);
  assert.ok(plain.report.noMarkedAt > 0, 'fixture 里该有一条没有标记日期的');
});

// ── 长文 ──────────────────────────────────────────────────────────────────

test('不挂作品的日记变成 Article——CSV 那边这几篇是直接丢掉的', () => {
  const arts = of(journal(plain), 'Article');
  assert.equal(arts.length, 4);
  for (const a of arts) {
    assert.equal(a.content.source.mediaType, 'text/markdown');
    assert.ok(a.content.source.content.length > 0);
    assert.ok(!a.content.withRegardTo, 'Article 不挂条目');
  }
  const titles = arts.map((a) => a.content.name);
  assert.ok(titles.includes('豆瓣更换海外手机号显示“不可预期状态”的解决方案'));
});

// ── 在豆瓣上不公开的长文 ──────────────────────────────────────────────────
//
// 起因：`Doubak/doubak-export-adapters#4`。日记默认按公开导入，而 NeoDB 的
// Article 是要联邦出去的，于是一篇在豆瓣上「仅自己可见」的日记会被推上公网。
//
// 而「仅自己可见」有两个成因，**方向相反**：作者自己藏的，和豆瓣锁掉的。前者发
// 出去就撤不回来；后者留住它恰恰是这份存档存在的理由。这里能有一个安全的默认值，
// 是因为**导出不等于公开**——记录照样进用户自己的账号，只是不对外可见，
// 要不要公开由他在 NeoDB 自己那一页上决定。

test('**作者自己藏的收成 visibility=2，公开的不写**', () => {
  const arts = of(journal(plain), 'Article');
  const 藏 = arts.find((a) => a.content.name === '测试一下私密日记？');
  const 公开 = arts.find((a) => a.content.name === '测试一下带图的日记');
  assert.equal(藏.visibility, 2, '作者自己藏起来的日记不该公开导入');
  assert.ok(!('visibility' in 公开), '公开的日记跟其他记录一样不写');
});

test('**豆瓣锁掉的照常公开导入** —— 它本来就是公开的，是豆瓣把它关掉的', () => {
  // 档案主人定的（2026-09-07）。那篇日记之所以「仅自己可见」，恰恰因为它曾经是
  // 公开的；跟着豆瓣一起把它收起来，这份存档就白存了。
  //
  // **这一条要单独测，不能靠上一条的反面。** 「作者藏的收起来」与「豆瓣锁的不收」
  // 是两条独立的规则，把 `restricted` 写成恒假会让前者失效而这条照样绿。
  const 锁 = of(journal(plain), 'Article').find((a) => a.content.name === '想看的被河蟹的电影');
  assert.ok(!('visibility' in 锁), '被豆瓣锁掉的日记不该跟着一起收起来');
});

test('`--visibility` 收紧时，豆瓣锁的那篇跟着基线走，不例外', () => {
  // 「按公开导入」说的是**不单独收紧**，不是「无论如何都公开」。用户明确要求
  // 全部收紧时，它没有理由自成一档——那会变成替用户拿主意的第二次。
  const 收紧 = buildNeodbNdjson(data, { visibility: 2 });
  const 锁 = of(journal(收紧), 'Article').find((a) => a.content.name === '想看的被河蟹的电影');
  assert.equal(锁.visibility, 2);
});

test('**正文一个字都不许少** —— 收起来的是可见性，不是内容', () => {
  // 「不公开」与「不导出」是两件事。这份存档存在的理由正是留住豆瓣拿掉的东西，
  // 而把它整条丢掉就是替豆瓣把它二次消音——那比公开导入更隐蔽，因为一条被静默
  // 丢掉的记录不留任何痕迹给人发现。
  const 锁 = of(journal(plain), 'Article').find((a) => a.content.name === '想看的被河蟹的电影');
  assert.ok(锁.content.source.content.includes('An Unfinished Film'), '正文没了');
});

test('**评论恒为 null，那是「不适用」不是「不知道」，不许被收起来**', () => {
  // 豆瓣压根没给评论这个功能（实测 2 篇评论页上「私密」「仅自己」「可见」一个字
  // 都没有，连容器都不存在）。并进「不知道」的话，每个人的每一篇影评书评都会被
  // 收成 visibility=2 —— 而它们在豆瓣上本来就挂在作品页上给所有人看。
  for (const r of of(journal(plain), 'Review')) {
    assert.ok(!('visibility' in r), `${r.content.name} 不该被收起来`);
  }
});

test('**缺这个字段的老 canonical 按不公开处理**', () => {
  // 解析器 0.12.0 才开始写它。两个方向的代价差着一个量级：把公开的收成 2，
  // 用户点一下就改回来；把私密的推上联邦，撤不回来。
  // 只深拷 longform 那一段：`loadCanonical` 的产出里挂着函数，整份 structuredClone
  // 会抛 DataCloneError。
  const old = { ...data, longform: JSON.parse(JSON.stringify(data.longform)) };
  for (const piece of old.longform) {
    // **三个字段一起删。** 0.12.0 之前的 canonical 里一个都没有，只删 visibility
    // 的话那篇被豆瓣锁的还留着 restricted_by，模拟的就不是老档案了。
    for (const rev of piece.revisions) {
      delete rev.fields.visibility;
      delete rev.fields.restricted_by;
      delete rev.fields.restriction_notice;
    }
  }
  const arts = of(journal(buildNeodbNdjson(old, {})), 'Article');
  assert.ok(arts.length > 0, '一篇 Article 都没有，这条测试什么都没查');
  // **连那篇被豆瓣锁掉的也一起收起来**：`restricted_by` 是跟着 `visibility` 一起
  // 删掉的，于是这份老档案里根本没有「豆瓣锁的」这个正面证据。认不出来不等于
  // 豆瓣锁的——后者要证据，前者什么都没有。
  for (const a of arts) assert.equal(a.visibility, 2, `${a.content.name} 该按不公开处理`);
  // 评论仍然不受影响 —— 它们本来就是「不适用」而不是「不知道」。
  for (const r of of(journal(buildNeodbNdjson(old, {})), 'Review')) {
    assert.ok(!('visibility' in r), '评论不该跟着被收起来');
  }
});

test('**报告要逐篇点名，还要说清是谁让它不公开的**', () => {
  // 只给一个数字的话，看的人分不出「这是我自己藏的」和「这是豆瓣拿下的」——
  // 而那正是拿豆瓣的审查冒充用户的意愿。
  const { report } = plain;
  // **豆瓣锁的那篇也在名单里，尽管它是被公开导出的那一篇。** 恰恰更该说：
  // 联邦出去撤不回来，而看的人得知道自己正在把什么重新发出去。
  assert.deepEqual(
    report.restricted.map((x) => [x.title, x.by, x.url]).sort(),
    [['想看的被河蟹的电影', 'platform', 'https://www.douban.com/note/868128497/'],
      ['测试一下私密日记？', 'author', 'https://www.douban.com/topic/499256241/']].sort(),
  );
});

test('**认不出是谁设的，报告里就说认不出，不说「你自己设的」**', () => {
  // 两者都收成 visibility=2，行为一模一样——差别只在那句话上。而告诉用户
  // 「这是你自己设成私密的」，在我们其实没读出来的时候，是在替他编造一个决定。
  // 突变验过：把 unsure 那一支改成 author，行为测试一条都不红。
  const bend = (mut) => {
    const old = { ...data, longform: JSON.parse(JSON.stringify(data.longform)) };
    const one = old.longform.find((x) => fieldsOf(x).title === '测试一下带图的日记');
    for (const rev of one.revisions) mut(rev.fields);
    return buildNeodbNdjson(old, {}).report.restricted
      .find((x) => x.title === '测试一下带图的日记');
  };
  assert.deepEqual(
    bend((f) => { f.visibility = 'unknown'; }),
    // 带上网址：这一栏的下一步动作是**去看那一页**，只给标题的话还得先自己找。
    { title: '测试一下带图的日记', by: 'unsure', why: 'unrecognized', url: 'https://www.douban.com/topic/496284296/' },
  );
  // **两个成因要分开，因为下一步动作正好相反。** 老档案重跑一次解析器就有了；
  // 豆瓣改版那种重跑多少次都还是认不出来，要改的是抽取器。合成一句必然把一半人
  // 支去做一件做不成的事——与站点那边把「缺图」和「图烂了」分开报是同一条。
  assert.deepEqual(
    bend((f) => { delete f.visibility; delete f.restricted_by; }),
    { title: '测试一下带图的日记', by: 'unsure', why: 'legacy', url: 'https://www.douban.com/topic/496284296/' },
  );
  // 说得出是谁设的时候，`why` 就没有意义，必须是 null 而不是猜一个。
  assert.equal(bend((f) => { f.visibility = 'private'; f.restricted_by = 'author'; }).why, null);
});

test('挂在作品上的影评变成 Review，正文标成 markdown', () => {
  const reviews = of(journal(plain), 'Review');
  assert.equal(reviews.length, 2);
  const one = reviews.find((r) => r.content.withRegardTo === 'https://www.douban.com/game/10758368/');
  assert.equal(one.content.name, '噗，搬运一下组里用来做测试的攻略吧 - CROSS†CHANNEL汉化版攻略');
  assert.equal(one.content.mediaType, 'text/markdown');
  assert.ok(one.content.content.length > 1000);
});

// ── 豆列 ──────────────────────────────────────────────────────────────────

test('豆列变成 Collection——CSV 那边整个没有这一档', () => {
  const cols = of(journal(plain), 'Collection');
  assert.equal(cols.length, data.doulists.length);
  for (const c of cols) assert.ok(Array.isArray(c.items));
});

test('私密豆列写 visibility=2，公开的不写', () => {
  // 这是唯一一处自己拿主意写可见性的地方：档案确实知道，而 NDJSON 的上传表单
  // 根本没有这个选项，而且方向是收紧不是放开。
  const cols = of(journal(plain), 'Collection');
  const priv = cols.find((c) => c.content.name === 'SELECTS');
  assert.equal(priv.visibility, 2);
  const pub = cols.find((c) => c.content.name === '游戏购买小账本');
  assert.ok(!('visibility' in pub), '公开豆列不写 visibility，跟其他记录一致');
});

test('分类 3114 写成 /subject/ 的其实是游戏，要改写成 /game/', () => {
  // NeoDB 的 DoubanGame.URL_PATTERNS 不认 `www.douban.com/subject/<id>/`。
  // 实测：31 条 id 在档案里的条目，30 条是游戏，而档案里存的 URL 全是 /game/。
  const games = of(journal(plain), 'Collection').find((c) => c.content.name === '游戏购买小账本');
  const urls = games.items.map((i) => i.item);
  assert.ok(urls.includes('https://www.douban.com/game/30237482/'), '档案里没有这个 id，按分类改写');
  assert.ok(urls.includes('https://www.douban.com/game/37294205/'), '档案里有这个 id，用档案里存的 URL');
  for (const u of urls) {
    assert.ok(!/^https?:\/\/www\.douban\.com\/subject\//.test(u), `${u} 这个形状 NeoDB 认不出来`);
  }
});

test('不是条目的豆列成员写进旁挂文件，不塞进 zip', () => {
  // NeoDB 的收藏单只装条目。别人的影评、小组、人物、照片没有去处——
  // 硬塞进去只会变成一批注定失败的行。
  assert.equal(plain.report.doulistEntriesDropped, 1);
  const sc = fileNamed(plain.sidecars, 'neodb-doulist-needs-check.csv');
  assert.ok(sc.text.includes('douban.com/review/7500205/'));
  assert.ok(!plain.files.some((f) => f.name.includes('needs-check')));
});

test('豆列成员的短评带过去了', () => {
  const games = of(journal(plain), 'Collection').find((c) => c.content.name === '游戏购买小账本');
  const one = games.items.find((i) => i.item === 'https://www.douban.com/game/30237482/');
  assert.match(one.metadata.note, /amazon/);
});

test('一条都没剩下的豆列照样写出去，但要数出来', () => {
  // 单子存在过、叫什么、简介是什么，本身就是内容。但一个空收藏单看起来像出了错，
  // 所以它得在报告里有一行。
  assert.equal(plain.report.emptyCollections, 1);
  const empty = of(journal(plain), 'Collection').find((c) => c.items.length === 0);
  assert.equal(empty.content.name, 'SELECTS');
});

// ── 状态历史 ──────────────────────────────────────────────────────────────

test('默认就带状态历史，显式关掉才没有', () => {
  // 2026-08-25 把默认翻了过来。这段历史豆瓣自己已经不留了，不带走就是永久丢掉；
  // 而写错的代价是 NeoDB 上多几行日期不对的历史，不动标记、不发时间线、也不联邦。
  const byDefault = buildNeodbNdjson(data);
  assert.ok(byDefault.report.shelfLogs > 0, '不给 options 也该有历史');
  assert.equal(of(journal(byDefault), 'ShelfLog').length, byDefault.report.shelfLogs);
  assert.equal(of(journal(plain), 'ShelfLog').length, 0);
  assert.equal(plain.report.shelfLogs, 0);
  assert.ok(withHistory.report.shelfLogs > 0);
});

test('广播还原出来的历史带着当天的星和当天的字', () => {
  // 标记上那颗星是豆瓣**每次编辑都覆盖**的最后一次；广播是发出去那一刻冻住的，
  // 所以它是「你那天打的分」。这两件事不一样，而豆瓣自己只留后者。
  const logs = of(journal(withHistory), 'ShelfLog')
    .filter((l) => l.item === 'https://www.douban.com/game/37294205/')
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  assert.deepEqual(logs.map((l) => l.status), ['wishlist', 'progress', 'complete']);
  assert.equal(logs[1].metadata.rating_grade, 10);
  assert.ok(logs[0].metadata.comment_text.length > 0);
});

test('舞台剧的广播 target_type 是 loc，不是 drama', () => {
  // 3411 条广播里 target_type 一共 12 种值，其中根本没有 `drama`。
  // 照着 medium 的名字猜键名，这几条会一声不吭地全部漏掉。
  const logs = of(journal(withHistory), 'ShelfLog')
    .filter((l) => l.item.includes('/location/drama/'));
  assert.ok(logs.length >= 2, '舞台剧的历史该有两条（想看 → 看过）');
});

test('不是作品的广播不进历史', () => {
  // doulist / sns / ilmen / rec / fav / app / board——转发、收藏豆列之类。
  const items = new Set(of(journal(withHistory), 'ShelfLog').map((l) => l.item));
  for (const u of items) {
    assert.match(u, /douban\.com\/(subject|game|location)\//, `${u} 不是作品 URL`);
  }
});

test('历史只给 zip 里真有标记的作品写', () => {
  // 一个不在这份导出里的作品，导入时连条目都定位不到；写它的历史没有意义。
  // 这条同时保证 `--sample` 切出来的那份还是自洽的（sample() 不削广播）。
  const marked = new Set(of(journal(withHistory), 'ShelfMember').map((m) => m.content.withRegardTo));
  for (const l of of(journal(withHistory), 'ShelfLog')) {
    assert.ok(marked.has(l.item), `${l.item} 有历史却没有标记`);
  }
});

// ── catalog ───────────────────────────────────────────────────────────────

test('catalog 的 id 就是豆瓣链接——它既是键，也是唯一的匹配线索', () => {
  // `parse_catalog` 调的是 get_item_by_info_and_links("", "", links)：
  // 标题空、info 空，只靠 URL。CSV 那边 `info: isbn:…` 的兜底这边没有。
  const entries = fileNamed(plain.files, 'catalog.ndjson').text
    .split('\n').filter(Boolean).slice(1).map((l) => JSON.parse(l));
  const patterns = [
    /^https?:\/\/movie\.douban\.com\/subject\/\d+\/?$/,
    /^https?:\/\/book\.douban\.com\/subject\/\d+\/?$/,
    /^https?:\/\/music\.douban\.com\/subject\/\d+\/?$/,
    /^https?:\/\/www\.douban\.com\/game\/\d+\/?$/,
    /^https?:\/\/www\.douban\.com\/location\/drama\/\d+\/?[^#]*$/,
  ];
  for (const e of entries) {
    assert.ok(patterns.some((p) => p.test(e.id)), `NeoDB 认不出这个链接: ${e.id}`);
  }
  assert.ok(entries.length >= 15, `catalog 只有 ${entries.length} 条，样本太小`);
});

test('有 IMDb 的一并写进 external_resources', () => {
  // `_PREFERRED_SITES` 里 IMDb 排在豆瓣前面；而且条目哪天在豆瓣被删了，
  // IMDb 链接还在。
  const entries = fileNamed(plain.files, 'catalog.ndjson').text
    .split('\n').filter(Boolean).slice(1).map((l) => JSON.parse(l));
  const one = entries.find((e) => e.id === 'https://movie.douban.com/subject/34965089/');
  assert.deepEqual(one.external_resources, [{ url: 'https://www.imdb.com/title/tt22868010/' }]);
  const noImdb = entries.find((e) => e.id === 'https://www.douban.com/game/26927545/');
  assert.ok(!noImdb.external_resources, '没有 IMDb 就不写这个键');
});

test('没有豆瓣链接的那条不进 zip，改写进旁挂文件', () => {
  // NDJSON 这条路只靠 URL 匹配，连 CSV 那边的 isbn 兜底都没有，
  // 所以这一行比在 CSV 里更没救。
  assert.equal(plain.report.noLink, 1);
  const sc = fileNamed(plain.sidecars, 'neodb-needs-check.csv');
  assert.equal(sc.text.trim().split('\n').length, 2); // 表头 + 1 行
  const ids = catalogIds(plain);
  for (const id of ids) assert.ok(id, 'catalog 里不该有空 id');
});

// ── 不做的那几件事 ────────────────────────────────────────────────────────

test('不出 actor.ndjson——它会覆盖用户在 NeoDB 上的昵称和简介', () => {
  assert.ok(!plain.files.some((f) => f.name === 'actor.ndjson'));
});

test('不写 posts，也不出 post 记录——上游那段是空函数', () => {
  for (const r of journal(withHistory)) {
    assert.notEqual(r.type, 'post');
    assert.ok(!('posts' in r), '写 posts 没有任何作用');
  }
});

// ── 可见性 ────────────────────────────────────────────────────────────────

test('默认不写 visibility：写死 0 跟不写等价，但不写不会盖掉别的', () => {
  // **两处例外，都是「档案确实知道它不公开」，方向都是收紧。**
  const 私密豆列 = (r) => r.type === 'Collection' && r.visibility === 2;
  const 作者藏的长文 = (r) => ['Article', 'Note', 'Review'].includes(r.type) && r.visibility === 2;
  let 例外 = 0;
  for (const r of journal(plain)) {
    if (私密豆列(r) || 作者藏的长文(r)) { 例外 += 1; continue; }
    assert.ok(!('visibility' in r), `${r.type} 默认不该写 visibility`);
  }
  // **例外要数出来。** 不数的话，这两个谓词哪天因为字段改名而恒为假，这条测试
  // 会照样通过——而它守的正是「除了它们，别的都不许写」。
  //
  // 2 而不是 3：那篇被豆瓣锁掉的日记**按公开导入**，所以它不在例外里，
  // 而是走上面那条「默认不该写 visibility」。
  assert.equal(例外, 2, '1 份私密豆列 + 1 篇作者自己藏的日记');
});

test('--visibility=1 把每条记录都写上，除了更严的私密豆列', () => {
  // NDJSON 的上传页面把可见性单选框整个藏起来了（检测到 ndjson 就 display:none），
  // 所以这个选择只能写在文件里。
  const followers = buildNeodbNdjson(data, { visibility: 1 });
  let checked = 0;
  for (const r of journal(followers)) {
    if (r.type === 'ShelfLog') continue; // import_shelf_log 不读 visibility
    if (r.type === 'Collection' && r.content.name === 'SELECTS') {
      assert.equal(r.visibility, 2, '私密豆列不该被放宽');
      continue;
    }
    // 在豆瓣上不公开的长文同理：`--visibility` 是给公开记录定基线的，
    // **它不该把已知不公开的东西放宽**。两处例外方向一致。
    if ((r.content?.name ?? r.content?.title) === '测试一下私密日记？') {
      assert.equal(r.visibility, 2, '作者自己藏起来的日记不该被放宽');
      continue;
    }
    assert.equal(r.visibility, 1, `${r.type} 没写上 visibility`);
    checked += 1;
  }
  assert.ok(checked >= 50, `只核了 ${checked} 条`);
});

test('visibility 只收 0 / 1 / 2', () => {
  assert.throws(() => buildNeodbNdjson(data, { visibility: 3 }), /visibility 只能是/);
});

// ── 可重现 ────────────────────────────────────────────────────────────────

test('同一份 canonical 导两次，逐字节相同', () => {
  // `zip.js` 把时间戳钉在 1980-01-01 就是为了这个；表头里塞一个 now()
  // 会把这条毁掉，而「这次导出跟上次有什么不一样」就再也答不了了。
  const a = buildNeodbNdjson(data, { shelfHistory: true });
  const b = buildNeodbNdjson(data, { shelfHistory: true });
  assert.deepEqual(a.files, b.files);
  assert.deepEqual(a.sidecars, b.sidecars);
});

test('表头第一行带 server，否则 parse_header 认不出来', () => {
  for (const name of ['catalog.ndjson', 'journal.ndjson']) {
    const first = JSON.parse(fileNamed(plain.files, name).text.split('\n')[0]);
    assert.ok(first.server, `${name} 的表头没有 server`);
    // 墙上时钟会毁掉可重现性。
    assert.ok(!JSON.stringify(first).includes(String(new Date().getFullYear())),
      `${name} 的表头里有当前时间`);
  }
});

// ── 跟 CSV 那一路对一遍 ────────────────────────────────────────────────────

test('NDJSON 跟 CSV 在 CSV 表达得了的每一件事上完全一致', () => {
  // 两份产物各自都跟 canonical 对过了，所以这不是重复劳动。
  // **CSV 那条路是唯一做过真实往返的**（2026-08-20，42 条进去 41 条），
  // 所以它是「已知好的」那一份——NDJSON 跟它不一致的地方，就是
  // 「一个验证过的行为被改掉了」的地方，而这正是换格式最容易出的事故。
  //
  // 只对 CSV 装得下的东西。豆列、不挂作品的日记、状态历史 CSV 里没有，
  // 不一致是意料之中的。
  // CSV 的解析交给 helpers 里那份独立实现，别拿写出器自己的逻辑去验自己。
  const csvRows = new Map();
  for (const f of buildNeodb(data).files) {
    if (!f.name.endsWith('_mark.csv')) continue;
    for (const r of parseCsvObjects(f.text)) {
      csvRows.set(r.links.split(' ')[0], r);
    }
  }

  const records = journal(plain);
  const nd = new Map();
  const entry = (u) => {
    if (!nd.has(u)) nd.set(u, {});
    return nd.get(u);
  };
  for (const r of records) {
    const u = r.content?.withRegardTo;
    if (r.type === 'ShelfMember') entry(u).status = r.content.status;
    if (r.type === 'Rating') entry(u).rating = String(r.content.value);
    if (r.type === 'Comment') entry(u).comment = r.content.content;
    if (r.type === 'TagMember') (entry(u).tags ??= []).push(r.content.tag);
  }

  assert.equal(nd.size, csvRows.size, '两条路带走的作品数不一样');
  let checked = 0;
  for (const [url, row] of csvRows) {
    const n = nd.get(url);
    assert.ok(n, `${url} 在 CSV 里有，NDJSON 里没有`);
    assert.equal(n.status, row.status, `${url} 状态不一致`);
    assert.equal(n.rating ?? '', row.rating, `${url} 评分不一致`);
    assert.equal(n.comment ?? '', row.comment, `${url} 短评不一致`);
    assert.equal((n.tags ?? []).join('|'), row.tags, `${url} 标签不一致`);
    checked += 1;
  }
  assert.ok(checked >= 15, `只核了 ${checked} 个作品，样本太小`);
});

test('书评在两条路里是同一篇', () => {
  // CSV 那边的书评表头里有两个 title，`row.title` 拿到的是第 5 列的书评标题——
  // 那是整条 CSV 路上唯一有实证的判断（真导进去之后标题确实在）。
  const csvReviews = [];
  for (const f of buildNeodb(data).files) {
    if (!f.name.endsWith('_review.csv')) continue;
    for (const r of parseCsvObjects(f.text)) csvReviews.push(r);
  }
  const ndReviews = of(journal(plain), 'Review');
  assert.equal(ndReviews.length, csvReviews.length);
  for (const c of csvReviews) {
    const n = ndReviews.find((x) => x.content.withRegardTo === c.links);
    assert.ok(n, `${c.links} 的书评只在 CSV 里`);
    assert.equal(n.content.name, c.title);
    assert.equal(n.content.content, c.content);
  }
});

test('没有链接、进不了 zip 的那几条，两条路挑出来的是同一批', () => {
  const csvSide = fileNamed(buildNeodb(data).sidecars, 'neodb-needs-check.csv').text;
  const ndSide = fileNamed(plain.sidecars, 'neodb-needs-check.csv').text;
  assert.equal(ndSide, csvSide);
});

// ── 边角情况 ──────────────────────────────────────────────────────────────
//
// 下面一部分对着 fixture 里真实存在的形状（换行的短评、没有标题的作品），
// 一部分对着**现实档案里 0 次命中**的形状——那些用现搭的最小 canonical 验，
// 并且注明是搭出来的。0 次命中不等于不会发生：这份档案是一个人的，
// 而这些代码是给所有人的。

/** 现搭一份最小 canonical。只放测试要用的字段，其余按真实形状留空。 */
function tiny({ marks = [], subjects = [], longform = [], doulists = [], broadcasts = [] }) {
  const rev = (fields) => ({
    revisions: [{ parser_version: 'test', last_observed_at: '2026-01-01T00:00:00+08:00', fields }],
  });
  const out = {
    marks: marks.map((m) => ({ medium: m.medium, subject: m.subject, ...rev(m.fields) })),
    subjects: subjects.map((s) => ({ medium: s.medium, id: s.id, url: s.url, ...rev(s.fields ?? {}) })),
    longform: longform.map((l) => ({ kind: l.kind, ...rev(l.fields) })),
    doulists: doulists.map((d) => rev(d.fields)),
    broadcasts: broadcasts.map((b) => rev(b.fields)),
    account: { user_id: '1', username: 'test' },
    multiRevisionMarks: 0,
  };
  const byKey = new Map(out.subjects.map((s) => [`${s.medium}:${s.id}`, s]));
  out.subjectOf = (m) => byKey.get(`${m.medium}:${m.subject?.id}`) ?? null;
  return out;
}

const MOVIE = { medium: 'movie', id: '1', url: 'https://movie.douban.com/subject/1/', fields: { title: 'X' } };
const markOn = (fields) => ({ medium: 'movie', subject: { id: '1', url: MOVIE.url }, fields });

test('一条记录一行——短评里的换行绝不能把记录切成两半', () => {
  // 这是 NDJSON 唯一真正致命的失败：一个没转义的换行会把一条记录劈开，
  // 而后面**整份文件**的行号全部错位。实测档案里有 20 条短评带换行。
  const text = fileNamed(withHistory.files, 'journal.ndjson').text;
  const lines = text.split('\n').filter(Boolean);
  for (const l of lines) JSON.parse(l); // 逐行必须能单独解析
  assert.equal(lines.length, journal(withHistory).length + 1); // +1 是表头

  const withNewline = of(journal(plain), 'Comment')
    .filter((c) => /[\r\n]/.test(c.content.content));
  assert.ok(withNewline.length > 0, 'fixture 里该有带换行的短评');
  // 原文一个字不差地回来了
  const byUrl = new Map(data.marks.filter((m) => m.subject?.url)
    .map((m) => [m.subject.url, fieldsOf(m).comment]));
  for (const c of withNewline) {
    assert.equal(c.content.content, byUrl.get(c.content.withRegardTo));
  }
});

test('没有标题的作品不写 title 键，而不是写 null', () => {
  // 实测档案里有 8 个。`"title": null` 跟没有这个键在 JSON 里不是一回事，
  // 而这个字段导入器根本不读——写一个 null 进去只是噪音。
  const entries = fileNamed(plain.files, 'catalog.ndjson').text
    .split('\n').filter(Boolean).slice(1).map((l) => JSON.parse(l));
  for (const e of entries) {
    if ('title' in e) assert.ok(e.title, `${e.id} 的 title 是空的`);
    if ('type' in e) assert.ok(e.type, `${e.id} 的 type 是空的`);
  }
});

test('状态认不出来的标记不猜成「想看」，挑出来给人看', () => {
  // 现实档案里 0 条命中。`import_shelf_member` 自己会把缺失的 status 当成
  // wishlist——**替用户宣称他想看一部作品，比漏掉这一条严重得多**。
  const d = tiny({
    subjects: [MOVIE],
    marks: [markOn({ status: null, marked_at: { iso: '2024-01-01T00:00:00+08:00' } })],
  });
  const built = buildNeodbNdjson(d);
  assert.equal(built.report.noStatus, 1);
  assert.equal(built.report.marks, 0);
  assert.equal(of(journal(built), 'ShelfMember').length, 0);
  assert.match(fileNamed(built.sidecars, 'neodb-needs-check.csv').text, /不替你猜一个/);
});

test('空标签丢掉——写进去会变成一个叫「_」的标签', () => {
  // `Tag.cleanup_title` 把空串变成字面量 `_`，于是档案里凭空多一个豆瓣上
  // 并不存在的标签。
  const d = tiny({
    subjects: [MOVIE],
    marks: [markOn({ status: 'done', tags: ['科幻', '', '   '] })],
  });
  const built = buildNeodbNdjson(d);
  assert.deepEqual(of(journal(built), 'Tag').map((t) => t.name), ['科幻']);
  assert.equal(built.report.emptyTags, 2);
});

test('同一条标记上重复的标签只写一次', () => {
  const d = tiny({
    subjects: [MOVIE],
    marks: [markOn({ status: 'done', tags: ['科幻', '科幻'] })],
  });
  const built = buildNeodbNdjson(d);
  assert.equal(of(journal(built), 'TagMember').length, 1);
  assert.equal(built.report.duplicateTags, 1);
});

test('两条标记共用一个标签，Tag 只出一条，TagMember 出两条', () => {
  const d = tiny({
    subjects: [MOVIE, { ...MOVIE, id: '2', url: 'https://movie.douban.com/subject/2/' }],
    marks: [
      markOn({ status: 'done', tags: ['科幻'] }),
      { medium: 'movie', subject: { id: '2', url: 'https://movie.douban.com/subject/2/' }, fields: { status: 'wish', tags: ['科幻'] } },
    ],
  });
  const built = buildNeodbNdjson(d);
  assert.equal(of(journal(built), 'Tag').length, 1);
  assert.equal(of(journal(built), 'TagMember').length, 2);
});

test('广播有状态但没有时间，不进历史——timestamp 缺了导入器直接抛错', () => {
  // `import_shelf_log` 里写着：timestamp 不可空，插进去会 IntegrityError，
  // 而那会**带崩外面整个事务**，后面的记录一条都进不去。
  const d = tiny({
    subjects: [MOVIE],
    marks: [markOn({ status: 'done' })],
    broadcasts: [
      { fields: { status: 'wish', target_type: 'movie', target_id: '1', posted_at: null } },
      { fields: { status: 'done', target_type: 'movie', target_id: '1', posted_at: { iso: '2024-01-01T00:00:00+08:00' } } },
    ],
  });
  const built = buildNeodbNdjson(d, { shelfHistory: true });
  const logs = of(journal(built), 'ShelfLog');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, 'complete');
});

test('同一秒同一状态的两条广播只出一条历史', () => {
  const at = { iso: '2024-01-01T00:00:00+08:00' };
  const d = tiny({
    subjects: [MOVIE],
    marks: [markOn({ status: 'done' })],
    broadcasts: [
      { fields: { status: 'done', target_type: 'movie', target_id: '1', posted_at: at } },
      { fields: { status: 'done', target_type: 'movie', target_id: '1', posted_at: at } },
    ],
  });
  assert.equal(of(journal(buildNeodbNdjson(d, { shelfHistory: true })), 'ShelfLog').length, 1);
});

test('广播上的星是当天那颗，跟标记上现在那颗不是一回事', () => {
  // 豆瓣每次编辑都覆盖标记上的评分；广播是发出去那一刻冻住的。
  const d = tiny({
    subjects: [MOVIE],
    marks: [markOn({ status: 'done', rating: 3 })],
    broadcasts: [{ fields: { status: 'done', rating: 5, text: '当时觉得神作', target_type: 'movie', target_id: '1', posted_at: { iso: '2024-01-01T00:00:00+08:00' } } }],
  });
  const built = buildNeodbNdjson(d, { shelfHistory: true });
  assert.equal(of(journal(built), 'Rating')[0].content.value, 6); // 现在 3 星
  assert.equal(of(journal(built), 'ShelfLog')[0].metadata.rating_grade, 10); // 当时 5 星
  assert.equal(of(journal(built), 'ShelfLog')[0].metadata.comment_text, '当时觉得神作');
});

test('没打分的广播不写 rating_grade，而不是写 0', () => {
  const d = tiny({
    subjects: [MOVIE],
    marks: [markOn({ status: 'wish' })],
    broadcasts: [{ fields: { status: 'wish', rating: null, text: null, target_type: 'movie', target_id: '1', posted_at: { iso: '2024-01-01T00:00:00+08:00' } } }],
  });
  const log = of(journal(buildNeodbNdjson(d, { shelfHistory: true })), 'ShelfLog')[0];
  assert.deepEqual(log.metadata, {});
});

// ---- 标记自己就会生成一条历史 ---------------------------------------------
//
// `import_shelf_member` 走 `Mark.update`，里面 `ensure_log_entry()` 按
// (owner, shelf_type, item, created_time) 自己建一条 ShelfLogEntry，
// `_update_log_entry` 再把标记**当前**的星和短评写进那一行。所以「作品现在这个
// 状态」这件事，NeoDB 本来就有一行。
//
// 豆瓣的 marked_at 只有日期（实测 2942 条全是 +08:00 的 00:00:00），广播带的是
// 真实时刻，两者永远不相等，而 ShelfLogEntry 的唯一键里有 timestamp——于是同一
// 件事排成两行。实测 40 条样本的 54 条历史里 38 条是这样，全量 3174 条里 2345 条。
// 这是真的导进 neodb.social 之后一眼看出来的，本地任何测试都进不去那个上下文。

const DAY = '2024-03-05';
const markedThatDay = (extra = {}) => markOn({ status: 'done', marked_at: { iso: `${DAY}T00:00:00+08:00` }, ...extra });
const cast = (fields) => ({ fields: { target_type: 'movie', target_id: '1', ...fields } });
const logsOf = (d) => of(journal(buildNeodbNdjson(d, { shelfHistory: true })), 'ShelfLog');

test('标记当天那个状态的广播并进标记那一行，不另开一行', () => {
  const logs = logsOf(tiny({
    subjects: [MOVIE],
    marks: [markedThatDay()],
    broadcasts: [cast({ status: 'done', text: '看了', posted_at: { iso: `${DAY}T22:38:00+08:00` } })],
  }));
  assert.equal(logs.length, 1);
  // 写成标记那个时间戳，才会落到 update_or_create 的同一行上。写广播的真实时刻
  // 就是第二行——**而且 00:00+08:00 跟当天 22:38+08:00 渲染到 +10 的时区还会
  // 变成两个日期**，读起来像隔天又标了一次。
  assert.equal(logs[0].timestamp, `${DAY}T00:00:00+08:00`);
  assert.equal(logs[0].metadata.comment_text, '看了');
});

test('并进去的是广播冻住的那一版，不是标记现在这一版', () => {
  // 归档的全部意义所在：豆瓣只留最后一版，广播留着当天那一版。
  const logs = logsOf(tiny({
    subjects: [MOVIE],
    marks: [markedThatDay({ comment: '改过之后的短评', rating: 3 })],
    broadcasts: [cast({ status: 'done', text: '当天写的短评', rating: 5, posted_at: { iso: `${DAY}T22:38:00+08:00` } })],
  }));
  assert.equal(logs.length, 1);
  assert.equal(logs[0].metadata.comment_text, '当天写的短评');
  assert.equal(logs[0].metadata.rating_grade, 10);
});

test('广播只冻住了星，并上去也不会把标记的短评抹掉', () => {
  // `update_or_create(defaults={"metadata": …})` 是**整块覆盖**，不是合并。
  // 只写 rating_grade 过去，`_update_log_entry` 刚写进那一行的短评就没了。
  const logs = logsOf(tiny({
    subjects: [MOVIE],
    marks: [markedThatDay({ comment: '标记上的短评', rating: 3 })],
    broadcasts: [cast({ status: 'done', rating: 5, text: null, posted_at: { iso: `${DAY}T22:38:00+08:00` } })],
  }));
  assert.equal(logs[0].metadata.rating_grade, 10, '星用广播冻住的');
  assert.equal(logs[0].metadata.comment_text, '标记上的短评', '短评保持 NeoDB 本来会写的那份');
});

test('广播什么都没冻住，那一条整个不写——写个空的过去等于把标记的短评抹掉', () => {
  const d = tiny({
    subjects: [MOVIE],
    marks: [markedThatDay({ comment: '标记上的短评' })],
    broadcasts: [cast({ status: 'done', rating: null, text: null, posted_at: { iso: `${DAY}T22:38:00+08:00` } })],
  });
  assert.equal(logsOf(d).length, 0);
  assert.equal(buildNeodbNdjson(d, { shelfHistory: true }).report.shelfLogsMergedEmpty, 1);
});

test('被豆瓣截断的正文不并进去——拿半句换整句是净亏', () => {
  const bc = (extra) => cast({ status: 'done', text: '完整的一长段', text_truncated: true, posted_at: { iso: `${DAY}T22:38:00+08:00` }, ...extra });
  const mark = markedThatDay({ comment: '完整的一长段短评' });

  // 还冻住了一颗星，所以那一行仍要写——短评保持标记上的完整那份。
  const logs = logsOf(tiny({ subjects: [MOVIE], marks: [mark], broadcasts: [bc({ rating: 5 })] }));
  assert.equal(logs[0].metadata.comment_text, '完整的一长段短评');
  assert.equal(logs[0].metadata.rating_grade, 10);

  // 只有一段截断的正文 = 什么都没冻住，那一行整个不写。
  assert.equal(logsOf(tiny({ subjects: [MOVIE], marks: [mark], broadcasts: [bc({})] })).length, 0);
});

test('换了状态、或者换了一天的广播照样是独立一行，用广播自己的时刻', () => {
  const logs = logsOf(tiny({
    subjects: [MOVIE],
    marks: [markedThatDay()],
    broadcasts: [
      cast({ status: 'wish', posted_at: { iso: `${DAY}T09:00:00+08:00` } }), // 同一天，别的状态
      cast({ status: 'done', posted_at: { iso: '2023-01-01T09:00:00+08:00' } }), // 同状态，别的年份：重看
      cast({ status: 'done', text: '当天', posted_at: { iso: `${DAY}T22:38:00+08:00` } }), // 这条才是标记那件事
    ],
  }));
  assert.equal(logs.length, 3);
  const byStamp = Object.fromEntries(logs.map((l) => [l.timestamp, l.status]));
  assert.equal(byStamp[`${DAY}T09:00:00+08:00`], 'wishlist');
  assert.equal(byStamp['2023-01-01T09:00:00+08:00'], 'complete');
  assert.equal(byStamp[`${DAY}T00:00:00+08:00`], 'complete');
});

test('同一天同一状态有好几条广播，取最晚那条并上去', () => {
  const logs = logsOf(tiny({
    subjects: [MOVIE],
    marks: [markedThatDay()],
    broadcasts: [
      cast({ status: 'done', text: '早上写的', posted_at: { iso: `${DAY}T09:00:00+08:00` } }),
      cast({ status: 'done', text: '晚上改的', posted_at: { iso: `${DAY}T22:38:00+08:00` } }),
    ],
  }));
  assert.equal(logs.length, 1);
  assert.equal(logs[0].metadata.comment_text, '晚上改的');
});

test('整份档案里没有一条历史会跟标记那件事撞成两行', () => {
  // 上面每条都是构造出来的；这一条是对着真档案的横扫，防的是「换个写法又漏一类」。
  const marks = new Map();
  for (const r of journal(withHistory)) {
    if (r.type === 'ShelfMember') marks.set(r.content.withRegardTo, r.content);
  }
  let checked = 0;
  for (const l of of(journal(withHistory), 'ShelfLog')) {
    const m = marks.get(l.item);
    if (!m?.published) continue;
    if (l.status !== m.status) continue;
    if (l.timestamp.slice(0, 10) !== m.published.slice(0, 10)) continue;
    checked += 1;
    assert.equal(l.timestamp, m.published,
      `${l.item} 的 ${l.status} 跟标记同一天却不是同一个时间戳，导进去会是两行`);
  }
  assert.ok(checked > 0, '样本里该有并进标记那一行的历史，一条都没扫到说明这个检查空转了');
});

test('没有广播的档案开着 --shelf-history 也不炸', () => {
  const d = tiny({ subjects: [MOVIE], marks: [markOn({ status: 'done' })] });
  const built = buildNeodbNdjson(d, { shelfHistory: true });
  assert.equal(built.report.shelfLogs, 0);
  assert.equal(built.report.marks, 1);
});

test('豆列条目没有 URL 就丢进旁挂文件，不会写出一个空引用', () => {
  const d = tiny({
    subjects: [MOVIE],
    marks: [markOn({ status: 'done' })],
    doulists: [{ fields: { title: '单子', visibility: 'public', items: [{ url: null, title: '没链接的' }] } }],
  });
  const built = buildNeodbNdjson(d);
  assert.equal(of(journal(built), 'Collection')[0].items.length, 0);
  assert.equal(built.report.doulistEntriesDropped, 1);
});

test('两份豆列收了同一个作品，catalog 里只出一条', () => {
  const url = 'https://book.douban.com/subject/9/';
  const entry = { url, category: '1001', title: '书', comment: null };
  const d = tiny({
    subjects: [MOVIE],
    marks: [markOn({ status: 'done' })],
    doulists: [
      { fields: { title: 'A', visibility: 'public', items: [entry] } },
      { fields: { title: 'B', visibility: 'public', items: [entry] } },
    ],
  });
  const built = buildNeodbNdjson(d);
  const ids = [...catalogIds(built)];
  assert.equal(ids.filter((x) => x === url).length, 1);
  assert.equal(built.report.collectionItems, 2); // 两份单子各算一条成员
});

test('挂不上作品的影评也变成 Article，而不是丢掉', () => {
  // 现实档案里 0 篇，但影评没有 subject_url 是可能的（作品被豆瓣删了）。
  const d = tiny({
    subjects: [MOVIE],
    marks: [markOn({ status: 'done' })],
    longform: [{ kind: 'review', fields: { title: '一篇影评', body: '正文', subject_url: null, published_at: { iso: '2024-01-01T00:00:00+08:00' } } }],
  });
  const built = buildNeodbNdjson(d);
  assert.equal(built.report.articles, 1);
  assert.equal(built.report.reviews, 0);
  assert.equal(of(journal(built), 'Article')[0].content.name, '一篇影评');
});

test('长文没有发布时间就不写 published，Article 也一样', () => {
  const d = tiny({
    subjects: [MOVIE],
    marks: [markOn({ status: 'done' })],
    longform: [{ kind: 'note', fields: { title: '日记', body: '正文', subject_url: null, published_at: null } }],
  });
  const a = of(journal(buildNeodbNdjson(d)), 'Article')[0];
  assert.ok(!('published' in a.content));
});

test('只有标记、没有长文没有豆列没有广播的档案，产出仍然是完整的两个文件', () => {
  const d = tiny({ subjects: [MOVIE], marks: [markOn({ status: 'done' })] });
  const built = buildNeodbNdjson(d, { shelfHistory: true });
  assert.deepEqual(built.files.map((f) => f.name).sort(), ['catalog.ndjson', 'journal.ndjson']);
  assert.deepEqual(built.sidecars, []);
  assert.equal(journal(built).length, 1);
});

test('--sample=1 切出来的那份仍然自洽', () => {
  // 小样最容易出的事故是引用悬空：豆列和广播不跟着削，于是指向被削掉的作品。
  const one = sample(data, 1);
  const built = buildNeodbNdjson(one, { shelfHistory: true });
  const ids = catalogIds(built);
  for (const r of journal(built)) {
    if (r.content?.withRegardTo) assert.ok(ids.has(r.content.withRegardTo));
    if (r.type === 'ShelfLog') assert.ok(ids.has(r.item));
    for (const m of r.items ?? []) assert.ok(ids.has(m.item));
  }
  assert.equal(of(journal(built), 'ShelfMember').length, 1);
});

// ── content.updated ───────────────────────────────────────────────────────
//
// 没有这个键，`_is_current` 退回「`created_time` vs `published`」，而豆瓣的
// `marked_at` 是标记那天、改短评不动它——于是用户第一次导入之后在豆瓣上做的编辑，
// 第二次导入会一声不吭地不生效。这一组测的就是它不会。

/** 造一条带多次修订的记录：每个 `fields` 一条 revision，摘要按值算。 */
function revised(base, states, times) {
  const digest = (v) => `sha256:${JSON.stringify(v)}`;
  return {
    ...base,
    revisions: states.map((fields, i) => ({
      parser_version: 'test',
      first_observed_at: times[i][0],
      last_observed_at: times[i][1],
      fields,
      digests: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, digest(v)])),
    })),
  };
}

const T1 = ['2026-01-01T00:00:00+08:00', '2026-01-05T00:00:00+08:00'];
const T2 = ['2026-02-01T00:00:00+08:00', '2026-02-05T00:00:00+08:00'];

test('导入器会读 updated 的那七种记录都写了，别的三种一个都不写', () => {
  // 读的是 Collection / ShelfMember / Article / Review / Note / Comment / Rating；
  // Tag / TagMember / ShelfLog 的 import_* 根本不看这个键，写了是噪音。
  const records = journal(withHistory);
  const reads = new Set(['ShelfMember', 'Rating', 'Comment', 'Review', 'Note', 'Article', 'Collection']);
  let checked = 0;
  for (const r of records) {
    if (reads.has(r.type)) {
      assert.ok(r.content.updated, `${r.type} 没写 updated`);
      checked += 1;
    } else {
      assert.ok(!r.content?.updated && !r.updated, `${r.type} 不该写 updated`);
    }
  }
  assert.ok(checked >= 20, `只核了 ${checked} 条`);
});

test('updated 按字段算：只改了短评，评分的 updated 不跟着动', () => {
  // 一条标记的 revision 只要任意字段变了就会新增，所以拿整条记录的时间去当
  // 短评的 updated，会在只改了评分的时候谎称短评也编辑过。摘要是按字段存的。
  const mark = revised(
    { medium: 'movie', subject: { id: '1', url: MOVIE.url } },
    [
      { status: 'done', marked_at: { iso: '2024-01-01T00:00:00+08:00' }, rating: 4, comment: '第一版' },
      { status: 'done', marked_at: { iso: '2024-01-01T00:00:00+08:00' }, rating: 4, comment: '改过了' },
    ],
    [T1, T2],
  );
  const d = tiny({ subjects: [MOVIE] });
  d.marks = [mark];
  const records = journal(buildNeodbNdjson(d));
  const at = (t) => of(records, t)[0].content.updated;
  assert.equal(at('Comment'), T2[0], '短评变了，updated 该是第二条 revision 的 first_observed_at');
  assert.equal(at('Rating'), T1[0], '评分没变，updated 该停在第一条');
  assert.equal(at('ShelfMember'), T1[0], '状态和标记日都没变');
});

test('updated 用 first_observed_at，不是 last_observed_at', () => {
  // last_observed_at 每抓一次就变，用它等于宣称每条记录每次都被编辑过：
  // 每次导入都会把所有东西重写一遍，edited_time 全被推到今天。
  const mark = revised(
    { medium: 'movie', subject: { id: '1', url: MOVIE.url } },
    [{ status: 'done', comment: '没改过' }],
    [T1],
  );
  const d = tiny({ subjects: [MOVIE] });
  d.marks = [mark];
  const c = of(journal(buildNeodbNdjson(d)), 'Comment')[0].content;
  assert.equal(c.updated, T1[0]);
  assert.notEqual(c.updated, T1[1], 'last_observed_at 是每次抓取都会变的那个');
});

test('再抓一次但什么都没改，updated 不动', () => {
  // 幂等：同一条内容被观测第二次不算编辑。动了的话每次导入都会重写一遍。
  const same = { status: 'done', comment: '一个字没改' };
  const one = tiny({ subjects: [MOVIE] });
  one.marks = [revised({ medium: 'movie', subject: { id: '1', url: MOVIE.url } }, [same], [T1])];
  const two = tiny({ subjects: [MOVIE] });
  two.marks = [revised({ medium: 'movie', subject: { id: '1', url: MOVIE.url } }, [same, same], [T1, T2])];
  const get = (d) => of(journal(buildNeodbNdjson(d)), 'Comment')[0].content.updated;
  assert.equal(get(one), T1[0]);
  assert.equal(get(two), T1[0], '同样的内容观测两次，不是编辑');
});

test('在豆瓣改了短评、重新抓一份，updated 会往后走——这就是整件事的意义', () => {
  // 没有这个键的话：published（marked_at）不变，目标的 created_time 等于它，
  // _is_current 判定「目标已经是最新的」，这次编辑一声不吭地不生效。
  const base = { medium: 'movie', subject: { id: '1', url: MOVIE.url } };
  const marked = { iso: '2024-01-01T00:00:00+08:00' };
  const before = tiny({ subjects: [MOVIE] });
  before.marks = [revised(base, [{ status: 'done', marked_at: marked, comment: '第一版' }], [T1])];
  const after = tiny({ subjects: [MOVIE] });
  after.marks = [revised(base,
    [{ status: 'done', marked_at: marked, comment: '第一版' },
      { status: 'done', marked_at: marked, comment: '改过了' }], [T1, T2])];

  const c1 = of(journal(buildNeodbNdjson(before)), 'Comment')[0].content;
  const c2 = of(journal(buildNeodbNdjson(after)), 'Comment')[0].content;
  assert.equal(c1.published, c2.published, 'marked_at 不会因为改短评而变——这正是问题所在');
  assert.ok(c2.updated > c1.updated, 'updated 必须往后走，否则第二次导入认不出这是编辑');
});

test('档案里没有摘要时退回比字段值，而不是当成「变过」', () => {
  // 老的 canonical 可能没有 digests。此时按值比，结论一样；当成变过的话，
  // 每条记录的 updated 都会跳到最后一次观测。
  const base = { medium: 'movie', subject: { id: '1', url: MOVIE.url } };
  const noDigest = (fields, t) => ({
    parser_version: 'test', first_observed_at: t[0], last_observed_at: t[1], fields,
  });
  const d = tiny({ subjects: [MOVIE] });
  d.marks = [{
    ...base,
    revisions: [noDigest({ status: 'done', comment: '一样' }, T1),
      noDigest({ status: 'done', comment: '一样' }, T2)],
  }];
  assert.equal(of(journal(buildNeodbNdjson(d)), 'Comment')[0].content.updated, T1[0]);
});

test('没有观测时间就不写 updated，而不是编一个', () => {
  const d = tiny({ subjects: [MOVIE] });
  d.marks = [{
    medium: 'movie',
    subject: { id: '1', url: MOVIE.url },
    revisions: [{ parser_version: 'test', fields: { status: 'done', comment: 'x' }, digests: {} }],
  }];
  const c = of(journal(buildNeodbNdjson(d)), 'Comment')[0].content;
  assert.ok(!('updated' in c));
});

test('豆列的 published 用最早那次观测，再抓一次也不动', () => {
  // import_collection 认收藏单靠 (owner, title, created_time)，而 created_time
  // 就是 published。用最后一次观测的话每导一次都变，第二次导入会新建一个同名的。
  const items = [];
  const one = tiny({ subjects: [MOVIE] });
  one.marks = [];
  one.doulists = [revised({}, [{ title: '单子', visibility: 'public', items }], [T1])];
  const two = tiny({ subjects: [MOVIE] });
  two.marks = [];
  two.doulists = [revised({}, [{ title: '单子', visibility: 'public', items },
    { title: '单子', visibility: 'public', items }], [T1, T2])];
  const pub = (d) => of(journal(buildNeodbNdjson(d)), 'Collection')[0].content.published;
  assert.equal(pub(one), T1[0]);
  assert.equal(pub(two), T1[0], '再抓一次不该改变收藏单的身份');
});

test('**`platform` 要正面证据：`unknown` 配上 `restricted_by=platform` 也不算**', () => {
  // 这一栏是唯一会被**公开**导出的「不公开」，所以判据必须是正面证据，
  // 而不是「有个字段这么写着」。我们自己的解析器不会产出这个组合（它只在判定
  // private 之后才去看那条通告），但 schema 上两个字段是独立的，别的产出方、
  // 手改过的 canonical、或者以后某一版解析器都可能凑出来。
  // 突变验过：把判据改回只看 `restricted_by`，这一条红，别的一条都不红。
  const bent = { ...data, longform: JSON.parse(JSON.stringify(data.longform)) };
  const one = bent.longform.find((x) => fieldsOf(x).title === '测试一下带图的日记');
  for (const rev of one.revisions) {
    rev.fields.visibility = 'unknown';
    rev.fields.restricted_by = 'platform';
  }
  const out = buildNeodbNdjson(bent, {});
  const art = of(journal(out), 'Article').find((a) => a.content.name === '测试一下带图的日记');
  assert.equal(art.visibility, 2, '认不出来的不许因为多了个 restricted_by 就被公开发出去');
  assert.equal(out.report.restricted.find((x) => x.title === '测试一下带图的日记').by, 'unsure');
});

// ── 读不出隐私状态的那几篇，用户可以自己定 ──────────────────────────────

/** 把那篇公开日记改成 `unknown`，模拟豆瓣改版之后抽取器读不出来。 */
const withUnknown = () => {
  const d = { ...data, longform: JSON.parse(JSON.stringify(data.longform)) };
  const one = d.longform.find((x) => fieldsOf(x).title === '测试一下带图的日记');
  for (const rev of one.revisions) rev.fields.visibility = 'unknown';
  return d;
};
const visOf = (out, title) => of(journal(out), 'Article').find((a) => a.content.name === title)?.visibility;

test('**读不出来的默认收成 2，但用户可以调**', () => {
  const d = withUnknown();
  assert.equal(visOf(buildNeodbNdjson(d, {}), '测试一下带图的日记'), 2, '默认要收起来');
  assert.equal(visOf(buildNeodbNdjson(d, { unknownVisibility: 1 }), '测试一下带图的日记'), 1);
  // **0 的意思是「跟基线走」，不是「一律公开」。** 基线本身是 1 的时候，
  // 「不单独收紧」得到的必须是 1——写成「强制公开」的话，`--visibility=1`
  // 配上它会把读不出来的那几篇发得比别的记录还开，而那是撤不回来的方向。
  assert.equal(visOf(buildNeodbNdjson(d, { unknownVisibility: 0 }), '测试一下带图的日记'), undefined);
  assert.equal(
    visOf(buildNeodbNdjson(d, { unknownVisibility: 0, visibility: 1 }), '测试一下带图的日记'),
    1,
    '基线是 1 的时候，「跟基线走」不能变成 0',
  );
});

test('**这个开关放松不了作者自己藏的那一篇**', () => {
  // 开关只作用于「说不准」那一栏。作者的意思是明确的，没有可商量的余地——
  // 一个能把它打开的开关，就是绕过整套非对称性的后门，而放松的方向撤不回来。
  // 突变验过：把判据从「只有 unsure 可调」改成「restricted 都可调」，这一条红。
  const d = withUnknown();
  for (const v of [0, 1, 2]) {
    assert.equal(
      visOf(buildNeodbNdjson(d, { unknownVisibility: v }), '测试一下私密日记？'),
      2,
      `--unknown-visibility=${v} 不该动到作者自己设成私密的那一篇`,
    );
  }
});

test('unknownVisibility 只收 0 / 1 / 2', () => {
  assert.throws(() => buildNeodbNdjson(data, { unknownVisibility: 3 }), /unknownVisibility/);
  assert.throws(() => buildNeodbNdjson(data, { unknownVisibility: -1 }), /unknownVisibility/);
});

test('**默认值只许有一处，宿主不许各兜一个**', async () => {
  // 两个宿主（CLI 与扩展面板）都要在「用户没选」的时候用这个默认值。各写一个 `2`
  // 的话，改的时候必然漏掉一个，而**漏掉是静默的**：一个宿主收着、另一个发出去，
  // 两边都不报错——正是「一条流水线，两个宿主」里最贵的那一半。
  assert.equal(UNKNOWN_VISIBILITY_DEFAULT, 2, '默认必须是收紧的那一边');
  // 不传这个键要落到它上面，而不是落到别的什么值。
  const d = { ...data, longform: JSON.parse(JSON.stringify(data.longform)) };
  const one = d.longform.find((x) => fieldsOf(x).title === '测试一下带图的日记');
  for (const rev of one.revisions) rev.fields.visibility = 'unknown';
  assert.equal(buildNeodbNdjson(d, {}).report.unknownVisibility, UNKNOWN_VISIBILITY_DEFAULT);
  assert.equal(buildNeodbNdjson(d).report.unknownVisibility, UNKNOWN_VISIBILITY_DEFAULT);

  // CLI 不许再写一个默认值：没给开关就整个不传。
  const cli = await readFile(new URL('../bin/export.js', import.meta.url), 'utf8');
  assert.match(cli, /--unknown-visibility='\)\);\n\s*if \(!f\) return undefined;/);
  assert.doesNotMatch(cli, /startsWith\('--unknown-visibility='\)\);\n\s*if \(!f\) return [0-9]/);
});
