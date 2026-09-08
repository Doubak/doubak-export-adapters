/**
 * 删掉再重标：canonical 分成两条是对的，导出不能跟着分。
 *
 * 用户在豆瓣上删掉一条标记再重新标，会拿到一个新的条目 id，解析器据此如实分成两条
 * ——canonical 是事件日志，那是对的。但**导出是当前状态**，一个作品只能有一行。
 *
 * 不并的话实测《盗梦空间》(`movie/3541415`) 导出了两条 ShelfMember，而 NeoDB 那边
 * 一个作品只有一个书架条目：第二条覆盖第一条，**谁覆盖谁由文件里的先后决定，
 * 不由任何判据决定**。站点生成器 2026-09-04 已经为同一件事做过一次，这边当时没跟上。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { mergeReMarks } from '../src/record.js';

const mark = (medium, id, upstreamId, { seen, marked } = {}) => ({
  medium,
  upstream_id: upstreamId,
  subject: { id },
  revisions: [{
    last_observed_at: seen ?? '2026-01-01T00:00:00+08:00',
    fields: { marked_at: marked ? { iso: marked } : null },
  }],
});

describe('删掉再重标', () => {
  test('同一个作品的两条并成一条', () => {
    const r = mergeReMarks([
      mark('movie', '3541415', 'a', { seen: '2026-01-01T00:00:00+08:00' }),
      mark('movie', '3541415', 'b', { seen: '2026-09-04T00:00:00+08:00' }),
    ]);
    assert.equal(r.marks.length, 1);
    assert.equal(r.superseded, 1);
  });

  test('**留下的是最后一次看到的那条** —— 不是标记日期最新的那条', () => {
    // 豆瓣现在还留着的那条，才是最近一次抓取里出现过的。按 marked_at 挑是错的：
    // 补标一部老片可以有更早的日期，而它仍然是现存的那一条。
    const 旧标记新看见 = mark('movie', '1', 'new', {
      seen: '2026-09-04T00:00:00+08:00', marked: '2010-01-01T00:00:00+08:00',
    });
    const 新标记旧看见 = mark('movie', '1', 'old', {
      seen: '2026-01-01T00:00:00+08:00', marked: '2025-01-01T00:00:00+08:00',
    });
    assert.equal(mergeReMarks([新标记旧看见, 旧标记新看见]).marks[0].upstream_id, 'new');
    // 喂进去的次序不该影响结果。
    assert.equal(mergeReMarks([旧标记新看见, 新标记旧看见]).marks[0].upstream_id, 'new');
  });

  test('**媒介不同就不是同一个作品** —— 豆瓣的 subject id 会跨媒介撞号', () => {
    const r = mergeReMarks([mark('movie', '34965089', 'a'), mark('book', '34965089', 'b')]);
    assert.equal(r.marks.length, 2);
    assert.equal(r.superseded, 0);
  });

  test('**排序是全序** —— 否则同一份 canonical 读两次会给出不同结果', () => {
    // 与 bundle 去重那次的教训一样：`last_observed_at` 与 `marked_at` 都相同时，
    // 还得有第三层判据，否则结果取决于 readdir 的次序。
    const same = { seen: '2026-01-01T00:00:00+08:00', marked: '2020-01-01T00:00:00+08:00' };
    const a = mark('movie', '1', 'aaa', same);
    const b = mark('movie', '1', 'bbb', same);
    assert.equal(mergeReMarks([a, b]).marks[0].upstream_id, 'bbb');
    assert.equal(mergeReMarks([b, a]).marks[0].upstream_id, 'bbb', '次序换了结果就变了');
  });

  test('没有重标的时候一条都不动，也不谎报', () => {
    const r = mergeReMarks([mark('movie', '1', 'a'), mark('book', '2', 'b')]);
    assert.equal(r.marks.length, 2);
    assert.equal(r.superseded, 0, '没并却报了并，那句提示就是假的');
  });

  test('空输入不炸', () => {
    assert.deepEqual(mergeReMarks([]), { marks: [], superseded: 0 });
    assert.deepEqual(mergeReMarks(undefined), { marks: [], superseded: 0 });
  });
});
