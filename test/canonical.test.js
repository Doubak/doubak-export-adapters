import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCanonical, latest, fieldsOf } from '../src/canonical.js';
import { FIXTURE } from './helpers.js';

test('当前状态按 last_observed_at 取，不按数组下标', () => {
  // 解析器今天是按顺序追加的，照下标取碰巧也对。但那是它的实现细节，
  // 不是 canonical 规定的次序——把没写进 spec 的保证当保证，是会过期的。
  const record = {
    revisions: [
      { last_observed_at: '2026-08-10T00:00:00Z', fields: { status: 'done' } },
      { last_observed_at: '2026-08-01T00:00:00Z', fields: { status: 'wish' } },
    ],
  };
  assert.equal(latest(record).fields.status, 'done');
  assert.equal(fieldsOf(record).status, 'done');
});

test('没有 revision 的记录不炸，给一个空 fields', () => {
  assert.equal(latest({ revisions: [] }), null);
  assert.deepEqual(fieldsOf({ revisions: [] }), {});
  assert.deepEqual(fieldsOf(null), {});
});

test('读得进真实档案切出来的样本', () => {
  const data = loadCanonical(FIXTURE);
  assert.equal(data.marks.length, 18);
  assert.equal(data.subjects.length, 18);
  assert.equal(data.longform.length, 5);
  assert.equal(data.account.username, 'mewcatcher');
});

test('作品是按 (medium, id) 定位的', () => {
  // 豆瓣的 subject id 在不同 medium 下会撞号，只按 id 找会张冠李戴。
  const data = loadCanonical(FIXTURE);
  const mark = data.marks.find((m) => m.subject.id === '34965089');
  assert.equal(fieldsOf(data.subjectOf(mark)).title, '重返寂静岭 / Return to Silent Hill');
  assert.equal(data.subjectOf({ medium: 'book', subject: { id: '34965089' } }), null);
});

test('数出有多次修订的标记——导出会把它们压平，用户不会自己发现', () => {
  const data = loadCanonical(FIXTURE);
  assert.equal(data.multiRevisionMarks, 1);
});

test('缺文件不算错，但 marks 和 subjects 都没有就是给错目录了', () => {
  // 豆列是后加的，老的 canonical 目录里没有 doulists.ndjson。
  const dir = mkdtempSync(join(tmpdir(), 'doubak-canon-'));
  writeFileSync(join(dir, 'marks.ndjson'), '');
  writeFileSync(join(dir, 'subjects.ndjson'), '');
  assert.throws(() => loadCanonical(dir), /不像 canonical 目录/);
});

test('坏行报出行号，不是默默跳过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doubak-canon-'));
  writeFileSync(join(dir, 'marks.ndjson'), '{"medium":"movie"}\n\n{ 这不是 JSON\n');
  assert.throws(() => loadCanonical(dir), /第 3 行/);
});
