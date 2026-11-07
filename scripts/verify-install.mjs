#!/usr/bin/env node
/**
 * verify-install.mjs —— 只读检查 dsh-tag-memory 是否真的装进了某个 profile。
 *
 * 为什么要有它：`dsh plugin --profile x list` 会在 profile 目录里建 `package.json.lock`，
 * 在受限沙箱（workspace-write）里直接 EPERM；而这个脚本只读文件，不启动 dsh、不碰 pnpm，
 * 所以「人、脚本、agent」在三种环境下都能用它自证装没装好。
 *
 * 用法（装好后、重启 dsh 之前跑都行）：
 *   node scripts/verify-install.mjs
 *   node scripts/verify-install.mjs --profile web
 *   node scripts/verify-install.mjs --home /opt/dsh --min-version 1.2.0
 *   node scripts/verify-install.mjs --json
 *
 * 判据全部在 checks.mjs 里，与 install.mjs 装完后的验收是同一套。
 * 退出码：0 = 全部通过；1 = 有问题（逐条列出 + 下一步）。
 */

import { MIN_VERSION, resolveTarget, verifyProfile } from './checks.mjs'

const argv = process.argv.slice(2)
const valueOf = (nameFlag, fallback) => {
  const i = argv.indexOf(nameFlag)
  if (i < 0) return fallback
  const next = argv[i + 1]
  return next !== undefined && !next.startsWith('--') ? next : fallback
}
const target = resolveTarget({
  home: valueOf('--dsh-home', valueOf('--home', undefined)),
  profile: valueOf('--profile', undefined),
})
const profile = target.profile
const home = target.home
const minVersion = valueOf('--min-version', MIN_VERSION)
const asJson = argv.includes('--json')

const report = verifyProfile({ home, profile, minVersion })

if (asJson) {
  process.stdout.write(JSON.stringify({ profile, home, targetSource: target.source, ...report }, undefined, 2) + '\n')
  process.exit(report.ok ? 0 : 1)
}

process.stdout.write(`\ndsh-tag-memory 安装自检  (profile=${profile})\n`)
process.stdout.write(`  目标来源  = ${target.source}\n`)
process.stdout.write(`  DSH_HOME = ${home}\n  profile  = ${report.profileDir}\n\n`)
for (const item of report.results) {
  process.stdout.write(`  ${item.ok ? '✓' : '✗'} ${item.title}\n`)
  if (item.detail) process.stdout.write(`      ${String(item.detail).replace(/\n/g, '\n      ')}\n`)
}
process.stdout.write('\n')

if (report.ok) {
  process.stdout.write('结论：装好了。\n')
  process.stdout.write('下一步：重启 dsh（没有 restart 子命令：容器 docker restart <容器>，本机 Ctrl-C 再起），\n')
  process.stdout.write('重启后 10 个 dtm_* 工具才会出现；浏览器页面再刷新一次。\n\n')
  process.exit(0)
}
process.stdout.write('结论：上面有红项，先别重启。\n')
process.stdout.write('最省事的修法：重跑安装命令（node scripts/install.mjs apply），再跑一次本脚本。\n\n')
process.exit(1)
