import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCanonical } from '../src/canonical.js';
import { buildNeodb } from '../src/targets/neodb.js';
import { buildNeodbNdjson } from '../src/targets/neodb-ndjson.js';
import { buildLetterboxd } from '../src/targets/letterboxd.js';
import { buildGoodreads } from '../src/targets/goodreads.js';
import { instructions } from '../src/instructions.js';
import { FIXTURE } from './helpers.js';

const data = loadCanonical(FIXTURE);
const full = {
  neodb: buildNeodbNdjson(data).report,
  neodbCsv: buildNeodb(data).report,
  letterboxd: buildLetterboxd(data).report,
  goodreads: buildGoodreads(data).report,
  doulists: data.doulists.length,
  multiRevisionMarks: data.multiRevisionMarks,
};

test('说明里带的是这一次的真实条数，不是「导出成功」', () => {
  const text = instructions(full);
  assert.match(text, new RegExp(`\\*\\*${full.neodb.marks} 条标记\\*\\*`));
  assert.match(text, new RegExp(`看过的 ${full.letterboxd.watched} 部`));
  assert.match(text, new RegExp(`\\*\\*${full.goodreads.books} 本书\\*\\*`));
});

test('只导一个目标，就只写那一个目标的说明', () => {
  // 一份写着「上传 letterboxd-watched.csv」的说明，配上一个没有那个文件的目录，
  // 比不写说明更糟。
  const text = instructions({ neodb: full.neodb, doulists: 0, multiRevisionMarks: 0 });
  assert.match(text, /## NeoDB/);
  assert.ok(!text.includes('## Letterboxd'));
  assert.ok(!text.includes('## Goodreads'));
});

test('Letterboxd 那段必须说清楚是两次上传', () => {
  const text = instructions(full);
  assert.match(text, /要传两次/);
  assert.match(text, /letterboxd-watched\.csv/);
  assert.match(text, /letterboxd-watchlist\.csv/);
});

test('没导出去的东西也写进说明，不是只写成功的部分', () => {
  const text = instructions(full);
  // 豆列和不挂作品的日记这两样，NDJSON 装得下、CSV 装不下——所以这两句
  // 现在挂在 CSV 那一节下面，而不是整份说明里都没有。
  assert.match(text, new RegExp(`${full.doulists} 份豆列没有导出`));
  assert.match(text, new RegExp(`${full.neodbCsv.unattachedLongform} 篇日记没有导出`));
  assert.match(text, new RegExp(`剧集 ${full.letterboxd.skippedTv} 部`));
  // NDJSON 那一节反过来要说清楚它**装下了**：一份说明里两节自相矛盾，
  // 比哪一节都不写更容易让人传错文件。
  assert.match(text, new RegExp(`${full.neodb.collections} 份豆列`));
  assert.match(text, new RegExp(`${full.neodb.articles} 篇不挂作品的日记`));
});

test('NDJSON 那一节要写明可见性没得选', () => {
  // 上传页面检测到 ndjson 就把三个可见性单选框藏起来，于是恒为公开。
  // 说明里不写，用户会以为自己选过。
  const text = instructions(full);
  assert.match(text, /没有可见性选项/);
  assert.match(text, /--visibility=/);
});

test('说明里明确写着「这不是备份」', () => {
  // 三个平台都收不下修订历史。把导出的 CSV 当档案，是这个项目最怕的误解。
  const text = instructions(full);
  assert.match(text, /不是备份/);
  assert.match(text, /别把这些 CSV 当成你的档案/);
  assert.match(text, new RegExp(`\\*\\*${full.multiRevisionMarks} 条标记改过\\*\\*`));
});

test('数字全是 0 的时候也不炸', () => {
  const text = instructions({ doulists: 0, multiRevisionMarks: 0 });
  assert.match(text, /怎么把这些文件导进去/);
});
