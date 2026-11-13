/**
 * merge.t.test — 合并时「同号保留较新」的判定
 *
 * ============ 这条测试防的是真实缺陷（2026-11-06） ============
 *
 * 规格《流程_整理》§二 L90：
 *   「冲突以"编号唯一、同号保留较新"为原则」
 *
 * 原实现：
 *   const existing = byId.get(id);            // id 就是编号
 *   if (idNewerThan(rec['编号'], existing['编号'])) { 覆盖 }
 *
 * 但进到这个分支说明两条**编号完全相同** ——
 * `idNewerThan("M-20261106-001", "M-20261106-001")` 恒为 false。
 *
 * 结果：「保留较新」是死代码，合并方的版本永远被静默丢弃（changed 恒为 0）。
 * 实测：把含新版 M-001 的库合并进来，changed=0，库里还是旧内容。
 *
 * 修法：编号相同就用不了编号，改看条目自身状态 ——
 *   ① 时距大者胜（时距=被召回次数，用得多的更贴合当下）
 *   ② 时距相同看稳定性：稳定 > 观察 > 易变
 *   ③ 都一样则保留当前库（幂等）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const HOST_SRC = readFileSync(join(process.cwd(), 'index.js'), 'utf8')

/** 从源码抽出 recordNewerThan 并执行（纯判定，无副作用） */
function buildRecordNewerThan() {
  const i = HOST_SRC.indexOf('function recordNewerThan')
  assert.ok(i >= 0, '找不到 recordNewerThan（合并判新函数）')

  let depth = 0
  let end = -1
  const bodyStart = HOST_SRC.indexOf('{', HOST_SRC.indexOf(')', i))
  for (let k = bodyStart; k < HOST_SRC.length; k++) {
    if (HOST_SRC[k] === '{') depth++
    else if (HOST_SRC[k] === '}') {
      depth--
      if (depth === 0) {
        end = k + 1
        break
      }
    }
  }
  const src = HOST_SRC.slice(i, end)
  // eslint-disable-next-line no-new-func
  return new Function(src + '\nreturn recordNewerThan;')()
}

const newer = buildRecordNewerThan()

const rec = (tick, stability) => ({ 时距: tick, 稳定性: stability })

// ── T1: 时距优先 ─────────────────────────────────────────

test('T1 时距大者胜（合并方时距 5 vs 当前库 1）', () => {
  assert.equal(newer(rec(5, '观察'), rec(1, '稳定')), true, '时距大的应该覆盖')
})

test('T2 合并方时距小则保留当前库', () => {
  assert.equal(newer(rec(1, '稳定'), rec(5, '观察')), false, '时距小不该覆盖')
})

test('T3 时距相同看稳定性：稳定 > 观察', () => {
  assert.equal(newer(rec(3, '稳定'), rec(3, '观察')), true)
  assert.equal(newer(rec(3, '观察'), rec(3, '稳定')), false)
})

test('T4 稳定性完整序：稳定 > 观察 > 易变', () => {
  assert.equal(newer(rec(2, '稳定'), rec(2, '易变')), true)
  assert.equal(newer(rec(2, '观察'), rec(2, '易变')), true)
  assert.equal(newer(rec(2, '易变'), rec(2, '观察')), false)
})

test('T5 时距与稳定性都相同 → 保留当前库（幂等，不折腾）', () => {
  assert.equal(newer(rec(3, '观察'), rec(3, '观察')), false)
})

// ── T6: 边界值 ───────────────────────────────────────────

test('T6 时距缺失/非数字按 0 处理，不抛错', () => {
  assert.equal(newer({ 稳定性: '稳定' }, rec(1, '观察')), false)
  assert.equal(newer(rec(1, '观察'), { 稳定性: '稳定' }), true)
  assert.equal(newer({ 时距: 'abc' }, { 时距: 'xyz' }), false)
})

test('T7 稳定性缺失按最低处理', () => {
  assert.equal(newer({ 时距: 1 }, rec(1, '易变')), false, '缺稳定性不该胜出')
})

// ── T8: 源码级，防退回死代码 ─────────────────────────────

