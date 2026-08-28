import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync as run } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE } from './helpers.js';
import { zip, unzip } from '../src/zip-node.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = join(ROOT, 'tools', 'check-roundtrip.mjs');
const EXPORT = join(ROOT, 'bin', 'export.js');

/**
 * 假装自己是服务器：把我们写出去的那份包，变成 NeoDB 导出来的样子。
 *
 * **这个模拟器本身就是一份对 `journal/importers/ndjson.py` 的转写**，跟
 * `test/neodb-ndjson.test.js` 里那张契约表是同一类东西——真正会出错的那个环境
 * （一台跑着的 NeoDB）本地进不去，所以只能把读到的行为写下来，再拿它当判据。
 *
 * 它照抄的是三件事，每一件都在真实往返里验过（2026-08-25，40 条那份）：
 *
 * 1. 条目 id 换成服务器自己的 uuid URL，豆瓣 URL 退到 `external_resources` 里。
 *    校验器只能靠这条链接搭桥，所以这也顺带验了搭桥那段。
 * 2. 时间戳变成 UTC，中间是空格不是 `T`。
 * 3. **每一条标记都会附带生成一行状态历史**——`import_shelf_member` →
 *    `Mark.update` → `ensure_log_entry()`，键是 `(owner, shelf_type, item, created_time)`，
 *    内容由 `_update_log_entry` 写成标记**当前**的星和短评。
 *
 * 第 3 条是这份测试的重点：哪天我们不再把当天那条广播并进标记那一行，
 * 服务器上就会多出解释不了的行，这里立刻红。
 */
async function asServerExport(ourZip) {
  const files = await unzip(readFileSync(ourZip));
  const parse = (name) => (files.get(name) ?? '').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const catalog = parse('catalog.ndjson').filter((d) => d.id);
  const journal = parse('journal.ndjson').filter((d) => d.type);

  let n = 0;
  const uuid = new Map();
  const theirId = (doubanUrl) => {
    if (!uuid.has(doubanUrl)) { n += 1; uuid.set(doubanUrl, `https://example.test/item/${n}`); }
    return uuid.get(doubanUrl);
  };
  const utc = (s) => (s ? new Date(Date.parse(s)).toISOString().replace('T', ' ').replace('Z', '+00:00') : s);

  const outCatalog = catalog.map((c) => ({
    id: theirId(c.id),
    type: c.type,
    display_title: c.title ?? '',
    // 服务器认条目靠外部链接，我们那条自己的 id（豆瓣 URL）在它眼里也是一条链接。
    external_resources: [{ url: c.id }, ...(c.external_resources ?? [])],
  }));

  const outJournal = [];
  for (const d of journal) {
    const rec = structuredClone(d);
    rec.visibility = d.visibility ?? 0; // 我们省掉 0，服务器一定写出来
    if (rec.content) {
      if (rec.content.withRegardTo) rec.content.withRegardTo = theirId(rec.content.withRegardTo);
      if (rec.content.published) rec.content.published = utc(rec.content.published);
      if (rec.content.updated) rec.content.updated = utc(rec.content.updated);
      rec.content.attributedTo = 'https://example.test/@someone/';
      // Article 的正文服务器会另外渲染一份 html 放进 `content`，`source` 原样留着。
      if (rec.type === 'Article' && rec.content.source) rec.content.content = '<p>渲染过的</p>';
    }
    if (rec.items) rec.items = rec.items.map((x) => ({ ...x, item: theirId(x.item) }));
    if (rec.type === 'ShelfLog') {
      rec.item = theirId(rec.item);
      rec.timestamp = utc(rec.timestamp);
      rec.metadata = { ...rec.metadata, posts: [1234567890] }; // 服务器自己塞的，不该参与比对
    }
    outJournal.push(rec);
  }

  // 档案里没有标记日期的那几条，我们整个不写 `published`，服务器于是拿
  // 导入那一刻当日期。实测全量 2943 条里有 8 条走这条路。
  const IMPORTED_AT = '2026-08-25 08:49:46+00:00';
  for (const rec of outJournal) {
    if (rec.type === 'ShelfMember' && !rec.content.published) rec.content.published = IMPORTED_AT;
  }

  // 导标记时顺带生成的那一行。已经有同键的行就不重复建——`get_or_create`。
  const have = new Set(outJournal.filter((d) => d.type === 'ShelfLog').map((d) => `${d.item}|${d.status}|${d.timestamp}`));
  const rating = new Map(journal.filter((d) => d.type === 'Rating').map((d) => [d.content.withRegardTo, d.content.value]));
  const comment = new Map(journal.filter((d) => d.type === 'Comment').map((d) => [d.content.withRegardTo, d.content.content]));
  for (const d of journal) {
    if (d.type !== 'ShelfMember') continue;
    const it = theirId(d.content.withRegardTo);
    // 没有 `published` 的那几条，服务器建行用的也是它自己填的那个导入时刻。
    const ts = d.content.published ? utc(d.content.published) : IMPORTED_AT;
    if (have.has(`${it}|${d.content.status}|${ts}`)) continue;
    const metadata = {};
    if (rating.has(d.content.withRegardTo)) metadata.rating_grade = rating.get(d.content.withRegardTo);
    if (comment.has(d.content.withRegardTo)) metadata.comment_text = comment.get(d.content.withRegardTo);
    outJournal.push({ type: 'ShelfLog', item: it, status: d.content.status, timestamp: ts, metadata });
  }

  const head = (rows) => [JSON.stringify({ server: 'example.test', neodb_version: 'test' }), ...rows.map((r) => JSON.stringify(r))].join('\n');
  return { catalog: outCatalog, journal: outJournal, head };
}

