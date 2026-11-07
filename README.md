# dsh-tag-memory

> 给 DSH 智能体一套**标签化、可检索、跨会话**的长期记忆。

[![Version](https://img.shields.io/badge/version-1.2.0-blue)]()
[![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1-orange)]()
[![Tests](https://img.shields.io/badge/tests-296%20passing-brightgreen)]()

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

**一条命令。只要 `node ≥ 24.9` + `npx`——不需要 pnpm、git、已装插件，也不需要模型。**

```bash
npx -y https://codeload.github.com/marsma-101/dsh-tag-memory/tar.gz/refs/tags/v1.2.0 apply
```

`npx` 只负责把包拉下来；真正干活的是包里的 [`scripts/install.mjs`](scripts/install.mjs)（纯 node、零依赖、约 1 秒）：

1. **自检本包**：名字/版本、`dsh.bundle.patch`、`exports`、`preset/lib` 零框架依赖——不过就**一个字节不写**；
2. **拷本体**到 `<DSH_HOME>/plugins/dsh-tag-memory`（不能直接链到 npx 临时目录：npx 清缓存时链接会指向空气）；
3. **建链接** `<profile>/node_modules/dsh-tag-memory`（Windows junction / POSIX symlink）；
4. **改 profile 的 `package.json`**：`dependencies` 加 `link:<本体>`、`dsh.profile.bundles` 追加本插件（先备份 `.bak-tag-memory-*`）；
5. **验收**：和 `verify-install.mjs` 用同一份判据（[`scripts/checks.mjs`](scripts/checks.mjs)），全绿才打 `INSTALL OK`。

常用变体：

```bash
npx -y <同一个 URL>                            # 只预检 + 打计划，一个字节不动
npx -y <同一个 URL> apply --profile tui        # 换 profile
npx -y <同一个 URL> apply --dsh-home /opt/dsh  # 换 DSH_HOME
npx -y <同一个 URL> uninstall                  # 预演卸载
npx -y <同一个 URL> uninstall apply            # 真卸
node scripts/install.mjs apply                 # 包已经在本地时，直接用同一个脚本
```

**装到哪个实例不用猜**：不带参数时，脚本先认 `$DSH_PROFILE_DIR`（DSH 在每个 shell 调用里都会带它），
直接落进**当前正在跑的那个 profile**；没有它才看 `$DSH_HOME`，最后才是 `~/.dsh`。输出里会打印
`目标来源 = $DSH_PROFILE_DIR（当前实例）`，装错地方一眼能看出来。

### 在容器里让 agent 装（目标场景）

对 agent 只需要一句话：

> 从这个 URL 装 1.2.0：`npx -y https://codeload.github.com/marsma-101/dsh-tag-memory/tar.gz/refs/tags/v1.2.0 apply`，
> 别手写 profile 的 `package.json` / `cordis.patch.yml`；装完把输出贴出来，等用户重启 dsh。

它会自动落到容器里 `/opt/dsh/profiles/<profile>`（靠 `$DSH_PROFILE_DIR`），不需要 `--dsh-home`。

两个必须知道的边界：

- **权限**：agent 的受限沙箱（workspace-write）写不了 `DSH_HOME`。脚本会**先做写权限预检**并明确报错
  （不会装到一半才 EPERM）——这时让用户在自己的终端跑同一条命令，或走 `plugin_manager install_bundle`（需批准）。
- **重启**：bundle 补丁只在启动时装配，agent 重启不了自己的进程。装完 `INSTALL OK` 之后，
  容器 `docker restart <容器名>`，重启后 10 个 `dtm_*` 才出现。

### 实测记录（2026-11-07，Node 24.21 / dsh 0.2.2-rc.1，隔离 DSH_HOME）

| 场景 | 结果 |
|---|---|
| `npx` 从 HTTP tarball 装（等价于 codeload URL） | exit 0，13 项验收全绿；profile 里出现 `link:` 依赖与 `dsh.profile.bundles` 条目 |
| 装完 `dsh --profile e2e --dump-config` | 两条行都在：`dsh-tag-memory` + `dsh-tag-memory/preset` |
| 重复 `apply` | 幂等，manifest 不变 |
| `uninstall apply` | 链接摘掉、依赖与 bundle 条目摘回原样；本体与记忆数据保留 |
| profile 不存在 / 链接位是实体目录 | 拒绝安装，**一个字节没写** |
| 带 `$DSH_PROFILE_DIR` 的 shell 里不带参数跑 | 自动定位到当前实例（`目标来源 = $DSH_PROFILE_DIR`），不会错装到 `~/.dsh` |
| 从 `main`（1.1.0）装 | 自检 4 项红——所以钉 tag，不装 `main` |

装完**重启 dsh**：bundle 补丁只在启动时装配，没有 `restart` 子命令——容器 `docker restart <容器名>`，
本机前台就 Ctrl-C 再起；浏览器页面再刷新一次。

### 装完自检（只读，不需要 pnpm、不需要 dsh 在跑）

```bash
node ~/.dsh/profiles/web/node_modules/dsh-tag-memory/scripts/verify-install.mjs
```

Windows 路径：`node %USERPROFILE%\.dsh\profiles\web\node_modules\dsh-tag-memory\scripts\verify-install.mjs`

它逐条核对：依赖登记、安装版本 ≥ 1.2.0、有没有旧结构特征（`peerDependencies` 带 `@deepseek-ai/dsh-tools`）、
`dsh.bundle.patch` 存在、`dsh.profile.bundles` 已登记（**不登记就不会装载**）、`preset/lib` 有没有框架 import、
入口文件齐不齐。全绿再重启；有红项它会直接说下一步。

### 升级

换 tag 重跑同一条命令（覆盖本体、重指链接、条目已存在则跳过）。

### 别用这几种写法

| 写法 | 为什么不行 |
|---|---|
| `dsh plugin add dsh-tag-memory` | npm 上 `latest` 还是**旧版 0.3.7**（结构不同、带两个 peerDeps），1.x 没发到 npm |
| `.../tar.gz/main` | `main` 浮动，当前是 1.1.0（带 `@deepseek-ai/dsh-tools` peer），装上工具全丢 |
| `add github:marsma-101/dsh-tag-memory` | 要连 `github.com`（被墙时 21 s 超时，实测），且 git 依赖会走 `prepare` 构建 |
| 手动 `cp` 到 `node_modules` | `dsh.bundle.patch` 不登记，插件不激活 |
| 装完不重启 | 工具不会出现 |

> 装了 pnpm 的机器，也可以用 DSH 自己的 `dsh plugin --profile web add <tag URL>`——它走 pnpm + `reconcile()`，
> 效果一样；上面那条是为了「只有 node + npx」的机器准备的，两条都实测过。

### 零运行时依赖

插件**不 import 任何 `@deepseek-ai/*` 或 `cordis`**，`package.json` 里也**没有 `peerDependencies`**；
`preset/define-tool.js` 是自带的 `defineTool`（移植自官方 `dsh-tools`，MIT，输出经逐字节比对一致）。

以前 `preset/tools.js` 顶层写着 `import … from '@deepseek-ai/dsh-tools'`，插件一旦落在没有
`node_modules` 链的目录（实测 `/opt/dsh/plugins/…`）就 `ERR_MODULE_NOT_FOUND`，整个 preset
挂不上、10 个工具全丢，日志里只有一行 import 失败。现在装哪都能跑。

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
# 全量测试（零外部依赖，不需要任何 shim）
node --test --test-isolation=none
```

```
300 条测试：296 通过 / 0 失败 / 4 条视觉如实未验
```

### 零框架依赖

`lib/engine/**` 不得 import 任何 `@deepseek-ai/*` 或 `cordis`（`purity.j.test` 强制）。
`preset/**` 同样不 import 框架包——`define-tool.js` 是自带的（见「安装」）。
所有模块都能脱离 DSH 直接 `node --test`。

---

## 许可

MIT
