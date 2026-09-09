import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zip, unzip } from '../src/zip-node.js';
import { ZipWriter } from '../src/zip.js';
import { deflateRawSync } from 'node:zlib';

/** @param {Uint8Array} b */
const deflateRaw = (b) => new Uint8Array(deflateRawSync(b));

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

/**
 * 流式那条路（`ZipWriter`）——档案导出用它。
 *
 * 与 `zip()` 的区别只在**大**：一份真实档案 619 MB，单个段就有 159 MB，而这个项目
 * 从第一天起就写着不许在内存里拼一个巨大的 Blob。所以大成员走「存储 + 数据描述符」，
 * 本地头里的 CRC 与长度在正文之后才补。
 *
 * 判据只能是**别人的实现认不认**：数据描述符是 1989 年就在的机制，但写错一个字节
 * 的后果是「我们自己读得回来、`unzip` 读不出来」——而用户手上只有 `unzip`。
 */
describe('ZipWriter：流式那条路', () => {
  const collect = async (fn) => {
    /** @type {Uint8Array[]} */
    const parts = [];
    const w = new ZipWriter({ write: (c) => { parts.push(c); }, deflateRaw });
    await fn(w);
    await w.finish();
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  };

  /** @param {Uint8Array} bytes */
  const writeTmp = (bytes) => {
    const dir = mkdtempSync(join(tmpdir(), 'doubak-zipw-'));
    const path = join(dir, 'a.zip');
    writeFileSync(path, bytes);
    return path;
  };

  test('分块写进去的成员，系统 unzip 认，而且 -t 通过', { skip: HAS_UNZIP ? false : '没有 unzip' }, async () => {
    const chunks = [
      new TextEncoder().encode('第一块 '),
      new Uint8Array([0, 1, 2, 255, 254]), // 二进制安全：档案里 26% 是 JPEG
      new TextEncoder().encode(' 第三块'),
    ];
    const bytes = await collect(async (w) => {
      await w.add('doubak-bundle-x/data-000001.warc.gz', chunks);
      await w.add('doubak-bundle-x/manifest.json', new TextEncoder().encode('{"a":1}'));
    });
    const path = writeTmp(bytes);
    assert.match(execFileSync('unzip', ['-t', path], { encoding: 'utf8' }), /No errors detected/);

    // 内容也要对得上——`-t` 只验 CRC，不验我们把长度写对了没有。
    const got = execFileSync('unzip', ['-p', path, 'doubak-bundle-x/data-000001.warc.gz']);
    const want = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    assert.deepEqual(new Uint8Array(got), new Uint8Array(want));
    assert.equal(
      execFileSync('unzip', ['-p', path, 'doubak-bundle-x/manifest.json'], { encoding: 'utf8' }),
      '{"a":1}',
    );
  });

  test('目录结构原样保留 —— 解开就是搬得回去的那个形状', { skip: HAS_UNZIP ? false : '没有 unzip' }, async () => {
    // 这是「zip 只是个壳子」那条主张的技术前提：解开之后必须**就是**档案目录，
    // 与 Chrome 直接导出的一模一样，不然「壳子不是格式」就成了一句空话。
    const bytes = await collect(async (w) => {
      await w.add('doubak-bundle-a/index-a.ndjson', new TextEncoder().encode('{}\n'));
      await w.add('doubak-bundle-b/index-b.ndjson', new TextEncoder().encode('{}\n'));
    });
    const out = execFileSync('unzip', ['-Z1', writeTmp(bytes)], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(out.sort(), ['doubak-bundle-a/index-a.ndjson', 'doubak-bundle-b/index-b.ndjson']);
  });

  test('数据描述符那 4 个字节的签名要写对', async () => {
    // **系统 unzip 查不出这一条**——它按中央目录里的长度定位，压根不读描述符。
    // 突变验过：把签名改成 0x08074b51，上面每一条测试照样绿。
    // 而流式读取器（边下边解的那种）认的就是这个签名，写错了它们会当场读崩。
    // 所以这里直接查字节。
    const data = new TextEncoder().encode('一二三');
    const bytes = await collect(async (w) => { await w.add('x', [data]); });
    // 本地头(30) + 名字(1) + 正文 之后就是描述符
    const at = 30 + 1 + data.length;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(view.getUint32(at, true), 0x08074b50, '数据描述符签名不对');
    assert.equal(view.getUint32(at + 8, true), data.length, '描述符里的压缩长度不对');
    assert.equal(view.getUint32(at + 12, true), data.length, '描述符里的原长不对');
  });

  test('空成员也要写对', async () => {
    // 0 字节的段文件是可能出现的（刚开一个新段就崩了），而 CRC 与长度都为 0
    // 恰好是最容易被写成「忘了写」的那种值。
    const bytes = await collect(async (w) => { await w.add('empty', []); });
    const back = await unzip(bytes);
    assert.equal(back.get('empty'), '');
  });

  test('**重名要响亮地拒绝**', async () => {
    // zip 允许重名，而解开之后后一个会盖掉前一个——档案导出最不能出的就是这件事。
    await assert.rejects(
      () => collect(async (w) => {
        await w.add('x', new Uint8Array([1]));
        await w.add('x', new Uint8Array([2]));
      }),
      /重复的成员名/,
    );
  });

  test('超过 4 GB 要**抛**，不许悄悄写出一个坏 zip', async () => {
    // ZIP 不带 ZIP64 时上限就是 4 GB。悄悄越过去的后果是用户以为导出成功了，
    // 几个月后才发现解不开——而那时原档案可能已经删了。
    const w = new ZipWriter({ write: () => {}, deflateRaw });
    await w.add('x', new Uint8Array([1]));
    w._offset = 0x1_0000_0000; // 假装已经写过 4 GB
    await assert.rejects(() => w.finish(), /ZIP64/);
  });

  test('`zip()` 就建立在它之上 —— 格式只有一份实现', async () => {
    // 两个 zip 写出器意味着「NeoDB 收不收得下」要验两遍，而其中一遍多半没人验。
    const src = readFileSync(new URL('../src/zip.js', import.meta.url), 'utf-8');
    assert.match(src, /new ZipWriter\(/, 'zip() 没有走 ZipWriter');
  });
});

describe('ZipWriter.beginMember：推的那半边', () => {
  const collect = async (fn) => {
    /** @type {Uint8Array[]} */
    const parts = [];
    const w = new ZipWriter({ write: (c) => { parts.push(c); }, deflateRaw });
    await fn(w);
    await w.finish();
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  };

  test('推进去的与迭代进去的，产出逐字节相同', async () => {
    // 两种形状必须是**同一条路**。分成两份实现的话，有一天其中一条会开始写出
    // 不一样的 zip，而两边各自的测试都还是绿的。
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    const pulled = await collect((w) => w.add('x', chunks));
    const pushed = await collect(async (w) => {
      const m = await w.beginMember('x');
      for (const c of chunks) await m.write(c);
      await m.close();
    });
    assert.deepEqual(pulled, pushed);
  });

  test('收尾之后再写要抛', async () => {
    await assert.rejects(() => collect(async (w) => {
      const m = await w.beginMember('x');
      await m.close();
      await m.write(new Uint8Array([1]));
    }), /已经收尾了/);
  });

  test('重名照样拒绝', async () => {
    await assert.rejects(() => collect(async (w) => {
      await (await w.beginMember('x')).close();
      await w.beginMember('x');
    }), /重复的成员名/);
  });
});
