// 闸门① B 组：自由标签 `|` 序列化（5 条）
//
// 依据：《架构说明》§8.1 第 2/3 条、§8.2（比对不受格式影响）、《功能说明》§十四「存储（CSV）」。
// Q5 裁定：空标签列读回 []，不是 ['']。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { tagsToCell, tagCellToArray } from '../../lib/engine/core.mjs'
import schema from '../../lib/engine/templates/schema.json' with { type: 'json' }

/* ------------------------------------------------------------------ *
 * B1 三个标签 join / split 往返，顺序保留
 * ------------------------------------------------------------------ */
test('B1 三标签 join/split 往返 → 数组完全相等（含顺序）', () => {
  const tags = ['发版检查', '需先build', '部署']
  const cell = tagsToCell(tags)

  assert.equal(cell, '发版检查|需先build|部署', `落盘必须是 | 连接，实际「${cell}」`)
  assert.deepEqual(tagCellToArray(cell), tags, '读回数组必须完全相等（含顺序）')
})

/* ------------------------------------------------------------------ *
 * B2 单标签
 * ------------------------------------------------------------------ */
test('B2 单标签 → 单元格无 | ，读回长度 1', () => {
  const cell = tagsToCell(['csv'])
  assert.equal(cell, 'csv')
  assert.equal(cell.includes('|'), false, '单标签单元格不得含 |')
  assert.deepEqual(tagCellToArray(cell), ['csv'])
})

/* ------------------------------------------------------------------ *
 * B3 空数组 → 单元格空，读回 []（不是 ['']）  —— Q5 裁定
 * ------------------------------------------------------------------ */
test("B3 空数组 → 读回 []，不是 ['']（Q5 裁定）", () => {
  const cell = tagsToCell([])
  assert.equal(cell, '', '空数组落盘必须是空单元格')

  const back = tagCellToArray('')
  assert.deepEqual(back, [], `空单元格必须读回 []，实际 ${JSON.stringify(back)}`)
  assert.notDeepEqual(back, [''], "绝不允许读回 ['']")

  const back2 = tagCellToArray(cell)
  assert.deepEqual(back2, [], '空数组 → 空单元格 → 仍应读回 []')
})

/* ------------------------------------------------------------------ *
 * B4 比对结果不受格式影响（架构 §8.2：麻烦只在序列化那两行）
 * ------------------------------------------------------------------ */
test('B4 落盘往返后再算交集/占比 → 与内存数组结果完全一致', () => {
  /** 规范化 + 求交集（按《流程_读取》§4.2 语义，只做集合运算，不做归一表） */
  const norm = (arr) => Array.from(new Set(arr.map((s) => String(s).trim()).filter((s) => s !== '')))
  const hitOf = (a, b) => {
    const sb = new Set(norm(b))
    return norm(a).filter((t) => sb.has(t))
  }

  const entryTags = ['发版检查', '需先build', '部署']
  const queryTags = ['发版检查', '部署']

  // 内存态（未落盘）
  const inMemory = hitOf(queryTags, entryTags)

  // 落盘再读回
  const cell = tagsToCell(entryTags)
  const restored = tagCellToArray(cell)
  const afterDisk = hitOf(queryTags, restored)

  assert.deepEqual(afterDisk, inMemory, '落盘往返不得改变交集结果')
  assert.equal(afterDisk.length, 2)

  const eRatioMemory = inMemory.length / norm(entryTags).length
  const eRatioDisk = afterDisk.length / restored.length
  assert.equal(eRatioDisk, eRatioMemory, 'e_ratio 必须完全一致')
  assert.equal(eRatioMemory, 2 / 3)

  const qRatioMemory = inMemory.length / norm(queryTags).length
  const qRatioDisk = afterDisk.length / norm(queryTags).length
  assert.equal(qRatioDisk, qRatioMemory, 'q_ratio 必须完全一致')
})

/* ------------------------------------------------------------------ *
 * B5 序列化层遇 | 不做替身替换（拒写责任在 write.mjs）
 * ------------------------------------------------------------------ */
test('B5 序列化层遇 | 不做替身替换 → 原样交上层；拒写责任在 write 校验', () => {
  // 含 | 的"标签"在序列化层会被原样拼进去（这是为什么要拒写，不是要这里静默替换）
  const cell = tagsToCell(['发版检查', 'a|b', '部署'])
  assert.equal(cell, '发版检查|a|b|部署', '序列化层必须原样拼接，不得偷偷把 | 换成别的字符')

  // 读回会串位：3 个标签读成 4 个（《待查证问题》实测数据）
  const back = tagCellToArray(cell)
  assert.equal(back.length, 4, `含 | 的标签读回必然串位成 4 个，实际 ${back.length} 个`)
  assert.deepEqual(back, ['发版检查', 'a', 'b', '部署'], '串位结果正是要拒写的理由')

  // 换句话说：序列化层不该"修复"它，写入校验必须拦在序列化之前
  assert.notEqual(back.length, 3, '若这里变成 3，说明序列化层做了不该做的替身替换')
})
