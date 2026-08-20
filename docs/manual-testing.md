# 手工验一遍

`npm test` 有 85 个测试，但它们证明不了这件事最要紧的那一半。

测试对着 `test/fixtures/` 里那 18 条真实记录跑，证明的是**代码在那 18 条上是对的**。它证明不了：

- 你那几千条里有没有样本里没出现过的形状（短评里三个连续换行、标签里带竖线、IMDb 号是空字符串而不是缺失）；
- **三个平台到底收不收。** 这里的每一列都是读它们导入器的源码定的，不是照文档抄的——但「读对了源码」和「对方真的收」之间还差一次真实上传。

这一页就是补这两块。整个流程约 20 分钟，其中大部分是等对方的导入队列。

> **一句话版本**：`--sample=20` 先切一小份 → `tools/check-export.mjs` 离线自查 → 传上去看那 20 条对不对 → 确认没问题再导全量。

---

## 第 0 步 · 先跑一次，读报告

```sh
node bin/export.js ~/downloads/20260806-canonical /tmp/export-full
```

**报告本身就是第一道检查。** 里面每个数都该说得通：

```
NeoDB  → /tmp/export-full/neodb/neodb-import.zip
  标记 2943 条（book 145 · game 598 · movie 1470 · music 84 · performance 5 · tv 641）
  ⚠ 8 条没读到详情页，分不出电影还是剧集，按电影处理
  ⚠ 7 条连豆瓣链接都没有（条目已被豆瓣删除），没有放进 zip
```

对着自己的档案问三句：

- **总数对得上吗。** 「标记 2943 条」加上「7 条没有豆瓣链接」，该等于 canonical 里 `marks.ndjson` 的行数（`wc -l`，实测 2950）。
- **分类的比例说得通吗。** 「剧集 641」意味着你的「电影」里有三成是剧集。如果你几乎不看剧集却看到几百，那是判据出问题了，不是数据。
- **⚠ 那几行的数字大得离谱吗。** 「没读到详情页」如果是几千而不是几个，说明详情页那条路线基本没抓到——这时候该先回去补抓，而不是继续导。

---

## 第 1 步 · 不上传就能做的检查

```sh
node tools/check-export.mjs ~/downloads/20260806-canonical /tmp/export-full
```

它把刚写出来的文件**读回来**，跟 canonical 逐条逐字段对：

```
NeoDB     标记 2943 行 · 7 张表 · zip 拆得开（另有 7 条没有豆瓣链接，在 neodb-needs-check.csv 里）
Letterboxd 看过 953 · 想看 509
Goodreads  145 本

✔ 每一条都跟档案对得上。可以上传了。
```

它盯的是这些（每一条都是「错了不会报错、只会看着正常」的那种）：

| 检查 | 错了会怎样 |
|---|---|
| 每个字段跟档案逐字相同 | CSV 错位：后面的字段整体挪一格，评分变成日期、评语变成标签 |
| 一条不多一条不少，链接不重复 | 重复的条目在对方那里变成两条记录 |
| NeoDB 的表名是它认的七个之一 | 名字不对，**整张表不会被读，而且不报错** |
| NeoDB 的 `info` 列里值不带空格 | 它按空格切 `key:value`，一个空格会把后面的键吃掉 |
| 评分在 1–5（NeoDB 是 ×2 之后的 1–10） | 越界的评分要么被拒，要么被截成别的数 |
| 剧集没混进 Letterboxd | 可能匹配到一部**同名电影**，观影记录里凭空多一部没看过的片子 |
| Goodreads 只有「读过」带读完日期 | 替你宣称你读完了想读的书 |

退出码 0 是全对，1 是有对不上的。**这一步过不了就别上传**，直接开 issue。

如果想自己再看两眼：

```sh
unzip -l /tmp/export-full/neodb/neodb-import.zip     # 里面有哪几张表
unzip -p /tmp/export-full/neodb/neodb-import.zip movie_mark.csv | head -3
head -3 /tmp/export-full/letterboxd/letterboxd-watched.csv
cat /tmp/export-full/letterboxd/letterboxd-needs-check.csv   # 匹配不了的那几条
```

---

## 第 2 步 · 切一小份，真传一次

这是唯一能回答「对方到底收不收」的一步。

**三个平台的导入都不好撤**：NeoDB 要一条条删，Letterboxd 的观影记录没有批量撤销，Goodreads 更麻烦。所以别拿全量去试。

```sh
node bin/export.js ~/downloads/20260806-canonical /tmp/export-sample --sample=20
```

`--sample` 按 **(分类, 状态)** 轮着取，不是取前 20 条。取前 20 条会拿到一堆同类的——canonical 按抓取顺序排，开头很可能全是电影、全是「看过」，那样验不了图书的 ISBN、验不了「想看」有没有跑进「看过」、验不了舞台剧的链接对方认不认。

轮着取保证**每一种组合都至少来一条**。代价是分给电影的少：真实档案里有 13 种组合，`--sample=20` 只给 Letterboxd 留 2 部片子。想多验几部就 `--sample=40`。

长文和豆列**不削**——它们本来就只有个位数，而书评走的是另一张表（就是表头里有两个 `title` 的那张）。

小样也要先自查一遍，但**要带 `--sample`**：

```sh
node tools/check-export.mjs ~/downloads/20260806-canonical /tmp/export-sample --sample
```

不带的话它会报「20 行，该有 2943 条」——这是对的，**「产物比档案少」正是漏导的症状**，默认就放行等于把最该报的那个警报关掉。带上 `--sample`，逐条的检查照做，只是不再核对总条数。

