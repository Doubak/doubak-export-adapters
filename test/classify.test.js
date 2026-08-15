import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, identifiers, splitTitle } from '../src/classify.js';

const withInfo = (info) => ({ info });

test('豆瓣的「电影」按 info 里有没有剧集专属行分成电影和剧集', () => {
  assert.deepEqual(classify('movie', withInfo({ 类型: ['剧情'] })), { category: 'movie', guessed: false });
  for (const key of ['集数', '首播', '季数']) {
    assert.equal(classify('movie', withInfo({ [key]: ['12'] })).category, 'tv', `${key} 应判为剧集`);
  }
});

test('空数组不算数——「读过详情页，那一行没有」跟「有这一行」不是一回事', () => {
  assert.equal(classify('movie', withInfo({ 集数: [] })).category, 'movie');
});

test('没有 info 的电影退回默认值，但要标出来是猜的', () => {
  // 游戏和舞台剧压根没有 #info；电影里也有 8 个是详情页没抓到。
  // 默认值本身没问题，问题是它跟「读过详情页、确认是电影」长得一模一样。
  assert.deepEqual(classify('movie', null), { category: 'movie', guessed: true });
  assert.deepEqual(classify('movie', {}), { category: 'movie', guessed: true });
  assert.deepEqual(classify('movie', withInfo({})), { category: 'movie', guessed: false });
});

test('其余四种 medium 一一对应，不需要 info', () => {
  assert.deepEqual(classify('book', null), { category: 'book', guessed: false });
  assert.deepEqual(classify('music', null), { category: 'music', guessed: false });
  assert.deepEqual(classify('game', null), { category: 'game', guessed: false });
  assert.deepEqual(classify('drama', null), { category: 'performance', guessed: false });
});

test('IMDb 号格式不对就当没有', () => {
  // 一个格式不对的 id 会让整行匹配失败，而留空还能退回标题匹配。
  assert.equal(identifiers(withInfo({ IMDb: ['tt22868010'] })).imdb, 'tt22868010');
  assert.equal(identifiers(withInfo({ IMDb: [' tt22868010 '] })).imdb, 'tt22868010');
  assert.equal(identifiers(withInfo({ IMDb: ['暂无'] })).imdb, null);
  assert.equal(identifiers(withInfo({ IMDb: [''] })).imdb, null);
  assert.equal(identifiers(null).imdb, null);
});

test('ISBN 去掉连字符，留 X', () => {
  assert.equal(identifiers(withInfo({ ISBN: ['978-7-220-11404-5'] })).isbn, '9787220114045');
  assert.equal(identifiers(withInfo({ ISBN: ['080442957x'] })).isbn, '080442957X');
});

test('年份取最早的一个，不是列在最前面的那个', () => {
  // 豆瓣的「上映日期」是按地区列的一串，次序不保证；一部片子的年份是它首次公映那年。
  const info = withInfo({ 上映日期: ['2026-04-30(中国大陆)', '2025-09-05(美国)'] });
  assert.equal(identifiers(info).year, '2025');
});

test('年份能从首播/出版年/发行时间里取', () => {
  assert.equal(identifiers(withInfo({ 首播: ['2016-10-14(日本)'] })).year, '2016');
  assert.equal(identifiers(withInfo({ 出版年: ['2019-8-1'] })).year, '2019');
  assert.equal(identifiers(withInfo({ 发行时间: ['2016-10-05'] })).year, '2016');
  assert.equal(identifiers(withInfo({})).year, null);
});

test('标题按第一个 " / " 切成中文名和原名', () => {
  assert.deepEqual(splitTitle('重返寂静岭 / Return to Silent Hill'),
    { local: '重返寂静岭', original: 'Return to Silent Hill' });
  assert.deepEqual(splitTitle('窗外是蓝星'), { local: '窗外是蓝星', original: null });
  assert.deepEqual(splitTitle(null), { local: '', original: null });
});

test('原名里再有斜杠也不再切', () => {
  // 按第一个切：中文名里不会出现 " / " 这个写法，原名里会。
  assert.deepEqual(splitTitle('某某 / A / B'), { local: '某某', original: 'A / B' });
});
