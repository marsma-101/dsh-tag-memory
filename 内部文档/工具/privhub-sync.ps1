# privhub-sync.ps1 — 把本地 dsh-tag-memory 设计文档统一维护到 PrivHub 站内（v2 重写版）
#
# 与旧版区别：
#   1. 源目录 = 插件根目录（设计文档就放在根，不再有 docs/ 子目录）。
#   2. 清单 = 当前 v2 的 7 份设计文档（功能说明/架构说明/标签字典/流程_* / 待查证问题）。
#   3. 新增「删旧」：推送完当前 7 份后，把站内**不在清单里**的 .md 删掉
#      （即上一版留下的老文件，如 标签_类别_草案.md / 初始记忆.md 等）。
#      —— 你要求「将老文件删除」；这里用「清单外即旧」判旧，避免误删。
#
# 方向：本地是权威账本，站内是镜像（记忆 M-20261014-011 定的规矩）。
#       本站内只有一份在架副本，PUT 写前服务端自动 snapshot 上一版（落 .trash，带毫秒时间戳），
#       所以覆盖是服务端保证可回滚的；DELETE 则真删，只删「清单外的旧文件」。
#
# 用法（在【能打开 PrivHub 的那个终端】里跑；本机没装 pwsh(7)，用自带 Windows PowerShell）：
#   powershell -ExecutionPolicy Bypass -File ops\privhub-sync.ps1
#   powershell -ExecutionPolicy Bypass -File ops\privhub-sync.ps1 -DryRun        # 只看差异/将要删除的，不写不删
#   powershell -ExecutionPolicy Bypass -File ops\privhub-sync.ps1 -BaseUrl http://127.0.0.1:3180
#   powershell -ExecutionPolicy Bypass -File ops\privhub-sync.ps1 -NoDelete      # 只推新、保留站内旧文件
#
# 口令：不落脚本、不落历史。取环境变量 PRIVHUB_ADMIN_PASSWORD，没有就交互输入。
#       （铁规矩：密码不落脚本与历史）
#
# 必须存成 UTF-8 **带 BOM**：Windows PowerShell 5.1 遇到无 BOM 的 .ps1 会按 ANSI 读，中文注释会打乱。