test('T8 【关键】合并循环不得再用 idNewerThan 比较编号', () => {
  // 2026-11-12：合并循环抽成 mergeInto（P0-2 锁内化），契约不变，定位改到 mergeInto。
  const i = HOST_SRC.indexOf('for (const rec of incomingRecords)')
  assert.ok(i >= 0, '找不到合并循环（mergeInto）')

  let depth = 0
  let end = -1
  const bodyStart = HOST_SRC.indexOf('{', i)
  for (let k = bodyStart; k < HOST_SRC.length; k++) {
    if (HOST_SRC[k] === '{') depth++
    else if (HOST_SRC[k] === '}') {
      depth--
      if (depth === 0) {
        end = k + 1
        break
      }
    }
  }
  // ⚠️ 必须剥掉注释再判断：新代码的注释里**专门写了**这个旧写法做说明，
  // 直接正则匹配源码会把注释命中，造成假失败。
  const loopBody = HOST_SRC.slice(i, end)
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')

  assert.equal(
    /idNewerThan\s*\(/.test(loopBody),
    false,
    '合并循环里不得再用 idNewerThan —— 两条编号相同时它恒为 false，「保留较新」会变成死代码',
  )
  assert.match(loopBody, /recordNewerThan\s*\(/, '必须用 recordNewerThan（按时距/稳定性判新）')
})

test('T9 mergeLibrary 返回里的 changed 会真实反映覆盖数', () => {
  // 2026-11-12：累加逻辑在 mergeInto（P0-2 抽出的纯合并函数），契约不变。
  const i = HOST_SRC.indexOf('function mergeInto')
  assert.ok(i >= 0, '找不到 mergeInto')

  let depth = 0
  let end = -1
  const bodyStart = HOST_SRC.indexOf('{', HOST_SRC.indexOf(')', i))
  for (let k = bodyStart; k < HOST_SRC.length; k++) {
    if (HOST_SRC[k] === '{') depth++
    else if (HOST_SRC[k] === '}') {
      depth--
      if (depth === 0) {
        end = k + 1
        break
      }
    }
  }
  const body = HOST_SRC.slice(i, end)

  assert.match(body, /changed\s*\+=\s*1/, 'changed 必须真的累加（否则调用方看不出有没有覆盖）')
  assert.match(body, /conflicts\s*\+=\s*1/, 'conflicts 计数必须保留')
})

// ── T10-T12: 源文件不存在 / 不是文件 / 正常路径 ──────────

test('T10 【关键】合并源文件不存在时必须拒绝，不许返回 ok:true', () => {
  const i = HOST_SRC.indexOf('async function mergeLibrary')
  assert.ok(i >= 0, '找不到 mergeLibrary')

  let depth = 0
  let end = -1
  const bodyStart = HOST_SRC.indexOf('{', HOST_SRC.indexOf(')', i))
  for (let k = bodyStart; k < HOST_SRC.length; k++) {
    if (HOST_SRC[k] === '{') depth++
    else if (HOST_SRC[k] === '}') {
      depth--
      if (depth === 0) {
        end = k + 1
        break
      }
    }
  }
  const body = HOST_SRC.slice(i, end)
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')

  // 必须有 stat 存在性检查
  assert.match(body, /fsp\.stat\s*\(/, '必须先 stat 源文件，确认它真的存在')
  // 必须处理 ENOENT
  assert.match(body, /ENOENT/, '必须处理文件不存在（ENOENT）')
  // 必须给出明确错误码
  assert.match(body, /MERGE_SOURCE_NOT_FOUND/, '文件不存在要返回 MERGE_SOURCE_NOT_FOUND')
})

test('T11 路径是目录时也要拒绝（不能当空库合并）', () => {
  const i = HOST_SRC.indexOf('async function mergeLibrary')
  let depth = 0
  let end = -1
  const bodyStart = HOST_SRC.indexOf('{', HOST_SRC.indexOf(')', i))
  for (let k = bodyStart; k < HOST_SRC.length; k++) {
    if (HOST_SRC[k] === '{') depth++
    else if (HOST_SRC[k] === '}') {
      depth--
      if (depth === 0) {
        end = k + 1
        break
      }
    }
  }
  const body = HOST_SRC.slice(i, end)
  assert.match(body, /isFile\s*\(/, '必须用 isFile() 排除目录')
  assert.match(body, /MERGE_SOURCE_NOT_FILE/, '目录要返回 MERGE_SOURCE_NOT_FILE')
})

test('T12 存在性检查必须在读取内容之前', () => {
  const i = HOST_SRC.indexOf('async function mergeLibrary')
  const body = HOST_SRC.slice(i, i + 3000)
  const iStat = body.indexOf('fsp.stat')
  const iRead = body.indexOf('readLibraryCsv(src')
  assert.ok(iStat >= 0, '缺 stat 检查')
  assert.ok(iRead >= 0, '缺读取')
  assert.ok(iStat < iRead, 'stat 必须在 readLibraryCsv 之前 —— 否则读到空记录就被当空库')
})
