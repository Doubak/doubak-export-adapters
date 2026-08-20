import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFileSync as run } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE } from './helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = join(ROOT, 'tools', 'check-export.mjs');
const EXPORT = join(ROOT, 'bin', 'export.js');

/** 跑一次导出，返回产出目录。 */
function exported() {
  const dir = mkdtempSync(join(tmpdir(), 'doubak-export-'));
  run(process.execPath, [EXPORT, FIXTURE, dir], { stdio: 'ignore' });
  return dir;
}

/** 跑校验器，返回 { code, out }。 */
function check(dir) {
  try {
    return { code: 0, out: run(process.execPath, [CHECK, FIXTURE, dir], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: e.stdout ?? '' };
  }
}

test('刚导出来的那份，校验器说全对', () => {
  const { code, out } = check(exported());
  assert.equal(code, 0, out);
  assert.match(out, /每一条都跟档案对得上/);
});

test('评分被改过就抓得住', () => {
  // 这是 CSV 最难发现的错法的替身：字段错位之后，评分那一列会变成别的东西，
  // 而导进去之后看着像数据本来就那样。
  const dir = exported();
  const p = join(dir, 'letterboxd', 'letterboxd-watched.csv');
  writeFileSync(p, readFileSync(p, 'utf8').replace(/,([1-5]),(\d{4}-)/, ',9,$2'));
  const { code, out } = check(dir);
  assert.equal(code, 1);
  assert.match(out, /评分 9 越界/);
});

test('「想读」带上读完日期就抓得住', () => {
  // 豆瓣的日期是标记那天，不是读完那天——写上去等于替用户宣称他读完了。
  const dir = exported();
  const p = join(dir, 'goodreads', 'goodreads.csv');
  const text = readFileSync(p, 'utf8');
  // 列的次序是 …, Date Read, Date Added, Shelves, …，所以「想读」那一行里
  // 一定有 `,,<日期>,to-read,`——空的读完日期挨着有值的加入日期。
  // 不能按逗号切开取第 N 列：短评里就有逗号，切出来的列会整体错位。
  const at = /,,(\d{4}\/\d{2}\/\d{2}),to-read,/;
  assert.match(text, at, '样本里该有一本「想读」的书');
  writeFileSync(p, text.replace(at, ',2019/01/01,$1,to-read,'));
  const { code, out } = check(dir);
  assert.equal(code, 1);
  assert.match(out, /却带着读完日期/);
});

test('NeoDB 的表被改名就抓得住——名字不对它会整张跳过，而且不报错', () => {
  const dir = exported();
  // zip 里的文件名是明文存的，直接在字节里替换就能改名（长度不变）。
  const p = join(dir, 'neodb', 'neodb-import.zip');
  const buf = readFileSync(p);
  const from = Buffer.from('movie_mark.csv');
  const to = Buffer.from('movee_mark.csv');
  let at = 0;
  while ((at = buf.indexOf(from, at)) !== -1) { to.copy(buf, at); at += from.length; }
  writeFileSync(p, buf);
  const { code, out } = check(dir);
  assert.equal(code, 1);
  assert.match(out, /不是 NeoDB 认的/);
});

test('导出目录是空的，报错而不是说「全对」', () => {
  // 「没检查到任何东西」和「检查过了都没问题」长得一模一样，是这类脚本的经典事故。
  const empty = mkdtempSync(join(tmpdir(), 'doubak-empty-'));
  let status = 0;
  try {
    execFileSync(process.execPath, [CHECK, FIXTURE, empty], { stdio: 'pipe' });
  } catch (e) {
    status = e.status;
  }
  assert.equal(status, 2);
});

test('小样：带 --sample 该过，不带该失败', () => {
  // 「产物比档案少」正是漏导的症状。让脚本自己猜「大概是小样吧」，
  // 等于把最该报的那个警报关掉——所以这件事必须显式说。
  const dir = mkdtempSync(join(tmpdir(), 'doubak-sample-'));
  run(process.execPath, [EXPORT, FIXTURE, dir, '--sample=6'], { stdio: 'ignore' });

  const ok = run(process.execPath, [CHECK, FIXTURE, dir, '--sample'], { encoding: 'utf8' });
  assert.match(ok, /每一条都跟档案对得上/);
  assert.match(ok, /小样模式/);

  const { code, out } = check(dir);
  assert.equal(code, 1);
  assert.match(out, /标记 \d+ 行，该有 \d+ 条/);
});
