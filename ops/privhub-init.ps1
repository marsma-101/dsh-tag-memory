# privhub-init.ps1 — 一次性：同步设计文档到 PrivHub + 删旧 + 看板写开发进度
#
# 设计文档（本地权威）单向同步到本机 PrivHub 备份服务器（project dsh-tag-memory）：
#   - 推 7 份当前设计文档（PUT，服务端写前自动存档上一版）
#   - 删站内「清单外」旧文件（即上版留下的老稿）
#   - 在看板写开发进度卡片（按 开发计划.md 的阶段）
#
# 口令：只取环境变量 PRIVHUB_ADMIN_PASSWORD（铁规矩：不落脚本/不落历史）。
#       没有就交互 Read-Host（在你自己的终端里跑时生效，密码不进任何文件）。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File ops\privhub-init.ps1
#   powershell -ExecutionPolicy Bypass -File ops\privhub-init.ps1 -DryRun        # 只看，不写不删不建卡
#   powershell -ExecutionPolicy Bypass -File ops\privhub-init.ps1 -NoUpload     # 只写看板，不碰文档
#   powershell -ExecutionPolicy Bypass -File ops\privhub-init.ps1 -NoKanban     # 只同步文档，不建卡
#   powershell -ExecutionPolicy Bypass -File ops\privhub-init.ps1 -NoDelete     # 同步文档但不删旧文件
#
# 必须在能打开 PrivHub 的那个终端里跑（dev 3180）。