/** 跑一次导出（带状态历史），返回我们那个 zip 的路径。 */
function exported() {
  const dir = mkdtempSync(join(tmpdir(), 'doubak-roundtrip-'));
  run(process.execPath, [EXPORT, FIXTURE, dir, '--target=neodb', '--shelf-history'], { stdio: 'ignore' });
  return join(dir, 'neodb', 'neodb-ndjson-import.zip');
}

/**
 * 把模拟出来的服务器导出写成 zip。
 * @param {string} ourZip
 * @param {(s: {catalog: any[], journal: any[]}) => void} [mutate] 写出去之前动个手脚
 */
async function serverZip(ourZip, mutate) {
  const s = await asServerExport(ourZip);
  // mutate 可能要 await（里面会拆包重打），所以这里必须 await 它 ——
  // 不 await 的话回调里的改动会在 zip 写出之后才落地，测试静静地失去意义。
  if (mutate) await mutate(s);
  const p = join(mkdtempSync(join(tmpdir(), 'doubak-server-')), 'export.zip');
  writeFileSync(p, await zip([
    { name: 'catalog.ndjson', text: `${s.head(s.catalog)}\n` },
    { name: 'journal.ndjson', text: `${s.head(s.journal)}\n` },
  ]));
  return p;
}

function check(ourZip, serverPath) {
  try {
    return { code: 0, out: run(process.execPath, [CHECK, ourZip, serverPath], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: e.stdout ?? '' };
  }
}

test('原样存住的那份，校验器说全对', async () => {
  const ours = exported();
  const { code, out } = check(ours, await serverZip(ours));
  assert.equal(code, 0, out);
  assert.match(out, /送上去的每一条都原样存住了/);
  // 非空断言：真跑过东西，不是所有表都是 0 条。
  assert.match(out, /标记\s+我们\s+1[0-9] 条/);
  assert.match(out, /状态历史\s+我们\s+2[0-9] 条/);
  assert.match(out, /多出来的 \d+ 条都对得上标记本身那件事/);
  // 没有标记日期的那几条只报一行说明，不算错。样本里正好有 1 条——
  // 断言它出现过，否则这条路等于没测：真实全量里是 8 条，
  // 而**一个永远有内容的失败清单就是一个没人看的失败清单**。
  assert.match(out, /其中 1 条档案里没有标记日期/);
});

test('同一件事被写成两行就抓得住——这正是 2026-08-24 那个 bug', async () => {
  const ours = exported();
  // 把某条并进标记那一行的历史，改回广播的钟点：同一天、同一状态、时间戳不同。
  // 服务器上于是有了两行，而单看任何一行都不像重复——文字和时间都不一样。
  const server = await serverZip(ours, async (s) => {
    const marks = new Map(s.journal.filter((d) => d.type === 'ShelfMember' && d.content.published)
      .map((d) => [`${d.content.withRegardTo}|${d.content.status}`, d.content.published]));
    let hit = 0;
    for (const d of [...s.journal]) {
      if (d.type !== 'ShelfLog' || hit) continue;
      if (marks.get(`${d.item}|${d.status}`) !== d.timestamp) continue;
      // 往后挪 13 小时——广播带的是真实钟点，标记那条是 +08:00 的零点。
      const later = new Date(Date.parse(d.timestamp.replace(' ', 'T')) + 13 * 3600 * 1000);
      const ts = later.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '+00:00');
      assert.notEqual(ts, d.timestamp, '改出来的时间戳得跟原来的不一样，否则只是把那一行覆盖了');
      s.journal.push({ ...d, timestamp: ts, metadata: { comment_text: '那天写的' } });
      hit += 1;
    }
    assert.equal(hit, 1, '样本里该有一条并进标记那一行的历史');
  });
  const { code, out } = check(ours, server);
  assert.equal(code, 1, out);
  assert.match(out, /在服务器上有两行/);
  assert.match(out, /是同一件事/);
});

