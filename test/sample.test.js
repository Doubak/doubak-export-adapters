import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCanonical, fieldsOf } from '../src/canonical.js';
import { sample } from '../src/sample.js';
import { classify } from '../src/classify.js';
import { buildNeodb } from '../src/targets/neodb.js';
import { FIXTURE } from './helpers.js';

const data = loadCanonical(FIXTURE);
const bucketOf = (d, m) => {
  const s = d.subjectOf(m);
  return `${classify(m.medium, s ? fieldsOf(s) : null).category}:${fieldsOf(m).status}`;
};

test('切出来的条数就是要的条数', () => {
  assert.equal(sample(data, 5).marks.length, 5);
  assert.equal(sample(data, 1).marks.length, 1);
});

test('要得比档案里还多，就是整份，不报错', () => {
  assert.equal(sample(data, 9999).marks.length, data.marks.length);
});

test('按分类和状态轮着取——取前 N 条会拿到一堆同类的', () => {
  // 小样是拿去真平台试的。全是电影全是「看过」的 20 条，验不了图书的 ISBN、
  // 验不了「想看」有没有跑进「看过」、验不了舞台剧的链接对方认不认。
  const buckets = new Set(data.marks.map((m) => bucketOf(data, m)));
  const picked = new Set(sample(data, buckets.size).marks.map((m) => bucketOf(data, m)));
  assert.equal(picked.size, buckets.size, '每一种组合都该来一条');
});

test('同样的输入切出来永远是同一批', () => {
  // 否则「上次那条有问题的记录」下次就找不回来了。
  const a = sample(data, 7).marks.map((m) => m.subject.id);
  const b = sample(data, 7).marks.map((m) => m.subject.id);
  assert.deepEqual(a, b);
});

test('长文和豆列不削——书评那张表是另一条代码路径', () => {
  // 而书评表恰好是重复表头那一处，小样把它削没了就等于没验。
  const s = sample(data, 2);
  assert.equal(s.longform.length, data.longform.length);
  assert.equal(s.doulists.length, data.doulists.length);
  assert.equal(buildNeodb(s).report.reviews, 2);
});

test('「有几条改过」按小样重算，不照抄全量', () => {
  // 照抄的话，说明里会写着「这份里有 1 条改过」，而这 2 条里可能一条都没有。
  const s = sample(data, 2);
  assert.equal(s.multiRevisionMarks, s.marks.filter((m) => m.revisions.length > 1).length);
  assert.ok(s.multiRevisionMarks <= data.multiRevisionMarks);
});

test('N 不是正整数就报错，不静默取整', () => {
  for (const bad of [0, -1, 1.5, NaN, '5']) {
    assert.throws(() => sample(data, /** @type {any} */ (bad)), /正整数/);
  }
});

test('小样照样是一份能用的导出', () => {
  const { files } = buildNeodb(sample(data, 6));
  assert.ok(files.length > 0);
  for (const f of files) assert.match(f.name, /^[a-z]+_(mark|review|note)\.csv$/);
});