### NeoDB

1. 头像菜单 → `数据` → 导入 → **CSV**，上传 `neodb/neodb-import.zip`（整个 zip，不用解压）。
2. **把可见性设成「仅自己可见」。** 这是小样，不该出现在关注你的人的时间线上。
3. 等。NeoDB 库里没有的条目它会**自己去豆瓣抓一份**建出来，所以第一次很慢，页面要挂着。

传完之后逐项看那 20 条：

- [ ] **条目对上了吗**——点开一条，是不是同一部作品，不是同名的另一部。
- [ ] **状态**：想读/在读/读过、想看/在看/看过，跟豆瓣一致。
- [ ] **评分**：豆瓣 ★★★★ 在 NeoDB 应当是 **8**（1–5 × 2 = 1–10）。这一条最容易错，而且看起来只是「分高了点」。
- [ ] **短评**：整段在，标点没被吃掉，换行还在。
- [ ] **标签**：几个就是几个，没有被拆开或粘在一起。
- [ ] **日期**：标记时间是豆瓣上那天，不是今天。
- [ ] **书评**：`game_review.csv` 那两篇进去了，而且**有标题**。标题空了就是重复表头那一处理解错了。

**`neodb-needs-check.csv` 不要上传。** 它跟 zip 放在同一个目录里，但它是给人看的：里面是豆瓣已经删掉、档案里连链接都没留下的条目，NeoDB 无从定位。

导入完成后 NeoDB 会给一行结果，形如 `41 items imported, 0 skipped, 1 failed`。**`failed` 应当是 0。** 实测 2026-08-20 第一次真实导入 42 条时报了 1 个 `Could not find item: `（冒号后面是空的），原因正是上面那条没有链接的记录——现在它已经不进 zip 了，所以再遇到非 0 的 `failed`，那就是真出了问题，请开 issue。

不满意就把这 20 条删掉重来——**这正是先传 20 条的意义**。

### Letterboxd

**要传两次，两个入口不一样。**

1. 看过的：Settings → Import & Export → Import your data，上传 `letterboxd-watched.csv`。
2. 想看的：到 Watchlist 页面，用那里的导入，上传 `letterboxd-watchlist.csv`。

Letterboxd 会先给一屏**匹配确认**，那一屏就是最好的检查点——**在这里点掉，什么都不会写进去**：

- [ ] 匹配上的是不是同一部片子（中文片名对英文片名，最容易张冠李戴）。
- [ ] **有没有剧集混进来**。有的话立刻停下来开 issue：这是这一路最要命的错。
- [ ] 评分是不是 1–5（**不换算**，豆瓣 ★★★★ 就是 4，不是 8）。
- [ ] 观影日期是豆瓣上标记那天。
- [ ] 短评作为 Review 在，中文没乱码。

`letterboxd-needs-check.csv` 里是**没有 IMDb 号**（照样导了，靠标题猜）和**没读到详情页**（没有导）的两类，`Why` 那一列分得开。

### Goodreads

My Books → Import and export → Import Books，上传 `goodreads.csv`。它是排队处理的，几分钟到几十分钟。

- [ ] 书对上了吗（ISBN 认准的是**这一版**，封面可能跟豆瓣上那版不同，这是对的）。
- [ ] 书架是 to-read / currently-reading / read 三者之一，跟豆瓣一致。
- [ ] **想读的书没有读完日期。**
- [ ] 短评在 My Review 里。

---

## 第 3 步 · 全量

小样确认没问题，才做这一步。

```sh
node bin/export.js ~/downloads/20260806-canonical /tmp/export-full
node tools/check-export.mjs ~/downloads/20260806-canonical /tmp/export-full   # 这次不带 --sample
```

**导到一个新目录，别覆盖小样那份。** 出了问题还得回去看当时传的到底是什么。

NeoDB 那边会跳过已经存在的记录（`created_time` 更新的那条赢），所以小样的 20 条不会变成重复条目。

---

## 出了问题怎么报

开 [issue](https://github.com/Doubak/doubak-export-adapters/issues)，带上：

1. `bin/export.js` 打出来的整段报告；
2. `tools/check-export.mjs` 的输出；
3. **出问题那一行的 CSV 原文**，以及它在对方那里变成了什么样（截图最好）。

CSV 原文可以这么取：

```sh
unzip -p /tmp/export-sample/neodb/neodb-import.zip movie_mark.csv | grep 34965089
```

> 这些文件里有你的短评、标签和豆瓣链接。贴之前留意一下——**定位问题靠的是那一行的形状，不是它的内容**，把评语替换成 `xxx` 完全不影响排查。

---

## 已知会「看起来不对」但其实是对的

这几条每次都会被当成 bug 报一次，所以先写在这里：

- **NeoDB 里的评分是豆瓣的两倍。** 它的评分是 1–10，豆瓣是 1–5 星。★★★★ → 8 是对的。
- **Letterboxd 和 Goodreads 的评分不换算。** 两边都是 1–5。
- **Goodreads 上的封面/出版社跟豆瓣不一样。** 匹配是按 ISBN 走的，ISBN 认的是那一个具体版本。
- **豆列没有导出。** NeoDB 的 CSV 导入里没有「收藏单」这一档，不是漏了。
- **3 篇日记没有导出。** 它们不挂在任何作品上，而 NeoDB 的笔记必须挂一个条目。
- **8 条标记的修订历史没了。** 三个平台都只收「现在是什么样」。历史还在 canonical 里——这也是**别把这几个 CSV 当成备份**的原因。
