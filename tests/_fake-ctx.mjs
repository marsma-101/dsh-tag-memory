// qa 测试用假 ctx：只收集注册调用，不模拟任何宿主行为
//
// 依据：《架构说明》§十二.2「工具注册冒烟：用假 ctx 加载插件，检查 dtm_* 是否都注册了」
// 这是官方允许的冒烟方式，**不是**模拟 React/DOM（客户端才涉及 React）。

/**
 * 造一个最小 ctx。
 * - tools.register   收集工具定义
 * - systemPrompt.section 收集注入段
 * - effect           立即执行并在 dispose 时回滚
 * - get              返回注入的服务（供 preset 惰性取宿主服务）
 * - logger           空实现
 */
export function createFakeCtx({ services = {} } = {}) {
  const tools = []
  const sections = []
  const disposers = []

  const ctx = {
    __tools: tools,
    __sections: sections,
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
    },

    effect(fn) {
      const ret = fn()
      if (typeof ret === 'function') disposers.push(ret)
      return ret
    },

    get(name) {
      return services[name] ?? null
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
