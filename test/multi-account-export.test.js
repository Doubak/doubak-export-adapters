import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadCanonical, findCanonicalDirs } from '../src/canonical.js';

function createDummyCanonical(dir, records100 = [], records200 = []) {
  mkdirSync(dir, { recursive: true });
  const marks = [
    ...records100.map((r, i) => ({
      upstream_id: `u100_${i}`,
      medium: 'movie',
      subject: { id: `m100_${i}`, title: `Movie 100 ${i}` },
      account: { user_id: '100', nickname: 'Alice' },
      revisions: [{ last_observed_at: '2026-08-01T00:00:00Z', fields: { marked_at: { iso: '2026-08-01' }, status: 'done' } }],
    })),
    ...records200.map((r, i) => ({
      upstream_id: `u200_${i}`,
      medium: 'movie',
      subject: { id: `m200_${i}`, title: `Movie 200 ${i}` },
      account: { user_id: '200', nickname: 'Bob' },
      revisions: [{ last_observed_at: '2026-08-01T00:00:00Z', fields: { marked_at: { iso: '2026-08-01' }, status: 'done' } }],
    })),
  ];
  writeFileSync(join(dir, 'marks.ndjson'), marks.map((m) => JSON.stringify(m)).join('\n') + '\n');
  writeFileSync(join(dir, 'subjects.ndjson'), '');
  writeFileSync(join(dir, 'broadcasts.ndjson'), '');
  writeFileSync(join(dir, 'longform.ndjson'), '');
  writeFileSync(join(dir, 'doulists.ndjson'), '');
}

test('export-adapters 多账号防护与子目录探测', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'export-multi-account-test-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const mixedDir = join(tmp, 'mixed');
  createDummyCanonical(mixedDir, [{}], [{}]);

  // 1. loadCanonical 默认阻断混合账号
  assert.throws(() => loadCanonical(mixedDir), /输入的 canonical 目录中包含多个账号的数据/);

  // 2. loadCanonical 带 account 过滤成功
  const res100 = loadCanonical(mixedDir, { account: '100' });
  assert.equal(res100.marks.length, 1);
  assert.equal(res100.account.user_id, '100');

  // 3. loadCanonical 指定不存在账号抛出清晰错误
  assert.throws(() => loadCanonical(mixedDir, { account: '999' }), /指定的账号 999 在 canonical 数据中不存在/);

  // 4. findCanonicalDirs 子目录探测
  const parentDir = join(tmp, 'parent');
  const sub1 = join(parentDir, 'user_a');
  createDummyCanonical(sub1, [{}]);
  const found = findCanonicalDirs(parentDir);
  assert.deepEqual(found, [sub1]);

  // 5. CLI: 未带参数跑混合 canonical 应当报错退出（exit code 1）
  const r1 = spawnSync(process.execPath, ['bin/export.js', mixedDir, join(tmp, 'out1')], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf-8',
  });
  assert.equal(r1.status, 1);
  assert.match(r1.stderr, /输入的 canonical 目录中包含多个账号的数据/);

  // 6. CLI: --account 100 过滤导出成功（exit code 0）
  const out2 = join(tmp, 'out2');
  const r2 = spawnSync(process.execPath, ['bin/export.js', mixedDir, out2, '--account', '100'], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf-8',
  });
  assert.equal(r2.status, 0);
  assert.ok(existsSync(join(out2, '怎么导入.md')));

  // 7. CLI: --all-accounts 批量分流导出（exit code 0）
  const out3 = join(tmp, 'out3');
  const r3 = spawnSync(process.execPath, ['bin/export.js', mixedDir, out3, '--all-accounts'], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf-8',
  });
  assert.equal(r3.status, 0);
  assert.ok(existsSync(join(out3, '100', '怎么导入.md')));
  assert.ok(existsSync(join(out3, '200', '怎么导入.md')));

  // 8. CLI: 子目录自动定位探测
  const out4 = join(tmp, 'out4');
  const r4 = spawnSync(process.execPath, ['bin/export.js', parentDir, out4], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf-8',
  });
  assert.equal(r4.status, 0);
  assert.match(r4.stdout, /自动定位到子目录中的 canonical 存档/);
});
