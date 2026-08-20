import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCanonical } from '../src/canonical.js';
import { buildNeodb } from '../src/targets/neodb.js';
import { FIXTURE, parseCsv, parseCsvObjects, fileNamed } from './helpers.js';

const data = loadCanonical(FIXTURE);
const { files, sidecars, report } = buildNeodb(data);
const rowsOf = (name) => parseCsvObjects(fileNamed(files, name).text);

test('文件名就是 NeoDB 的七个分类之一，别的名字它根本不读', () => {
  // run() 是拿 ItemCategory 去拼文件名的：拼不到就整张表不读，而且不报错。
  const known = ['book', 'movie', 'tv', 'music', 'game', 'podcast', 'performance'];
  for (const f of files) {
    const m = /^([a-z]+)_(mark|review|note)\.csv$/.exec(f.name);
    assert.ok(m, `${f.name} 不是 NeoDB 认的文件名`);
    assert.ok(known.includes(m[1]), `${m[1]} 不是 NeoDB 的分类`);
  }
});

test('标记表的列名和次序一字不差', () => {
  const header = parseCsv(fileNamed(files, 'movie_mark.csv').text)[0];
  assert.deepEqual(header, ['title', 'info', 'links', 'timestamp', 'status', 'rating', 'comment', 'tags']);
});

test('书评表的表头里有两个 title，而且不能去重', () => {
  // 不是笔误：NeoDB 用 csv.DictReader 读，重复键后一个赢，所以 row["title"]
  // 拿到的是第 5 列的书评标题。把它「修好」成一个 title，书评就全部变成无标题。
  const header = parseCsv(fileNamed(files, 'game_review.csv').text)[0];
  assert.deepEqual(header, ['title', 'info', 'links', 'timestamp', 'title', 'content']);
  assert.equal(header.filter((h) => h === 'title').length, 2);

  const rows = rowsOf('game_review.csv');
  const one = rows.find((r) => r.links === 'https://www.douban.com/game/10758368/');
  assert.equal(one.title, '噗，搬运一下组里用来做测试的攻略吧 - CROSS†CHANNEL汉化版攻略');
  assert.ok(one.content.length > 1000);
});

test('豆瓣 1–5 星换成 NeoDB 的 1–10 分', () => {
  const row = rowsOf('movie_mark.csv').find((r) => r.links.includes('/subject/34965089/'));
  assert.equal(row.rating, '4'); // 档案里是 2 星
  for (const r of rowsOf('movie_mark.csv')) {
    if (r.rating) assert.ok(Number(r.rating) % 2 === 0 && Number(r.rating) <= 10, `评分 ${r.rating} 不对`);
  }
});

test('没评分写空，不写 0', () => {
  // 「没打分」和「打了 0 分」是两件事，豆瓣也从来没有 0 星。
  const rows = rowsOf('movie_mark.csv');
  assert.ok(rows.some((r) => r.rating === ''));
  assert.ok(!rows.some((r) => r.rating === '0'));
});

test('状态用 NeoDB 的书架词，三个都出现', () => {
  const all = files.filter((f) => f.name.endsWith('_mark.csv')).flatMap((f) => parseCsvObjects(f.text));
  const seen = new Set(all.map((r) => r.status));
  assert.deepEqual([...seen].sort(), ['complete', 'progress', 'wishlist']);
});

test('links 里放豆瓣链接，有 IMDb 的再加一条 IMDb', () => {
  // IMDb 排在 NeoDB 的偏好次序前面，而且条目哪天在豆瓣被删了，IMDb 链接还在。
  const row = rowsOf('movie_mark.csv').find((r) => r.links.includes('/subject/34965089/'));
  assert.deepEqual(row.links.split(' '), [
    'https://movie.douban.com/subject/34965089/',
    'https://www.imdb.com/title/tt22868010/',
  ]);
  assert.equal(row.info, 'imdb:tt22868010 year:2026');
});

test('info 列里的值不能带空格——NeoDB 是按空格切 key:value 的', () => {
  const all = files.filter((f) => f.name.endsWith('_mark.csv')).flatMap((f) => parseCsvObjects(f.text));
  for (const r of all) {
    for (const pair of r.info.split(' ').filter(Boolean)) {
      assert.match(pair, /^[a-z]+:[^\s]+$/, `info 里的 ${pair} 形状不对`);
    }
  }
});

