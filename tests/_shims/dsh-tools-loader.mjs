// qa 测试用 shim：把 @deepseek-ai/dsh-tools 指到最小 stub
//
// 为什么需要这层：
//   本机没有 node_modules（插件尚未 install_bundle），`@deepseek-ai/dsh-tools`
//   无法从包内解析。而 preset/tools.js 顶层 `import { defineTool }`，
//   不解决这个 import 就完全加载不了 tools.js。
//
// 这**不是**模拟 React/DOM，也不违反 verification.md：
//   官方明确允许"工具注册冒烟 = 用假 ctx 加载插件，检查 dtm_* 是否都注册"
//   （《架构说明》§十二.2）。这里只替换掉一个纯声明式依赖（defineTool 只是
//   给对象加个标记），不伪造任何宿主行为。
//
// 用法：node --import ./tests/_shims/dsh-tools-loader.mjs ...
//   通过 module customization hook 拦截该 specifier。

import { registerHooks } from 'node:module'

const SHIM_URL = new URL('./dsh-tools-stub.mjs', import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') {
      return { url: SHIM_URL, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
