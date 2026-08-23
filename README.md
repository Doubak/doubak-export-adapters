# doubak-export-adapters

[![test](https://github.com/Doubak/doubak-export-adapters/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/Doubak/doubak-export-adapters/actions/workflows/test.yml?query=branch%3Amain) [![Coverage Status](https://coveralls.io/repos/github/Doubak/doubak-export-adapters/badge.svg?branch=main)](https://coveralls.io/github/Doubak/doubak-export-adapters?branch=main)

> **这是源码仓库。** 项目主页在 **<https://doubak.com>**。

豆备 (Doubak) 的对外导出适配器。把 [解析器](https://github.com/Doubak/doubak-data-parser) 产出的 **canonical** 转成 **NeoDB / Letterboxd / Goodreads** 的导入文件。

```sh
node bin/export.js <canonical 目录> [输出目录] [--target=…] [--sample=N] [--shelf-history]
node tools/check-export.mjs <canonical 目录> <导出目录>   # 上传前离线自查
npm test    # node --test，零依赖，不需要 npm install（160 个测试）
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

一次真实导出的输出：

```
NeoDB  → neodb/neodb-ndjson-import.zip  (NDJSON)
  标记 2943 条（book 145 · performance 5 · game 598 · movie 1470 · tv 641 · music 84）· 评分 1788 · 短评 2110
  标签 712 个（贴了 7222 次）· 书评影评 2 篇 · 笔记 0 篇
  豆列 6 份（73 条） · 不挂作品的日记 3 篇 · 条目 2979 个
  状态历史 3179 条（从广播还原，豆瓣自己已经不显示了）
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

NeoDB 的维护者在 [PR 里](https://github.com/neodb-social/neodb/pull/1801)说得很直接：

> 厉害。可以生成NDJSON吗？旧的CSV格式只是为了兼容NiceDB和Doufen，限制太多了。

也就是说 CSV 不只是「旧」——它是为了兼容另外两个工具留下的一层壳。NDJSON 是 NeoDB 自己导出、自己导入的格式，装得下 CSV **结构上装不下**的四样东西：**豆列**、**不挂作品的日记**、**每条记录各自的可见性**，以及**状态历史**。

最后一样才是真正要紧的。豆瓣只存当前状态，**但广播是发出去那一刻就冻住的**，所以 3411 条广播里藏着一条 想看 → 在看 → 看过 的时间线，还带着当时打的星。实测 2373 个作品有这样的历史，其中 **678 个状态变过不止一次**——这是豆瓣自己都不再保留的东西。加 `--shelf-history` 带上（默认不带，因为它是最新的一条路，还没有真实往返验证过）。

CSV 那一份没删，只是要显式要。它现在只有两个地方比 NDJSON 强，两个都写在下面的「NDJSON 换来的两处倒退」里。

### 两处倒退，说清楚

- **没有 ISBN / IMDb 的 `info` 兜底。** `parse_catalog` 调的是 `get_item_by_info_and_links("", "", links)`——标题空、info 空，**只靠 URL 匹配**。CSV 那边 `info` 列里的 `isbn:` 还能找回一本豆瓣页面已经没了的书，这边不能。IMDb 有 URL 形式（写进 `external_resources`），ISBN 没有。
- **上传页面上没有可见性选项。** `data.html` 里检测到 ndjson 就把那三个单选框整个隐藏，于是 `request.POST.get("visibility", 0)` 恒为 0，全部按公开导入。所以这个选择挪进了文件里：`--visibility=1`（仅关注者）/ `2`（仅提及者）。

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

- **还没写 `content.updated`，而这是个会静默出错的缺口。** 上游 2026-08-23 给 NDJSON 加了这个字段，`_is_current` 优先拿它跟目标的 `edited_time` 比。我们一个字没写，于是退回「`created_time` vs `published`」——而豆瓣的 `marked_at` 是**标记那天**，改短评不会动它。所以第一次导完之后，在豆瓣改了短评、重新抓、再导一次：`published` 没变，目标的 `created_time` 等于它，**这次编辑一声不吭地不生效**。

  canonical 恰好能答对：一条 revision 是在**字段摘要变了**的时候才产生的，所以最新那条 revision 的 `first_observed_at` 就是「这份内容最早被看见」的时刻，正是 `updated` 要的语义。用 `last_observed_at` 是错的——每次抓取都会变，等于宣称每条都改过。

- **NDJSON 那一路还没做过真实往返验证。** 离线能证明的只是「产出符合从导入器源码里读出来的格式」，不是「对方真的收」。CSV 那一路验过（下面那条），NDJSON 没有。**状态历史尤其没有**——它是全新的一条路，所以默认关着。
- **Letterboxd 和 Goodreads 还没做过真实往返验证。** 那两家目前能证明的只是「产出符合读源码/读文档读出来的格式」，不是「对方真的收」。步骤在 [`docs/manual-testing.md`](docs/manual-testing.md)，`--sample=N` 就是为它加的。

  **NeoDB 这一路已经验过了**（2026-08-20，40 条小样）：42 条记录进去 41 条，唯一那次失败是没有豆瓣链接的一条，现在已经不进 zip。逐项核对过标记的状态、评分（豆瓣 1–5 星 → NeoDB 1–10 分）、短评、标签、标记日期，以及两篇书评**带着标题**——最后这一条最要紧，它是「重复表头后一个赢」那个判断的唯一实证。

  顺带得到一次外部旁证：NeoDB 的分类是它自己按条目重新判的（文件名不参与匹配），而它判出来的 movie 6 / tv 8 跟这边按 `集数`/`首播`/`季数` 判的**完全一致**（n=14）。这是那条判据目前唯一的外部证据。注意它证明的不是「我们分对了桶」——就算把两个桶对调，NeoDB 那边的书架也一样是对的。
- ~~豆列成员的短评没验证过~~ —— **已确认，2026-08-24。** `ItemList.append_item` 的 docstring 说具名字段要直接传、不要塞进 `metadata` dict，看着像是这条路走不通。但 NeoDB 自己的测试 `test_ndjson_member_note_edit_reindexes_collection` 就是拿 `append_item(item, metadata={"note": …})` 写进去、再读出 `member.note` 的——所以 `metadata` 这条路是它自己在用的那条。读 docstring 会得出相反的结论，又一次。
- Letterboxd 的 `Rewatch` 列没写——豆瓣不记重看。
- Goodreads 的 `Binding` 没写：豆瓣写「平装 / 精装」，Goodreads 要 `Paperback / Hardcover`，翻译得出来，但 ISBN 已经把版本钉死了，这一列只会在冲突时添乱。

## 零依赖

跟其余几个 JS 仓库一样：纯 ES 模块、JSDoc 类型、`node:test`、**零运行时和开发依赖、无构建步骤**。

连 zip 也是自己写的（`src/zip.js`，约 80 行，只用 `node:zlib`）。ZIP 的存储格式是 1989 年定死的、公开的、每个操作系统都自带解压——**它跟 WARC 是同一类东西：几段定长头，加上负载。** 判据是「别人的实现认不认」，所以测试里用系统的 `unzip -t` 校验，而不是只用自己写的解析器。
