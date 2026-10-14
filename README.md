# dsh-tag-memory

DSH 插件：把记忆存到 CSV 文件里稳定读写，闲时可整理的一份记忆库系统。

具体来说，它把技能 **`marsma101-tag-memory`** 的 CSV 标签记忆接进 DeepSeek Harness。

- **一份逻辑**：读写/筛选规则只在技能的 `scripts/lib/core.mjs` 里定义一次。技能 CLI 与插件共用它，不抄第二遍。
- **两段式**：模型读注入的**标签字典**自己判断维度；程序（本插件的两个工具）负责执行。
- **零依赖**：只追加的 CSV；不引入向量、API 或外部服务。

## 两半

| 文件 | 平面 | 干什么 |
|---|---|---|
| `index.js` | profile（bundle patch 插入） | **记忆文件托管**：探测各智能体 `MEMORY.md`，写一段受控的「记忆系统在运行」说明块；挂载自愈。另挂 `/tag-memory-api`（给设置页取数）。 |
| `preset.js` | 每个智能体（preset 里挂 `dsh-tag-memory/preset`） | `systemPrompt.section` 每轮注入**标签字典**；注册 `memory_write` / `memory_recall` 两个工具。 |
| `client.js` | 浏览器（`dsh.client`，挂 `settings.section` / `sidebar.panellist` / `main`） | **「记忆」页**：条目表格/卡片 + 维度筛选 + 搜索，标题行上带**备份 / 恢复 / 合并**。条目只读；备份那三件事会写。 |

## 客户端入口（client.js）

同一页组件挂三处，`id` 一律用 `tag-memory`（`sidebar.panellist` 的 `id` 必须等于 `main` 面板的 `key`）：

| 槽 | 作用 | 位置 |
|---|---|---|
| `sidebar.panellist` | 侧边栏全局面板按钮（图标 + 「记忆」） | `order: 5`，紧排在官方**插件**按钮（`order: 0`）下面、日程（`order: 10`）上面 |
| `main` | 侧边栏按钮切过去的主区页面 | `key: 'tag-memory'`；shell 的 `.centerCol` 是 `overflow:hidden` 且高度确定，**面板必须自己当滚动容器**（`.tm-panel` = `height:100% + overflow:auto`），顶部再让出 `--dsh-frame-top-clearance` |
| `settings.section` | 设置里的**「记忆」**一栏（第二入口，同一组件） | `order: 60` |

数据全走宿主的只读 API：

| 端点 | 方法 | 返回 |
|---|---|---|
| `/tag-memory-api/overview` | GET | 是否就绪、技能/库路径、维度取值与计数、记忆文件托管状态 |
| `/tag-memory-api/entries` | GET | `?cond=<JSON>&q=<关键词>&sort=<排序>&limit=<n>&offset=<n>` → 命中的条目（含 `total` / `shown` / `hasMore`） |
| `/tag-memory-api/heal` | POST | 立即重跑一次记忆文件自愈，返回 summary + 新状态 |
| `/tag-memory-api/backup` | GET | 备份现状：地址是否已设、上次时间/条数、条数差、份数/占用/盘上余量、最近几份、到点没 |
| `/tag-memory-api/backup` | POST | `{label?}` → 立即备份。**没设地址时返回 `code:'NO_DIR'`**，界面据此切进「设置备份地址」状态 |
| `/tag-memory-api/backup/dir` | POST | `{dir}` → 设置备份地址（绝对路径；不存在就建；建不了/不可写就报错不落配置） |
| `/tag-memory-api/restore` | POST | `{stamp}` → **整体替换**成那一版；先强制留档当前版，换完复核记录数 |
| `/tag-memory-api/merge` | POST | `{path\|text, apply?}` → 合并外来 `memory.csv`；不传 `apply` 就是预演（不落笔） |

条目列表的浏览能力：

