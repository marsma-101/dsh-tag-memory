# dsh-tag-memory

> 给 DSH 智能体一套**标签化、可检索、跨会话**的长期记忆。

[![Version](https://img.shields.io/badge/version-1.1.0-blue)]()
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.2-orange)]()
[![Tests](https://img.shields.io/badge/tests-295%20passing-brightgreen)]()

---

## 它解决什么问题

DSH 的会话是有界的：换一个会话，智能体就忘了上一次说过什么。

`dsh-tag-memory` 把值得记住的事存成**带标签的条目**，下次用同样的身份进会话时，
按标签能重新召回——不需要用户重复交代。

---

## 核心设计

### 双标签体系

| 类型 | 说明 | 取值范围 |
|---|---|---|
| **固定标签** | 结构化的分类维度 | 形态（6 种）/ 稳定性（3 态）/ 状态（3 态） |
| **自由标签** | 由模型按《标签字典》自行决定，**不设词表** | 上限 20 个，用 `\|` 分隔存储 |

固定标签锁在 `lib/engine/templates/schema.json`，改取值域只改这一处。

### 隔离：谁写的只有谁能读

每条记忆都带 `项目` 和 `智能体`，读取时**先做硬筛**：

```
条目的 项目 ∈ {通用, 引入, 当前项目}
AND   智能体 ∈ {通用, 引入, 当前智能体}
AND   状态 = 生效
```

**跨智能体查不到，靠的是隔离，不是分数低。**

### 召回：分数只用来筛「有用」

```
形态命中    50 分
标签交集    0~40 分（按 q_ratio 线性）
时距加成    0~10 分（min(log2(时距) × 2, 10)）
──────────────
及格线      40 分
```

但**过线不等于返回**，还有两道否决：

| 否决 | 条件 | 含义 |
|---|---|---|
| 条目侧 | `e_ratio > 0.5` 才通过（**严格大于**） | 这条记忆被 query 命中了多少 |
| query 侧 | `q_ratio >= 0.15` 才通过 | query 的方向对不对 |

擦边未过的会进 `near`（最多 3 条），让模型能区分**真查空**和**假查空**。

### 存储：CSV，用户能直接编辑

```
store/memory.csv          9 列，RFC4180（引号包裹 / "" 转义 / 字段内换行）
records/write.jsonl       写入台账（成功和失败都记）
records/read.jsonl        读取台账（含 feedback，驱动稳定性状态机）
records/tidy.jsonl        整理台账（每次改动记 before/after/basis）
backup/                   改库前自动备份
```

**为什么不用 SQLite**：用户要能手工改。**为什么不用 Markdown 表格**：单元格不能含换行。

---

## 安装

> ⚠️ **有一条硬要求，违反了不会报错，只会静默失效。**

### 用 plugin_manager 安装

```bash
dsh plugin --profile web install dsh-tag-memory
```

或通过 `plugin_manager` 的 `install_bundle`。**不要手动 cp 到 node_modules**——
那样 dsh.bundle.patch 不会被注册，插件不会激活。

### profile 补丁的 `id` 必须等于 bundle 补丁 `insert` 的 `id`

插件自带的 `cordis.patch.yml`（bundle 层）定义了两个条目：

```yaml
- insert:
    - id: dsh-tag-memory
      name: dsh-tag-memory
    - id: dsh-tag-memory-tools
      name: dsh-tag-memory/preset
```

如果你想在 profile 层覆盖配置（比如改数据目录），**必须用完全相同的 id**：

```yaml
# ✅ 正确
- id: dsh-tag-memory
  config:
    dataDir: /your/path

# ❌ 错误（会被静默丢弃，只打一条 warn）
- id: tag-memory
  config:
    dataDir: /your/path
```

**为什么**：`dsh-app-boot` 的 `applyPatches` 里，顶层 `- id: xxx` 是
「按 id **覆盖已存在条目**」，不是新增。找不到目标就整条丢弃。

> 这是本项目踩过的真实事故：改名时 bundle 的 id 从 `tag-memory` 改成 `dsh-tag-memory`，
> profile 补丁没跟着改，导致所有配置从那天起静默失效，数据一路落到插件包内——
> 而 `pnpm` 升级会整个删除插件包目录。

### config 是整体替换，不是深合并

```yaml
# bundle 里：  config: { dataDir: '/a', other: 1 }
# profile 里： config: { dataDir: '/b' }
# 结果是：     { dataDir: '/b' }        ← other:1 被整个丢掉
```

### 装完跑校验

```bash
node 内部文档/工具/verify-install.mjs
```

```
✅ 校验通过
   bundle insert id:  dsh-tag-memory, dsh-tag-memory-tools
   profile 覆盖 id:   无
   dataDir:           ~/.dsh/tag-memory
   来源:              dsh-home
```

---

## 数据目录：5 级优先级

| 优先级 | 来源 | `dataDirSource` | 说明 |
|---|---|---|---|
| ① | `config.dataDir` | `config` | patch 里显式配的，**锁定**（设置页搬家无效） |
| ② | `DSH_TAG_MEMORY_DATA_DIR` | `env` | 环境变量，**锁定** |
| ③ | 设置页选的 | `settings` | 用户通过 UI 选 |
| ④ | `$DSH_HOME/tag-memory` | `dsh-home` | **出厂默认**（不配也能用） |
| ⑤ | `<插件包>/data` | `package` | **最后手段，会告警** |

④ 的跨平台落点：

```
Linux/macOS:  $DSH_HOME/tag-memory          （容器里 = /opt/dsh/tag-memory）
Windows:      %USERPROFILE%\.dsh\tag-memory （= C:\Users\<你>\.dsh\tag-memory）
```

**落到 ⑤ 会怎样**：日志 warn + `getSettings().warning` + UI 警示色。
因为 `pnpm` 重装/升级会整个删除插件包目录，**数据会丢**。

---

## 10 个工具

| 工具 | 作用 | 是否改库 |
|---|---|---|
| `dtm_bind` | 绑定本次会话的身份（智能体 + 项目） | — |
| `dtm_write` | 写一条记忆 | ✅ 追加 |
| `dtm_recall` | 按形态 + 自由标签召回 | 命中时距 +1 |
| `dtm_supersede` | 用新条顶替旧条（旧条标「被取代」） | ✅ |
| `dtm_archive` | 退场（标「已归档」，行不删） | ✅ |
| `dtm_retag` | 改某条的标签字段（**必须带 basis**） | ✅ |
| `dtm_review` | 只读通览一批条目 | ❌ |
| `dtm_records` | 查台账（write / read / tidy） | ❌ |
| `dtm_export` | 导出为 CSV | ❌ |
| `dtm_merge` | 合并另一份记忆库 | ✅ |

### 两条容易踩的语义

**① `dtm_retag` 的省略 ≠ 清空**

```
只传 { 编号, 稳定性, basis }  →  只改稳定性，其余字段保持原值
```

不想改的字段**直接省略**，不用传原值。传空数组/空串才表示「想清空」（会被拒绝）。

**② `dtm_merge` 的同号判新**

编号相同（如两份库都有 `M-20261106-001`）时，按：

```
① 时距大者胜（时距 = 被召回次数）
② 时距相同看稳定性：稳定 > 观察 > 易变
③ 都一样则保留当前库（幂等）
```

---

## 稳定性状态机

由 `read.jsonl` 的 `feedback` 驱动，**读写环节不改**，只在整理时演进：

```
        ok 累计 ≥ 3 且无 wrong
观察 ──────────────────────────────→ 稳定
  ↑                                    │
  │  本轮无 wrong                       │ wrong > 0
  │  （安静了就自愈）                    ↓
易变 ←─────────────────────────────────┘
```

> **大量调用错误不是弃用，而是降 `易变`** —— 给它一次自我修正的机会。

---

## 界面

挂在「插件」页的插件详情里（不占左侧栏）：

- **记忆条目页**：库概况、筛选（形态/状态/项目/智能体/自由标签）、表格、编辑器、分页
- **设置页**：库位置 + 搬家、备份、自动整理、标签字典只读预览、导出到指定目录

**编辑边界**（硬约束）：只有 6 个字段可改 —— `形态` / `项目` / `智能体` / `自由标签` / `稳定性` / `状态`。
`编号` / `主要内容` / `时距` **永远只读**：那是唯一标识、一手材料、程序计数器。

---

## 开发

```bash
# 全量测试（必须带 shim，否则 preset 相关会 ERR_MODULE_NOT_FOUND）
node --import ./tests/_shims/dsh-tools-loader.mjs \
     --test --test-isolation=none $(ls tests/**/*.test.mjs)
```

```
299 条测试：295 通过 / 0 失败 / 4 条视觉如实未验
```

### 引擎零框架依赖

`lib/engine/**` 不得 import 任何 `@deepseek-ai/*` 或 `cordis`（`purity.j.test` 强制）。
所有引擎模块都能脱离 DSH 直接 `node --test`。

---

## 许可

MIT
