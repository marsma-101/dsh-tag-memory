// 闸门③ S 组：视觉验证（如实报告区）
//
// 铁律依据：官方 references/verification.md + 《架构说明》§十二
//   ❌ 不从 shell 另起浏览器、不改 HOME、不翻个人浏览器配置、不找 token
//   ❌ 不找光栅化工具、不调 Quick Look、不把 SVG 导出成预览图
//   ❌ 不模拟 React/DOM、不写自定义渲染器来"补上"没有浏览器的缺口
//   ❌ mock 页面的截图不算验证
//   ✅ 没有浏览器控制时，只验到语法/manifest/slot 注册，并明确报告"视觉未验证"
//
// 因此本组**不产出任何"视觉通过"的结论**。它只做两件事：
//   1. 记录本次真实的能力探测结果（服务可达性）
//   2. 断言"我们没有用造假手段补缺口"（防止有人日后加 mock 截图冒充验证）
// S2~S5（无 slot crash / 明暗可读 / 编辑字段 / 不白屏）在无浏览器控制下**一律未验证**。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { ROOT, listAllFiles } from '../_helpers.mjs'

const GUI_URL = 'http://127.0.0.1:3080'

/* ------------------------------------------------------------------ *
 * S1 能力探测：记录真实结果，不伪造
 * ------------------------------------------------------------------ */
test('S1 记录已连接页面的真实可达性（探测结果仅供参考，不代表视觉已验证）', async () => {
  let reachable = false
  let detail = ''

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    const res = await fetch(GUI_URL, { signal: controller.signal, redirect: 'manual' })
    clearTimeout(timer)
    reachable = res.status >= 200 && res.status < 400
    detail = `HTTP ${res.status}`
  } catch (err) {
    detail = `不可达：${err.code || err.name || err.message}`
  }

  // 只记录，不判失败——没有浏览器控制不是缺陷，是能力边界
  console.log(`\n[视觉能力探测] ${GUI_URL}`)
  console.log(`  探测结果: ${detail}`)
  console.log(`  可自动加载页面: ${reachable ? '是' : '否'}`)
  console.log(
    `  结论: ${reachable ? '页面可达，但本会话无浏览器控制/无认证通道 → 仍无法做渲染级视觉验证' : '无浏览器控制 → 视觉未验证'}`,
  )
  console.log('  说明: 按官方 verification.md，不另起浏览器、不找 token、不改 HOME、不模拟 React/DOM。\n')

  // 本用例永远"通过"——它证明的是"我们如实探测了"，不是"视觉已验证"
  assert.ok(true)
})

/* ------------------------------------------------------------------ *
 * S2-S5 标记为未验证（用 skip 显式表达"没验"，不伪装成通过）
 * ------------------------------------------------------------------ */
test('S2 控制台无 slot entry crashed — 未验证（无浏览器控制）', { skip: '无浏览器控制，按官方 verification.md 如实报未验证，不做替代验证' }, () => {})
test('S3 明暗主题可读 — 未验证（无浏览器控制）', { skip: '无浏览器控制，按官方 verification.md 如实报未验证，不做替代验证' }, () => {})
test('S4 条目编辑只开放 6 字段 — 未验证（无浏览器控制）', { skip: '无浏览器控制，按官方 verification.md 如实报未验证，不做替代验证' }, () => {})
test('S5 渲染异常不白屏 — 未验证（无浏览器控制）', { skip: '无浏览器控制，按官方 verification.md 如实报未验证，不做替代验证' }, () => {})

/* ------------------------------------------------------------------ *
 * S6 反造假自检：仓库里不得出现"拿截图当验证"的产物
 *     这条是防止日后有人为了"看起来验过了"而留下 mock 截图
 * ------------------------------------------------------------------ */
test('S6 反造假自检：仓库内无 mock 截图 / 光栅化预览产物', () => {
  // 允许的图片：只有插件图标本身
  const ALLOWED_IMAGES = new Set(['icon.svg'])

  const images = listAllFiles().filter((f) => /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(f))
  const offenders = images.filter((f) => !ALLOWED_IMAGES.has(f))

  assert.deepEqual(
    offenders,
    [],
    `仓库内出现位图截图（不得拿 mock 截图当视觉验证，也不得把 SVG 光栅化成预览图）：\n  ${offenders.join('\n  ')}`,
  )
})
