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
 * @param {{ identity?: object|null, dataDir?: string }} opts
 *   identity: null = 未绑定；{ 智能体, 项目 } = 已绑定
 */
export async function makeHostCtx(opts = {}) {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'qa-host-'))
  const identityRef = { value: opts.identity ?? null }

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
  const fakeSession = { id: 'qa-session' }
  services.sessionProjections = {
    stateOf: (_session, _key) => identityRef.value,
    register: (def) => {
      ctx._identityDef = def
      return () => {}
    },
  }

  /** 造一个带 .session 的假 agent（identityOfSync 要求 agent.session 存在） */
  const fakeAgent = { session: fakeSession }

  const { apply } = await import('../index.js')
  const dispose = apply(ctx, { dataDir })

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
