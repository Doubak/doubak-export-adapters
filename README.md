# doubak-export-adapters

> **这是源码仓库。** 项目主页在 **<https://doubak.com>**。

豆备 (Doubak) 的对外导出适配器。把 [解析器](https://github.com/Doubak/doubak-data-parser) 产出的 **canonical** 转成 **NeoDB / Letterboxd / Goodreads** 的导入文件。

```sh
node bin/export.js <canonical 目录> [输出目录] [--target=…] [--sample=N]
node tools/check-export.mjs <canonical 目录> <导出目录>   # 上传前离线自查
npm test    # node --test，零依赖，不需要 npm install（85 个测试）
```

需要 Node ≥ 20。**不联网**——产出是几个文件，什么时候上传、上不上传，都不影响档案。

```sh
node bin/export.js ~/downloads/20260806-canonical ~/downloads/20260806-export
```

产出目录里除了几个 CSV 和一个 zip，还有一份 `怎么导入.md`，写着这一次的真实条数和每个平台的上传入口。

**第一次导之前请看 [`docs/manual-testing.md`](docs/manual-testing.md)。** 三个平台的导入都不好撤，所以流程是「`--sample=20` 切一小份 → 离线自查 → 真传一次看那 20 条 → 再导全量」。`--sample` 按 (分类, 状态) 轮着取，保证每一种组合都至少来一条——取前 N 条会拿到一堆同类的，验不了跨类的任何东西。

## 三个平台不是一回事

实测同一份真实档案（2945 条标记），三个平台能收下的差得很远：

| | 电影 | 剧集 | 图书 | 音乐 | 游戏 | 舞台剧 | 书评影评 | 豆列 | 标签 |
|---|---|---|---|---|---|---|---|---|---|
| **档案里有** | 1468 | 639 | 145 | 84 | 604 | 5 | 2 | 6 | ✅ |
| **NeoDB** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✖︎ | ✅ |
| **Letterboxd** | ✅ | ✖︎ | ✖︎ | ✖︎ | ✖︎ | ✖︎ | ✖︎ | ✖︎ | ✅ |
| **Goodreads** | ✖︎ | ✖︎ | ✅ | ✖︎ | ✖︎ | ✖︎ | ✖︎ | ✖︎ | 书架 |

一次真实导出的输出：

```
NeoDB  → neodb/neodb-import.zip
  标记 2945 条（book 145 · game 604 · movie 1468 · music 84 · performance 5 · tv 639）· 书评影评 2 篇
  ⚠ 8 条没读到详情页，分不出电影还是剧集，按电影处理
  ⚠ 7 条连豆瓣链接都没有（条目已被删），NeoDB 匹配不上
  ⚠ 3 篇长文不挂在作品上（日记），NeoDB 的 CSV 导入没有地方放
  · 豆列 6 份没有导出：NeoDB 的 CSV 导入里没有「收藏单」这一档

Letterboxd → letterboxd/
  看过 952 部 · 想看 508 部（含在看 0 部）
  跳过 剧集 639 · 非影视 838（Letterboxd 只收电影）
  ⚠ 8 条没读到详情页，分不清是电影还是剧集，没有导出
  ⚠ 34 部没有 IMDb 号，见 letterboxd-needs-check.csv
  ⚠ 4 条的标签里有逗号，Letterboxd 会按逗号拆成多个标签

Goodreads → goodreads/
  图书 145 本（读过 45 · 在读 18 · 想读 82）
```

**「导不出去的是什么、有多少」跟「导出去的是什么」一样是正式产出。** 三个平台没有一个能收下整份档案，一句「导出成功」等于什么也没说。

## NeoDB 不需要 API，也不需要谁批准

这个仓库原来叫 `doubak-neodb-adapter`，README 上写着「需要 NeoDB 维护者提供协助」。那是把 API 当成唯一入口时的判断。

NeoDB 还收一种**用户自己上传的 zip**（[`journal/importers/csv.py`](https://github.com/neodb-social/neodb/blob/main/neodb/journal/importers/csv.py)）：不用 OAuth、不用 key、没有速率限制、不需要任何人批准，而且**没有给这个项目新添一个活的外部依赖**。

后一点是硬约束，不是偏好：整个 doubak 的前提是「丢掉全部派生数据、离线重建」。一个要联网才能产出的导出器，等于把刚拆掉的依赖又装回去。

跟 NeoDB 的维护者打个招呼仍然值得，但那是礼貌和交换信息，不是前置条件。

## 列的形状是读源码定的，不是读文档定的

三个平台的导入格式都没有正式规格。这里的每一列都能指到一处出处：

| 目标 | 出处 |
|---|---|
| NeoDB | [`journal/importers/csv.py`](https://github.com/neodb-social/neodb/blob/main/neodb/journal/importers/csv.py) + [`base.py`](https://github.com/neodb-social/neodb/blob/main/neodb/journal/importers/base.py) + [`exporters/csv.py`](https://github.com/neodb-social/neodb/blob/main/neodb/journal/exporters/csv.py) |
| Letterboxd | [官方导入说明](https://letterboxd.com/about/importing-data/) + [`rwalle/douban-export`](https://github.com/rwalle/douban-export/blob/master/SPEC.md) 用过的列 |
| Goodreads | [`rwalle/douban-export`](https://github.com/rwalle/douban-export/blob/master/SPEC.md) 的 14 列（那个工具是真对着 Goodreads 跑过的） |

读源码读出来两件文档上没有的事，两件都是「按看起来对的写法会静默出错」：

- **NeoDB 的书评表，表头里有两个 `title`。** 不是笔误：它用 `csv.DictReader` 读，重复键后一个赢，所以 `row["title"]` 拿到的是第 5 列的**书评标题**，第 1 列的作品名压根不参与匹配。把它「修好」成一个 `title`，书评会全部变成无标题。
- **NeoDB 文件名里的分类不参与匹配。** `run()` 只拿分类去拼文件名，`import_mark` 从没看过这一行来自哪个文件——条目是靠 `links` 里的豆瓣链接定位的。所以「电影还是剧集」分错桶在 NeoDB 这边没有后果，**但文件名必须是那七个之一**，否则整张表根本不会被读。

## 豆瓣的「电影」里三成是剧集

实测 2107 个「电影」里 **638 个是剧集**。豆瓣把两者放在同一种 subject 下，canonical 忠实照抄；三个目标平台没有一个是这么分的。

判据是 `info` 里有没有 `集数` / `首播` / `季数`（实测覆盖 624 / 637 / 271，并集 638）——豆瓣的电影条目从不出现这三行。

**分错的代价两边不一样，所以处理方式也不一样：**

- NeoDB 那边没有代价（见上），分错桶照样匹配得上。
- Letterboxd 只收电影，一部剧集当电影送过去，最好的结果是匹配不上，最坏的结果是**匹配到一部同名电影**——于是用户的观影记录里凭空多出一部他没看过的片子。

所以**没读到详情页、分不出是哪种的，Letterboxd 一条都不送**，改列进 `letterboxd-needs-check.csv`。代价是详情页一张都没抓过的人会导出一个空文件，但那件事是真的，报告里会把条数说出来。

## 匹配全靠 IMDb 和 ISBN，中文标题帮不上忙

Letterboxd 和 Goodreads 的库里没有中文条目。`重返寂静岭` 匹配不到任何东西，`Return to Silent Hill` 能。

- **IMDb**：实测电影 1423/1465（97%）、剧集 589/638（92%）。
- **ISBN**：实测图书 **145/145**（豆瓣的图书详情页必带这一行）。三个平台里 Goodreads 的覆盖最干净。
- **标题**：解析器把豆瓣的 `<h1>` 存成 `中文名 / 原名`，实测 2107 部电影里 1779 部有原名。往外导取斜杠后面那半。

**导演那一列故意不写。** Letterboxd 允许用 Title + Year + Directors 做模糊匹配，但档案里的导演名是中文（`克里斯托夫·甘斯`），跟它库里的 `Christophe Gans` 对不上。给一个对不上的导演名，比不给更糟——它会把本来靠标题能猜中的那几条也否掉。

## 三处「宁可少送」

每一处都是「多送一条 = 替用户宣称一件没发生的事」：

- **Letterboxd 的看过和想看是两个文件**，两次上传。混在一起的话，508 部想看的片子会变成 508 条「看过但没写日期」的记录。
- **Goodreads 的 `Date Read` 只有「读过」才写。** 豆瓣的 `marked_at` 是**标记那一天**，不是读完那一天——想读的那 82 本也有日期。全写进去就是宣称用户读完了 82 本没读过的书。
- **没评分写空，不写 0。** 「没打分」和「打了 0 分」是两件事，豆瓣也从来没有 0 星。

「在看」三个平台都没有对应状态。Letterboxd 那边放进想看清单：不声称看过、不写日期、不写评分，是唯一不伪造事实的选项。

## 导出是有损的，损失的正是这个项目的卖点

canonical 里一条标记记的是**一串观测**：哪个版本的解析器、在什么时候、看见了什么。三个平台都只收「现在是什么样」，一条记录一行。所以这里做的事只有一件：**取最后一条 revision，其余全部丢掉。**

实测这份档案 2945 条标记里有 7 条带两次修订。数字小不代表可以不说——**恰恰因为小，用户不会自己发现**，所以报告里单列一行。

这是对外适配器该有的方向，但反过来是灾难：拿 NeoDB 的形状当储存格式，等于把版本历史、每字段摘要、回指 WARC 的 `capture_ids` 一次性删干净，而且不可逆。

## 还没做的

- **豆列 → NeoDB 的收藏单。** CSV 导入里没有这一档，Collection 只存在于 NeoDB 自己的 NDJSON 归档格式里，而那个格式要两遍扫描、要先解析出条目表，是它的内部实现细节。照着猜一个出来不如明说没做。同一个格式里的 `ShelfLog`（状态变更历史）是三个平台里唯一跟 canonical 的事件日志对得上的东西，值得再看。
- **没有一次真实的往返验证。** 这里能证明产出符合读源码读出来的格式，**不能证明三个平台真的收**。在有人拿一小批实际导进去之前，诚实的说法是「符合已记录的格式」，不是「能用」。做这件事的步骤写在 [`docs/manual-testing.md`](docs/manual-testing.md) 里，`--sample=20` 就是为它加的。
- Letterboxd 的 `Rewatch` 列没写——豆瓣不记重看。
- Goodreads 的 `Binding` 没写：豆瓣写「平装 / 精装」，Goodreads 要 `Paperback / Hardcover`，翻译得出来，但 ISBN 已经把版本钉死了，这一列只会在冲突时添乱。

## 零依赖

跟其余几个 JS 仓库一样：纯 ES 模块、JSDoc 类型、`node:test`、**零运行时和开发依赖、无构建步骤**。

连 zip 也是自己写的（`src/zip.js`，约 80 行，只用 `node:zlib`）。ZIP 的存储格式是 1989 年定死的、公开的、每个操作系统都自带解压——**它跟 WARC 是同一类东西：几段定长头，加上负载。** 判据是「别人的实现认不认」，所以测试里用系统的 `unzip -t` 校验，而不是只用自己写的解析器。
