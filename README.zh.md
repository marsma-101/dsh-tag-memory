# dsh-tag-memory

> 给 DSH 智能体一套**标签化、可检索、跨会话**的长期记忆。

[![Version](https://img.shields.io/badge/version-1.2.8-blue)]()
[![DSH](https://img.shields.io/badge/DSH-0.2.1%2B-orange)]()
[![Tests](https://img.shields.io/badge/tests-323%20passing-brightgreen)]()

[English](README.md) | 中文

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

### 方式一：插件市场（推荐）

在 dsh 里打开 **插件 → 发现**，搜「标签记忆」或 `dsh-tag-memory`，点安装，然后**重启 dsh**。

或者用命令行（市场条目用的就是这条命令）：

```bash
dsh plugin --profile web add github:marsma-101/dsh-tag-memory
```

> 装在哪个 profile 就写哪个 profile；容器里是 `--profile headless` 之类，按你的实例改。
> 这条命令需要 pnpm 和 git，由 dsh 自己调用，不需要手动装依赖。

### 方式二：`npx`（不依赖 pnpm / git）

**只要 `node ≥ 24.9` + `npx`——不需要 pnpm、git、已装插件，也不需要模型。**

```bash
npx -y https://codeload.github.com/marsma-101/dsh-tag-memory/tar.gz/refs/tags/v1.2.8 apply
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
npx -y <同一个 URL> uninstall                  # 预演卸载（打印将清理什么）
npx -y <同一个 URL> uninstall apply            # 真卸（保留记忆库）
npx -y <同一个 URL> uninstall apply --keep-backups  # 连 backup/ 也留着
npx -y <同一个 URL> uninstall apply --keep-runtime  # 运行期产物全留，只摘插件
npx -y <同一个 URL> cleanup --all-profiles     # 预演清历史残留（0.x/早期 1.x 装的）
npx -y <同一个 URL> cleanup --all-profiles apply  # 真清
node scripts/install.mjs apply                 # 包已经在本地时，直接用同一个脚本
```

**卸载保留什么、清掉什么**（`uninstall` 段的判据）：

| | 内容 | 为什么 |
|---|---|---|
| ✅ 保留 | `store/memory.csv`（记忆库本体） | 你的资产，删了不可恢复。重装后直接继续用 |
| ✅ 保留 | `store/.memory.lock` | 空锁文件，可能正在被用 |
| ✅ 保留 | `<DSH_HOME>/plugins/dsh-tag-memory`（本体副本） | 它可能是数据目录兜底，删了有丢数据风险 |
| 🗑 清理 | `records/*.jsonl`（台账） | 只用于审计，库还在就能重建 |
| 🗑 清理 | `backup/`（自动备份） | 库还在就不需要历史备份（`--keep-backups` 可留） |
| 🗑 清理 | `settings.json`（运行参数） | 备份/整理间隔，重装后重设即可 |
| 🗑 清理 | `<包根>/config/`（设置页选的库位置） | 插件都卸了，这个选择没意义了 |

卸载**先摆清单再动手**：不带 `apply` 只预演，一个字节不动。真卸时逐项删、逐项报，
某项删不掉（比如被占用）不影响其他项，且**删完会复查库还在不在**——万一不在会明确报错，
不会假装成功。

> ⚠️ 为什么卸载必须用这个脚本、而不是先 `dsh plugin remove` 再清理：
> `dsh plugin remove` 走 `pnpm remove`，会把整个包目录删掉，之后**没有任何插件代码还能执行**。
> 所以清理只能发生在卸载之前，且必须在包外跑。

**装到哪个实例不用猜**：不带参数时，脚本先认 `$DSH_PROFILE_DIR`（DSH 在每个 shell 调用里都会带它），
直接落进**当前正在跑的那个 profile**；没有它才看 `$DSH_HOME`，最后才是 `~/.dsh`。输出里会打印
`目标来源 = $DSH_PROFILE_DIR（当前实例）`，装错地方一眼能看出来。

### 在容器里让 agent 装（目标场景）

对 agent 只需要一句话：

> 从这个 URL 装最新版：`npx -y https://codeload.github.com/marsma-101/dsh-tag-memory/tar.gz/refs/tags/v1.2.8 apply`，
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
| `uninstall apply` | 链接摘掉、依赖与 bundle 条目摘回原样；**记忆库保留**，台账/备份/参数/config 清掉；删完复查库完好 |
| 卸载 → 重装（2026-11-09 实测） | 3 条记忆完整保留，`getOverview` 总数 3、召回 3 条，重装后继续写入编号接续 `M-20261109-004` |
| profile 不存在 / 链接位是实体目录 | 拒绝安装，**一个字节没写** |
| 带 `$DSH_PROFILE_DIR` 的 shell 里不带参数跑 | 自动定位到当前实例（`目标来源 = $DSH_PROFILE_DIR`），不会错装到 `~/.dsh` |
| 容器实装（dsh **0.2.1-rc.2**，`/opt/dsh`） | 重启后启动日志零错误；页面 boot 表里有 `dsh-tag-memory/client.js`；问 agent 拿到全部 10 个 `dtm_*`；插件页显示「标签记忆」 |
| `cleanup --all-profiles apply`（容器里 1.0.0 残留） | 摘掉悬空 `link:/opt/dsh/plugins/dsh-tag-memory-1.0.0`、bundle 条目、坏掉的补丁块，补丁恢复成 `[]` |
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

### 清理历史残留（0.x / 早期 1.x 装的）

老版本（0.3.x、1.0.0）的安装脚本会往 profile 里写别的东西，卸新版不会自动帮它们清。`cleanup` 只清这三样：

- `dependencies` 里那条**悬空**的 `dsh-tag-memory`（`link:` 指向的目录已经不存在）；
- `dsh.profile.bundles` 里对应的 `dsh-tag-memory` 条目；
- `cordis.patch.yml` 里 `# >>> dsh-tag-memory-… >>>` … `# <<< … <<<` 成对的旧安装块（摘完只剩 `[]` 就还原成合法最小补丁）。

```bash
npx -y <URL> cleanup --all-profiles        # 预演：逐 profile 列出会清什么
npx -y <URL> cleanup --all-profiles apply  # 真清（每个文件先备份）
```

**不动**：插件本体 `<DSH_HOME>/plugins`、记忆数据 `<DSH_HOME>/tag-memory`、其它依赖与补丁内容；
没有成对结束标记的块**不猜着删**，原样保留并报出来。

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

## 初始记忆（种子）

新装的库是空的，界面上什么都看不见，智能体也不知道该查什么。所以安装成功后会**顺带播几条种子**
（`scripts/seed.mjs`），让库一开始就有基本说明。

```bash
node scripts/seed.mjs              # 预演：只打印将写入什么
node scripts/seed.mjs apply        # 真写（库非空会自动跳过）
node scripts/seed.mjs apply --force  # 库里已有内容也强行加
```

种子全部是 `项目=通用`、`智能体=通用`，所以**任何项目、任何身份的会话都能看到**。

### 种子写了什么，为什么是这些

先说**没写什么**：没有写「介绍一下这个插件」「介绍 10 个工具」「去问用户身份」。
这三件事注入里已经写了，而且更详细——注入是每次会话都出现的固定前缀（5916 字节），
种子是**按需召回**的。把注入抄进库里，只会让 `dtm_recall` 查「工具」时先召回一堆自我介绍，
把真正的条目挤掉。**凡「每次都需要」的进注入，「偶尔查一下」的才进库。**

实际写了 6 条，都是注入给不了、只有库里能有的：

| 种子 | 形态 | 内容要点 |
|---|---|---|
| 库在哪 | 事实 | `store/memory.csv` 的实际路径、可编辑可备份、卸载不删 |
| 种子来历 | 事实 | 这批是种子、可改写可归档，不是项目结论 |
| 查空排错 | 技能 | 新装查不到是正常的，别「换个说法再试」 |
| 整理 | 技能 | 整理做什么、怎么触发、改坏了从 `backup/` 恢复 |
| 防污染 | 规则 | 种子不是用户事实，别以为看过了就了解用户 |
| 子智能体身份 | 技能 | 给子智能体带身份的正确做法（见下） |

### 标签为什么恰好 3 个

这不是随手定的，是召回闸门逼出来的。`read.mjs` L388 的硬闸门是：

```
e_ratio = 命中标签数 / 条目标签数   必须 严格大于 0.5
```

即**条目一半以上的标签必须被命中**，否则该条直接被否决。于是：

| 条目标签数 | 查 2 个标签 | 结果 |
|---|---|---|
| 5 个 | 2/5 = 0.40 | 否决 |
| 3 个 | 2/3 = 0.67 | **通过** |
| 2 个 | 2/2 = 1.00 | 通过，但查 1 个时 1/2 = 0.50 就被否决 |

所以 3 是「用两个词就能召回」的最大标签数。**标签多不是好事，它会让条目更难被召回**——
这是反直觉但已实测的规则。种子之间也刻意不共享标签，否则一次查询会同时命中两条，互相抢 Top-K。

### 给子智能体带身份（重要，容易想错）

父会话绑定了某个身份（比如「小明」）后，想让子智能体也以小明的身份读写记忆，
**必须在派活的提示里明确要求它先调 `dtm_bind`**：

> 先调 `dtm_bind`，`智能体=小明`，然后……

**不会自动继承。** 实测结论：

| 子智能体形态 | 能否继承身份 |
|---|---|
| `spawn`（默认，全新 session） | ❌ `UNBOUND_IDENTITY` |
| `fork`（播种父会话历史） | ❌ 仍然拿不到（fork 只播种对话历史，不含插件身份） |
| 子智能体自己 `dtm_bind` 同名 | ✅ 能读到父以该身份写的全部记忆 |
| 子智能体 `dtm_bind` 别的名字 | ✅ 绑成功，但**读不到**小明的记忆（隔离生效，符合设计） |

原因是身份存在进程内 WeakMap 里、不落任何事件，而子智能体是**全新的 agent 对象 + 独立 session**
（`dsh-subagent-spawn-in-process` 源码：*its own session, own system prompt, zero parent context*，
且 `inheritsParentContext = false`）。所以只能靠子智能体自己再绑一次。

好消息是子智能体**默认继承父的 preset**（`dsh-subagent` README L65：
*Without a selection, a local child joins the parent's current preset revision*），
所以它有 `dtm_*` 工具，绑一下就能用。

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
323 条测试：319 通过 / 0 失败 / 4 条视觉如实未验
```

### 零框架依赖

`lib/engine/**` 不得 import 任何 `@deepseek-ai/*` 或 `cordis`（`purity.j.test` 强制）。
`preset/**` 同样不 import 框架包——`define-tool.js` 是自带的（见「安装」）。
所有模块都能脱离 DSH 直接 `node --test`。

---

## 许可

MIT
