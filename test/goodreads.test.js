import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCanonical, fieldsOf } from '../src/canonical.js';
import { buildGoodreads } from '../src/targets/goodreads.js';
import { FIXTURE, parseCsv, parseCsvObjects, fileNamed } from './helpers.js';

const data = loadCanonical(FIXTURE);
const { files, report } = buildGoodreads(data);
const rows = parseCsvObjects(fileNamed(files, 'goodreads.csv').text);

test('列名和次序照 douban-export 用过的那 14 列', () => {
  assert.deepEqual(parseCsv(fileNamed(files, 'goodreads.csv').text)[0], [
    'Title', 'Author', 'ISBN', 'My Rating', 'Average Rating', 'Publisher', 'Binding',
    'Year Published', 'Original Publication Year', 'Date Read', 'Date Added',
    'Shelves', 'Bookshelves', 'My Review',
  ]);
});

test('只有图书', () => {
  assert.equal(rows.length, 3);
  assert.equal(report.skippedOther, 15);
});

test('每一本都有 ISBN——匹配全靠它，书名作者都是中文，帮不上忙', () => {
  assert.equal(report.noIsbn, 0);
  assert.ok(!files.some((f) => f.name === 'goodreads-needs-check.csv'));
  for (const r of rows) assert.match(r.ISBN, /^\d{9,12}[\dX]$/);
});

test('三种状态对上 Goodreads 的三个互斥书架', () => {
  assert.deepEqual(rows.map((r) => r.Shelves).sort(), ['currently-reading', 'read', 'to-read']);
});

test('Date Read 只有「读过」才写', () => {
  // 豆瓣的日期是标记那一天，不是读完那一天。全写进去就是替用户宣称他读完了想读的书。
  for (const r of rows) {
    if (r.Shelves === 'read') assert.match(r['Date Read'], /^\d{4}\/\d{2}\/\d{2}$/);
    else assert.equal(r['Date Read'], '', `${r.Title} 是 ${r.Shelves}，不该有读完日期`);
  }
});

test('Date Added 三种状态都写', () => {
  for (const r of rows) assert.match(r['Date Added'], /^\d{4}\/\d{2}\/\d{2}$/);
});

test('Average Rating / Original Publication Year / Binding 一律留空', () => {
  // 前两个档案里没有，第三个是中英对照的猜测——而 ISBN 已经把版本钉死了。
  for (const r of rows) {
    assert.equal(r['Average Rating'], '');
    assert.equal(r['Original Publication Year'], '');
    assert.equal(r.Binding, '');
  }
});

test('作者、出版社、出版年从详情页的 info 里来', () => {
  const mark = data.marks.find((m) => m.medium === 'book' && fieldsOf(data.subjectOf(m)).title === '富爸爸穷爸爸');
  const info = fieldsOf(data.subjectOf(mark)).info;
  const row = rows.find((r) => r.Title === '富爸爸穷爸爸');
  assert.equal(row.Author, info['作者'].join(', '));
  assert.equal(row.Publisher, info['出版社'][0]);
  assert.equal(row['Year Published'], info['出版年'][0].slice(0, 4));
});

test('短评进 My Review，标签进 Bookshelves', () => {
  const mark = data.marks.find((m) => m.medium === 'book' && fieldsOf(m).comment);
  const f = fieldsOf(mark);
  const row = rows.find((r) => r.Title === fieldsOf(data.subjectOf(mark)).title);
  assert.equal(row['My Review'], f.comment);
  assert.equal(row.Bookshelves, (f.tags ?? []).join(', '));
});

test('豆瓣 1–5 星就是 Goodreads 的 1–5 星，不换算', () => {
  for (const r of rows) {
    if (r['My Rating']) assert.ok(Number(r['My Rating']) >= 1 && Number(r['My Rating']) <= 5);
  }
});