test('豆瓣五种 medium 的 URL，NeoDB 的五个站点规则都认', () => {
  // 逐条核对过 neodb/catalog/sites/douban_*.py 里的 URL_PATTERNS。
  // 舞台剧那条尤其要核：DoubanDramaVersion 要求 URL 带 # 片段，我们这种是 DoubanDrama。
  const patterns = [
    /^https?:\/\/movie\.douban\.com\/subject\/\d+\/?$/,
    /^https?:\/\/book\.douban\.com\/subject\/\d+\/?$/,
    /^https?:\/\/music\.douban\.com\/subject\/\d+\/?$/,
    /^https?:\/\/www\.douban\.com\/game\/\d+\/?$/,
    /^https?:\/\/www\.douban\.com\/location\/drama\/\d+\/[^#]*$/,
    /^https:\/\/www\.imdb\.com\/title\/tt\d+\/$/,
  ];
  const all = files.filter((f) => f.name.endsWith('_mark.csv')).flatMap((f) => parseCsvObjects(f.text));
  let checked = 0;
  for (const r of all) {
    for (const link of r.links.split(' ').filter(Boolean)) {
      assert.ok(patterns.some((p) => p.test(link)), `NeoDB 认不出这个链接: ${link}`);
      checked += 1;
    }
  }
  assert.ok(checked >= 20, `只核了 ${checked} 条链接，样本太小`);
});

test('不挂作品的日记没有去处，数出来而不是硬塞', () => {
  assert.equal(report.unattachedLongform, 3);
  assert.equal(report.reviews, 2);
});

test('标签用竖线分隔', () => {
  const row = rowsOf('movie_mark.csv').find((r) => r.links.includes('/subject/34965089/'));
  assert.deepEqual(row.tags.split('|'), ['2026', '美国', '恐怖']);
});

test('用户写的字一个不少地过去了，逗号引号换行都在', () => {
  const all = files.filter((f) => f.name.endsWith('_mark.csv')).flatMap((f) => parseCsvObjects(f.text));
  const byUrl = new Map(all.map((r) => [r.links.split(' ')[0], r]));
  let checked = 0;
  for (const mark of data.marks) {
    const url = mark.subject?.url;
    if (!url) continue;
    const want = mark.revisions.at(-1).fields.comment;
    if (!want) continue;
    assert.equal(byUrl.get(url).comment, want);
    checked += 1;
  }
  assert.ok(checked >= 10, `只核了 ${checked} 条短评`);
});

test('没有行的分类不出文件——一个 0 行的 podcast_mark.csv 只会让人以为漏抓了', () => {
  assert.ok(!files.some((f) => f.name.startsWith('podcast')));
  assert.ok(!files.some((f) => parseCsv(f.text).length <= 1));
});

test('没有豆瓣链接的那条不进 zip，改写进 zip 外面的核对清单', () => {
  // 一次真实导入印证了它注定失败：42 条里 41 成功，1 失败，
  // 报 `Could not find item: `（冒号后面是空的）。
  //
  // 代价不是那一行本身，是它**教会用户忽略失败清单**——全量导入会固定报 7 个
  // 失败，真出了别的问题也混在里面看不见了。
  const all = files.filter((f) => f.name.endsWith('_mark.csv')).flatMap((f) => parseCsvObjects(f.text));
  assert.equal(all.filter((r) => r.links === '').length, 0, 'zip 里不该有空 links 的行');

  assert.equal(report.noLink, 1);
  const sc = fileNamed(sidecars, 'neodb-needs-check.csv');
  assert.equal(parseCsvObjects(sc.text).length, report.noLink);
  // 它必须在 zip 外面，否则一样会被导入。
  assert.ok(!files.some((f) => f.name === 'neodb-needs-check.csv'));
});

test('zip 里的每一行都有一条能定位的链接', () => {
  const all = files.filter((f) => f.name.endsWith('_mark.csv')).flatMap((f) => parseCsvObjects(f.text));
  assert.equal(all.length, report.marks);
  for (const r of all) assert.ok(r.links.trim().length > 0);
});
