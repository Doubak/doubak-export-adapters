import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zip, unzip } from '../src/zip-node.js';

test('自己拆得开，内容一字不差', async () => {
  const files = [
    { name: 'movie_mark.csv', text: 'title,rating\r\n重返寂静岭,4\r\n' },
    { name: 'book_mark.csv', text: 'x\r\n' + 'y'.repeat(5000) + '\r\n' },
  ];
  const back = await unzip(await zip(files));
  assert.equal(back.size, 2);
  for (const f of files) assert.equal(back.get(f.name), f.text);
});

/** 系统上有没有 unzip。没有的话下面那条测试只能跳过——而跳过等于没测。 */
const HAS_UNZIP = (() => {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('系统的 unzip 也拆得开，而且 -t 通过', { skip: HAS_UNZIP ? false : '这台机器上没有 unzip' }, async () => {
  // 自己写的解析器跟自己写的写出器可能一起错。真正的判据是别人的实现认不认。
  const dir = mkdtempSync(join(tmpdir(), 'doubak-zip-'));
  const path = join(dir, 'a.zip');
  writeFileSync(path, await zip([{ name: 'movie_mark.csv', text: 'a,b\r\n看过,4\r\n' }]));
  const out = execFileSync('unzip', ['-t', path], { encoding: 'utf8' });
  assert.match(out, /No errors detected/);
  assert.equal(execFileSync('unzip', ['-p', path, 'movie_mark.csv'], { encoding: 'utf8' }), 'a,b\r\n看过,4\r\n');
});

test('同样的输入，两次产出逐字节相同', async () => {
  // 带真实时间戳的话，「这次导出跟上次有什么不一样」就永远答不了。
  const files = [{ name: 'x.csv', text: 'a\r\n1\r\n' }];
  assert.deepEqual(await zip(files), await zip(files));
});

/**
 * 产出是 `Uint8Array`，不是 `Buffer`。
 *
 * 写出器要能原样跑在浏览器扩展里，而那边没有 `Buffer`，所以整个文件改成了
 * `Uint8Array` + `DataView`。这几行跟着改是必然的——但值得说一句：`Buffer`
 * **本身就是 `Uint8Array` 的子类**，所以 `writeFileSync` 之类的接口一个字都
 * 不用动，只有 `readUIntXXLE` 这种 Buffer 独有的方法要换成 DataView。
 */
const le = (buf) => new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

test('压不小的时候按存储写，不会写出比原文还大的 zip 条目', async () => {
  const text = 'q'; // 一个字符，deflate 之后一定更长
  const buf = await zip([{ name: 'x.csv', text }]);
  assert.equal(le(buf).getUint16(8, true), 0); // method = 0（存储）
  assert.equal((await unzip(buf)).get('x.csv'), text);
});

test('空的文件列表也是一个合法 zip', async () => {
  const buf = await zip([]);
  assert.equal(buf.length, 22); // 只有 EOCD
  assert.equal(le(buf).getUint32(0, true), 0x06054b50);
});

test('不给压缩函数就报错，而不是写出一个坏 zip', async () => {
  // 这是拆分之后新出现的失误：`zip.js` 不再自带压缩，忘了传就该立刻炸。
  // 悄悄当成「存储」会写出一个能打开、但比原文大好几倍的包，而那是没人会去看的。
  const { zip: pure } = await import('../src/zip.js');
  await assert.rejects(() => pure([{ name: 'x', text: 'y' }], {}), /deflateRaw/);
  await assert.rejects(() => pure([{ name: 'x', text: 'y' }]), /deflateRaw/);
});
