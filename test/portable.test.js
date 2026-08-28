/**
 * 这几个模块要能原样跑在浏览器里，所以**一个内建模块都不许碰**。
 *
 * ## 为什么要一条测试守着
 *
 * 因为破坏它太容易了，而且失败离现场很远。往 `neodb-ndjson.js` 里加一行
 * `import { readFileSync } from 'node:fs'` 在这个仓库里毫无问题——`npm test`
 * 全绿，命令行照跑。炸的地方是扩展：模块加载直接失败，而如果那是个 Worker，
 * 抛出来的 `ErrorEvent` 上什么有用信息都没有（扩展仓库里
 * `no-node-builtins.test.js` 记着这笔账，代价是一整轮往返）。
 *
 * ## 传递依赖也要查
 *
 * 只查这几个文件本身是不够的：`neodb-ndjson.js` 自己干净，但它 import 的
 * `canonical.js` 曾经带着 `node:fs`——`latest`/`fieldsOf` 两个纯函数住在一个
 * 读目录的文件里。那正是 `record.js` 被拆出来的原因，也正是这条测试要盯的形状。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * 扩展要拿走的入口。**改这张表就是在改跨仓库的契约**——扩展那边的
 * `tools/sync-vendor.mjs` 有一份对应的名单，两边对不上时同步会失败。
 */
const PORTABLE_ENTRIES = [
  'targets/neodb-ndjson.js',
  'instructions.js',
  'zip.js',
];

/** 顺着相对 import 把传递依赖都收进来。 */
async function closure(entries) {
  const seen = new Set();
  const queue = entries.map((e) => resolve(SRC, e));
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = await readFile(file, 'utf-8');
    for (const m of text.matchAll(/from\s+'(\.[^']+)'/g)) {
      queue.push(resolve(dirname(file), m[1]));
    }
  }
  return seen;
}

test('可移植的那几个模块，连同它们的传递依赖，都不 import node: 内建模块', async () => {
  const files = await closure(PORTABLE_ENTRIES);

  // **断言真的扫到了东西。** 正则一旦写坏，这条测试会变成一个空循环而永远是绿的
  // ——那是这类静态检查最常见的失效方式，而它比没有测试更糟：它给的是假的安心。
  assert.ok(files.size >= 5, `只收集到 ${files.size} 个文件，import 的正则大概坏了`);

  const bad = [];
  for (const file of files) {
    const text = await readFile(file, 'utf-8');
    for (const m of text.matchAll(/from\s+'(node:[^']+)'/g)) {
      bad.push(`${file.slice(SRC.length + 1)} → ${m[1]}`);
    }
  }
  assert.deepEqual(bad, [], `这些文件要在浏览器里跑，不能碰内建模块：\n${bad.join('\n')}`);
});

test('zip.js 不再自带压缩，压缩绑定只在 zip-node.js 里', async () => {
  // 这两条一起说明了分界：格式在 zip.js（两边共用），压缩在各自的宿主里。
  const pure = await readFile(join(SRC, 'zip.js'), 'utf-8');
  const node = await readFile(join(SRC, 'zip-node.js'), 'utf-8');
  assert.ok(!/from 'node:zlib'/.test(pure), 'zip.js 又把 zlib 收回去了');
  assert.ok(/from 'node:zlib'/.test(node), 'zip-node.js 该是绑定 zlib 的那一个');
});
