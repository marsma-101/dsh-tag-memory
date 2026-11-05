/**
 * 客户端入口（Client module）：模块装配、槽位注册、样式注入。
 *
 * 骨架阶段：只立结构，不写 UI。
 * 实际实现见 task-6（client-dev）。
 *
 * 官方形态（cordis-plugin-development/templates/decoration/client.js）：
 *   window.__ModuleLoader__.load({ id: '<包名>', factory(require) { ... } })
 * React 从浏览器模块表 require('react') 取，不用自己装。
 */
window.__ModuleLoader__.load({
  id: 'dsh-tag-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    function Placeholder() {
      return h('div', { style: { padding: 12 } }, '标签记忆（骨架占位）')
    }

    return {
      inject: ['slots'],
      apply(_ctx) {
        // 占位：slot 与页面在 task-6 确认后注册
      },
    }
  },
})
