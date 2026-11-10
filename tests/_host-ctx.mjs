// qa 测试用宿主 ctx 工厂
//
// 依据 host-dev 给出的契约：service 名 dtmHost，身份走 sessionProjections 投影。
// 关键顺序（他踩过坑）：投影服务必须在 apply() 之前挂好，否则注册投影时拿不到。
//
// 这不是模拟 React/DOM —— 宿主是 Node 侧纯逻辑，官方明确允许"假 ctx 加载插件"冒烟。

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 造一个能跑 index.js apply 的假 ctx。
 *
 * @param {{ identity?: object|null, dataDir?: string, workingDir?: string }} opts
 *   identity: null = 未绑定；{ 智能体, 项目 } = 已绑定
 *   workingDir: 会话工作目录绝对路径（`项目` 由程序从这里取 basename）
 */
export async function makeHostCtx(opts = {}) {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'qa-host-'))
  const identityRef = { value: opts.identity ?? null }
  const workingDir = opts.workingDir ?? '/work/qa-project'

  const services = {}

  const ctx = {
    _services: services,
    _identityRef: identityRef,
    _dataDir: dataDir,

    logger: {
      warn() {},
      info() {},
      error() {},
      debug() {},
    },

    effect(fn) {
      const ret = typeof fn === 'function' ? fn() : undefined
      return typeof ret === 'function' ? ret : () => {}
    },

    on() {
      return () => {}
    },

    provide(name, value) {
      services[name] = value
      return () => {
        delete services[name]
      }
    },

    get(name) {
      return services[name]
    },
    /**
     * 子上下文注入（cordis 的 ctx.inject(deps, callback)）。
     * 宿主用 ctx.inject(['typert'], cb) 延迟注册 Remote 端点，
     * 因为 apply() 同步阶段 fiber 还没 ACTIVE，ctx.get('typert') 拿不到。
     * 冒烟里同步调用回调、把同一个 ctx 当 child 传进去即可。
     */
    inject(deps, callback) {
      const child = ctx
      const ret = typeof callback === 'function' ? callback(child) : undefined
      const dispose = typeof ret === 'function' ? ret : () => {}
      const fiber = Promise.resolve()
      fiber.dispose = async () => {
        try {
          await dispose()
        } catch {
          /* 卸载期忽略 */
        }
      }
      return fiber
    },
  }

  // ⚠️ 投影服务必须在 apply 之前挂好
  // 真实签名：stateOf(session, key) —— 不是 stateOf()
  //
  // 语义要对齐真实宿主：`stateOf` 读的是**投影状态**，而 `dtm_bind` 会写它。
  // 所以这里不能返回一个永远不变的常量——否则 bindIdentity 绑了也白绑，
  // 测试会看到"绑定无效"的假象（2026-11-08 踩过：F1b 因此失败）。
  const fakeSession = {
    id: 'qa-session',
    // 真实 session 用 append 记录事件；投影服务据事件更新状态
    append(_type, data) {
      if (data && typeof data === 'object') identityRef.value = data
    },
  }
  services.sessionProjections = {
    stateOf: (_session, _key) => identityRef.value,
    register: (def) => {
      ctx._identityDef = def
      return () => {}
    },
  }

  // ⚠️ workingDirectory 也必须在 apply 之前挂好
  // 真实签名：get(session) → 绝对路径（同步）。插件用它取 `项目`
  // （2026-11-08 起归属由程序填，不再让模型决定）。
  services.workingDirectory = {
    get: (_session) => workingDir,
    async ensure() {
      return workingDir
    },
    defaultDirectory: workingDir,
  }

  /** 造一个带 .session 的假 agent（identityOfSync 要求 agent.session 存在） */
  const fakeAgent = { session: fakeSession }

  const { apply } = await import('../index.js')
  // seed: false —— 关掉「首次初始化铺包内初始记忆」。
  // 测试要的是**干净的空库**来断言「零新增」「只有 2 条」这类计数；
  // 若铺了 6 条初始记忆，计数全都要 +6，测试就不再是在验证代码逻辑，
  // 而是在验证包内那个 CSV 文件有几行。初始记忆的行为由专门的测试覆盖。
  const dispose = apply(ctx, { dataDir, seed: false })

  const host = services.dtmHost
  if (!host) throw new Error('apply 之后未提供 dtmHost 服务')

  return {
    ctx,
    host,
    dataDir,
    agent: fakeAgent,
    /** 切换绑定状态（测未绑定铁律最省事的开关） */
    setIdentity(v) {
      identityRef.value = v
    },
    cleanup() {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* 卸载期忽略 */
      }
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

/** 已绑定身份的默认值 */
export const BOUND = { 智能体: 'qa-agent', 项目: 'qa-project' }
