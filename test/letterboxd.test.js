import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCanonical, fieldsOf } from '../src/canonical.js';
import { buildLetterboxd } from '../src/targets/letterboxd.js';
import { FIXTURE, parseCsv, parseCsvObjects, fileNamed } from './helpers.js';

const data = loadCanonical(FIXTURE);
const { files, report } = buildLetterboxd(data);
const watched = parseCsvObjects(fileNamed(files, 'letterboxd-watched.csv').text);
const watchlist = parseCsvObjects(fileNamed(files, 'letterboxd-watchlist.csv').text);
const check = parseCsvObjects(fileNamed(files, 'letterboxd-needs-check.csv').text);

test('剧集一部都不进去', () => {
  // Letterboxd 只收电影。剧集匹配到同名电影上，是用户看不见的那种错。
  assert.equal(report.skippedTv, 3);
  const tvTitles = data.marks
    .map((m) => fieldsOf(data.subjectOf(m)))
    .filter((f) => f.info?.['集数'] || f.info?.['首播'] || f.info?.['季数'])
    .map((f) => f.title);
  assert.ok(tvTitles.length >= 3);
  for (const row of [...watched, ...watchlist]) {
    assert.ok(!tvTitles.some((t) => t?.includes(row.Title)), `${row.Title} 是剧集，不该出现`);
  }
});

test('图书音乐游戏舞台剧也不进去', () => {
  assert.equal(report.skippedOther, 10);
});

test('没读到详情页的不往外送，改列进 needs-check', () => {
  // 分不出电影还是剧集的时候，宁可少送。把剧集当电影送出去，
  // 可能给用户的观影记录里添一部他没看过的片子。
  assert.equal(report.skippedUnknown, 1);
  const row = check.find((r) => r.Why.includes('分不清'));
  assert.ok(row);
  assert.ok(![...watched, ...watchlist].some((r) => r.Title === row.Title));
});

test('看过和想看是两个文件，不是一个文件里的两种状态', () => {
  // 混在一起的话，想看的片子会变成「看过但没写日期」——那是替用户宣称他看过。
  assert.deepEqual(parseCsv(fileNamed(files, 'letterboxd-watched.csv').text)[0],
    ['Title', 'Year', 'imdbID', 'Rating', 'WatchedDate', 'Tags', 'Review']);
  assert.deepEqual(parseCsv(fileNamed(files, 'letterboxd-watchlist.csv').text)[0],
    ['Title', 'Year', 'imdbID']);
  assert.equal(watched.length, report.watched);
  assert.equal(watchlist.length, report.watchlist);
});

test('想看清单里不写日期、不写评分、不写短评', () => {
  const header = parseCsv(fileNamed(files, 'letterboxd-watchlist.csv').text)[0];
  for (const col of ['Rating', 'WatchedDate', 'Review']) {
    assert.ok(!header.includes(col), `想看清单里不该有 ${col}`);
  }
});

test('标题用原名，中文名匹配不到 Letterboxd 库里任何东西', () => {
  const row = watched.find((r) => r.imdbID === 'tt22868010');
  assert.equal(row.Title, 'Return to Silent Hill');
  assert.equal(row.Year, '2026');
});

test('没有原名的退回中文名，不是留空', () => {
  // 中文名匹配不中，但空标题连人工确认都做不了。
  const row = watchlist.find((r) => r.Title === '八仙！');
  assert.ok(row, '想看清单里应该有这部只有中文名的');
  assert.equal(row.imdbID, 'tt43515101'); // 有 IMDb 号，标题是中文也无所谓
  assert.ok(report.noOriginalTitle >= 1);
  for (const r of [...watched, ...watchlist]) assert.notEqual(r.Title, '');
});

test('没 IMDb 号的照样导出——Letterboxd 会一条条让人确认，匹配不上顶多是跳过', () => {
  const noImdbInCheck = check.filter((r) => r.Why.startsWith('没有 IMDb 号'));
  assert.equal(noImdbInCheck.length, report.noImdb);
  const exported = [...watched, ...watchlist].map((r) => r.Title);
  for (const r of noImdbInCheck) assert.ok(exported.includes(r.Title), `${r.Title} 应该照样在导出文件里`);
});

test('豆瓣 1–5 星就是 Letterboxd 的 1–5 星，不换算', () => {
  for (const r of watched) {
    if (r.Rating) assert.ok(Number(r.Rating) >= 1 && Number(r.Rating) <= 5, `评分 ${r.Rating} 越界`);
  }
  assert.equal(watched.find((r) => r.imdbID === 'tt22868010').Rating, '2');
});

test('日期是 YYYY-MM-DD', () => {
  for (const r of watched) {
    if (r.WatchedDate) assert.match(r.WatchedDate, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('导演那一列不写——中文导演名配不上 Letterboxd 的库，给了反而更糟', () => {
  const header = parseCsv(fileNamed(files, 'letterboxd-watched.csv').text)[0];
  assert.ok(!header.includes('Directors'));
});

test('带逗号的标签会被 Letterboxd 拆开，这件事要数出来', () => {
  // 它的 Tags 列就是逗号分隔的，没有转义写法。丢的不是标签，是分组。
  assert.equal(report.tagsWithComma, 1);
});

test('短评原样进 Review 列', () => {
  const row = watched.find((r) => r.imdbID === 'tt22868010');
  const mark = data.marks.find((m) => m.subject.id === '34965089');
  assert.equal(row.Review, fieldsOf(mark).comment);
});
