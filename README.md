# doubak-export-adapters

[![test](https://github.com/Doubak/doubak-export-adapters/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/Doubak/doubak-export-adapters/actions/workflows/test.yml?query=branch%3Amain) [![Coverage Status](https://coveralls.io/repos/github/Doubak/doubak-export-adapters/badge.svg?branch=main)](https://coveralls.io/github/Doubak/doubak-export-adapters?branch=main)

> **本仓库为项目源码。** 项目官方主页请访问 **<https://doubak.com>**。

豆备（Doubak）的对外数据导出适配器。负责将 [解析器（doubak-data-parser）](https://github.com/Doubak/doubak-data-parser) 产出的标准 **canonical** 数据转换为面向 **NeoDB、Letterboxd 与 Goodreads** 的导入文件。

```sh
node bin/export.js <canonical 目录> [输出目录] [--target=…] [--sample=N] [--no-shelf-history]
#              [--visibility=0|1|2] [--notes-visibility=0|1|2] [--unknown-visibility=0|1|2]
node tools/check-export.mjs <canonical 目录> <导出目录>       # 导入前的离线自检
node tools/check-roundtrip.mjs <导出目录> <NeoDB 导出的 zip>  # 导入后与服务端导出数据的比对核验
npm test                                                     # 运行测试套件（使用 Node 内置 test runner，零外部依赖）
```

- `--target`：可选 `neodb`（推荐的 NDJSON 格式）、`neodb_csv`（旧版 CSV 格式）、`letterboxd`、`goodreads`；若未显式指定，默认同时产出 `neodb`、`letterboxd` 与 `goodreads`（`neodb_csv` 需显式指定）。
- **三级可见性控制模型**：每一级的取值 `0` 均表示继承上一级设定，因此层级间遵循“仅收紧、不放松”的继承安全原则：
  ```
  --visibility            全量 NDJSON 记录的默认基础可见性（默认 0，即公开）
    └ --notes-visibility    日记记录专用的可见性控制（默认 0，继承基础可见性；书评与影评不受影响）
        └ --unknown-visibility  针对未能识别可见性状态的日记（默认 2，即仅提及者可见）
  ```
  继承机制避免了非对称配置漏洞（例如当基础设为受限时，子级继承不会意外越权扩大公开范围）。无论参数如何设定，**对于用户在豆瓣上主动设定为私密的日记，系统强制固化为 `2`（仅提及者可见）**，绝不提供越权公开的配置项。

运行环境要求：Node ≥ 20。全流程**纯离线运行，不发起任何网络请求**。

```sh
node bin/export.js ~/downloads/canonical ~/downloads/export
```

执行后产出目录中除了各目标平台的文件外，还会附带一份 `怎么导入.md`，详细列出本次导出的具体条目统计与各平台的实际导入步骤。完整的首次导入检查流程另见 [`docs/manual-testing.md`](docs/manual-testing.md)。建议初次使用时先通过 `--sample=20` 抽取样本并在目标平台小范围验证，确认无误后再执行全量导入。

---

## 跨平台能力与字段映射对比

以包含 2950 条有效标记的真实归档为例，各个平台对不同数据维度的接收支持能力对比如下：

| 数据维度 | 归档实际包含 | NeoDB (NDJSON) | NeoDB (CSV) | Letterboxd | Goodreads |
|---|---|---|---|---|---|
| **电影** | 1470 | ✅ | ✅ | ✅ | ✖︎ |
| **剧集** | 641 | ✅ | ✅ | ✖︎ | ✖︎ |
| **图书** | 145 | ✅ | ✅ | ✖︎ | ✅ |
| **音乐** | 84 | ✅ | ✅ | ✖︎ | ✖︎ |
| **游戏** | 605 | ✅ | ✅ | ✖︎ | ✖︎ |
| **舞台剧** | 5 | ✅ | ✅ | ✖︎ | ✖︎ |
| **长文（书评/影评）** | 2 | ✅ | ✅ | ✖︎ | ✖︎ |
| **长文（独立日记）** | 3 | ✅ | ✖︎ | ✖︎ | ✖︎ |
| **豆列收藏单** | 6 | ✅ | ✖︎ | ✖︎ | ✖︎ |
| **状态演变历史** | 3179 | ✅ (2519) | ✖︎ | ✖︎ | ✖︎ |
| **标签 (Tags)** | 717 | ✅ | ✅ | ✅ | 转换为书架 |

> 导出统计中的详细说明：
> - 状态历史中，有 1688 条与标记条目的初始状态重合，已直接并入标记所在行以补齐评分与评语；另有 657 条广播未附带评分或文本内容，依规整略过；
> - 游戏条目中，归档收录 605 个，实际导出 598 个，差异的 7 个为豆瓣官方已彻底下线且缺少可访问 URL 的条目；
> - 导出报告会统计因平台能力限制而无法导出的条目数量，并针对部分需要人工处理的异常生成明细文件（如 `neodb-needs-check.csv` 与 `letterboxd-needs-check.csv`），避免静默遗漏。

---

## NeoDB 导出实现：NDJSON 架构与语义保全

NeoDB 官方提供了原生的 NDJSON 归档导入规范。相比旧版 CSV，NDJSON 格式支持了 CSV 结构无法承载的核心维度：**豆列收藏单**、**不挂载具体作品的独立日记**、**细粒度记录可见性**，以及**状态演变历史**。

### 核心特性与适配决策

#### 1. 广播动态还原历史流转（ShelfLog）
豆瓣个人主页仅记录作品当前的最终标记状态，而广播在发布时具有不可变性，完整记录了从“想看/想读”到“在看/在读”再到“看过/读过”的历史演变时间线及评分。默认情况下（启用 `--shelf-history`），适配器会自动从广播记录中恢复这些状态变迁，并在 NeoDB 中生成对应的 `ShelfLog` 演变历史。

#### 2. 格式差异与注意事项
- **ISBN 与条目识别**：NDJSON 格式依赖 URL 资源与外部引用匹配，不支持在元数据文本中直接注入 ISBN 检索；
- **页面端可见性控制**：NeoDB 的 Web 上传界面在检测到 NDJSON 文件时会隐藏全局可见性单选框，因此记录可见性需由导出文件直接显式声明（通过 `--visibility` 等参数控制）；
- **多次标记与去重合并**：在豆瓣上若删除某条标记后重新添加，会生成全新的条目 ID，解析器会忠实记录为两条历史事件——在 canonical 事件日志中这是完全正确的。然而导出目标反映的是当前最终状态，一个作品在书架上应仅对应一行记录：若不执行合并，实测《盗梦空间》会导出两条 `ShelfMember`；NeoDB 对同一作品只有一个书架条目，后写入的记录会覆盖先写入的记录，覆盖顺序取决于文件先后而非语义判据。合并判定的依据是「最后一次观测到的时间戳」（`last_observed_at`）而非用户标记日期 —— 补标老电影可能标注较早的历史日期，但该记录依然是当前现存的有效条目。合并详情会在导出报告中明确提示（更早期的短评与标签仍完整保留于 canonical 原始归档中）。
- **日记隐私可见性映射策略**：
  - **公开日记**：继承基础可见性配置（默认公开）；
  - **用户主动设为私密**：严格锁定为 `visibility=2`（仅提及者可见）；
  - **豆瓣平台锁闭（如违规拦截提示）**：属于平台审查行为而非作者初衷，默认按基础配置导出以在联邦网络中恢复内容，用户可显式收紧；
  - **页面结构未能识别或老版本归档**：在缺乏充分公开证据时，系统默认向隐私保护倾斜，置为 `visibility=2`，可通过 `--unknown-visibility` 显式微调。

#### 3. 修订时间精确对齐（`content.updated`）
为使 NeoDB 的增量导入能够准确识别用户对历史短评或评分的更新，系统利用 canonical 记录的按字段版本摘要，将 `content.updated` 准确回溯至该字段内容发生变更时的 `first_observed_at` 时间戳。这种基于字段级摘要的判定方式避免了使用易受抓取时间污染的 `last_observed_at`，确保只有真实被编辑的字段才会向前推进更新时间。

#### 4. 消除标记与广播的时间戳冲突
导入标记条目时，NeoDB 会自动生成一条初始的 `ShelfLogEntry`。由于豆瓣标记仅记录日期（时间固定为 `00:00:00`），而广播记录包含具体秒级时间戳，若直接将两者写入会导致同一天对同一作品的同一操作被分裂为两条重复记录。系统会自动将同日同状态的广播历史与标记记录原子合并，既保留了广播冻结时的短评与评分，又保证了时间线记录的整洁与自洽。

---

## 双向往返校验机制

项目提供了全面的端到端离线自检与全量往返验证工具链：

1. **导出前离线自检（`tools/check-export.mjs`）**：
   比对导出的各平台文件与源 canonical 数据的业务实体一致性，确认记录数、评分值、正文文本完整无误；
2. **导入后服务器双向比对（`tools/check-roundtrip.mjs`）**：
   将从目标平台（如 NeoDB 的“设置 → 数据 → 导出”）重新导出的备份包与本地导出文件进行逐字段比对。在 17305 条全量记录的生产测试中，验证了条目数量、评分短评、标签关联及自动补齐的状态历史均实现 100% 严格对齐。

---

## 媒介类型分类与平台匹配规则

豆瓣将电影与剧集统一归类于影视条目（`movie`），但第三方平台具有不同的分类边界：

- **Letterboxd**：仅收录单部电影，不收录电视连续剧；若将剧集误送入，极易误匹配为同名电影导致数据污染；
- **分类判定规则**：依据条目元数据中是否包含 `集数`、`首播`、`季数` 进行精确区分（覆盖率达 98.8%）；
- **安全缺省策略**：对于未能抓取到详情页、无法明确区分电影或剧集的条目，Letterboxd 导出模块会选择主动跳过并输出至 `letterboxd-needs-check.csv`，避免向外部服务提交未经验证的错误数据；
- **外部标识绑定**：Letterboxd 与 Goodreads 均使用英文条目库，系统优先提取并输出 IMDb 编号与 ISBN，避免依赖中文标题进行模糊检索。

---

## 工程实现与跨端支持

1. **零运行时依赖**：代码采用纯 ES 模块编写，内置轻量流式 ZIP 打包实现（`ZipWriter`），打包产物兼容操作系统原生 `unzip` 工具并支持确定性校验。
2. **多端代码复用**：核心导出转换逻辑（`targets/neodb-ndjson.js`、`record.js`、`zip.js`）保持纯函数设计，不依赖 Node.js 专有模块，已无缝复用于浏览器扩展端（`doubak-extension`）的本地快速导出链路。
