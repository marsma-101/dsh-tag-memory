// 闸门③ ARCH 组：注入通道必须过会话级节流闸门（2026-11-13 框架级约束）
//
// ── 为什么要有这组静态守卫 ────────────────────────────────────────
// 用户裁定：「要从规则上避免某一个记忆被同一轮对话反复推送……
// 作为开发要对规则和框架进行改进，不能头痛医头脚痛医脚。」
//
// 只在 reminder.js 里接一次闸门，只治好了「这一条提醒」。将来任何人新增
// 注入通道（记忆自动推送、整理提示、诊断告警…）都会重新踩同一个坑：
// 去重只比对当前一步的 messages 数组，跨轮完全不设防。
//
// 所以把「凡向消息历史投递本插件内容，必须过 claimInjection」升成**架构约束**，
// 用静态扫描守住：新增通道若绕过闸门，这组测试立刻变红。
// 这是把一次修复变成一条规则的唯一办法。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PRESET_DIR = path.join(PACKAGE_DIR, 'preset')

/** 读 preset 下所有 .js 源码（注入通道只可能在这里）。 */
function presetSources() {
  return fs.readdirSync(PRESET_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ file: f, text: fs.readFileSync(path.join(PRESET_DIR, f), 'utf8') }))
}

/**
 * 该文件是否「构造了本插件的消息」——即出现 source.kind = 'tag-memory'。
 * 只查代码，剥掉注释行（注释里举例提到不算）。
 */
function constructsOwnMessage(text) {
  return text
    .split(/\r?\n/)
    .filter((l) => {
      const t = l.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
    })
    .some((l) => /kind:\s*['"]tag-memory['"]/.test(l))
}

test('ARCH1 【框架约束】凡构造 tag-memory 消息的 preset 文件，必须引用会话级闸门', () => {
  const offenders = []
  for (const { file, text } of presetSources()) {
    if (!constructsOwnMessage(text)) continue
    // 必须真的用引擎闸门（import + 调用），不是只在注释里提一句
    const importsGate = /from\s+['"][^'"]*inject-gate\.mjs['"]/.test(text)
    const callsGate = /\bclaimInjection\s*\(/.test(text)
    if (!importsGate || !callsGate) {
      offenders.push(`${file}（import=${importsGate} 调用=${callsGate}）`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '以下文件向消息历史投递本插件内容，却没过会话级节流闸门 claimInjection：\n'
      + offenders.join('\n')
      + '\n\n这会让同一内容在会话里被反复推送（2026-11-13 事故根因）。'
      + '\n修法：import { createInjectionLedger, claimInjection, injectionKey } from \'../lib/engine/inject-gate.mjs\'，'
      + '\n按 agent 持一个台账，投递前 claimInjection(...)，不 allowed 就原样放行。',
  )
})

test('ARCH2 闸门本体在引擎层且零框架依赖（可被任何通道复用）', () => {
  const gatePath = path.join(PACKAGE_DIR, 'lib', 'engine', 'inject-gate.mjs')
  assert.ok(fs.existsSync(gatePath), '闸门必须在 lib/engine/ 下——放 preset 里就无法被宿主/其他层复用')
  const src = fs.readFileSync(gatePath, 'utf8')

  // 引擎纯度：不得引框架
  for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const spec = m[1]
    assert.ok(
      spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../'),
      `引擎闸门不得引框架依赖，发现 "${spec}"`,
    )
  }
  // 不得有模块级可变全局状态（多会话会串台，《DSH 插件守则》P2）
  const codeLines = src.split(/\r?\n/).filter((l) => {
    const t = l.trim()
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
  })
  const moduleLevelMutable = codeLines.filter((l) => /^(let|var)\s/.test(l))
  assert.deepEqual(
    moduleLevelMutable,
    [],
    '闸门不得有模块级可变状态：台账必须由调用方按会话持有（WeakMap keyed by agent）',
  )
})

test('ARCH3 闸门导出齐全，且默认策略对「反复推送」真的有上限', async () => {
  const gate = await import('../../lib/engine/inject-gate.mjs')
  for (const fn of ['createInjectionLedger', 'claimInjection', 'injectionKey', 'injectionStats']) {
    assert.equal(typeof gate[fn], 'function', `缺导出 ${fn}`)
  }
  assert.ok(
    Number.isFinite(gate.DEFAULT_INJECTION_POLICY.maxPerSession)
      && gate.DEFAULT_INJECTION_POLICY.maxPerSession >= 1,
    '默认必须有有限的会话配额——无上限就等于没修',
  )

  // 行为断言（不只断言常量存在）：连推 20 轮，总投递数必须被配额卡住
  const ledger = gate.createInjectionLedger()
  let delivered = 0
  for (let turn = 1; turn <= 20; turn++) {
    if (gate.claimInjection(ledger, '同一条内容', { turn }).allowed) delivered++
  }
  assert.ok(
    delivered <= gate.DEFAULT_INJECTION_POLICY.maxPerSession,
    `20 轮里投了 ${delivered} 次，超过配额 ${gate.DEFAULT_INJECTION_POLICY.maxPerSession}`,
  )
})

test('ARCH4 提醒的可配置节流已接到 preset 配置（用户可调，不必改代码）', () => {
  const src = fs.readFileSync(path.join(PRESET_DIR, 'index.js'), 'utf8')
  assert.ok(
    /installWriteReminder\s*\([^)]*policy/.test(src),
    'preset/index.js 必须把 config.injectionPolicy 透传给提醒器，否则用户无法调节流',
  )
})
