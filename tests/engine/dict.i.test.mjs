// 闸门① I 组：配置与字典加载（5 条）
//
// 依据：《架构说明》§4.1、§十三「阈值/开关这类可调值」、《流程_整理》§5.1、
//       《接口契约》Q2（schema.json）/ 疑点 1（两个 10）、Lead 裁定 Q3（dict 从磁盘读）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  loadSchema,
  loadScoring,
  loadTagEquivalence,
  loadTagDictText,
  extractDictSections,
  renderCompactInjection,
  templatePaths,
  clearConfigCache,
  clearDictCache,
} from '../../lib/engine/dict.mjs'

const TEMPLATES_DIR = join(process.cwd(), 'lib', 'engine', 'templates')
const DICT_PATH = join(process.cwd(), '标签字典.md')

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-i-'))
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }))
}

/* ------------------------------------------------------------------ *
 * I1 schema.json
 * ------------------------------------------------------------------ */
test('I1 schema.json 存在可解析，含 9 列 / 6 形态 / 3 稳定性 / 3 状态 / limits', async () => {
  clearConfigCache()
  const schema = await loadSchema({ baseDir: TEMPLATES_DIR })

  assert.equal(schema.columns.length, 9, `必须 9 列，实际 ${schema.columns.length}`)
  assert.deepEqual(
    schema.columns,
    ['编号', '主要内容', '形态', '项目', '智能体', '自由标签', '稳定性', '时距', '状态'],
    '列顺序必须固定（《架构说明》§八）',
  )

  assert.equal(schema.shapes.length, 6, `形态必须 6 个，实际 ${schema.shapes.length}`)
  assert.deepEqual(schema.shapes, ['技能', '流程', '规则', '偏好', '事实', '模板'])

  assert.deepEqual(schema.stabilities, ['观察', '稳定', '易变'])
  assert.deepEqual(schema.statuses, ['生效', '被取代', '已归档'])

  assert.equal(schema.limits.tagsMax, 20)
  assert.equal(schema.limits.projectNameMax, 40)
  assert.equal(schema.limits.agentNameMax, 40)
})

/* ------------------------------------------------------------------ *
 * I2 scoring.json（含两个 10 分开命名）
 * ------------------------------------------------------------------ */
test('I2 scoring.json 含权重/及格线/否决阈值/两个 10（tickMaxScore 与 tickCap 分开）', async () => {
  clearConfigCache()
  const cfg = await loadScoring({ baseDir: TEMPLATES_DIR })

  assert.equal(cfg.weights.shapeHit, 50)
  assert.equal(cfg.weights.tagMax, 40)
  assert.equal(cfg.weights.tickMaxScore, 10, '打分权重上限必须是 weights.tickMaxScore')

  assert.equal(cfg.passLine, 40)
  assert.equal(cfg.veto.entryRatio, 0.5)
  assert.equal(cfg.veto.queryFloor, 0.15, 'Q4 裁定：queryFloor 出厂 0.15')

  assert.equal(cfg.tickCap, 10, '时距字段值上限必须是顶层 tickCap')
  assert.equal(cfg.topK, 5)
  assert.equal(cfg.nearLimit, 3)
  assert.equal(cfg.writeLogTagLimit, 10)

  // 两个 10 必须在不同位置，且都不是同一个键
  assert.notEqual('tickCap' in cfg.weights, true, 'tickCap 不应在 weights 下（那是打分权重区）')
  assert.notEqual('tickMaxScore' in cfg, true, 'tickMaxScore 不应在顶层（必须属于 weights）')
})

/* ------------------------------------------------------------------ *
 * I3 tag-equivalence.json
 * ------------------------------------------------------------------ */
test('I3 tag-equivalence.json 存在可解析，双向归一可用', async () => {
  clearConfigCache()
  const eq = await loadTagEquivalence({ baseDir: TEMPLATES_DIR })

  assert.ok(Array.isArray(eq.groups), 'groups 必须是数组')
  assert.ok(eq.groups.length > 0, 'groups 不能为空')
  for (const g of eq.groups) {
    assert.ok(Array.isArray(g), '每个 group 必须是数组')
    assert.ok(g.length >= 2, `每个等价组至少 2 个成员，实际 ${JSON.stringify(g)}`)
    for (const m of g) {
      assert.equal(typeof m, 'string')
      assert.ok(m.trim().length > 0, '等价表成员不得为空串')
    }
  }

  // 文档里举的例子必须真在表里（否则等价表形同虚设）
  const flat = eq.groups.flat()
  for (const word of ['发版', '上线', 'deploy']) {
    assert.ok(flat.includes(word), `等价表必须收「${word}」（《流程_整理》§5.2 举例）`)
  }
})

/* ------------------------------------------------------------------ *
 * I4 配置缺失 → 明确错误，不静默兜底
 * ------------------------------------------------------------------ */