- **表格视图**（默认）：库就是 CSV，所以一行一条、一列一个字段。**列名与列序都照库自己的表头**（`overview.header`），库里改名/挪列这里跟着走；默认只摆十列（`id 内容 时间 稳定性 成熟度 距离 角色 项目 状态 关键词`），环境/原因/备注/工具/版本/依据这些长文本或常空的留在「详情」里。表头与勾选列常驻，列多时横向滚动，长文本截断（悬浮看全文）。注意 `成熟度` 这一列在筛选下拉里叫「深度」——那是 schema 的维度名，表头悬停有提示。设置页窄，默认仍给**卡片视图**；右上角按钮可随时切换，选择记在 `localStorage`。
- **维度下拉**：每个维度一个下拉（选项带计数、已选打 ✓），横向排一行；选一个取值就叠加一条条件，同一个再选一次即取消。
- **排序** `sort`：`time_desc`（默认）/ `time_asc` / `id_desc` / `id_asc`，按自然序比较（`M-20260101-002` 这类也排得对）。
- **分页** `limit` + `offset`，页尾「加载更多」；`hasMore` 指示是否还有。
- **含已归档**：默认沿用核心规则排除 `被取代` / `已归档`；开关打开时把 `状态` 全集 + `留白` 显式写进条件（`overview.statusValues` 提供全集）。
- **详情展开**：每条可就地展开全部非空字段（环境/原因/依据/关键词/工具/版本/备注/作用…）；正文超过 120 字先折叠。
- **多维选择**：同一维度可多选（维度内 = 或，维度间 = 与）；当前条件以**面包屑**显示，可逐个撤掉。
- **勾选带走**：勾选条目（含全选本页 / 清空）→「复制 Markdown」或「导出 CSV」；每条也有单独「复制」。
- **本地记忆**：条件 / 排序 / 每页数存 `localStorage`，重开设置页仍在。
- **键盘**：`/` 聚焦搜索框，`Esc` 清空全部条件与关键词。

条目本身只读：写入仍由智能体经 `memory_write` 工具完成。`类型` 维度尚未落列，所以标「未落列」、不可点筛。

### 版式：主位通则

**用户要看的、要点的放主位；说明、状态、设置退到次位并默认收起。** 判据一句话：
这东西用户「每次都要看」还是「出了事才看」？

按这条排出来是：

| 位置 | 内容 |
|---|---|
| 标题行（右对齐） | **立即备份 / 恢复… / 合并… / 设置备份地址…** 四颗按钮——要点的，跟标题同一行，不另占一张卡 |
| 标题下面一行 | 备份现状：地址 · 上次时间 · 库条数与条数差 · 份数/占用 · 盘上余量 · 「该备份了」 |
| 正文（主位） | **记忆条目**：维度下拉一行 + 搜索/排序/每页/含已归档 + 勾选工具条 + 表格/卡片 |
| 页尾（默认收起） | **维护与状态**：记忆文件托管明细 + 手上的备份列表（都是「出事了才看」的） |

> 2026-10-14 用户当场指出：原来「记忆文件托管」——一个全自动、用户完全不用碰的状态说明——
> 是完整一张卡，还排在用户真正要查的条目**上面**。已记进记忆库（`M-20261014-001`）。

### 备份 / 恢复 / 合并

- **没有默认备份地址。** 地址存 `store/backup.json` 的 `backupDir`，空就是没设。
  点「立即备份」而地址为空 → **直接展开「设置备份地址」面板**（跟点那颗按钮一模一样），
  不是弹一句提醒。
- **选一次就记住。** 点「设置备份地址」会弹系统文件夹选择框——用的是
  **DSH 自己的那道门**：客户端 `ctx.uiWorkspace.pickDirectory()`，也就是开新会话选工作区时弹的同一个框
  （native / 内建浏览两种后端它自己适配，取消、前台激活这些它也处理好了）。
  **选中即落笔**（写 `store/backup.json`）：面板顶上那行「当前地址」立刻跟着变，**刷新 / 重开界面都还是它，
  直到你重新选**。手填绝对路径的走右边「保存这个地址」。**存地址与立刻备份是两件事**——
  备份归标题行的「立即备份」，不捆在存地址那颗按钮上。
- **地址只有一个落笔点**：`commitDir()` → `POST /backup/dir`。选文件夹、内建浏览的「就选这个目录」、
  手填后保存，全汇到它；没有第二条路能偷偷改地址。
- **两级兜底**：拿不到 `uiWorkspace`（或它没有原生选择能力）→ 退回**内建目录浏览**
  （`uiWorkspace.listDirectory()` 给的一层：面包屑 + 子目录 + 「就选这个目录」）；
  连这个也没有 → 输入框还在，手填绝对路径。
