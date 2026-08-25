# doubak-export-adapters

[![test](https://github.com/Doubak/doubak-export-adapters/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/Doubak/doubak-export-adapters/actions/workflows/test.yml?query=branch%3Amain) [![Coverage Status](https://coveralls.io/repos/github/Doubak/doubak-export-adapters/badge.svg?branch=main)](https://coveralls.io/github/Doubak/doubak-export-adapters?branch=main)

> **这是源码仓库。** 项目主页在 **<https://doubak.com>**。

豆备 (Doubak) 的对外导出适配器。把 [解析器](https://github.com/Doubak/doubak-data-parser) 产出的 **canonical** 转成 **NeoDB / Letterboxd / Goodreads** 的导入文件。

```sh
node bin/export.js <canonical 目录> [输出目录] [--target=…] [--sample=N] [--no-shelf-history]
node tools/check-export.mjs <canonical 目录> <导出目录>   # 上传前离线自查
node tools/check-roundtrip.mjs <导出目录> <NeoDB 导出的 zip>   # 导入后跟服务器对一遍
npm test    # node --test，零依赖，不需要 npm install（182 个测试）
```

`--target` 可选 `neodb`（NDJSON）、`neodb_csv`（旧的 CSV）、`letterboxd`、`goodreads`；
不写的话出前面三个，**`neodb_csv` 要显式要**。

需要 Node ≥ 20。**不联网**——产出是几个文件，什么时候上传、上不上传，都不影响档案。

```sh
node bin/export.js ~/downloads/20260806-canonical ~/downloads/20260806-export
```

产出目录里除了几个 CSV 和一个 zip，还有一份 `怎么导入.md`，写着这一次的真实条数和每个平台的上传入口。

**第一次导之前请看 [`docs/manual-testing.md`](docs/manual-testing.md)。** 三个平台的导入都不好撤，所以流程是「`--sample=20` 切一小份 → 离线自查 → 真传一次看那 20 条 → 再导全量」。`--sample` 按 (分类, 状态) 轮着取，保证每一种组合都至少来一条——取前 N 条会拿到一堆同类的，验不了跨类的任何东西。

## 三个平台不是一回事

实测同一份真实档案（2950 条标记），三个平台能收下的差得很远：

| | 电影 | 剧集 | 图书 | 音乐 | 游戏 | 舞台剧 | 书评影评 | 日记 | 豆列 | 状态历史 | 标签 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **档案里有** | 1470 | 641 | 145 | 84 | 605 | 5 | 2 | 3 | 6 | 3179 | ✅ |
| **NeoDB（NDJSON）** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **NeoDB（CSV）** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✖︎ | ✖︎ | ✖︎ | ✅ |
| **Letterboxd** | ✅ | ✖︎ | ✖︎ | ✖︎ | ✖︎ | ✖︎ | ✖︎ | ✖︎ | ✖︎ | ✖︎ | ✅ |
| **Goodreads** | ✖︎ | ✖︎ | ✅ | ✖︎ | ✖︎ | ✖︎ | ✖︎ | ✖︎ | ✖︎ | ✖︎ | 书架 |

「状态历史 3179」是**档案里有多少条**——3411 条广播里有这么多能对上一件作品。写进 zip 的是 **2519** 条，两个数都对：其中 1688 条并进了 NeoDB 导标记时自己就会建的那一行（补上当天的星和短评），另外 657 条广播既没星也没字，整条略过。详见下面「标记自己就会生成一条历史」。游戏那一列同理：档案里 605 个，导出 598 个，差的 7 个是豆瓣已经删掉、连链接都没留下的。

一次真实导出的输出：

```
NeoDB  → neodb/neodb-ndjson-import.zip  (NDJSON)
  标记 2943 条（book 145 · performance 5 · game 598 · movie 1470 · tv 641 · music 84）· 评分 1788 · 短评 2110
  标签 712 个（贴了 7222 次）· 书评影评 2 篇 · 笔记 0 篇
  豆列 6 份（73 条） · 不挂作品的日记 3 篇 · 条目 2979 个
  状态历史 2519 条（从广播还原，豆瓣自己已经不显示了）
  · 其中 1688 条是并进标记那一行的（标记本身那件事，NeoDB 导标记时自己就会建一行，我们只把当时的星和短评补上去）
  · 另有 657 条广播什么都没冻住（没星也没字），整条略过
  ⚠ 8 条没读到详情页，分不出电影还是剧集，按电影处理
  ⚠ 7 条连豆瓣链接都没有（条目已被豆瓣删除），没有放进 zip——见 neodb-needs-check.csv
  ⚠ 8 条没有标记日期，这几条不写 published
  ⚠ 豆列里有 61 条不是作品条目（影评/小组/人物/照片…），收藏单装不下

Letterboxd → letterboxd/
  看过 953 部 · 想看 509 部（含在看 0 部）
  跳过 剧集 641 · 非影视 839（Letterboxd 只收电影）
  ⚠ 8 条没读到详情页，分不清是电影还是剧集，没有导出
  ⚠ 34 部没有 IMDb 号，见 letterboxd-needs-check.csv
  ⚠ 4 条的标签里有逗号，Letterboxd 会按逗号拆成多个标签

Goodreads → goodreads/
  图书 145 本（读过 45 · 在读 18 · 想读 82）
```

**「导不出去的是什么、有多少」跟「导出去的是什么」一样是正式产出。** 三个平台没有一个能收下整份档案，一句「导出成功」等于什么也没说。

## NeoDB 那一路现在出 NDJSON，CSV 降成 `--target=neodb_csv`

NeoDB 的维护者在 Discord 上说得很直接：

> 可以生成NDJSON吗？旧的CSV格式只是为了兼容NiceDB和Doufen，限制太多了。

也就是说 CSV 不只是「旧」——它是为了兼容另外两个工具留下的一层壳。NDJSON 是 NeoDB 自己导出、自己导入的格式，装得下 CSV **结构上装不下**的四样东西：**豆列**、**不挂作品的日记**、**每条记录各自的可见性**，以及**状态历史**。

最后一样才是真正要紧的。豆瓣只存当前状态，**但广播是发出去那一刻就冻住的**，所以 3411 条广播里藏着一条 想看 → 在看 → 看过 的时间线，还带着当时打的星。实测 2373 个作品有这样的历史，其中 **678 个状态变过不止一次**——这是豆瓣自己都不再保留的东西。**默认就带上**（2026-08-25 起；`--no-shelf-history` 关掉）。翻默认的理由是代价不对称：不带走就是**永久丢掉**——豆瓣自己已经不留这段历史了，而写错的代价是 NeoDB 上多几行日期不对的 `ShelfLog`，不动标记、不发时间线、也不联邦，而且 `import_shelf_log` 是幂等的。这不是「测试够了所以放心」——测试只能圈住想得到的错法，而 8-24 那个撞行的 bug 恰恰是没想到的那种，本地全绿。是**默认关着反而让证据来得更慢**：下一个用户得先知道有这个开关，才会产出第二份能验的档案。

CSV 那一份没删，只是要显式要。它现在只有两个地方比 NDJSON 强，两个都写在下面的「NDJSON 换来的两处倒退」里。

### 两处倒退，说清楚

- **没有 ISBN / IMDb 的 `info` 兜底。** `parse_catalog` 调的是 `get_item_by_info_and_links("", "", links)`——标题空、info 空，**只靠 URL 匹配**。CSV 那边 `info` 列里的 `isbn:` 还能找回一本豆瓣页面已经没了的书，这边不能。IMDb 有 URL 形式（写进 `external_resources`），ISBN 没有。
- **上传页面上没有可见性选项。** `data.html` 里检测到 ndjson 就把那三个单选框整个隐藏，于是 `request.POST.get("visibility", 0)` 恒为 0，全部按公开导入。所以这个选择挪进了文件里：`--visibility=1`（仅关注者）/ `2`（仅提及者）。

### `content.updated`：第二次导入能不能认出「你改过了」

上游 2026-08-23 给 NDJSON 加了 `content.updated`，`_is_current` 优先拿它跟目标的 `edited_time` 比，比不出来才退回 `created_time` vs `published`。

**退回去那条路对豆瓣是错的**：`marked_at` 是「标记那天」，改短评根本不动它。所以第一次导完之后，在豆瓣改了短评、重新抓一份、再导一次——`published` 没变，目标的 `created_time` 正好等于它，`_is_current` 判定「目标已经是最新的」，**这次编辑一声不吭地不生效**。

canonical 恰好能答对，而且大概是唯一能答对的：一条 revision 是在**字段摘要变了**的时候才产生的，所以从最新那条往回走、只要摘要没变就继续走，走到头那条的 `first_observed_at` 就是「这份内容最早被看见」的时刻——正是 `updated` 要的语义。**不能用 `last_observed_at`**，它每抓一次就变，等于宣称每条记录每次都被编辑过。

**按字段判，不按整条记录判。** 一条标记的 revision 只要任意字段变了就会新增，拿整条记录的时间当短评的 `updated`，会在只改了评分的时候谎称短评也编辑过。摘要本来就是按字段存的。实测这份档案 8 条多修订的标记里，有 2 条的三个 `updated` 不全相同——比如 `movie/30284835` 只改过短评，于是短评是 8-20 而状态和评分停在 7-31。

只写那七种真的会读它的记录（Collection / ShelfMember / Article / Review / Note / Comment / Rating）。`Tag` / `TagMember` / `ShelfLog` 的 `import_*` 根本不看这个键。

顺带查出来一个真 bug：**豆列的 `published` 原先取的是「最后一次观测」**，而 `import_collection` 认收藏单靠 `(owner, title, created_time)`，`created_time` 就是 `published`。每导一次都变的话，第二次导入认不出第一次那份，会直接新建一个同名收藏单。改成取最早那次——一条豆列被看见过一回之后就再也不会变。

### 标记自己就会生成一条历史

**这一条是真的导进 neodb.social 之后才看见的，本地测试到不了那个上下文。**

`import_shelf_member` 走 `Mark.update`，里面 `ensure_log_entry()` 会按 `(owner, shelf_type, item, created_time)` 自己建一条 `ShelfLogEntry`，`_update_log_entry` 再把标记**当前**的星和短评写进去。也就是说「作品现在这个状态」那件事，NeoDB 本来就有一行。

而豆瓣的 `marked_at` **只有日期**（实测 2942 条全是 `+08:00` 的 `00:00:00`），广播带的是真实时刻，两者永远不相等——`ShelfLogEntry` 的唯一键里有 `timestamp`，于是同一件事排成两行：

```
July 20, 2023 在读   总算添加上来了，这个版本是澳洲出版的
July 20, 2023 在读   总算添加上来了，这个版本是澳洲出版的
```

跨天的时候更难看：`00:00+08:00` 和当晚 `22:38+08:00` 渲染到 `+10` 的时区就成了两个日期，读起来像隔天又标了一次。

所以对得上标记那件事的广播（同状态 + 同一天）**不另开一行**，而是写成标记那个时间戳，让 `update_or_create` 正好落到同一行上，把广播冻住的那颗星和那段短评补进去。实测 40 条样本的 54 条历史里 38 条是这样，全量 3174 条里 **2345 条**——四分之三。

两个跟着来的细节，都是「不写反而更安全」：

- `defaults={"metadata": …}` 是**整块覆盖**，不是合并。只冻住一颗星的广播并上去，会把 `_update_log_entry` 刚写进那一行的短评一起抹掉，所以拿标记当前的值垫底、广播的值盖在上面。
- 广播什么都没冻住（没星也没字）就整条不写：那一行 NeoDB 已经有了，而且比我们全。少写一行不丢东西，写一行空的会。

### 从服务器把数据导回来对一遍

`check-export.mjs` 问的是「要传上去的这堆文件跟档案对得上吗」，两边都是我们自己写的，**同一个 bug 会同时出现在两边**。上面那个撞行的问题，本地测试全绿，是导进去才看见的。

所以有第二个校验器，问的是另一个问题：**传上去之后，服务器那边真的存成了我们写的样子吗。**

```sh
node tools/check-roundtrip.mjs <我们的导出目录或 zip> <NeoDB 导出的 zip>
```

NeoDB 的导出在「设置 → 数据 → 导出」，出来的是同一套 NDJSON。判据两条：我们写的每一条服务器上都要有、且一个字不差；服务器**多出来**的状态历史，每一条都要能解释成「某条标记自己那件事」——解释不了的那一行，多半就是我们把一件事写成了两行。

2026-08-25 跑了两次，40 条那份和**全量那份**（17305 条记录进去 0 失败，服务器导回来 18560 条）：

```
条目             我们  2979 个 · 服务器 2979 个 · 对上 2979 个
标记             我们  2943 条 · 对上 2943 条
                      其中 8 条档案里没有标记日期，服务器拿导入那一刻当日期（不比日期）
评分             我们  1788 条 · 对上 1788 条
短评             我们  2110 条 · 对上 2110 条
标签             我们   712 条 · 对上 712 条
标签关联         我们  7222 条 · 对上 7222 条
书评影评         我们     2 条 · 对上 2 条
不挂作品的日记   我们     3 条 · 对上 3 条
豆列             我们     6 份 · 对上 6 份
状态历史         我们  2519 条 · 对上 2519 条 · 服务器自己建的 1255 条（导标记时顺带的）
                      多出来的 1255 条都对得上标记本身那件事，没有一条是重复的
```

两边的条数是**能对平的**：18560 − 17305 = 1255 = 1247 条（标记那天没有广播）+ 8 条（档案里就没有标记日期，服务器拿导入那一刻建的行）。修之前 40 条那份会撞出 38 条重复；现在全量一条也没有。私密那份豆列存回来还是私密的（`visibility` 2）。

三个用它的时候要知道的：

- **`visibility` 为 0 时我们整个键都不写**，服务器导回来是 0——`import_*` 一律 `data.get("visibility", 0)`。这一条本来是从源码读出来的，现在有实测了。
- **没有标记日期的那 8 条只报一行说明，不进错误列表。** 我们故意不写 `published`（编一个日期出来就是替用户宣称他那天标记过），服务器于是拿导入那一刻当日期，日期必然对不上，而且永远修不掉。这类条目留在错误列表里，就成了**一个永远有内容的失败清单——也就是一个没人看的失败清单**，8 条足够盖住第 9 条真的问题。同样的道理，那 8 条附带的历史行也算「解释得通」。
- **NeoDB 导出的 `actor.ndjson` 里有那个身份的私钥。** 别把这份 zip 提交进仓库、贴进 issue，或者留下来当测试样本。所以 `test/check-roundtrip.test.js` 里那份「服务器」是**照着导入器的行为现造的**，不是真实导出——它顺带把「每条标记都会附带生成一行历史」写成了可执行的断言，哪天我们不再并行，那个测试立刻红。

### 五个静默的坑

形状全部是读 [`journal/importers/ndjson.py`](https://github.com/neodb-social/neodb/blob/main/neodb/journal/importers/ndjson.py) 定的。下面每一个写错了都照样是合法 JSON、照样解析通过、照样不报错：

1. **`ShelfLog` 的形状跟其他记录都不一样**——它读顶层的 `item` / `status` / `timestamp`，不是 `content.withRegardTo` / `content.status` / `content.published`。
2. **`ShelfMember` 上没有标签这一项。** CSV 是把标签挤在标记那一行里的，NDJSON 不从那儿读；不单独出 `Tag` + `TagMember`，换个格式就等于丢掉 712 个标签。
3. **`progress` 是三态的**：键不在 = 不动，`null` = **清掉用户手工填的进度**，有值 = 恢复。豆瓣不记进度，所以这个键整个不写。
4. **舞台剧的广播 `target_type` 叫 `loc`，不叫 `drama`。** 12 种取值里根本没有 `drama`。
5. **豆列里分类 `3114`、写成 `www.douban.com/subject/<id>/` 的其实是游戏**，而 `DoubanGame.URL_PATTERNS` 只认 `www.douban.com/game/<id>/`。改写是量出来的：31 条 id 在档案里的条目里 30 条是游戏，且档案里存的 URL 全是 `/game/`。

前三条有一个静态契约测试盯着（`test/neodb-ndjson.test.js` 里那张从导入器源码抄下来的表）：真正会出事的环境是一个跑着的 NeoDB，这边任何测试都进不去，所以检查只能是静态的，而且必须断言它真的扫到了东西。把生成器改成用错的形状写 `ShelfLog`，会有 7 个测试变红——所以它不是空转的。

### 跟 CSV 那一路对一遍

两份产物各自都跟 canonical 对过了，但那不能代替互相对：**CSV 是唯一做过真实往返的路**（2026-08-20，42 条进去 41 条），所以它是「已知好的」那一份，NDJSON 跟它不一致的地方就是「一个验证过的行为被换格式换掉了」。

实测拿新的 NDJSON 对 2026-08-20 **真的导进去过的那份 CSV**：作品 2943 对 2943，状态 / 评分 / 短评 / 标签 / 分类 / IMDb 链接逐条逐字段一致，两篇书评的标题和正文一致，`neodb-needs-check.csv` 逐字节一致。

这件事现在是常驻的，不是一次性的：

- `tools/check-export.mjs` 在同时看到 `neodb/` 和 `neodb_csv/` 两个目录时会自动多跑一遍互相对比（`--target=neodb,neodb_csv` 就有）。
- `test/neodb-ndjson.test.js` 对着 fixture 跑同一件事，所以改坏了 `npm test` 就红。

有一处要说清楚：**分类那一项证明得比看起来少。** 两条路都调同一个 `classify()`，所以它们一致只证明 `AP_TYPE` 那张表跟七个 CSV 文件名是对得上的，**不证明电影/剧集分对了**。一个不可能失败的检查，对它「本以为在检查的那件事」什么也没证明。

### 三件故意不做的

- **不出 `actor.ndjson`。** `process_actor` 会拿归档里的名字和简介覆盖目标账号的身份——一次导入的副作用不该是「你的昵称变了」。
- **不出 `attachments/`。** 图片字节在 WARC 里，这个工具只读 canonical 而且不联网。长文正文里的图片链接原样留着，指向豆瓣的图床。
- **不写 `posts`。** 上游的 `import_post` 是个空函数，广播变不成嘟文。

## NeoDB 不需要 API，也不需要谁批准

这个仓库原来叫 `doubak-neodb-adapter`，README 上写着「需要 NeoDB 维护者提供协助」。那是把 API 当成唯一入口时的判断。

NeoDB 还收一种**用户自己上传的 zip**（[`journal/importers/csv.py`](https://github.com/neodb-social/neodb/blob/main/neodb/journal/importers/csv.py)）：不用 OAuth、不用 key、没有速率限制、不需要任何人批准，而且**没有给这个项目新添一个活的外部依赖**。

后一点是硬约束，不是偏好：整个 doubak 的前提是「丢掉全部派生数据、离线重建」。一个要联网才能产出的导出器，等于把刚拆掉的依赖又装回去。

跟 NeoDB 的维护者打个招呼仍然值得，但那是礼貌和交换信息，不是前置条件。

**上游那半边现在也在做，而这边不依赖它。** 有两个 PR 往 NeoDB 提了一个 `DoubakImporter`，它们是**二选一**：

| PR | 读什么 | 状态 |
|---|---|---|
| [neodb#1810](https://github.com/neodb-social/neodb/pull/1810) | NDJSON | 开着，CI 全绿，推荐的那一个 |
| [neodb#1801](https://github.com/neodb-social/neodb/pull/1801) | 旧的那套 CSV | 开着，留作对照 |

它们加的是**「覆盖」模式**：`NdjsonImporter` 只有合并一种行为，而豆瓣给标记盖的是「标记那天」、之后编辑不动它，所以档案里的记录常常显得比它本该替换掉的那条更旧——一个本来就在 NeoDB 上手动标记的用户导入自己的豆瓣档案，所有重叠的记录都会被跳过。

**两个 PR 都没合，也不影响这个工具。** 产出的 zip 走的是 NeoDB **现有的**「导入 NeoDB 备份」入口，今天就能用——上面那份公开账号就是这么导进去的。PR 加的是选择权，不是可用性。

## 列的形状是读源码定的，不是读文档定的

三个平台的导入格式都没有正式规格。这里的每一列都能指到一处出处：

| 目标 | 出处 |
|---|---|
| NeoDB（NDJSON） | [`journal/importers/ndjson.py`](https://github.com/neodb-social/neodb/blob/main/neodb/journal/importers/ndjson.py) + [`exporters/ndjson.py`](https://github.com/neodb-social/neodb/blob/main/neodb/journal/exporters/ndjson.py) + 各 model 的 `ap_object` + `users/templates/users/data.html` 里那段格式检测 |
| NeoDB（CSV） | [`journal/importers/csv.py`](https://github.com/neodb-social/neodb/blob/main/neodb/journal/importers/csv.py) + [`base.py`](https://github.com/neodb-social/neodb/blob/main/neodb/journal/importers/base.py) + [`exporters/csv.py`](https://github.com/neodb-social/neodb/blob/main/neodb/journal/exporters/csv.py) |
| Letterboxd | [官方导入说明](https://letterboxd.com/about/importing-data/) + [`rwalle/douban-export`](https://github.com/rwalle/douban-export/blob/master/SPEC.md) 用过的列 |
| Goodreads | [`rwalle/douban-export`](https://github.com/rwalle/douban-export/blob/master/SPEC.md) 的 14 列（那个工具是真对着 Goodreads 跑过的） |

读源码读出来两件文档上没有的事，两件都是「按看起来对的写法会静默出错」：

- **NeoDB 的书评表，表头里有两个 `title`。** 不是笔误：它用 `csv.DictReader` 读，重复键后一个赢，所以 `row["title"]` 拿到的是第 5 列的**书评标题**，第 1 列的作品名压根不参与匹配。把它「修好」成一个 `title`，书评会全部变成无标题。
- **NeoDB 文件名里的分类不参与匹配。** `run()` 只拿分类去拼文件名，`import_mark` 从没看过这一行来自哪个文件——条目是靠 `links` 里的豆瓣链接定位的。所以「电影还是剧集」分错桶在 NeoDB 这边没有后果，**但文件名必须是那七个之一**，否则整张表根本不会被读。

## 豆瓣的「电影」里三成是剧集

实测 2111 个「电影」里 **641 个是剧集**。豆瓣把两者放在同一种 subject 下，canonical 忠实照抄；三个目标平台没有一个是这么分的。

判据是 `info` 里有没有 `集数` / `首播` / `季数`（实测覆盖 627 / 640 / 273，并集 641）——豆瓣的电影条目从不出现这三行。

**分错的代价两边不一样，所以处理方式也不一样：**

- NeoDB 那边没有代价（见上），分错桶照样匹配得上。
- Letterboxd 只收电影，一部剧集当电影送过去，最好的结果是匹配不上，最坏的结果是**匹配到一部同名电影**——于是用户的观影记录里凭空多出一部他没看过的片子。

所以**没读到详情页、分不出是哪种的，Letterboxd 一条都不送**，改列进 `letterboxd-needs-check.csv`。代价是详情页一张都没抓过的人会导出一个空文件，但那件事是真的，报告里会把条数说出来。

### 电影/剧集的判据：跟 NeoDB 的目录对了一遍全量

小样（n=14）那次两边**完全一致**，当时把它当成了判据可靠的证据。全量跑完发现那是样本太小：**2111 条影视里 25 条不一致**（净差 3——我们 movie 1470 / tv 641，NeoDB movie 1473 / tv 638）。98.8% 一致比「14 条全对」有用得多，但那 25 条得说清楚，因为它们分三类：

- **3 条根本没读到详情页**，没有判据可用，默认按电影处理。这一类是已知的，本来就不进 Letterboxd，也已经写在 `letterboxd-needs-check.csv` 里——机制是生效的。
- **8 条有详情页，但三行一行都没有**：黑镜：圣诞特别篇、进击的巨人 最终季 完结篇、超感猎杀：完结特别篇、奇蛋物语 特别篇、死后文 未放送话…… 全部是**电视特别篇 / OVA**。豆瓣用电影模板渲染它们，NeoDB（走 TMDB）把它们归到母剧集下面。两边都说得通，但对 Letterboxd 来说我们这一边更危险。
- **14 条有那一行、我们判剧集而 NeoDB 判电影**，而这一桶里两边都有错：鬼灭之刃：无限列车篇、刺客信条、疯狂的麦克斯5：废土 是电影，豆瓣页面上却有「首播」；边境安全：澳洲、中国奇谭、四驱兄弟 是不折不扣的剧集，被 NeoDB 归成了电影。

**两个目录都不是权威，所以「对不上」不等于「我们错了」。** 判据本身站得住，变的是它能支撑多大的结论。

## 匹配全靠 IMDb 和 ISBN，中文标题帮不上忙

Letterboxd 和 Goodreads 的库里没有中文条目。`重返寂静岭` 匹配不到任何东西，`Return to Silent Hill` 能。

- **IMDb**：实测电影 1428/1470（97%）、剧集 592/641（92%）。
- **ISBN**：实测图书 **145/145**（豆瓣的图书详情页必带这一行）。三个平台里 Goodreads 的覆盖最干净。
- **标题**：解析器把豆瓣的 `<h1>` 存成 `中文名 / 原名`，实测 2111 部电影里 1782 部有原名。往外导取斜杠后面那半。

**导演那一列故意不写。** Letterboxd 允许用 Title + Year + Directors 做模糊匹配，但档案里的导演名是中文（`克里斯托夫·甘斯`），跟它库里的 `Christophe Gans` 对不上。给一个对不上的导演名，比不给更糟——它会把本来靠标题能猜中的那几条也否掉。

## 三处「宁可少送」

每一处都是「多送一条 = 替用户宣称一件没发生的事」：

- **Letterboxd 的看过和想看是两个文件**，两次上传。混在一起的话，509 部想看的片子会变成 509 条「看过但没写日期」的记录。
- **Goodreads 的 `Date Read` 只有「读过」才写。** 豆瓣的 `marked_at` 是**标记那一天**，不是读完那一天——想读的那 82 本也有日期。全写进去就是宣称用户读完了 82 本没读过的书。
- **没评分写空，不写 0。** 「没打分」和「打了 0 分」是两件事，豆瓣也从来没有 0 星。

「在看」三个平台都没有对应状态。Letterboxd 那边放进想看清单：不声称看过、不写日期、不写评分，是唯一不伪造事实的选项。

## 导出是有损的，损失的正是这个项目的卖点

canonical 里一条标记记的是**一串观测**：哪个版本的解析器、在什么时候、看见了什么。三个平台都只收「现在是什么样」，一条记录一行。所以这里做的事只有一件：**取最后一条 revision，其余全部丢掉。**

实测这份档案 2950 条标记里有 8 条带多次修订。数字小不代表可以不说——**恰恰因为小，用户不会自己发现**，所以报告里单列一行。

这是对外适配器该有的方向，但反过来是灾难：拿 NeoDB 的形状当储存格式，等于把版本历史、每字段摘要、回指 WARC 的 `capture_ids` 一次性删干净，而且不可逆。

## 还没做的

- **Letterboxd 和 Goodreads 还没做过真实往返验证。** 那两家目前能证明的只是「产出符合读源码/读文档读出来的格式」，不是「对方真的收」。步骤在 [`docs/manual-testing.md`](docs/manual-testing.md)，`--sample=N` 就是为它加的。

  **NeoDB 这一路已经验过了**（2026-08-20，40 条小样）：42 条记录进去 41 条，唯一那次失败是没有豆瓣链接的一条，现在已经不进 zip。逐项核对过标记的状态、评分（豆瓣 1–5 星 → NeoDB 1–10 分）、短评、标签、标记日期，以及两篇书评**带着标题**——最后这一条最要紧，它是「重复表头后一个赢」那个判断的唯一实证。

  顺带得到一次外部旁证：NeoDB 的分类是它自己按条目重新判的（文件名不参与匹配），所以拿它的书架跟我们的对，是那条 `集数`/`首播`/`季数` 判据**唯一的外部证据**。注意它证明的不是「我们分对了桶」——就算把两个桶对调，NeoDB 那边的书架也一样是对的。全量的结果见上面「电影/剧集的判据」那一节。

  **NDJSON 那一路验到全量了**（2026-08-25）：先 40 条小样带状态历史，285 条记录进去 0 失败；同日全量 **17305 条进去 0 失败**，再从服务器导出来逐字段对，2979 个条目、每一类记录一条不差、2519 条状态历史原样。结果是公开的，可以自己点进去看：

  **<https://neodb.social/users/immewx/>** —— 整份档案导进去之后长什么样。

  ```
  想看/想读/想玩 1098 · 在看/在读/在玩 71 · 看过/读过/玩过 1774
  电影 1473 · 剧集 638 · 游戏 598 · 图书 145 · 音乐 84 · 舞台剧 5
  ```

  （那里的电影/剧集是 **NeoDB 自己判的**，跟我们判的差 25 条——见上面那一节。另一个账号 <https://neodb.social/users/doubak/> 留着不动，那是 CSV 那一路的干净证据，PR #1801 里引用过。）
- ~~豆列成员的短评没验证过~~ —— **已确认，2026-08-24。** `ItemList.append_item` 的 docstring 说具名字段要直接传、不要塞进 `metadata` dict，看着像是这条路走不通。但 NeoDB 自己的测试 `test_ndjson_member_note_edit_reindexes_collection` 就是拿 `append_item(item, metadata={"note": …})` 写进去、再读出 `member.note` 的——所以 `metadata` 这条路是它自己在用的那条。读 docstring 会得出相反的结论，又一次。
- Letterboxd 的 `Rewatch` 列没写——豆瓣不记重看。
- Goodreads 的 `Binding` 没写：豆瓣写「平装 / 精装」，Goodreads 要 `Paperback / Hardcover`，翻译得出来，但 ISBN 已经把版本钉死了，这一列只会在冲突时添乱。

## 零依赖

跟其余几个 JS 仓库一样：纯 ES 模块、JSDoc 类型、`node:test`、**零运行时和开发依赖、无构建步骤**。

连 zip 也是自己写的（`src/zip.js`，约 80 行，只用 `node:zlib`）。ZIP 的存储格式是 1989 年定死的、公开的、每个操作系统都自带解压——**它跟 WARC 是同一类东西：几段定长头，加上负载。** 判据是「别人的实现认不认」，所以测试里用系统的 `unzip -t` 校验，而不是只用自己写的解析器。
