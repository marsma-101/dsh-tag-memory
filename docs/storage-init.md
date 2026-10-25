# 存储初始化与升级安全

> 规则的办法：**发布包不带记忆文件**，写入时先检测、没有就建。
> 这样覆盖升级不会碰到已有记忆。本文件是这条规矩的操作细则。

## 一、发布包长什么样

**发布包（zip）里不含任何记忆数据。** 记忆文件只以「模板」形式存在，且**库根本不在插件目录里**：

```
dsh-tag-memory/                 ← 插件包（代码，可覆盖升级）
├── index.js / preset.js / client.js
├── package.json
├── docs/                       ← 规则文档（本文件在这里）
├── lib/
│   ├── engine/                 ← 引擎内置副本
│   │   ├── core.mjs
│   │   ├── backup.mjs
│   │   ├── tags.schema.json
│   │   └── templates/          ← 空模板，升级时会被覆盖也无所谓
│   │       ├── index.md        手边层骨架（无内容）
│   │       ├── memory.csv      只有表头
│   │       └── backup.json     默认配置
│   └── store.mjs …
└── （没有 store/）

<DSH_HOME>/tag-memory/          ← 库（数据，升级重装都不碰）
└── store/
    ├── index.md
    ├── memory.csv
    └── backup.json
```

**关键区别**：
- 插件包（含 `lib/engine/templates/`）是**代码**，可以随包更新、随便覆盖。
- `<DSH_HOME>/tag-memory/` 是**数据**，不可再生，升级时必须保住。
- **数据不在插件目录里**，所以覆盖升级、卸载重装都碰不到它——这是本版最重要的一条。

## 二、写入时的自检（前述那一步）

**每次要写记忆之前，先检查库目录里三个文件在不在：**

```
① <DSH_HOME>/tag-memory/store/ 不存在        → 建目录
② store/index.md 不存在                       → 从 lib/engine/templates/index.md 复制一份
③ store/memory.csv 不存在                     → 从 lib/engine/templates/memory.csv 复制一份（★ 带表头，不要建空文件）
④ store/backup.json 不存在                    → 从 lib/engine/templates/backup.json 复制一份
⑤ 都在                                        → 直接写入
```

**⚠️ ③ 为什么必须从 templates 复制**：`lib/engine/templates/memory.csv` 里**带着 21 列表头**。
若建 0 字节空文件，**表头就没了**——后续写入没有列名，标签全废。
（`templates/` 是代码，随包交付；`store/` 是数据，升级时必须保住。）

**顺序**：先自检补齐，**再**写入。不要假设文件已存在。

### 实现要点

```bash
# 目录与文件补齐（node，跨平台，不写 BOM）
node -e "
const fs=require('fs'),p=require('path');
const root=process.argv[1], tpl=p.join(root,'lib','engine','templates'), st=p.join(root,'..','store');
fs.mkdirSync(st,{recursive:true});
for(const f of ['index.md','memory.csv','backup.json']){
  const dst=p.join(st,f), src=p.join(tpl,f);
  if(!fs.existsSync(dst)){ fs.existsSync(src)?fs.copyFileSync(src,dst):fs.writeFileSync(dst,'','utf8'); }
}
console.log('store ready');
" '<DSH_HOME>/tag-memory'
```

**PowerShell 5.1 注意**：别用 `-Encoding UTF8`（会写 BOM，见 `portability.md`）。
若确实要手工建 `memory.csv`，**先写表头**（别建空文件）：

```powershell
$hdr = 'id,内容,时间,环境,原因,备注,稳定性,成熟度,距离,角色,项目,状态,关键词,工具,版本,依据,类型'
$enc = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText("$root\store\memory.csv", $hdr + "`n", $enc)
```

## 三、⚠️ 只读宿主怎么办（实测踩过）

**实测**：在某些宿主的目录（如 `<宿主配置目录>\.dsh\skills\`）下写文件会被沙箱拒绝，报
`[sandbox: file access denied under workspace-write mode]`。

也就是说：**在带写保护的宿主上，「没有就创建」这一步会直接失败。**

所以插件里必须写死这条判断：

| 情况 | 做法 |
|---|---|
| 库目录（`<DSH_HOME>/tag-memory`）可写 | 正常：自检补齐 → 写入 `store/` |
| **库目录不可写** | **不要卡死**，走下面的降级 |

### 库目录不可写时的降级

按顺序找可写位置，**找到就用，并告知用户存在哪了**：

```
① 用户指定的记忆目录（问一次，记下来；对应配置项 libraryDir）
② 环境变量 DSH_TAG_MEMORY_DATA_DIR 指的目录
③ 宿主的工作区目录（cwd）下建 tag-memory/
④ 都不行 → 只用手边层（把记忆写在当前会话能写的地方），并明确告知用户「记忆无法持久化」
```

**规矩**：
- 换位置后**只在新的地方读写**，别两头都写（会出现两处真相）。
- 位置变了要**主动告知用户**，别默默换。
- 位置记在哪：写进配置项 `libraryDir`，或直接在用户的会话里说明。

## 四、升级插件的正确姿势

用户这套办法已经让**覆盖解压**变安全了（因为库不在插件目录里）。但仍建议按下面走：

### 推荐：覆盖解压（最省事）

```
① 解压新版本，直接覆盖到原插件目录
② 库在 <DSH_HOME>/tag-memory，根本不在插件目录里，所以原记忆文件原封不动 ← 这就是用户这招的价值
③ 验：读一下库里的 memory.csv 条数没变
```

### 保险：先留底再覆盖

```
① 把旧插件目录整体改名留底（例 dsh-tag-memory.bak-20261009）
② 解压新版本到原位置
③ 库目录没动，不用拷（只有换了库目录时，才把旧库的 store/ 整个搬过去）
④ 验：条数、索引对齐
⑤ 确认无误后再删留底目录
```

### 什么时候必须留底

- 用户说「升级记忆插件」时
- 包里**意外**带了 `store/`（打包失误）时
- 要改 `memory.csv` 的**结构**（加字段、改格式）时

## 五、打包发布时的检查清单

以后要重打包，**发之前逐条核对**：

```
□ zip 里没有 store/ 目录（插件包里本来就不该有库）
□ lib/engine/templates/ 三个模板文件在
□ lib/engine/templates/memory.csv 只有表头、共 21 列（末尾四列 强度/最后强化/已验证项目/使用次数）
□ lib/engine/ 下 core.mjs / backup.mjs / tags.schema.json 都在
□ docs/ 下 13 个规则文档在，且没有残留「技能目录」这类指路
□ 所有文件无 BOM
□ package.json 与 index.js 在包根层
□ 解压到空目录后，库由插件自己按第二节在 <DSH_HOME>/tag-memory 创建
```

**验命令**（解压后应看不到真实条目）：

```powershell
[System.IO.Compression.ZipFile]::OpenRead($zip).Entries | Select-Object FullName
# 应无 store\memory.csv 带内容的条目
```

## 六、为什么备份仍然要留

用户的办法堵住了**覆盖解压**这条主要风险，但下面几条它堵不住：

| 情况 | 用户这招能防吗 |
|---|---|
| 覆盖解压 | ✓ 能防 |
| **先删目录再解压** | ✗ 防不住，记忆一起没了 |
| 误删 `store/` | ✗ 防不住 |
| 磁盘坏、误格式化 | ✗ 防不住 |
| 改坏了 `memory.csv`（格式写错） | ✗ 防不住 |

所以 `docs/backup.md` 的备份规则**保留**，只是从「保命项」降为「兜底项」。
**建议**：用户指定一个备份目录，升级或大改之前备一次就够，不必频繁。