[CmdletBinding()]
param(
  [string]$BaseUrl  = 'http://127.0.0.1:3180',
  [string]$User     = 'admin',
  [string]$Project  = 'dsh-tag-memory',
  [switch]$DryRun,
  [switch]$NoDelete
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# 本脚本住在工作区顶层的 ops/，插件目录是上一级的 dsh-tag-memory/。
$PluginDir = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if (-not (Test-Path $PluginDir)) { throw "找不到插件目录：$PluginDir" }

# 只推「插件运行/对外」需要的文件。内部文档（内部文档/）**绝不推**。
$Manifest = @(
  '标签字典.md'
)

function Say($tag, $msg, $color) {
  Write-Host ("  [{0}] {1}" -f $tag, $msg) -ForegroundColor $color
}

# ---------- 1. 探活 + 登录 ----------
Write-Host ''
Write-Host "PrivHub 统一维护  →  $BaseUrl  项目 $Project" -ForegroundColor Cyan
try {
  $probe = Invoke-WebRequest -Uri "$BaseUrl/privhub/" -TimeoutSec 6 -UseBasicParsing
  Say 'OK'   "服务可达（HTTP $($probe.StatusCode)）" Green
} catch {
  Say 'FAIL' "连不上 $BaseUrl —— $($_.Exception.Message)" Red
  Write-Host '      先在那个网络空间里把 privhub\start.bat 起来（dev 3180），或用 -BaseUrl 指向实际地址。' -ForegroundColor DarkGray
  exit 2
}

$Password = $env:PRIVHUB_ADMIN_PASSWORD
if ([string]::IsNullOrWhiteSpace($Password)) {
  $sec = Read-Host -Prompt "PrivHub $User 口令" -AsSecureString
  $Password = [Net.NetworkCredential]::new('', $sec).Password
}
$body = @{ username = $User; password = $Password } | ConvertTo-Json -Compress
$login = Invoke-RestMethod -Uri "$BaseUrl/privhub/api/login" -Method Post `
        -ContentType 'application/json; charset=utf-8' -Body $body -SessionVariable sess
if (-not $login.ok) { throw "登录失败：$($login.error)" }
Say 'OK' "已登录（$User）" Green

# 有些部署只认 body.token，不认 cookie；两个都带上最稳
$H = @{ Authorization = "Bearer $($login.token)" }

# ---------- 2. 逐份对比 ----------
$toPush = @(); $same = @(); $missing = @()
foreach ($name in $Manifest) {
  $path = Join-Path $PluginDir $name
  if (-not (Test-Path $path)) { $missing += $name; continue }
  $text  = [IO.File]::ReadAllText($path, [Text.UTF8Encoding]::new($false))
  $lhash = (Get-FileHash -InputStream ([IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes($text)))).Hash

  try {
    $q = "?project=$([uri]::EscapeDataString($Project))&path=$([uri]::EscapeDataString($name))"
    $r = Invoke-RestMethod -Uri "$BaseUrl/privhub/api/doc$q" -Headers $H -WebSession $sess -TimeoutSec 15
    $rhash = (Get-FileHash -InputStream ([IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes([string]$r.doc)))).Hash
    if ($rhash -eq $lhash) { $same += $name } else { $toPush += @{ name = $name; text = $text; mtime = $r.mtime } }
  } catch {
    $toPush += @{ name = $name; text = $text; mtime = 0 }   # 404 / 读不到 = 站内没有，当新增推
  }
}

# 只清「曾经推过的内部文档」——内部文档已改为不上传，站内若残留就删掉；不碰别的文件。
try {
  $q = "?project=$([uri]::EscapeDataString($Project))"
  $listing = Invoke-RestMethod -Uri "$BaseUrl/privhub/api/list$q" -Headers $H -WebSession $sess -TimeoutSec 15
  $onServer = @($listing.entries | Where-Object { -not $_.isDir -and $_.name -like '*.md' } | ForEach-Object { $_.name })
  $LegacyInternal = @('功能说明.md','架构说明.md','流程_写入.md','流程_读取.md','流程_整理.md','待查证问题.md')
  $toDelete = @($onServer | Where-Object { $LegacyInternal -contains $_ })
} catch { $toDelete = @() }

Write-Host ''
Say 'SUM' ("一致 {0} · 待推 {1} · 本地缺 {2} · 站内旧文件待删 {3}" -f $same.Count, $toPush.Count, $missing.Count, $toDelete.Count) Yellow
foreach ($n in $same)    { Say '···' "$n 已一致" DarkGray }
foreach ($n in $missing) { Say 'MISS' "$n 本地不存在（清单需修）" DarkYellow }
foreach ($n in $toDelete){ Say 'OLD' "站内有旧文件「$n」→ 将删除" DarkYellow }

if ($DryRun) { Write-Host ''; Say 'DRY' '只看不写不删，结束' Cyan; exit 0 }

# ---------- 3. 推送（服务端写前自动存档上一版） ----------
Write-Host ''
foreach ($it in $toPush) {
  $put = @{ project = $Project; path = $it.name; doc = $it.text; baseMtime = $it.mtime } | ConvertTo-Json -Compress
  try {
    $res = Invoke-RestMethod -Uri "$BaseUrl/privhub/api/doc" -Method Put -Headers $H -WebSession $sess `
            -ContentType 'application/json; charset=utf-8' `
            -Body ([Text.Encoding]::UTF8.GetBytes($put)) -TimeoutSec 30
    if ($res.ok) { Say 'PUSH' "$($it.name) → $([Text.Encoding]::UTF8.GetByteCount($it.text)) 字节" Green }
    else         { Say 'FAIL' "$($it.name)：$($res.error)" Red }
  } catch {
    $resp = $_.Exception.Response
    $code = if ($resp) { [int]$resp.StatusCode } else { '-' }
    Say 'FAIL' "$($it.name) HTTP $code —— $($_.Exception.Message)" Red
    if ($code -eq 409) { Say 'NOTE' '409 = 站内这份被别人改过或被锁；先人工看过再决定覆盖，本脚本不自动抢写。' DarkYellow }
  }
}

# ---------- 4. 删旧 ----------
Write-Host ''
if ($NoDelete) {
  Say 'SKIP' '按 -NoDelete 跳过删除站内旧文件' DarkGray
} elseif ($toDelete.Count -eq 0) {
  Say 'OK' '站内没有需要删除的旧文件' Green
} else {
  foreach ($name in $toDelete) {
    $q = "?project=$([uri]::EscapeDataString($Project))&path=$([uri]::EscapeDataString($name))"
    try {
      $res = Invoke-RestMethod -Uri "$BaseUrl/privhub/api/doc$q" -Method Delete -Headers $H -WebSession $sess -TimeoutSec 30
      if ($res.ok) { Say 'DEL' "$name 已删除（旧文件）" Green }
      else         { Say 'FAIL' "$name：$($res.error)" Red }
    } catch {
      Say 'FAIL' "$name HTTP $(if($_.Exception.Response){[int]$_.Exception.Response.StatusCode}else{'-'}) —— $($_.Exception.Message)" Red
    }
  }
}
Write-Host ''
