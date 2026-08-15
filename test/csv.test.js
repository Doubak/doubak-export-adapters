import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csv, csvField } from '../src/csv.js';
import { parseCsv } from './helpers.js';

test('不需要引号的字段就不加引号', () => {
  assert.equal(csvField('看过'), '看过');
  assert.equal(csvField(2026), '2026');
});

test('逗号、引号、换行都要加引号，引号写成两个', () => {
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('他说“行”'), '他说“行”'); // 中文引号不是 CSV 的引号
  assert.equal(csvField('he said "yes"'), '"he said ""yes"""');
  assert.equal(csvField('第一行\n第二行'), '"第一行\n第二行"');
  assert.equal(csvField('回车\r也算'), '"回车\r也算"');
});

test('null 和 undefined 写成空，不是 "null"', () => {
  // JS 里 String(null) 是四个字母 'null'，进了「评分」那一列就是个非法值。
  assert.equal(csvField(null), '');
  assert.equal(csvField(undefined), '');
  assert.equal(csvField(0), '0'); // 但 0 是个值，不能一起吞掉
  assert.equal(csvField(''), '');
});

test('用户写的字原样往返，包括逗号引号换行', () => {
  const nasty = [
    '_(:з」∠)_',
    'From <May December>',
    '他说"这片子还行,但是"，然后走了',
    '第一行\n第二行\n第三行',
    '中间有个逗号, 和一个"引号"',
    '',
  ];
  const text = csv(['x'], nasty.map((s) => [s]));
  const back = parseCsv(text).slice(1).map((r) => r[0]);
  assert.deepEqual(back, nasty);
});

test('行分隔是 CRLF，且没有 BOM', () => {
  // BOM 会让 NeoDB 的 csv.DictReader 把第一个表头读成 `﻿title`，
  // 于是每一行的第一列都取不到，而且不报错。
  const text = csv(['a', 'b'], [['1', '2']]);
  assert.equal(text, 'a,b\r\n1,2\r\n');
  assert.ok(!text.startsWith('﻿'));
});

test('列数在每一行都一样，哪怕字段是空的', () => {
  const text = csv(['a', 'b', 'c'], [['1', '', null], [null, null, null]]);
  const rows = parseCsv(text);
  assert.deepEqual(rows.map((r) => r.length), [3, 3, 3]);
});