test('服务器上多出一行解释不了的历史就抓得住', async () => {
  const ours = exported();
  const server = await serverZip(ours, async (s) => {
    const one = s.journal.find((d) => d.type === 'ShelfLog');
    s.journal.push({ ...one, timestamp: '2001-01-01 00:00:00+00:00', metadata: {} });
  });
  const { code, out } = check(ours, server);
  assert.equal(code, 1, out);
  assert.match(out, /多出一行.*解释不了/s);
});

test('短评在服务器上变了样就抓得住', async () => {
  const ours = exported();
  const server = await serverZip(ours, async (s) => {
    const one = s.journal.find((d) => d.type === 'Comment');
    one.content.content = `${one.content.content}（被改过）`;
  });
  const { code, out } = check(ours, server);
  assert.equal(code, 1, out);
  assert.match(out, /短评：.*存进去变了样/);
});

test('整条没进去就抓得住', async () => {
  const ours = exported();
  const server = await serverZip(ours, async (s) => {
    const i = s.journal.findIndex((d) => d.type === 'ShelfMember');
    s.journal.splice(i, 1);
  });
  const { code, out } = check(ours, server);
  assert.equal(code, 1, out);
  assert.match(out, /标记：我们送了.*服务器上没有/);
});

test('私密豆列在服务器上变公开就抓得住', async () => {
  const ours = exported();
  const server = await serverZip(ours, async (s) => {
    const c = s.journal.filter((d) => d.type === 'Collection');
    assert.ok(c.length, '样本里该有豆列');
    // 样本里未必有私密的那一份，所以先让它私密，再模拟服务器把它存成了公开。
    const ourFiles = await unzip(readFileSync(ours));
    const j = ourFiles.get('journal.ndjson').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const mine = j.find((d) => d.type === 'Collection');
    mine.visibility = 2;
    writeFileSync(ours, await zip([
      { name: 'catalog.ndjson', text: ourFiles.get('catalog.ndjson') },
      { name: 'journal.ndjson', text: `${j.map((x) => JSON.stringify(x)).join('\n')}\n` },
    ]));
    for (const d of c) if (d.content.name === mine.content.name) d.visibility = 0;
  });
  const { code, out } = check(ours, server);
  assert.equal(code, 1, out);
  assert.match(out, /私密豆列变公开了/);
});
