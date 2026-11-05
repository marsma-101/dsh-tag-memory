// 闸门③ 补充：客户端 API 层行为（5 条）
//
// client-dev 已自测 5 个场景。我独立复核，并**补他未覆盖的边界**。
//
// 方法：把 client.js 里纯 JS 的 API 相关函数源码抽出，用 new Function 组装执行。
//   · 只抽「纯逻辑函数」（codec / error / createApi / hasApi / createLazyApi）
//   · **不碰 React、不碰 DOM、不渲染任何组件** → 不违反 verification.md 的
//     "不许模拟 React/DOM"（这条禁令针对的是"用假 React 假装验证了 UI 渲染"）
//   · 这是《架构说明》§十二.1 允许的"引擎单测"同级做法：能脱离框架跑的逻辑，直接跑

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(process.cwd(), 'client.js'), 'utf8')

/** 按大括号配对，裁出 `function name(...) { ... }` 的完整源码 */
function grab(name) {
  const start = SRC.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`client.js 里找不到 function ${name}`)
  let i = SRC.indexOf('{', start)
  let depth = 0
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++
    else if (SRC[i] === '}') {
      depth--
      if (depth === 0) return SRC.slice(start, i + 1)
    }
  }
  throw new Error(`function ${name} 大括号不配对`)
}

/** 组装出可执行的 API 模块（纯逻辑，无 React） */
function buildApiModule() {
  const code = [
    'const REMOTE_NS = "tagMemory";',
    'const PACKAGE_NAME = "dsh-tag-memory";',
    grab('passthroughCodec'),
    grab('businessError'),
    grab('transportError'),
    grab('createApi'),
    grab('hasApi'),
    grab('createLazyApi'),
    'return { createApi, hasApi, createLazyApi };',
  ].join('\n')

  // eslint-disable-next-line no-new-func
  return new Function(code)()
}

const M = buildApiModule()

/* ------------------------------------------------------------------ *
 * API1 未挂载 → 明确错误，不是静默返回空数据
 * ------------------------------------------------------------------ */
test('API1 命名空间未挂载 → hasApi=false、ready()=false、调用抛 REMOTE_UNAVAILABLE', async () => {
  const ctx = { remote: {} }

  assert.equal(M.hasApi(ctx), false, '未挂载时 hasApi 必须是 false')

  const lazy = M.createLazyApi(ctx)
  assert.equal(lazy.ready(), false, '未挂载时 ready() 必须是 false')

  await assert.rejects(
    () => lazy.getOverview(),
    (err) => {
      assert.equal(err.code, 'REMOTE_UNAVAILABLE', `应抛 REMOTE_UNAVAILABLE，实际 ${err.code}`)
      assert.match(String(err.message), /not mounted|未挂载|mount/i, `错误信息应说明未挂载，实际：${err.message}`)
      return true
    },
    '未挂载时调用必须抛明确错误，不得静默返回空数据（那会变成假数据）',
  )
})

/* ------------------------------------------------------------------ *
 * API2 正常路径
 * ------------------------------------------------------------------ */
test('API2 正常挂载 → 各方法返回宿主 value，且外层 carrier 被剥掉', async () => {
  const calls = []
  const ctx = {
    remote: {
      tagMemory: {
        getOverview: async (args) => {
          calls.push(['getOverview', args])
          return { ok: true, value: { total: 3 } }
        },
        listEntries: async (args) => {
          calls.push(['listEntries', args])
          return { ok: true, value: { items: [{ 编号: 'M-1' }], total: 1 } }
        },
      },
    },
  }

  assert.equal(M.hasApi(ctx), true)

  const api = M.createApi(ctx)
  const overview = await api.getOverview()
  assert.deepEqual(overview, { total: 3 }, '必须返回内层 value，不是整个 carrier 外壳')

  const list = await api.listEntries({ page: 1 })
  assert.deepEqual(list.items, [{ 编号: 'M-1' }])

  // 参数透传检查
  assert.deepEqual(calls[0][1], {}, '无参方法必须传 {} （assertExactArguments 要求 plain object）')
  assert.deepEqual(calls[1][1], { page: 1 }, '有参方法必须原样透传')
})

/* ------------------------------------------------------------------ *
 * API3 外层失败（gateway carrier）
 * ------------------------------------------------------------------ */