[CmdletBinding()]
param(
  [string]$BaseUrl  = 'http://127.0.0.1:3180',
  [string]$User     = 'admin',
  [string]$Project  = 'dsh-tag-memory',
  [switch]$DryRun,
  [switch]$NoUpload,
  [switch]$NoKanban,
  [switch]$NoDelete
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$PluginDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'dsh-tag-memory'
if (-not (Test-Path $PluginDir)) { throw "找不到插件目录：$PluginDir" }

# 只推「插件运行/对外」需要的文件。内部文档（内部文档/）**绝不推**。
$Manifest = @(
  '标签字典.md'
)

function Say($tag, $msg, $color) { Write-Host ("  [{0}] {1}" -f $tag, $msg) -ForegroundColor $color }

# ---------- 登录 ----------
Write-Host ''
Write-Host "PrivHub 初始化  →  $BaseUrl  项目 $Project" -ForegroundColor Cyan
try {
  $probe = Invoke-WebRequest -Uri "$BaseUrl/privhub/" -TimeoutSec 6 -UseBasicParsing
  Say 'OK' "服务可达（HTTP $($probe.StatusCode)）" Green
} catch { Say 'FAIL' "连不上 $BaseUrl —— $($_.Exception.Message)"; exit 2 }

$Password = $env:PRIVHUB_ADMIN_PASSWORD
if ([string]::IsNullOrWhiteSpace($Password)) {
  $sec = Read-Host -Prompt "PrivHub $User 口令" -AsSecureString
  $Password = [Net.NetworkCredential]::new('', $sec).Password
}
$login = Invoke-RestMethod -Uri "$BaseUrl/privhub/api/login" -Method Post `
        -ContentType 'application/json; charset=utf-8' `
        -Body (@{ username = $User; password = $Password } | ConvertTo-Json -Compress) -SessionVariable sess
if (-not $login.ok) { throw "登录失败：$($login.error)" }
Say 'OK' "已登录（$User）" Green
$H = @{ Authorization = "Bearer $($login.token)" }

if ($DryRun) { Say 'DRY' 'DryRun：以下为将要执行的动作预览' Cyan }

# ---------- 1. 推送文档 ----------
$toPush = @(); $toDelete = @()
if (-not $NoUpload) {
  foreach ($name in $Manifest) {
    $path = Join-Path $PluginDir $name
    if (-not (Test-Path $path)) { Say 'MISS' "$name 本地不存在" DarkYellow; continue }
    $text = [IO.File]::ReadAllText($path, [Text.UTF8Encoding]::new($false))
    try {
      $q = "?project=$([uri]::EscapeDataString($Project))&path=$([uri]::EscapeDataString($name))"
      $r = Invoke-RestMethod -Uri "$BaseUrl/privhub/api/doc$q" -Headers $H -WebSession $sess -TimeoutSec 15
      $rhash = (Get-FileHash -InputStream ([IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes([string]$r.doc)))).Hash
      $lhash = (Get-FileHash -InputStream ([IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes($text)))).Hash
      if ($rhash -ne $lhash) { $toPush += @{ name = $name; text = $text; mtime = $r.mtime } }
    } catch { $toPush += @{ name = $name; text = $text; mtime = 0 } }
  }
  try {
    $listing = Invoke-RestMethod -Uri "$BaseUrl/privhub/api/list?project=$([uri]::EscapeDataString($Project))" -Headers $H -WebSession $sess -TimeoutSec 15
    $onServer = @($listing.entries | Where-Object { -not $_.isDir -and $_.name -like '*.md' } | ForEach-Object { $_.name })
    # 只删「曾经推过的内部文档」——内部文档已改为不上传，站内若残留就清掉。
    # 不删别的（站内可能有别人放的文件）。
    $LegacyInternal = @('功能说明.md','架构说明.md','流程_写入.md','流程_读取.md','流程_整理.md','待查证问题.md')
    $toDelete = @($onServer | Where-Object { $LegacyInternal -contains $_ })
  } catch { $toDelete = @() }
  Say 'SUM' ("待推文档 {0} · 站内旧文件待删 {1}" -f $toPush.Count, $toDelete.Count) Yellow
  foreach ($it in $toPush)  { Say 'PUSH' "将推 $($it.name)" DarkGray }
  foreach ($n in $toDelete) { Say 'OLD'  "将删旧文件 $n" DarkYellow }
} else { Say 'SKIP' '按 -NoUpload 跳过文档同步' DarkGray }

# ---------- 2. 写看板 ----------
$seedCards = @()
if (-not $NoKanban) {
  # 按 开发计划.md 的 6 个阶段 + 已完成的脚手架
  $seedCards = @(
    @{ title='[Done] git初始化+版本记录v0.1.0+开发计划'; desc='已建本地 git 仓库，首提交 v0.1.0 设计定稿；新增 版本记录.md / 开发计划.md；说明文件禁止推送 GitHub，仅留档本机 PrivHub 与本地 git。'; priority='normal'; column='col_done' },
    @{ title='阶段0 探明阻塞点（问题1-4）'; desc='0.1 HTTP路由鉴权(requestRejection契约,fail closed 503)；0.2 客户端多文件组织；0.3 插件安装与依赖；0.4 JSONL读写+序列化抽层。任一阻塞立刻回报。'; priority='high'; column='col_todo' },
    @{ title='阶段1 骨架与数据层'; desc='三半骨架(index/preset/client)；store/memory.jsonl(9字段)+records/*.jsonl；序列化抽层；项目/智能体隔离键。'; priority='normal'; column='col_todo' },
    @{ title='阶段2 写入链路'; desc='dtmbind(未绑定短路); dtm_write(追加+记write.jsonl,不查重); dtmmrecall(评分召回+否决+记read.jsonl含feedback); 首次引导。'; priority='normal'; column='col_todo' },
    @{ title='阶段3 整理链路'; desc='对话内触发; 身份来源(绑定→整理智能体→提问); 去重/升通用强判定; 稳定性状态机据feedback驱动; 归纳/拆库拆表; 记tidy.jsonl。'; priority='normal'; column='col_todo' },
    @{ title='阶段4 维护工具链'; desc='dtmm_supersede/archive/review/retag/export/records + dtm_merge; 用户手动改项目/智能体必须有。'; priority='normal'; column='col_todo' },
    @{ title='阶段5 客户端UI与渲染'; desc='设置页(绑定/整理智能体/引导); 浏览编辑面板(feedback标记/手动改项目智能体); 真实环境渲染冒烟。'; priority='normal'; column='col_todo' },
    @{ title='阶段6 留档与交付'; desc='说明文件同步PrivHub+删旧(本脚本); 进度同步看板; 禁止推GitHub。JSONL为测试选型, 暴露问题及时回报。'; priority='low'; column='col_todo' }
  )
  Say 'KB' ("将看板建卡 {0} 张（若已存在同名卡则跳过）" -f $seedCards.Count) DarkGray
}

if ($DryRun) { Write-Host ''; Say 'DRY' 'DryRun 结束，未做任何写操作' Cyan; exit 0 }

# ---------- 执行：推文档 ----------
if (-not $NoUpload) {
  Write-Host ''
  foreach ($it in $toPush) {
    $put = @{ project = $Project; path = $it.name; doc = $it.text; baseMtime = $it.mtime } | ConvertTo-Json -Compress
    try {
      $res = Invoke-RestMethod -Uri "$BaseUrl/privhub/api/doc" -Method Put -Headers $H -WebSession $sess `
              -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($put)) -TimeoutSec 30
      if ($res.ok) { Say 'PUSH' "$($it.name) → $([Text.Encoding]::UTF8.GetByteCount($it.text)) 字节" Green } else { Say 'FAIL' "$($it.name)：$($res.error)" Red }
    } catch {
      $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { '-' }
      Say 'FAIL' "$($it.name) HTTP $code —— $($_.Exception.Message)" Red
      if ($code -eq 409) { Say 'NOTE' '409 = 站内被改过或被锁，先人工确认再覆盖' DarkYellow }
    }
  }
  if (-not $NoDelete) {
    foreach ($name in $toDelete) {
      $q = "?project=$([uri]::EscapeDataString($Project))&path=$([uri]::EscapeDataString($name))"
      try {
        $res = Invoke-RestMethod -Uri "$BaseUrl/privhub/api/doc$q" -Method Delete -Headers $H -WebSession $sess -TimeoutSec 30
        if ($res.ok) { Say 'DEL' "$name 已删（旧文件）" Green } else { Say 'FAIL' "$name：$($res.error)" Red }
      } catch { Say 'FAIL' "$name HTTP $(if($_.Exception.Response){[int]$_.Exception.Response.StatusCode}else{'-'}) —— $($_.Exception.Message)" Red }
    }
  } else { Say 'SKIP' '按 -NoDelete 跳过删旧' DarkGray }
}

# ---------- 执行：看板建卡 ----------
if (-not $NoKanban) {
  Write-Host ''
  # 拉当前看板（不存在则服务端回默认三列），用于去重
  try { $board = (Invoke-RestMethod -Uri "$BaseUrl/privhub/api/taskboard?project=$([uri]::EscapeDataString($Project))" -Headers $H -WebSession $sess -TimeoutSec 15).board }
  catch { $board = $null }
  $existing = @()
  if ($board -and $board.cards) { $existing = @($board.cards | ForEach-Object { $_.title }) }
  $colById = @{}
  if ($board -and $board.columns) { foreach ($c in $board.columns) { $colById[$c.id] = $c.id } }

  foreach ($c in $seedCards) {
    if ($existing -contains $c.title) { Say 'SKIP' "卡已存在：略过 $($c.title)" DarkGray; continue }
    $col = if ($c.column -and $colById.ContainsKey($c.column)) { $c.column } else { $null }
    $body = @{ project = $Project; title = $c.title; desc = $c.desc; priority = $c.priority }
    if ($col) { $body.columnId = $col }
    try {
      $res = Invoke-RestMethod -Uri "$BaseUrl/privhub/api/taskboard/cards" -Method Post -Headers $H -WebSession $sess `
              -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Compress))) -TimeoutSec 30
      if ($res.ok) { Say 'CARD' "建卡：$($c.title)" Green } else { Say 'FAIL' "建卡失败 $($c.title)：$($res.error)" Red }
    } catch { Say 'FAIL' "建卡 $($c.title) HTTP $(if($_.Exception.Response){[int]$_.Exception.Response.StatusCode}else{'-'}) —— $($_.Exception.Message)" Red }
  }
}
Write-Host ''