- ⚠️ **别自己去 spawn 进程弹框**。试过 PowerShell 的 `FolderBrowserDialog`：
  框**开在别的窗口后面**，等于弹不出来——Windows 只把前台激活权给前台进程，
  DSH 的原生选择框还得先合成一次 Alt 按键才抢得到（见 `dsh-host-directory-picker-native`）。
- **立即备份**：走技能里 `scripts/lib/backup.mjs` 的 `runBackup()`——与命令行
  `node scripts/backup.mjs` **同一条代码路径**。备 `memory.csv` / `index.md` / `backup.json` 三件套，
  文件名带戳 `YYYYMMDD-HHMMSS`；校验四项（字节数 / SHA-256 / 解析器数的记录数 / 无 BOM）全过才更新水位；
  戳上已有内容不同的同名文件就**往后挪一秒**，**备份从不覆盖已有内容**；超过 `keepCopies` 份轮转最旧的。
- **恢复 = 整体替换**（不是补缺失）。选中某一份后：先验它能读并把内容读进内存 →
  **强制先留档当前这一版**（失败就中止，一个字节不动）→ 写回 `memory.csv` + `index.md`
  （`backup.json` 不还原：那是设置不是记忆）→ 复核记录数，对不上就报错并指出用哪份回退。
- **合并**：给一份外来 `memory.csv` 的绝对路径 → **先预演**出报告（新增 / 重复跳过 / 撞号改新号 /
  内容为空 / 内容一样但标签不一样）→ 看过再「确认合并」。守技能 §6 的铁律：
  **先留档、只追加、不重写、不删任何条目、id 撞号按内容判**。

## 记忆文件托管（index.js / lib/notice.mjs）

MEMORY.md 里原本塞的是「没插件注入、所以每轮手动读技能」的补丁。插件接管字典注入后，该文件改放一段说明。

三条规矩：

1. **只认标记**：只动 `<!-- BEGIN dsh-tag-memory notice -->` 之间的内容，块外一个字节不碰；文件没有标记就当用户自己写的，**只追加、不重写**。
2. **只追加 / 原位替换**：有标记替换块内，没有则追加到末尾。旧的手工字典块（`marsma101-tag-memory dict`）会被顺手接管替换掉。
3. **不能轻易删除**：首次落笔先留 `.bak-<时间戳>`；插件每次挂载（以及新智能体出现时）核对标记，不在就补回。

探测的文件名由 `config.memoryFileNames` 决定，默认只认 **`MEMORY.md`**（大小写不敏感）。目录不存在、文件不存在 → 跳过。

## 自检

```bash
node scripts/selftest.mjs   # 125 项断言；全程沙箱（临时复制一份技能），不碰任何 live 数据
node scripts/install.mjs    # 只读校验：包结构 + profile 清单 + 预览会写哪些记忆文件
```

交付/测试用命令：`selftest.mjs` 全过 + `install.mjs`（check）全 PASS 即可视为可安装。

## 安装

```bash
node scripts/install.mjs                         # 只读校验 + 预览会写哪些记忆文件
node scripts/install.mjs --apply                 # 安装（链接 + profile 清单 + 写记忆块）
node scripts/install.mjs --apply --wire-presets  # 顺带把 /preset 行接进各智能体的 agent.cordis.yml
node scripts/install.mjs --dsh-home <路径> --profile <名>   # 装到别的 DSH / 别的 profile
```

装完需**重启 DSH** 才生效。所有被改文件脚本都会先留 `.bak-<时间戳>`。

安装前请确认技能已就位：默认找 `<DSH_HOME>/skills/marsma101-tag-memory`，
可用 `DSH_TAG_MEMORY_SKILL_DIR` 指定别处。

## 配置

`index.js`（profile 行）：

```yaml
- id: tag-memory
  name: dsh-tag-memory
  config:
    memoryFileNames: ['MEMORY.md']   # 探测哪些文件算「记忆文件」
    notice: true                     # 关掉则不写记忆块
    migrateLegacyDict: true          # 是否接管旧的手工字典块
```

`preset.js`（每个智能体）：

```yaml
- id: tag-memory
  name: 'dsh-tag-memory/preset'
  config:
    dir: !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('.', baseUrl))"
```