test('I4 配置/字典缺失 → 抛明确错误（CONFIG_MISSING / DICT_MISSING），不静默兜底', async () => {
  await withTempDir(async (dir) => {
    clearConfigCache()

    // 缺 schema.json
    await assert.rejects(
      () => loadSchema({ baseDir: dir }),
      (err) => {
        assert.ok(err, '必须抛错')
        assert.ok(
          err.code === 'CONFIG_MISSING' || err.code === 'ENOENT' || /CONFIG|ENOENT|not found|no such/i.test(String(err.message)),
          `缺配置必须抛明确错误，实际 code=${err.code} message=${err.message}`,
        )
        return true
      },
      '缺 schema.json 时必须抛错，不得静默返回内置默认值',
    )

    // 坏 JSON
    writeFileSync(join(dir, 'scoring.json'), '{ 这不是 JSON', 'utf8')
    clearConfigCache()
    await assert.rejects(
      () => loadScoring({ baseDir: dir }),
      (err) => {
        assert.equal(err.code, 'CONFIG_MISSING', `坏 JSON 应报 CONFIG_MISSING，实际 ${err.code}`)
        return true
      },
      '坏 JSON 必须报 CONFIG_MISSING',
    )

    // 缺标签字典
    clearDictCache()
    await assert.rejects(
      () => loadTagDictText({ dictPath: join(dir, '不存在的字典.md') }),
      (err) => {
        assert.ok(err, '缺字典必须抛错')
        assert.ok(
          err.code === 'DICT_MISSING' || err.code === 'ENOENT' || /DICT|ENOENT|no such/i.test(String(err.message)),
          `缺字典应报 DICT_MISSING，实际 code=${err.code}`,
        )
        return true
      },
      '缺标签字典必须抛错，不得静默用空字典',
    )
  })
})

/* ------------------------------------------------------------------ *
 * I5 dict.mjs：从磁盘读标签字典 + 提取区块 + 渲染注入
 * ------------------------------------------------------------------ */
test('I5 dict.mjs 从磁盘读 标签字典.md（Q3），能提取区块并渲染注入', async () => {
  clearDictCache()
  const dict = await loadTagDictText({ dictPath: DICT_PATH })

  assert.equal(typeof dict.text, 'string', 'loadTagDictText 必须返回 text')
  assert.ok(dict.text.length > 1000, `字典原文应有一定长度，实际 ${dict.text.length} 字`)

  // 来源必须是磁盘上的 标签字典.md（Q3：不硬编码进 preset）
  const onDisk = readFileSync(DICT_PATH, 'utf8')
  assert.equal(dict.text, onDisk, '读到的内容必须与磁盘上的 标签字典.md 逐字节一致（证明确实从磁盘读）')

  // 区块提取
  const sections = extractDictSections(dict.text)
  assert.ok(sections, '必须返回 sections')
  assert.ok(Array.isArray(sections.shapes) && sections.shapes.length === 6, '必须提取到 6 个形态值')
  assert.ok(Array.isArray(sections.tools), '必须提取到工具列表')

  // tools 是 { name, when } 对象数组（含"什么时候调"），不是裸字符串
  const toolNames = sections.tools.map((t) => (typeof t === 'string' ? t : t?.name))
  for (const t of toolNames) {
    assert.equal(typeof t, 'string', `工具项必须能取到名字，实际 ${JSON.stringify(t)}`)
  }

  // 10 个工具一个不缺（渲染注入的前提）
  const TOOLS = [
    'dtm_bind', 'dtm_write', 'dtm_recall', 'dtm_supersede', 'dtm_archive',
    'dtm_retag', 'dtm_review', 'dtm_records', 'dtm_export', 'dtm_merge',
  ]
  assert.equal(toolNames.length, 10, `必须提取到正好 10 个工具，实际 ${toolNames.length}：${toolNames.join(',')}`)
  for (const t of TOOLS) {
    assert.ok(toolNames.includes(t), `字典区块未提取到工具「${t}」，实际：${toolNames.join(',')}`)
  }

  // 渲染注入
  const injection = renderCompactInjection({ dict, identity: { bound: true, who: 'A' } })
  assert.equal(typeof injection, 'string', '渲染结果必须是字符串')
  assert.ok(injection.length > 0, '注入内容不能为空')
  for (const t of TOOLS) {
    assert.ok(injection.includes(t), `注入文本必须含工具入口「${t}」（一个都不能缺）`)
  }
  for (const shape of ['技能', '流程', '规则', '偏好', '事实', '模板']) {
    assert.ok(injection.includes(shape), `注入文本必须含形态值「${shape}」`)
  }
})

/* ------------------------------------------------------------------ *
 * I-附加 templatePaths 指向真实文件
 * ------------------------------------------------------------------ */
test('I-附加 templatePaths 返回的三个路径都指向真实存在的文件', async () => {
  const paths = templatePaths(TEMPLATES_DIR)
  assert.ok(paths.schema && paths.scoring && paths.equivalence, '必须返回 schema/scoring/equivalence 三个路径')
  for (const [k, p] of Object.entries(paths)) {
    const buf = readFileSync(p)
    assert.ok(buf.length > 0, `${k} 文件不能为空：${p}`)
    // 必须是合法 JSON
    assert.doesNotThrow(() => JSON.parse(buf.toString('utf8')), `${k} 必须是合法 JSON：${p}`)
  }
})
