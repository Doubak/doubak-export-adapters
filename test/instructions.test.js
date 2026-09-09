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

test('**「认不出来」和「旧档案」要给出各自的下一步，而不是同一句话**', () => {
  // 这一段此前一个断言都没有，而它当时说的是错的：`unsure` 的两个成因被合成
  // 「这份 canonical 里没有可见性字段（旧档案）」一句，于是豆瓣改版的那一种
  // 会被告知「重跑一次解析器」——而那件事做不成，要改的是抽取器。
  // 两个方向的下一步相反，说错的方向是**把人支去做做不成的事**，与站点那边
  // 「缺图」（去重抓）和「图烂了」（重抓没用）必须分开报是同一条。
  const with_ = (why) => instructions({
    ...full,
    neodb: { ...full.neodb, restricted: [{ title: '某篇日记', by: 'unsure', why, url: null }] },
  });

  const legacy = with_('legacy');
  assert.match(legacy, /旧档案/);
  assert.match(legacy, /重新跑一次解析器就有了/);
  assert.ok(!legacy.includes('救不回来'), '老档案是救得回来的，别把人吓住');

  const stale = with_('unrecognized');
  assert.match(stale, /没能读出来/);
  assert.match(stale, /重跑解析器救不回来/);
  assert.match(stale, /note_visibility/, '得说出去哪儿找线索，否则「改抽取器」无从下手');
  assert.ok(!stale.includes('旧档案'), '豆瓣改版跟档案新旧没关系，这么写会把人支错方向');
});

test('豆瓣锁掉的那几篇，说明里要说「按公开导入」并且说撤不回来', () => {
  // 这一份是被公开导出的那一份，所以恰恰更要说：Article 会联邦出去。
  const text = instructions({
    ...full,
    neodb: { ...full.neodb, restricted: [{ title: '想看的被河蟹的电影', by: 'platform', why: null, url: null }] },
  });
  assert.match(text, /想看的被河蟹的电影/);
  assert.match(text, /按公开导入/);
  assert.match(text, /撤不回来/);
  assert.match(text, /--visibility=2/, '得给出收紧的办法，否则说了代价却没给出路');
});

test('**请人去 GitHub 报一声，只在真读不出来的时候出现**', () => {
  // 两个方向都要测。**一句永远在的求助等于没人看的求助**——这个项目已经在
  // 「一个永远有条目的失败列表」上栽过六次，一句常驻的 🙏 是同一个形状。
  const with_ = (restricted) => instructions({ ...full, neodb: { ...full.neodb, restricted } });

  const 读不出 = with_([{ title: '某篇', by: 'unsure', why: 'unrecognized', url: null }]);
  assert.match(读不出, /github\.com\/Doubak\/doubak-data-parser\/issues/);
  assert.match(读不出, /note_visibility/, '得说清楚贴什么，否则「报一声」无从下手');
  assert.match(读不出, /不用重新抓豆瓣/, '这是这条求助最要紧的一句：代价很小');

  for (const [label, r] of [
    ['旧档案', [{ title: '某篇', by: 'unsure', why: 'legacy', url: null }]],
    ['作者自己设的', [{ title: '某篇', by: 'author', why: null, url: null }]],
    ['豆瓣锁的', [{ title: '某篇', by: 'platform', why: null, url: null }]],
    ['一篇都没有', []],
  ]) {
    assert.ok(!with_(r).includes('doubak-data-parser/issues'), `${label}：不该请人去报`);
  }
});

test('说明里那句「写成几」要跟 --unknown-visibility 一致，不能写死', () => {
  // 写死 2 的话，用户改过之后这一段就成了假话，而这一段的全部作用就是让他
  // 知道刚才发生了什么。
  const with_ = (unknownVisibility) => instructions({
    ...full,
    neodb: {
      ...full.neodb,
      unknownVisibility,
      restricted: [{ title: '某篇', by: 'unsure', why: 'unrecognized', url: null }],
    },
  });
  assert.match(with_(2), /写成 `visibility=2`（仅提及者）/);
  assert.match(with_(1), /写成 `visibility=1`（仅关注者）/);
  assert.match(with_(0), /跟上面那个基线走/);
  // 已经调成 0 的人不需要再被劝一次「可以调成 0」。
  assert.ok(!with_(0).includes('用 `--unknown-visibility=0` 重新导出'));
  assert.match(with_(2), /`--unknown-visibility=0` 重新导出/);
});