test('API3 外层 carrier 失败（outer.ok !== true）→ 抛 transportError', async () => {
  const ctx = {
    remote: {
      tagMemory: {
        getOverview: async () => ({ ok: false, error: { code: 'gateway/internal', message: 'boom' } }),
      },
    },
  }

  await assert.rejects(
    () => M.createApi(ctx).getOverview(),
    (err) => {
      assert.equal(err.code, 'gateway/internal', `应透传 gateway 错误码，实际 ${err.code}`)
      assert.match(String(err.message), /boom/)
      return true
    },
  )
})

/* ------------------------------------------------------------------ *
 * API4 【关键】内层业务失败必须抛错，不能当成功
 * ------------------------------------------------------------------ */
test('API4 【关键】内层 value.ok===false → 必须抛业务错误（否则非法修改会被当成已保存）', async () => {
  const ctx = {
    remote: {
      tagMemory: {
        retagEntry: async () => ({
          ok: true, // 外层成功
          value: {
            ok: false, // 内层业务失败
            code: 'TAG_CONTAINS_PIPE',
            errors: [{ message: '自由标签「a|b」含保留字符 |，请改写该标签后重试。' }],
          },
        }),
      },
    },
  }

  await assert.rejects(
    () => M.createApi(ctx).retagEntry({ 编号: 'M-1', patch: { 自由标签: ['a|b'] }, basis: 'b' }),
    (err) => {
      assert.equal(err.code, 'TAG_CONTAINS_PIPE', `必须抛业务错误码，实际 ${err.code}`)
      // 点名到具体标签的要求必须透传到用户眼前
      assert.match(String(err.message), /a\|b/, `错误信息必须点名到具体标签，实际：${err.message}`)
      return true
    },
    '只判外层 ok 会把业务失败当成功——用户改了非法标签却看到"已保存"，这是严重缺陷',
  )
})

/* ------------------------------------------------------------------ *
 * API5 惰性代理：晚挂载后能自动用上（原缺陷的回归测试）
 * ------------------------------------------------------------------ */
test('API5 惰性代理：先注册后挂载（模拟 $mount 异步）→ 挂载后无需重建即可用', async () => {
  const ctx = { remote: {} }

  // 模拟 slot 注册阶段：此时命名空间还不存在
  const lazy = M.createLazyApi(ctx)
  assert.equal(lazy.ready(), false, '注册时（未挂载）ready() 应为 false')

  // 注册完成后，异步 $mount 才把命名空间挂上。
  // 注意：hasApi() 以 `listEntries` 作为"命名空间已挂载"的探针，
  // 所以 mock 必须包含它（真实 $mount 会挂上全部 9 个方法）。
  ctx.remote.tagMemory = {
    getOverview: async () => ({ ok: true, value: { total: 42 } }),
    listEntries: async () => ({ ok: true, value: { items: [] } }),
  }

  // 关键：同一个 lazy 对象，现在必须能取到数据（不需要重建）
  assert.equal(lazy.ready(), true, '挂载后 ready() 应变 true')
  const value = await lazy.getOverview()
  assert.deepEqual(value, { total: 42 }, '挂载晚到时，同一个惰性代理必须自动用上（这是原缺陷的回归点）')
})

/* ------------------------------------------------------------------ *
 * API6 惰性代理与其他 api 方法行为一致
 * ------------------------------------------------------------------ */
test('API6 惰性代理与 createApi 行为一致（含错误透传）', async () => {
  const ctxInnerFail = {
    remote: {
      tagMemory: {
        retagEntry: async () => ({ ok: true, value: { ok: false, code: 'FIELD_NOT_EDITABLE', errors: [{ message: '不可改' }] } }),
      },
    },
  }

  const lazy = M.createLazyApi(ctxInnerFail)
  await assert.rejects(
    () => lazy.retagEntry({}),
    (err) => {
      assert.equal(err.code, 'FIELD_NOT_EDITABLE', '惰性代理也必须透传内层业务错误')
      return true
    },
  )

  // 9 个方法都必须挂在 lazy 上
  const METHODS = ['getOverview', 'listEntries', 'getFacets', 'getSettings',
    'retagEntry', 'migrateDataDir', 'backupNow', 'restore', 'mergeLibrary']
  for (const name of METHODS) {
    assert.equal(typeof lazy[name], 'function', `惰性代理缺少方法 ${name}`)
  }
  assert.equal(typeof lazy.ready, 'function', '惰性代理必须有 ready()')
})
