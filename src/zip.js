/**
 * ZIP 写出器，约 80 行，只用 `node:zlib`。
 *
 * ## 为什么不装一个 zip 库
 *
 * NeoDB 的 CSV 导入收的是一个 zip（里面按分类分文件：`movie_mark.csv`、
 * `book_review.csv`……）。整个项目的前提是「一个陌生人在 2040 年还能把它重建出来」，
 * 而 ZIP 的存储格式是 1989 年定死的、公开的、每个操作系统都自带解压——
 * **它跟 WARC 是同一类东西：几段定长头，加上负载。**
 *
 * 这跟站点生成器不把 Hugo 收成 npm 依赖是同一条线。
 *
 * ## 时间戳一律写 1980-01-01
 *
 * 同样一份 canonical 导两次，产物应当逐字节相同——扩展打包脚本已经是这么做的。
 * 带上真实时间的话，「这次导出跟上次有什么不一样」就永远答不了，因为**每次都不一样**。
 */

import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

/** @param {Buffer} buf @returns {number} */
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// 1980-01-01 00:00:00，DOS 时间戳能表示的最小值。
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

/**
 * 打一个 zip。
 * @param {{name: string, text: string}[]} files 名字是 zip 内的相对路径
 * @returns {Buffer}
 */
export function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.from(file.text, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    // 压完反而更大的时候按「存储」写。小 CSV 上真的会发生。
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // 文件名是 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, dir, end]);
}
