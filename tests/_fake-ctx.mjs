// qa 测试用假 ctx：只收集注册调用，不模拟任何宿主行为
//
// 依据：《架构说明》§十二.2「工具注册冒烟：用假 ctx 加载插件，检查 dtm_* 是否都注册了」
// 这是官方允许的冒烟方式，**不是**模拟 React/DOM（客户端才涉及 React）。

/**
 * 造一个最小 ctx。
 * - tools.register   收集工具定义
 * - systemPrompt.section 收集注入段（固定判据，进系统提示词前缀）
 * - systemPrompt.context 收集动态上下文（身份状态，进历史、不毁缓存）
 * - effect           立即执行并在 dispose 时回滚
 * - get              返回注入的服务（供 preset 惰性取宿主服务）
 * - logger           空实现
 *
 * ⚠️ 默认注入 `workingDirectory`：真实 Host 一定有这个服务，
 * 插件用它取 `项目`（会话工作目录名，2026-11-08 起由程序填）。
 * 假 ctx 不提供它，插件就取不到项目 → 所有写入报 PROJECT_EMPTY，
 * 测试会误报成「插件坏了」。所以要给一个与真实签名一致的桩：
 * `get(session)` 同步返回绝对路径。
 *
 * @param {object}   [opts]
 * @param {object}   [opts.services]  额外注入的服务（同键覆盖默认桩）
 * @param {string}   [opts.workingDir] 工作目录绝对路径，默认 '/work/dsh-tag-memory'
 */
export function createFakeCtx({ services = {}, workingDir = '/work/dsh-tag-memory' } = {}) {
  const tools = []
  const sections = []
  const contexts = []
  const disposers = []

  // 真实 Host 的 workingDirectory 服务：get(session) → 绝对路径（同步）
  const workingDirectory = {
    get() {
      return workingDir
    },
    async ensure() {
      return workingDir
    },
    get defaultDirectory() {
      return workingDir
    },
  }

  const ctx = {
    __tools: tools,
    __sections: sections,
    __contexts: contexts,
    __disposers: disposers,

    tools: {
      register(def) {
        tools.push(def)
        const dispose = () => {}
        disposers.push(dispose)
        return dispose
      },
    },

    systemPrompt: {
      section(opts) {
        sections.push(opts)
        const dispose = () => {}
        disposers.push(dispose)
        return dispose
      },
      context(opts) {
        contexts.push(opts)
        const dispose = () => {}
        disposers.push(dispose)
        return dispose
      },
    },

    effect(fn) {
      const ret = fn()
      if (typeof ret === 'function') disposers.push(ret)
      return ret
    },

    get(name) {
      // 调用方显式注入的服务优先（同键可覆盖默认桩）
      if (name in services) return services[name] ?? null
      if (name === 'workingDirectory') return workingDirectory
      return null
    },

    /**
     * 子上下文注入（cordis 的 ctx.inject(deps, callback)）。
     *
     * 宿主插件用 `ctx.inject(['typert'], cb)` 声明依赖后再注册 Remote 端点 ——
     * 因为 cordis 的 reflect.get(name, strict=true) 要求 fiber 已 ACTIVE，
     * apply() 同步阶段拿不到 typert。这里只要**同步调用回调**即可通过冒烟，
     * 传进去的 child 就是同一个 ctx（依赖已"满足"的近似）。
     *
     * @returns 一个带 dispose 的体（模拟 fiber）
     */
    inject(deps, callback) {
      const child = ctx
      const ret = typeof callback === 'function' ? callback(child) : undefined
      const dispose = typeof ret === 'function' ? ret : () => {}
      disposers.push(dispose)
      // 返回一个可 await、可 dispose 的体（cordis 的 fiber 形状）
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

    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
  }

  return ctx
}
