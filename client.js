/**
 * dsh-tag-memory — 客户端入口（Client module）
 *
 * 官方形态（cordis-plugin-development/templates/decoration/client.js）：
 *   window.__ModuleLoader__.load({ id: '<包名>', factory(require) { ... } })
 *
 * 硬规矩（踩了必返工）：
 *  1. 不 import 任何 Harness Client 包（`@deepseek-ai/dsh-client-ui-primitives` 等）；
 *     控件全部自己写，样式自己写。
 *  2. 不用 iframe 载入宿主 HTML；页面就是 slot 里的 React 组件。
 *  3. React 从浏览器模块表 require('react') 取，不自己装。
 *  4. 样式只用 `--dsw-alias-*` 主题 token（字面色只用于 artwork，本文件没有 artwork）。
 *  5. 注册必须写在 `ctx.slots.inject(ownerKey, () => ctx.slots.register(...))` 的回调里，
 *     这样 owner 塌陷时自动销毁、回来时自动重装。
 *  6. 可见文案走 Client locale 服务（`ctx.locale`），不硬编码。
 *
 * 槽位选型（已查实，非猜测）：
 *   `plugins.bundle.config`，key = 本包包名 `dsh-tag-memory`
 *   - 声明方：`dsh-client-ui-plugin-manager/lib/client.js:2964`
 *     `renderSlot("plugins.bundle.config", { view: "page" }, { entryKey: pkg.name })`
 *   - 契约：`dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:148-157`
 *     kind: 'keyed' / scope: 'root' / owner props 仅 `{ view, form? }`
 *   - 与《功能说明》§10.1「从「插件」列表进，不占左侧栏」一致。
 *
 * 单文件结构（Lead 裁定：首版单入口，逻辑按页面分区，物理同文件）：
 *   分区 1 模块头 → 分区 2 样式 → 分区 3 通用件 → 分区 4 记忆条目页
 *   → 分区 5 设置页 → 分区 6 入口 apply
 */

window.__ModuleLoader__.load({
  id: 'dsh-tag-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dtm'

    // ===================================================================
    // 分区 2：样式
    //
    // 只用 `--dsw-alias-*` 主题 token。token 清单核对自
    // `dsh-client-ui-theme/lib/client.js`（明暗两套由宿主切换，这里不写死任何颜色）。
    // 类名统一 `dtm-` 前缀，避免与宿主或其它插件冲突。
    // 样式以 React 元素形式渲染在组件内，组件卸载即移除（不往 document.head 写东西）。
    // ===================================================================

    const CSS = `
.dtm-root{display:flex;flex-direction:column;gap:0;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;box-sizing:border-box;width:100%;min-width:0}
.dtm-root *,.dtm-root *::before,.dtm-root *::after{box-sizing:border-box}

/* ---- 标签栏 ---- */
.dtm-tabs{display:flex;align-items:center;gap:4px;border-bottom:.5px solid var(--dsw-alias-border-l2);margin-bottom:16px}
.dtm-tab{appearance:none;border:none;background:0 0;font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:8px 12px;border-radius:8px 8px 0 0;border-bottom:2px solid transparent;transition:color .1s cubic-bezier(.4,0,.2,1),background-color .1s cubic-bezier(.4,0,.2,1)}
.dtm-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dtm-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:500}
.dtm-tab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}

/* ---- 通用文本 ---- */
.dtm-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px;margin:0}
.dtm-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px;margin:0}
.dtm-caption{color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px;margin:0}
.dtm-mono{font-family:var(--ds-font-family-code);font-size:12px}

/* ---- 面板 / 卡片 ---- */
.dtm-section{border:.5px solid var(--dsw-alias-border-l4);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:16px;margin-bottom:12px}
.dtm-section-head{display:flex;flex-direction:column;gap:4px;margin-bottom:12px}
.dtm-row{display:flex;align-items:center;gap:8px}
.dtm-row-between{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dtm-stack{display:flex;flex-direction:column;gap:8px}
.dtm-empty{padding:32px 16px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px}

/* ---- 按钮（自己写，不引 primitives）---- */
.dtm-btn{appearance:none;font:inherit;font-size:13px;line-height:20px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 14px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);transition:background-color .1s cubic-bezier(.4,0,.2,1)}
.dtm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dtm-btn:disabled{color:var(--dsw-alias-label-caption);cursor:default;opacity:.6}
.dtm-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dtm-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted)}
.dtm-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);color:var(--dsw-alias-label-primary-inverted)}
.dtm-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}

/* ---- 错误框 / 警告条 ---- */
.dtm-error{border:.5px solid var(--dsw-alias-state-error-primary);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:12px 16px;display:flex;flex-direction:column;gap:8px}
.dtm-error-title{color:var(--dsw-alias-state-error-primary);font-size:13px;font-weight:500;line-height:20px;margin:0}
.dtm-error-body{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin:0;white-space:pre-wrap;word-break:break-word}
.dtm-warn{border:.5px solid var(--dsw-alias-state-warn-primary);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:8px 12px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}

/* ---- 无障碍：仅屏幕阅读器可见 ---- */
.dtm-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}

/* ---- 表单控件（自己写，不引 primitives）---- */
.dtm-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.dtm-field-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dtm-input{appearance:none;font:inherit;font-size:13px;line-height:20px;height:32px;padding:0 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);width:100%;min-width:0;outline:none}
.dtm-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dtm-input:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}
.dtm-input:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent)}
.dtm-input:disabled{color:var(--dsw-alias-label-caption);cursor:default}
.dtm-input-sm{height:28px;font-size:12px;padding:0 8px;width:auto;min-width:64px}
textarea.dtm-input{height:auto;padding:8px 10px;resize:vertical;line-height:20px}

/* ---- 筛选栏 ---- */
.dtm-filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;align-items:end}
.dtm-field-wide{grid-column:span 2}
.dtm-field-actions{justify-content:flex-end}

/* ---- 库概况 ---- */
.dtm-overview{display:flex;flex-wrap:wrap;align-items:baseline;gap:20px;padding:12px 16px;border:.5px solid var(--dsw-alias-border-l4);border-radius:12px;background:var(--dsw-alias-bg-layer-1);margin-bottom:12px}
.dtm-stat{display:flex;flex-direction:column;gap:2px;min-width:0}
.dtm-stat-num{color:var(--dsw-alias-label-primary);font-size:20px;line-height:28px;font-variant-numeric:tabular-nums}
.dtm-stat-path{flex:1;min-width:200px}
.dtm-stat-path code{word-break:break-all;color:var(--dsw-alias-label-secondary)}

/* ---- 表格 ---- */
.dtm-table-wrap{overflow:auto;border:.5px solid var(--dsw-alias-border-l4);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.dtm-table{width:100%;border-collapse:collapse;font-size:13px;line-height:20px;table-layout:fixed;min-width:900px}
.dtm-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;padding:10px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2);white-space:nowrap;background:var(--dsw-alias-bg-layer-2);position:sticky;top:0;z-index:1}
.dtm-table td{padding:10px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2);vertical-align:top;color:var(--dsw-alias-label-primary)}
.dtm-table tbody tr:last-child td{border-bottom:none}
.dtm-table tbody tr:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dtm-table tbody tr[data-dtm-editing="1"]{background:var(--dsw-alias-bg-layer-2)}
.dtm-cell-readonly{color:var(--dsw-alias-label-secondary)}
.dtm-cell-readonly[data-dtm-readonly="content"]{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary)}
.dtm-nowrap{white-space:nowrap}
.dtm-cell-tags{display:flex;flex-wrap:wrap;gap:4px}
.dtm-cell-actions{white-space:nowrap;text-align:right}
.dtm-chip{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dtm-btn-sm{height:28px;padding:0 10px;font-size:12px}

/* ---- 分页 ---- */
.dtm-pager{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding-top:12px}

/* ---- 编辑面板 ---- */
.dtm-editor{border:.5px solid var(--dsw-alias-border-l4);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:16px;display:flex;flex-direction:column;gap:14px}
.dtm-editor-readonly{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2)}
.dtm-readonly-block{display:flex;flex-direction:column;gap:2px}
.dtm-readonly-label{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dtm-readonly-value{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;word-break:break-word}
.dtm-readonly-value.dtm-pre{white-space:pre-wrap;color:var(--dsw-alias-label-primary)}
.dtm-editor-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;align-items:start}
.dtm-editor-note{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;padding:8px 12px;border-left:2px solid var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-2);border-radius:8px}
.dtm-editor-actions{display:flex;align-items:center;gap:8px;justify-content:flex-end}

/* ---- 标签编辑器 ---- */
.dtm-tags-editor{display:flex;flex-direction:column;gap:8px}
.dtm-tags-list{display:flex;flex-wrap:wrap;gap:6px;min-height:22px}
.dtm-chip-editable{padding-right:2px;gap:2px}
.dtm-chip-invalid{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dtm-chip-x{appearance:none;border:none;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;font-size:14px;line-height:1;padding:0 4px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center}
.dtm-chip-x:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dtm-chip-x:disabled{cursor:default;opacity:.5}
.dtm-chip-x:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}

/* ---- 设置页 ---- */
.dtm-kv{display:flex;align-items:baseline;gap:12px;padding:6px 0;min-width:0}
.dtm-kv-key{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;min-width:88px;flex-shrink:0}
.dtm-kv-val{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;word-break:break-all;min-width:0}
.dtm-kv-val.dtm-chips{display:flex;flex-wrap:wrap;gap:4px}
.dtm-inline-form{display:flex;flex-direction:column;gap:8px;margin-top:12px;padding:12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2)}
.dtm-list{margin:0;padding-left:20px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:22px;display:flex;flex-direction:column;gap:2px}
.dtm-dict-pre{margin:8px 0 0;padding:12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;max-height:280px;overflow:auto}

/* ---- 弹窗（自己实现焦点管理与 Escape，抄宿主行为不抄代码）---- */
.dtm-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb, var(--dsw-alias-bg-base) 72%, transparent);backdrop-filter:none}
.dtm-modal{width:100%;max-width:520px;max-height:calc(100vh - 48px);overflow:auto;display:flex;flex-direction:column;gap:12px;padding:20px;border-radius:16px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-overlay);box-shadow:none;outline:none}
.dtm-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.dtm-modal-x{appearance:none;border:none;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;font-size:18px;line-height:1;padding:2px 6px;border-radius:4px;flex-shrink:0}
.dtm-modal-x:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dtm-modal-x:disabled{cursor:default;opacity:.5}
.dtm-modal-x:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}
.dtm-modal-body{display:flex;flex-direction:column;gap:8px}
.dtm-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding-top:4px}
.dtm-backup-list{display:flex;flex-direction:column;gap:4px;max-height:180px;overflow:auto;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;padding:4px}
.dtm-backup-item{appearance:none;border:none;background:0 0;font:inherit;text-align:left;cursor:pointer;display:flex;flex-direction:column;gap:2px;padding:6px 8px;border-radius:4px;color:var(--dsw-alias-label-primary)}
.dtm-backup-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dtm-backup-item:disabled{cursor:default;opacity:.6}
.dtm-backup-item-selected{background:var(--dsw-alias-bg-layer-2);outline:.5px solid var(--dsw-alias-state-business-primary)}
.dtm-backup-item:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.dtm-backup-name{font-size:13px;line-height:20px}
`

    // ===================================================================
    // 分区 3b：宿主调用层（等价于架构里的 client.api.js）
    //
    // **所有对宿主的调用集中在 createApi 里**，页面只认这里的方法签名，
    // 不认识任何传输细节（命令 / Remote / Base64 信封都不出现在页面代码里）。
    //
    // 契约来自 host-dev（2026-11-05 对齐）：
    //   - namespace `tagMemory`，session-free（root-scope 页面可用）
    //   - 每个远程调用返回 **两层** 结果：
    //       外层（carrier）：{ ok:true, value } | { ok:false, error }
    //       内层（业务）：  value.ok === false 表示宿主明确拒绝
    //     **两层都要判**，只判外层会把业务失败当成功。
    //   - 业务错误优先取 errors[0].message（engine 带可直接展示的措辞）
    //
    // 传输实现（已实测确认，2026-11-05）：
    //   `ctx.remote.$mount(contribution)` 需要 descriptor；
    //   `$mount` 的 `requireStrictCodec` 强制**入参** codec 为 `strict` 且带 `create`，
    //   但 `result` 不受此限，可用 `src-json`（返回值形状完全自由）。
    //   spec 构造单独抽在 `buildRemoteSpec()`，**换传输只改那一处**，
    //   上层的 call()/createApi() 与所有页面代码都不用动。
    // ===================================================================

    /** 宿主方法名 → 传参（便于一处看清全部契约面）。 */
    const REMOTE_NS = 'tagMemory'

    /** 本包名：Remote contribution 的 package 字段，必须与模块 id 一致。 */
    const PACKAGE_NAME = 'dsh-tag-memory'

    /**
     * 入参 codec 的 passthrough 解析器。
     *
     * 为什么能这么写（依据 + 实测，不是猜）：
     *  1. `$mount` 的 `requireStrictCodec` 强制 `codec.mode === 'strict'`，
     *     且 `strict` 必须带 `create` 工厂（`dsh-api-gateway/lib/client.browser.js`）。
     *     所以参数 codec **不能**用 `src-json`，必须给 `create`。
     *  2. 但 `TypertSchema<T>` 只承诺 `parse(value: unknown): T`
     *     （`dsh-typert-protocol` README），所以 `create` 只要返回带 `parse` 的对象即可。
     *  3. 宿主侧 `decode()` 会调 `codec.create().parse(value)` 再走 `assertJsonValue`。
     *     这里原样返回 = 「前端不做校验，交给宿主业务层」——**校验不在这层**，
     *     真正的强制在宿主方法里（host 会再校验一遍，不信前端）。
     *
     * 这**不是**死代码：它会被宿主执行，只是有意不做任何判断。
     */
    function passthroughCodec(typeSymbol) {
      return {
        mode: 'strict',
        typeSymbol: typeSymbol,
        create: function () {
          return {
            parse: function (value) {
              return value
            },
          }
        },
      }
    }

    /**
     * 9 个宿主方法的 Remote 描述符。
     *
     * 契约与 host 侧对齐：
     *  - namespace `tagMemory`，**session-free**（root-scope 插件页可调）
     *  - `invocation.kind: 'direct'`（不是 Context receiver）
     *  - 每个参数**显式** `source: 'json'`：不写会掉进 lookup 分支（静默陷阱）
     *  - `result.mode: 'src-json'`：`requireStrictInputs` 只查 parameters，不查 result
     *  - 不写 `jsonSchema`：宿主 `assertExactArguments` 只用 `parameter.wire`，
     *    客户端也从不读 `jsonSchema`（两处已核实）
     *
     * **所有调用都必须传对象**：`assertExactArguments` 要求 `args` 是 plain object，
     * 连无参方法也不能传 `undefined`（实测：`args must be a plain object`）。
     * 所以 `createApi` 里每个无参调用都显式传 `{}`。
     */
    function buildRemoteSpec() {
      return {
        package: PACKAGE_NAME,
        methods: {
          'tagMemory/getOverview': {
            service: REMOTE_NS,
            description: '记忆库概况：条目总数、各状态计数、数据目录与来源。',
            invocation: { kind: 'direct' },
            parameters: [],
            result: { mode: 'src-json' },
          },

          'tagMemory/listEntries': {
            service: REMOTE_NS,
            description: '按筛选与分页列出记忆条目（只读，不记台账、不动时距）。',
            invocation: { kind: 'direct' },
            parameters: [
              {
                name: 'query',
                source: 'json',
                wire: 'query',
                codec: passthroughCodec(PACKAGE_NAME + '/types#ListEntriesQuery'),
              },
            ],
            result: { mode: 'src-json' },
          },

          'tagMemory/getFacets': {
            service: REMOTE_NS,
            description: '去重后的项目值与智能体值，供筛选与编辑时的候选列表。',
            invocation: { kind: 'direct' },
            parameters: [],
            result: { mode: 'src-json' },
          },

          'tagMemory/getSettings': {
            service: REMOTE_NS,
            description: '设置页数据：库位置与来源、备份、自动整理、字典原文。',
            invocation: { kind: 'direct' },
            parameters: [],
            result: { mode: 'src-json' },
          },

          'tagMemory/retagEntry': {
            service: REMOTE_NS,
            description: '改一条记忆的 6 个可改字段。与 dtm_retag 共用同一宿主实现。',
            invocation: { kind: 'direct' },
            parameters: [
              {
                name: 'request',
                source: 'json',
                wire: 'request',
                codec: passthroughCodec(PACKAGE_NAME + '/types#RetagPayload'),
              },
            ],
            result: { mode: 'src-json' },
          },

          'tagMemory/migrateDataDir': {
            service: REMOTE_NS,
            description: '把数据目录搬到包外的新位置。被部署配置或环境变量锁定时返回明确错误。',
            invocation: { kind: 'direct' },
            parameters: [
              {
                name: 'request',
                source: 'json',
                wire: 'request',
                codec: passthroughCodec(PACKAGE_NAME + '/types#MigratePayload'),
              },
            ],
            result: { mode: 'src-json' },
          },

          'tagMemory/backupNow': {
            service: REMOTE_NS,
            description: '立即备份记忆库到数据目录的 backup/。',
            invocation: { kind: 'direct' },
            parameters: [],
            result: { mode: 'src-json' },
          },

          'tagMemory/listBackups': {
            service: REMOTE_NS,
            description: '列出已有备份，供恢复弹窗点选。',
            invocation: { kind: 'direct' },
            parameters: [],
            result: { mode: 'src-json' },
          },

          'tagMemory/restore': {
            service: REMOTE_NS,
            description: '用一份备份覆盖当前记忆库（覆盖前先自动备份当前库）。',
            invocation: { kind: 'direct' },
            parameters: [
              {
                name: 'request',
                source: 'json',
                wire: 'request',
                codec: passthroughCodec(PACKAGE_NAME + '/types#RestorePayload'),
              },
            ],
            result: { mode: 'src-json' },
          },

          'tagMemory/mergeLibrary': {
            service: REMOTE_NS,
            description: '合并另一份记忆库（编号唯一、同号保留较新）。',
            invocation: { kind: 'direct' },
            parameters: [
              {
                name: 'request',
                source: 'json',
                wire: 'request',
                codec: passthroughCodec(PACKAGE_NAME + '/types#MergePayload'),
              },
            ],
            result: { mode: 'src-json' },
          },
        },
      }
    }

    /**
     * 把 `buildRemoteSpec()` 的纯声明转成 `$mount` 能吃的 contribution。
     *
     * **为什么不用官方的 `createTypertRemoteInfo`**：
     * 它来自 `@deepseek-ai/dsh-typert-protocol`，而该包**不在浏览器基线模块表**里
     * （基线只有 react / react-dom / zod / cordis / ui-slots / ui-primitives /
     * ui-dockkit / client-store / @tanstack/react-virtual —— 已从
     * `dsh-web-frontend/dist/assets/index-*.js` 的 PLATFORM_MODULES 逐项核对）。
     * 而官方明令**禁止 import 任何 Harness Client 包**，所以不能 require 它。
     *
     * 因此这里内置一份**等价的最小实现**，只做 spec → descriptor 的必要转换：
     *   - 从 `"ns/method"` 拆出 namespace 与 method
     *   - 补 `wire`（缺省取 `name`）
     *   - 补 `id`（`<package>#<endpoint>`）
     *   - 给 direct 方法补 `invoke()`（按 wire 取值后转调命名空间方法）
     * 不实现 `NamedInput` / JSON Schema 投影 —— 客户端调用不经过它们
     * （真实的调用走 `ctx.remote.tagMemory.<method>()`，由 Gateway 组装参数）。
     *
     * @param {object} spec `{ package, methods }`
     * @returns {{ package: string, descriptors: object[], methods: object }}
     */
    function toContribution(spec) {
      const descriptors = []
      const methods = Object.create(null)

      for (const endpoint in spec.methods) {
        if (!Object.prototype.hasOwnProperty.call(spec.methods, endpoint)) continue
        const definition = spec.methods[endpoint]
        const separator = endpoint.indexOf('/')
        const namespace = endpoint.slice(0, separator)
        const method = endpoint.slice(separator + 1)

        const parameters = (definition.parameters || []).map(function (parameter) {
          const copy = {}
          for (const key in parameter) {
            if (Object.prototype.hasOwnProperty.call(parameter, key)) copy[key] = parameter[key]
          }
          // wire 缺省取 name（与官方 remote-info 一致）
          copy.wire = parameter.wire == null ? parameter.name : parameter.wire
          return copy
        })

        const descriptor = {}
        for (const key in definition) {
          if (Object.prototype.hasOwnProperty.call(definition, key)) descriptor[key] = definition[key]
        }
        descriptor.id = spec.package + '#' + endpoint
        descriptor.namespace = namespace
        descriptor.method = method
        descriptor.parameters = parameters

        if (definition.invocation && definition.invocation.kind === 'direct') {
          const direct = Object.assign(descriptor, {
            // 与官方一致：按 wire 依次取值后转调命名空间方法。
            // 实际调用路径不经这里，但提供它是 descriptor 的完整形态。
            invoke: function (remote, input, signal) {
              const named = input || {}
              const values = parameters.map(function (parameter) {
                return named[parameter.wire]
              })
              if (definition.cancellation !== undefined) values.push(signal)
              const receiver = remote[namespace]
              const fn = receiver[method]
              return fn.apply(receiver, values)
            },
          })
          methods[endpoint] = direct
        }

        descriptors.push(descriptor)
      }

      return { package: spec.package, descriptors: descriptors, methods: methods }
    }

    /** 业务失败时抛的错误：带 code 与 details，供页面原样展示。 */
    function businessError(method, value) {
      const first = value && Array.isArray(value.errors) ? value.errors[0] : null
      // 优先级：宿主 `message` 是**可直接给用户看的中文整句**（host 明确约定），
      // `errors[]` 只是程序细节，仅在没有 message 时兜底。
      const message =
        (value && value.message) ||
        (first && (first.message || first.detail)) ||
        'remote method rejected: ' + method
      const e = new Error(message)
      e.code = (value && (value.code || value.blocked)) || 'BUSINESS_REJECTED'
      e.details = (value && value.errors) || null
      return e
    }

    /** 传输层失败（命名空间缺失 / carrier 报错）。 */
    function transportError(method, code, message) {
      const e = new Error(message || 'remote call failed: ' + method)
      e.code = code || 'REMOTE_UNAVAILABLE'
      e.details = null
      return e
    }

    /**
     * 造宿主调用门面。
     *
     * @param {object} ctx 客户端 cordis 上下文
     * @returns 页面用的 api 对象；命名空间尚未挂上时各方法会抛明确错误
     */
    function createApi(nsRef) {
      function namespace() {
        return nsRef.current
      }

      async function call(method) {
        const args = Array.prototype.slice.call(arguments, 1)
        const ns = namespace()
        const fn = ns && ns[method]
        if (typeof fn !== 'function') {
          throw transportError(
            method,
            'REMOTE_UNAVAILABLE',
            'remote namespace "' + REMOTE_NS + '.' + method + '" is not mounted yet',
          )
        }

        // 注意：**每个调用都必须传一个对象**，无参方法传 `{}`。
        // `assertExactArguments` 要求 args 是 plain object，传 `undefined` 会被拒：
        //   "gateway/arguments-invalid: args must be a plain object"
        // （实测确认；不是可选的风格问题，是硬要求）
        const outer = await fn.apply(ns, args.length === 0 ? [{}] : args)
        if (!outer || outer.ok !== true) {
          const err = (outer && outer.error) || {}
          throw transportError(method, err.code, err.message)
        }

        // ---- 内层：宿主业务结果 ----
        const value = outer.value
        if (value && value.ok === false) {
          throw businessError(method, value)
        }
        return value
      }

      return {
        // 读
        getOverview: function () { return call('getOverview') },
        // listEntries 的 query 必须是对象；页面永远传完整对象，这里再兜一层
        listEntries: function (query) { return call('listEntries', query || {}) },
        getFacets: function () { return call('getFacets') },
        getSettings: function () { return call('getSettings') },

        // 写（与 dtm_retag 共用同一宿主方法；键名用 `编号`，与工具一致）
        retagEntry: function (payload) { return call('retagEntry', payload || {}) },

        // 搬家 / 备份 / 恢复 / 合并
        migrateDataDir: function (payload) { return call('migrateDataDir', payload || {}) },
        backupNow: function () { return call('backupNow') },
        listBackups: function () { return call('listBackups') },
        restore: function (payload) { return call('restore', payload || {}) },
        mergeLibrary: function (payload) { return call('mergeLibrary', payload || {}) },
      }
    }

    /**
     * 判断 api 是否真的可用（命名空间已挂上）。
     * 页面用它决定显示"未接线"还是真数据，**不伪造数据**。
     */
    function hasApi(nsRef) {
        const ns = nsRef.current
      return !!(ns && typeof ns.listEntries === 'function')
    }

    /**
     * 惰性宿主门面。
     *
     * 为什么不能直接给 `createApi(ctx)` 的快照：
     *   `ctx.remote.$mount()` 是**异步**的，而 slot 的 `inject` 面在注册时就求值。
     *   若在注册时探 `hasApi(ctx)`，首次必然是 false，页面会永远卡在"未接线"。
     *
     * 这里每个方法都是**调用时才探命名空间**，所以：
     *   - 挂载晚到 → 第一次点"刷新"或页面重渲染后就能用上
     *   - 挂载失败 → 调用时抛明确错误（页面显示原因，不白屏）
     *
     * 同时提供一个 `ready()` 供页面/调试判断当前是否真的连上。
     */
      function createLazyApi(nsRef) {
        const api = createApi(nsRef)
        const lazy = { ready: function () { return hasApi(nsRef) } }
      const methods = [
        'getOverview', 'listEntries', 'getFacets', 'getSettings',
        'retagEntry', 'migrateDataDir', 'backupNow', 'listBackups', 'restore', 'mergeLibrary',
      ]
      methods.forEach(function (name) {
        lazy[name] = function () {
          // 每次调用都走 createApi 里的 `call()`，它自己会重新探命名空间并给出明确错误
          return api[name].apply(api, arguments)
        }
      })
      return lazy
    }

    // ===================================================================
    // 分区 3：通用件
    // ===================================================================

    /**
     * 渲染错误边界：渲染出错时显示可读错误 + 不白屏。
     *
     * 《功能说明》§10.5 明确要求「渲染出错时显示错误信息……出错显示可读错误 + 切标签按钮，不白屏」。
     * 同时官方 `practices.md` 警告：组件抛错会让宿主控制台出现
     * `slot entry crashed in '<slot>'` —— 这个边界就是用来杜绝它的。
     */
    class DtmErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
        this.handleSwitchTab = this.handleSwitchTab.bind(this)
      }

      static getDerivedStateFromError(error) {
        return { error: error || new Error('unknown render error') }
      }

      componentDidCatch(error, info) {
        // 只记录，不上抛 —— 上抛会让宿主接管并触发 slot entry crashed
        const detail = info && info.componentStack ? info.componentStack : ''
        if (typeof console !== 'undefined' && console.error) {
          console.error('[dsh-tag-memory] render error:', error, detail)
        }
      }

      handleSwitchTab() {
        // 出错后允许切回安全标签页，让用户至少能离开故障页
        this.setState({ error: null })
        if (typeof this.props.onRecover === 'function') this.props.onRecover()
      }

      render() {
        const { error } = this.state
        if (!error) return this.props.children

        const t = translateOf(this.props)
        const msg = error && error.message ? error.message : String(error)
        return h(
          'div',
          { className: 'dtm-root', 'data-dtm-error': '1' },
          h('style', null, CSS),
          h(
            'div',
            { className: 'dtm-error', role: 'alert' },
            h('p', { className: 'dtm-error-title' }, t('errorTitle')),
            h('p', { className: 'dtm-error-body' }, msg),
            h(
              'div',
              { className: 'dtm-row' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dtm-btn',
                  onClick: this.handleSwitchTab,
                },
                t('errorSwitchTab'),
              ),
            ),
          ),
        )
      }
    }

    /**
     * 安全取翻译函数。
     *
     * 官方 `locale: NS` 会把 `t` 注入到 slot props（见
     * `dsh-client-ui-plugin-manager/README.zh.md:76-80` 的
     * `({ t, view }) => ...` 与 cot-translation 的 `TranslationSettings`）。
     * 但**万一字典还没注册好或宿主换了注入形态**，直接 `t(...)` 会抛错——
     * 而组件抛错会让宿主打出 `slot entry crashed in 'plugins.bundle.config'`。
     * 所以这里兜一层：拿不到 `t` 就回退到静态中文，绝不让渲染因为文案而崩。
     */
    function translateOf(props) {
      const fallback = props && props.__fallbackDict ? props.__fallbackDict : LOCALE_ZH
      if (props && typeof props.t === 'function') {
        return function (key) {
          try {
            const value = props.t(key)
            // 宿主未命中 key 时会回显 key 本身，这时退到静态字典更有用
            if (typeof value === 'string' && value !== key) return value
          } catch (_) {
            /* 落到下面的回退 */
          }
          return fallback[key] !== undefined ? fallback[key] : key
        }
      }
      return function (key) {
        return fallback[key] !== undefined ? fallback[key] : key
      }
    }

    /** 空态占位：统一措辞，不各处自造。 */
    function DtmEmpty(props) {
      return h('div', { className: 'dtm-empty' }, props.text)
    }

    /** 警告条：用于「包内数据目录有被 pnpm 重装删掉的风险」这类必须说清的事。 */
    function DtmWarn(props) {
      return h(
        'div',
        { className: 'dtm-warn', role: 'note' },
        props.children,
      )
    }

    /**
     * 标签栏。
     *
     * 可访问性按官方 practices 抄宿主做法：`role="tablist"` + `role="tab"` +
     * `aria-selected`，并支持左右方向键在标签间移动焦点。
     */
    function DtmTabs(props) {
      const { tabs, active, onSelect, t } = props
      const refs = React.useRef({})

      function onKeyDown(event) {
        const key = event.key
        if (key !== 'ArrowLeft' && key !== 'ArrowRight') return
        event.preventDefault()
        const index = tabs.findIndex(function (x) { return x.id === active })
        if (index < 0) return
        const delta = key === 'ArrowRight' ? 1 : -1
        const next = tabs[(index + delta + tabs.length) % tabs.length]
        onSelect(next.id)
        const node = refs.current[next.id]
        if (node && typeof node.focus === 'function') node.focus()
      }

      return h(
        'div',
        {
          className: 'dtm-tabs',
          role: 'tablist',
          'aria-label': t('tabsLabel'),
          onKeyDown,
        },
        tabs.map(function (tab) {
          const selected = tab.id === active
          return h(
            'button',
            {
              key: tab.id,
              type: 'button',
              role: 'tab',
              id: 'dtm-tab-' + tab.id,
              'aria-selected': selected ? 'true' : 'false',
              'aria-controls': 'dtm-panel-' + tab.id,
              tabIndex: selected ? 0 : -1,
              className: 'dtm-tab',
              ref: function (node) { refs.current[tab.id] = node },
              onClick: function () { onSelect(tab.id) },
            },
            t(tab.labelKey),
          )
        }),
      )
    }

    // ===================================================================
    // 分区 4：记忆条目页
    //
    // 步骤 2 填充：库概况、筛选、表格、分页、编辑入口、导出。
    //
    // 结构上分两半：**纯展示组件**（本分区先写完，不依赖宿主）与
    // **数据接线**（等 Lead 定下 Base64 信封协议后接 `client.api.js`）。
    //
    // ────────────────────────────────────────────────────────────────
    // 【只读字段的实现原则 —— 硬要求，qa 会专门验】
    //
    // `编号` / `主要内容` / `时距` 这三个字段在 UI 上**只渲染 span/div 纯文本**，
    // 绝不渲染 input / select / textarea / contenteditable 元素。
    //
    // **只读靠"不存在可写控件"实现，不靠 disabled/readonly 属性**——
    // 属性可能被绕过或误改（devtools 去掉 disabled、脚本改 readonly、
    // 复制粘贴控件模板时漏带属性），不存在的控件不会。
    //
    // 这条比"设 readonly 属性"更彻底：攻击面为零，因为压根没有可写的入口。
    // ────────────────────────────────────────────────────────────────

    /** 六个形态（取值域来自《功能说明》§四，顺序固定）。 */
    const SHAPES = ['技能', '流程', '规则', '偏好', '事实', '模板']
    /** 稳定性三态（《架构说明》§八）。 */
    const STABILITIES = ['观察', '稳定', '易变']
    /** 状态三态（《架构说明》§八）。 */
    const STATUSES = ['生效', '被取代', '已归档']
    /** 两个隔离维度的通用取值（《架构说明》§九）。 */
    const UNIVERSAL = ['通用', '引入']

    /** 自由标签上限（《功能说明》§6.4）。 */
    const TAGS_MAX = 20

    /**
     * 筛选栏。
     *
     * 纯受控组件：值来自 `value`，改动回调 `onChange(patch)`。
     * 项目/智能体用 `datalist` 给候选（防打错字导致隔离失效，《功能说明》§10.3），
     * 但允许自由输入 —— 因为用户可能确实要新建一个项目名。
     */
    function FilterBar(props) {
      const t = translateOf(props)
      const { value, onChange, facets, busy } = props
      const v = value || {}

      function patch(key, next) {
        const draft = {}
        for (const k in v) if (Object.prototype.hasOwnProperty.call(v, k)) draft[k] = v[k]
        draft[key] = next
        onChange(draft)
      }

      function selectField(labelKey, key, options, placeholderKey) {
        const id = 'dtm-filter-' + key
        return h(
          'div',
          { className: 'dtm-field' },
          h('label', { className: 'dtm-field-label', htmlFor: id }, t(labelKey)),
          h(
            'select',
            {
              id,
              className: 'dtm-input',
              value: v[key] || '',
              disabled: !!busy,
              onChange: function (e) { patch(key, e.target.value) },
            },
            h('option', { value: '' }, t(placeholderKey || 'filterAny')),
            options.map(function (opt) {
              return h('option', { key: opt, value: opt }, opt)
            }),
          ),
        )
      }

      const projectId = 'dtm-filter-project'
      const agentId = 'dtm-filter-agent'
      const tagId = 'dtm-filter-tags'
      // 宿主 getFacets() 用**中文键**返回（与 CSV 列名/台账字段一致，零映射）：
      //   { 项目:[], 智能体:[], 形态:[], 状态:[], 稳定性:[], allowedShapes:[], ... }
      const projects = (facets && facets['项目']) || []
      const agents = (facets && facets['智能体']) || []
      // 取值域优先用宿主给的 allowed*（来自 schema.json），拿不到再退回内置常量，
      // 这样以后改取值域只改宿主侧，前端不用跟。
      const shapeOptions =
        facets && Array.isArray(facets.allowedShapes) && facets.allowedShapes.length
          ? facets.allowedShapes
          : SHAPES
      const statusOptions =
        facets && Array.isArray(facets.allowedStatuses) && facets.allowedStatuses.length
          ? facets.allowedStatuses
          : STATUSES

      return h(
        'div',
        { className: 'dtm-filters', 'data-dtm-filters': '1' },
        selectField('filterShape', 'shape', shapeOptions),
        selectField('filterStatus', 'status', statusOptions),

        // 项目：datalist 给候选，可自由输入
        h(
          'div',
          { className: 'dtm-field' },
          h('label', { className: 'dtm-field-label', htmlFor: projectId }, t('filterProject')),
          h('input', {
            id: projectId,
            className: 'dtm-input',
            type: 'text',
            list: 'dtm-facet-projects',
            value: v.project || '',
            disabled: !!busy,
            placeholder: t('filterAny'),
            autoComplete: 'off',
            onChange: function (e) { patch('project', e.target.value) },
          }),
          h(
            'datalist',
            { id: 'dtm-facet-projects' },
            UNIVERSAL.concat(projects).map(function (opt) {
              return h('option', { key: opt, value: opt })
            }),
          ),
        ),

        // 智能体：同上
        h(
          'div',
          { className: 'dtm-field' },
          h('label', { className: 'dtm-field-label', htmlFor: agentId }, t('filterAgent')),
          h('input', {
            id: agentId,
            className: 'dtm-input',
            type: 'text',
            list: 'dtm-facet-agents',
            value: v.agent || '',
            disabled: !!busy,
            placeholder: t('filterAny'),
            autoComplete: 'off',
            onChange: function (e) { patch('agent', e.target.value) },
          }),
          h(
            'datalist',
            { id: 'dtm-facet-agents' },
            UNIVERSAL.concat(agents).map(function (opt) {
              return h('option', { key: opt, value: opt })
            }),
          ),
        ),

        // 自由标签：空格/回车分隔，做交集筛选
        h(
          'div',
          { className: 'dtm-field dtm-field-wide' },
          h('label', { className: 'dtm-field-label', htmlFor: tagId }, t('filterTags')),
          h('input', {
            id: tagId,
            className: 'dtm-input',
            type: 'text',
            value: v.tagsText || '',
            disabled: !!busy,
            placeholder: t('filterTagsHint'),
            autoComplete: 'off',
            onChange: function (e) { patch('tagsText', e.target.value) },
          }),
        ),

        h(
          'div',
          { className: 'dtm-field dtm-field-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dtm-btn',
              disabled: !!busy,
              onClick: function () {
                onChange({ shape: '', project: '', agent: '', status: '', tagsText: '' })
              },
            },
            t('filterClear'),
          ),
        ),
      )
    }

    /**
     * 表格单元格：只读纯文本。
     *
     * **再次强调**：这里只产出 `span`/`div`，不产出任何可写控件。
     * 三个受保护字段（编号/主要内容/时距）全部走这个组件。
     */
    function ReadOnlyCell(props) {
      const cls = 'dtm-cell-readonly' + (props.mono ? ' dtm-mono' : '') + (props.nowrap ? ' dtm-nowrap' : '')
      return h(
        'span',
        {
          className: cls,
          'data-dtm-readonly': props.field || '1',
          title: props.title,
        },
        props.children,
      )
    }

    /** 条目表格：一批行 + 每行「编辑」按钮（编辑面板在步骤 3）。 */
    function EntryTable(props) {
      const t = translateOf(props)
      const { items, onEdit, editingId } = props

      if (!items || items.length === 0) {
        return h(DtmEmpty, { text: t('entriesEmpty') })
      }

      return h(
        'div',
        { className: 'dtm-table-wrap' },
        h(
          'table',
          { className: 'dtm-table' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', { scope: 'col' }, t('colId')),
              h('th', { scope: 'col' }, t('colContent')),
              h('th', { scope: 'col' }, t('colShape')),
              h('th', { scope: 'col' }, t('colProject')),
              h('th', { scope: 'col' }, t('colAgent')),
              h('th', { scope: 'col' }, t('colTags')),
              h('th', { scope: 'col' }, t('colStability')),
              h('th', { scope: 'col' }, t('colTick')),
              h('th', { scope: 'col' }, t('colStatus')),
              h('th', { scope: 'col' }, h('span', { className: 'dtm-sr-only' }, t('colActions'))),
            ),
          ),
          h(
            'tbody',
            null,
            items.map(function (row) {
              const id = row['编号']
              const isEditing = editingId === id
              return h(
                'tr',
                {
                  key: id,
                  'data-dtm-row': id,
                  'data-dtm-editing': isEditing ? '1' : undefined,
                },
                // 编号：只读
                h('td', null, h(ReadOnlyCell, { field: 'id', mono: true, nowrap: true }, id)),
                // 主要内容：只读（可能很长，带换行，用 CSS 保留换行并截断）
                h(
                  'td',
                  { className: 'dtm-cell-content' },
                  h(ReadOnlyCell, { field: 'content', title: row['主要内容'] }, row['主要内容']),
                ),
                h('td', null, row['形态'] || '—'),
                h('td', null, row['项目'] || '—'),
                h('td', null, row['智能体'] || '—'),
                h(
                  'td',
                  { className: 'dtm-cell-tags' },
                  (row['自由标签'] || []).map(function (tag) {
                    return h('span', { key: tag, className: 'dtm-chip' }, tag)
                  }),
                ),
                h('td', null, row['稳定性'] || '—'),
                // 时距：只读
                h('td', null, h(ReadOnlyCell, { field: 'tick', nowrap: true }, String(row['时距'] == null ? '—' : row['时距']))),
                h('td', null, row['状态'] || '—'),
                h(
                  'td',
                  { className: 'dtm-cell-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dtm-btn dtm-btn-sm',
                      'aria-expanded': isEditing ? 'true' : 'false',
                      onClick: function () { onEdit(isEditing ? null : id) },
                    },
                    isEditing ? t('actionClose') : t('actionEdit'),
                  ),
                ),
              )
            }),
          ),
        ),
      )
    }

    /** 分页器。页码从 1 开始；总数为 0 时不给按钮。 */
    function Pager(props) {
      const t = translateOf(props)
      const { page, pageSize, total, onPage, onPageSize, busy } = props
      const pageCount = pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1

      return h(
        'div',
        { className: 'dtm-pager', 'data-dtm-pager': '1' },
        h(
          'span',
          { className: 'dtm-caption' },
          t('pageSummary')
            .replace('{page}', String(page))
            .replace('{pages}', String(pageCount))
            .replace('{total}', String(total)),
        ),
        h(
          'div',
          { className: 'dtm-row' },
          h(
            'label',
            { className: 'dtm-caption', htmlFor: 'dtm-page-size' },
            t('pageSize'),
          ),
          h(
            'select',
            {
              id: 'dtm-page-size',
              className: 'dtm-input dtm-input-sm',
              value: String(pageSize),
              disabled: !!busy,
              onChange: function (e) { onPageSize(Number(e.target.value)) },
            },
            [10, 20, 50, 100].map(function (n) {
              return h('option', { key: n, value: String(n) }, String(n))
            }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dtm-btn dtm-btn-sm',
              disabled: !!busy || page <= 1,
              onClick: function () { onPage(page - 1) },
            },
            t('pagePrev'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dtm-btn dtm-btn-sm',
              disabled: !!busy || page >= pageCount,
              onClick: function () { onPage(page + 1) },
            },
            t('pageNext'),
          ),
        ),
      )
    }

    /**
     * 库概况：总数 / 各状态计数 / 数据目录 / 生效来源。
     * 数据由宿主给（`getOverview`），这里只负责画。
     *
     * 宿主返回的是**扁平计数**（不是 byStatus 对象）：
     *   { total, active, superseded, archived, dataDir, dataDirSource }
     * 所以按状态名映射到对应字段，而不是去查 byStatus。
     */
    const STATUS_COUNT_FIELD = {
      生效: 'active',
      被取代: 'superseded',
      已归档: 'archived',
    }

    function OverviewBar(props) {
      const t = translateOf(props)
      const { overview } = props
      if (!overview) return null

      function countOf(status) {
        const field = STATUS_COUNT_FIELD[status]
        const n = field ? overview[field] : undefined
        return String(n == null ? 0 : n)
      }

      return h(
        'div',
        { className: 'dtm-overview', 'data-dtm-overview': '1' },
        h(
          'div',
          { className: 'dtm-stat' },
          h('span', { className: 'dtm-stat-num' }, String(overview.total == null ? 0 : overview.total)),
          h('span', { className: 'dtm-caption' }, t('statTotal')),
        ),
        STATUSES.map(function (s) {
          return h(
            'div',
            { className: 'dtm-stat', key: s },
            h('span', { className: 'dtm-stat-num' }, countOf(s)),
            h('span', { className: 'dtm-caption' }, s),
          )
        }),
        overview.dataDir
          ? h(
              'div',
              { className: 'dtm-stat dtm-stat-path' },
              h('span', { className: 'dtm-caption' }, t('statDataDir')),
              h('code', { className: 'dtm-mono' }, overview.dataDir),
            )
          : null,
      )
    }

    // ────────────────────────────────────────────────────────────────
    // 条目编辑面板（《功能说明》§10.3 —— 本题的验收重点）
    //
    // 可改 6 个：`形态` / `项目` / `智能体` / `自由标签` / `稳定性` / `状态`
    // 只读 3 个：`主要内容` / `编号` / `时距`
    //
    // 只读的 3 个在这里**渲染成纯文本块**（`ReadOnlyBlock`），
    // 连 `disabled` 的 input 都不给 —— 没有可写控件，就没有可绕过的属性。
    // 理由（写进代码，qa 会看）：
    //   原文是一手材料（改了就不是原始记录）、编号是唯一标识、时距是程序计数器。
    //
    // 本组件**不做任何宿主调用**：它只收集草稿并通过 `onSave(draft)` 交出去，
    // 真正的保存由 `client.api.js` → 宿主同一方法执行（与 `dtm_retag` 共用实现）。
    // ────────────────────────────────────────────────────────────────

    /** 只读文本块：给「编号/主要内容/时距」这种绝对不能改的字段用。 */
    function ReadOnlyBlock(props) {
      return h(
        'div',
        {
          className: 'dtm-readonly-block',
          'data-dtm-readonly-block': props.field,
          // 语义上声明只读，但**真正的保障是没有可写控件**，不是这个属性
          'aria-readonly': 'true',
        },
        h('span', { className: 'dtm-readonly-label' }, props.label),
        h(
          'span',
          { className: 'dtm-readonly-value' + (props.mono ? ' dtm-mono' : '') + (props.pre ? ' dtm-pre' : '') },
          props.children,
        ),
      )
    }

    /** 自由标签编辑器：chip + 输入框，回车/空格加，× 删。 */
    function TagsEditor(props) {
      const t = translateOf(props)
      const { tags, onChange, disabled } = props
      const [text, setText] = React.useState('')
      const list = Array.isArray(tags) ? tags : []

      function addTag(raw) {
        const parts = String(raw || '')
          .split(/[\s,，]+/)
          .map(function (s) { return s.trim() })
          .filter(Boolean)
        if (parts.length === 0) return
        const next = list.slice()
        for (const p of parts) {
          if (next.indexOf(p) >= 0) continue
          if (next.length >= TAGS_MAX) break
          next.push(p)
        }
        onChange(next)
        setText('')
      }

      function removeTag(tag) {
        onChange(list.filter(function (x) { return x !== tag }))
      }

      return h(
        'div',
        { className: 'dtm-tags-editor' },
        h(
          'div',
          { className: 'dtm-tags-list' },
          list.map(function (tag) {
            // 前端即时提示保留符问题（真正拒写在宿主/engine，这里只是让用户少跑一趟）
            const illegal = tag.indexOf('|') >= 0
            return h(
              'span',
              {
                key: tag,
                className: 'dtm-chip dtm-chip-editable' + (illegal ? ' dtm-chip-invalid' : ''),
                title: illegal ? t('tagIllegalPipe') : tag,
              },
              tag,
              h(
                'button',
                {
                  type: 'button',
                  className: 'dtm-chip-x',
                  'aria-label': t('tagRemove') + ': ' + tag,
                  disabled: !!disabled,
                  onClick: function () { removeTag(tag) },
                },
                '×',
              ),
            )
          }),
        ),
        h('input', {
          className: 'dtm-input',
          type: 'text',
          value: text,
          disabled: !!disabled,
          placeholder: t('tagAddHint'),
          autoComplete: 'off',
          onChange: function (e) { setText(e.target.value) },
          onKeyDown: function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              addTag(text)
            } else if (e.key === 'Backspace' && text === '' && list.length > 0) {
              onChange(list.slice(0, -1))
            }
          },
          onBlur: function () { if (text.trim()) addTag(text) },
        }),
        h(
          'span',
          { className: 'dtm-caption' },
          t('tagCount').replace('{n}', String(list.length)).replace('{max}', String(TAGS_MAX)),
        ),
      )
    }

    /**
     * 编辑面板本体。
     *
     * @param {object} props
     * @param {object} props.row      原始条目（9 列，中文键）
     * @param {object} props.facets   `{ projects: string[], agents: string[] }` 候选值
     * @param {function} props.onSave 收草稿：`{ patch, before }`
     * @param {function} props.onCancel
     */
    function EntryEditor(props) {
      const t = translateOf(props)
      const { row, facets, busy, error, onSave, onCancel } = props

      // 草稿：只含 6 个可改字段。只读字段不进 draft，从源头杜绝误提交。
      const [draft, setDraft] = React.useState(function () {
        return {
          形态: row['形态'] || '',
          项目: row['项目'] || '',
          智能体: row['智能体'] || '',
          自由标签: Array.isArray(row['自由标签']) ? row['自由标签'].slice() : [],
          稳定性: row['稳定性'] || '',
          状态: row['状态'] || '',
        }
      })

      function set(key, value) {
        setDraft(function (prev) {
          const next = {}
          for (const k in prev) if (Object.prototype.hasOwnProperty.call(prev, k)) next[k] = prev[k]
          next[key] = value
          return next
        })
      }

      // 宿主 getFacets() 用中文键（与 CSV 列名一致）
      const projects = (facets && facets['项目']) || []
      const agents = (facets && facets['智能体']) || []
      // 取值域优先取宿主 allowed*（来自 lib/engine/templates/schema.json），
      // 拿不到再退回内置常量 —— 改取值域只改宿主，前端不用跟。
      const shapeOptions =
        facets && Array.isArray(facets.allowedShapes) && facets.allowedShapes.length
          ? facets.allowedShapes
          : SHAPES
      const stabilityOptions =
        facets && Array.isArray(facets.allowedStabilities) && facets.allowedStabilities.length
          ? facets.allowedStabilities
          : STABILITIES
      const statusOptions =
        facets && Array.isArray(facets.allowedStatuses) && facets.allowedStatuses.length
          ? facets.allowedStatuses
          : STATUSES

      function submit() {
        // 只提交 6 个可改字段；`before` 供宿主写 tidy.jsonl 的改动前后值。
        //
        // 键名与工具 `dtm_retag` **完全一致**（`编号` / `patch` / `basis`），
        // 这样 UI 与工具落到同一个宿主方法的同一个参数形状，没有分叉判断。
        //   basis: 'user_edit' —— 区分"用户手动改"与"整理时模型改"
        //   who:   null        —— root 页面拿不到会话身份，宿主会落成「（用户手动）」
        const before = {
          形态: row['形态'],
          项目: row['项目'],
          智能体: row['智能体'],
          自由标签: Array.isArray(row['自由标签']) ? row['自由标签'].slice() : [],
          稳定性: row['稳定性'],
          状态: row['状态'],
        }
        onSave({
          编号: row['编号'],
          patch: draft,
          basis: 'user_edit',
          who: null,
          before: before,
        })
      }

      function selectRow(labelKey, key, options) {
        const id = 'dtm-edit-' + key
        return h(
          'div',
          { className: 'dtm-field' },
          h('label', { className: 'dtm-field-label', htmlFor: id }, t(labelKey)),
          h(
            'select',
            {
              id,
              className: 'dtm-input',
              value: draft[key],
              disabled: !!busy,
              onChange: function (e) { set(key, e.target.value) },
            },
            h('option', { value: '' }, '—'),
            options.map(function (opt) {
              return h('option', { key: opt, value: opt }, opt)
            }),
          ),
        )
      }

      function comboRow(labelKey, key, options) {
        const id = 'dtm-edit-' + key
        const listId = 'dtm-edit-list-' + key
        return h(
          'div',
          { className: 'dtm-field' },
          h('label', { className: 'dtm-field-label', htmlFor: id }, t(labelKey)),
          h('input', {
            id,
            className: 'dtm-input',
            type: 'text',
            list: listId,
            value: draft[key],
            disabled: !!busy,
            autoComplete: 'off',
            // 候选来自宿主已有值 —— 防打错字导致隔离失效（§10.3 硬要求）
            onChange: function (e) { set(key, e.target.value) },
          }),
          h(
            'datalist',
            { id: listId },
            UNIVERSAL.concat(options).map(function (opt) {
              return h('option', { key: opt, value: opt })
            }),
          ),
        )
      }

      return h(
        'div',
        { className: 'dtm-editor', 'data-dtm-editor': row['编号'] },

        // ---- 只读区：三字段纯文本，无任何可写控件 ----
        h(
          'div',
          { className: 'dtm-editor-readonly' },
          h(
            'p',
            { className: 'dtm-desc' },
            t('editorReadonlyHint'),
          ),
          h(ReadOnlyBlock, { field: 'id', label: t('colId'), mono: true }, row['编号']),
          h(ReadOnlyBlock, { field: 'content', label: t('colContent'), pre: true }, row['主要内容']),
          h(
            ReadOnlyBlock,
            { field: 'tick', label: t('colTick') },
            String(row['时距'] == null ? '—' : row['时距']),
          ),
        ),

        // ---- 可编辑区：6 个字段 ----
        h(
          'div',
          { className: 'dtm-editor-fields' },
          selectRow('colShape', '形态', shapeOptions),
          comboRow('colProject', '项目', projects),
          comboRow('colAgent', '智能体', agents),
          selectRow('colStability', '稳定性', stabilityOptions),
          selectRow('colStatus', '状态', statusOptions),
          h(
            'div',
            { className: 'dtm-field dtm-field-wide' },
            h('span', { className: 'dtm-field-label' }, t('colTags')),
            h(TagsEditor, {
              tags: draft['自由标签'],
              disabled: !!busy,
              onChange: function (next) { set('自由标签', next) },
            }),
          ),
        ),

        // ---- 提示条：只改标签，原文不动 ----
        h(
          'p',
          { className: 'dtm-editor-note' },
          t('editorNote'),
        ),

        error
          ? h('p', { className: 'dtm-error-body', role: 'alert' }, error)
          : null,

        h(
          'div',
          { className: 'dtm-editor-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dtm-btn dtm-btn-primary',
              disabled: !!busy,
              onClick: submit,
            },
            busy ? t('editorSaving') : t('editorSave'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dtm-btn',
              disabled: !!busy,
              onClick: onCancel,
            },
            t('editorCancel'),
          ),
        ),
      )
    }

    /**
     * 记忆条目页（真正带状态的版本）。
     *
     * 数据来源全部经由 `props.api`，本组件**不认识任何传输细节**：
     * 它只调 `api.listEntries(...)` / `api.retagEntry(...)` 这类方法。
     * 这样无论宿主最终用命令 + Base64 信封还是别的通道，**页面代码都不用改**
     * （传输实现集中在 `client.api.js`，等 Lead 定协议后接）。
     *
     * `api` 缺省时进"未接线"状态：显示明确说明，**不伪造数据**。
     */
    function EntriesPage(props) {
      const t = translateOf(props)
      const api = props.api

      const [filters, setFilters] = React.useState({
        shape: '', project: '', agent: '', status: '', tagsText: '',
      })
      const [page, setPage] = React.useState(1)
      const [pageSize, setPageSize] = React.useState(20)
      const [items, setItems] = React.useState(null)
      const [total, setTotal] = React.useState(0)
      const [overview, setOverview] = React.useState(null)
      const [facets, setFacets] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [loadError, setLoadError] = React.useState(null)
      const [editingId, setEditingId] = React.useState(null)
      const [editingRow, setEditingRow] = React.useState(null)
      const [saveError, setSaveError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)

      // 生成发给宿主的查询参数：自由标签按空白拆成数组（交集筛选）
      const query = React.useMemo(function () {
        return {
          shape: filters.shape || null,
          project: filters.project || null,
          agent: filters.agent || null,
          status: filters.status || null,
          tags: filters.tagsText
            ? filters.tagsText.split(/[\s,，]+/).filter(Boolean)
            : [],
          page: page,
          pageSize: pageSize,
        }
      }, [filters, page, pageSize])

      const load = React.useCallback(function () {
        if (!api) return
        let alive = true
        setBusy(true)
        setLoadError(null)
        // 并行取三份数据。宿主明确要求接口干净：listEntries 只返回 {items,total}，
        // 概况与候选各走自己的方法。数据都在同一个 Node 进程里读本地文件，
        // 并行没有网络往返成本，不必为"省一次调用"把它们塞进一个返回。
        // 概况/候选取失败不让整页失败（列表才是主体），所以各自 catch 成 null。
        Promise.all([
          api.listEntries(query),
          api.getOverview().catch(function () { return null }),
          api.getFacets().catch(function () { return null }),
        ])
          .then(function (results) {
            if (!alive) return
            const list = results[0] || {}
            // 宿主返回 { items, rows, total }；items 与 rows 是同一数组，优先 items
            setItems(list.items || list.rows || [])
            setTotal(list.total == null ? 0 : list.total)
            if (results[1]) setOverview(results[1])
            if (results[2]) setFacets(results[2])
          })
          .catch(function (err) {
            if (!alive) return
            setLoadError(err && err.message ? err.message : String(err))
          })
          .then(function () { if (alive) setBusy(false) })
        return function () { alive = false }
      }, [api, query])

      // 首次与筛选/分页变化时重新取
      React.useEffect(function () {
        return load()
      }, [load])

      function openEditor(id) {
        if (id === null) {
          setEditingId(null)
          setEditingRow(null)
          setSaveError(null)
          return
        }
        const row = (items || []).filter(function (r) { return r['编号'] === id })[0]
        setEditingId(id)
        setEditingRow(row || null)
        setSaveError(null)
        setNotice(null)
      }

      function saveEntry(payload) {
        // 方法与工具 `dtm_retag` 共用同一个宿主实现（一个操作、两个调用者）。
        if (!api) {
          setSaveError(t('editorNoApi'))
          return
        }
        setBusy(true)
        setSaveError(null)
        // createApi 已把两层失败都转成 reject，成功分支拿到的必定是业务成功值。
        Promise.resolve()
          .then(function () { return api.retagEntry(payload) })
          .then(function () {
            setEditingId(null)
            setEditingRow(null)
            setNotice(t('editorSaved'))
            return load()
          })
          .catch(function (err) {
            // 宿主拒绝的原因（未绑定/字段不可改/标签含 |…）直接展示，不吞掉
            setSaveError(err && err.message ? err.message : String(err))
          })
          .then(function () { setBusy(false) })
      }

      // ---- 未接线状态：诚实说明，不假装有数据 ----
      //
      // `api` 永远是惰性代理对象（不是 null），所以用 `api.ready()` 判断命名空间
      // 是否真的挂上。挂载是异步的：这里显示提示，用户看到后点「重试」即可，
      // 一旦 `ctx.remote.tagMemory` 出现，`load()` 就会取到真数据。
      const wired = !!(api && typeof api.ready === 'function' && api.ready())
      if (!wired && !loadError && items === null) {
        return h(
          'div',
          { className: 'dtm-stack', 'data-dtm-page': 'entries' },
          h(
            'div',
            { className: 'dtm-section' },
            h(
              'div',
              { className: 'dtm-section-head' },
              h('p', { className: 'dtm-title' }, t('entriesTitle')),
              h('p', { className: 'dtm-desc' }, t('entriesDesc')),
            ),
            h(DtmWarn, null, t('entriesNoApi')),
            h(
              'div',
              { className: 'dtm-row', style: { marginTop: 8 } },
              h(
                'button',
                { type: 'button', className: 'dtm-btn', onClick: function () { load() } },
                t('retry'),
              ),
            ),
          ),
        )
      }

      const rows = items || []

      return h(
        'div',
        { className: 'dtm-stack', 'data-dtm-page': 'entries' },

        h(OverviewBar, { overview }),

        // 筛选
        h(
          'div',
          { className: 'dtm-section' },
          h(FilterBar, {
            value: filters,
            facets,
            busy,
            onChange: function (next) {
              setFilters(next)
              setPage(1) // 改筛选回到第一页，避免"第 3 页空白"的困惑
            },
          }),
        ),

        // 列表
        h(
          'div',
          { className: 'dtm-section' },
          loadError
            ? h(
                'div',
                { className: 'dtm-error', role: 'alert' },
                h('p', { className: 'dtm-error-title' }, t('entriesLoadFailed')),
                h('p', { className: 'dtm-error-body' }, loadError),
                h(
                  'div',
                  { className: 'dtm-row' },
                  h(
                    'button',
                    { type: 'button', className: 'dtm-btn', onClick: function () { load() } },
                    t('retry'),
                  ),
                ),
              )
            : null,

          notice
            ? h('p', { className: 'dtm-caption', role: 'status' }, notice)
            : null,

          h(EntryTable, {
            items: rows,
            editingId,
            onEdit: openEditor,
          }),

          // 编辑面板：紧跟在表格下方（行内展开的语义）
          editingRow
            ? h(EntryEditor, {
                row: editingRow,
                facets,
                busy,
                error: saveError,
                onSave: saveEntry,
                onCancel: function () { openEditor(null) },
              })
            : null,

          h(Pager, {
            page,
            pageSize,
            total,
            busy,
            onPage: setPage,
            onPageSize: function (size) { setPageSize(size); setPage(1) },
          }),
        ),
      )
    }



    // ===================================================================
    // 分区 5：设置页
    //
    // 步骤 4 填充：库位置（+搬家入口/风险警告）、备份、自动整理、字典只读预览、只读边界说明。
    // ===================================================================

    /**
     * 设置页（《功能说明》§10.2 ②）。
     *
     * 五块：库位置（+搬家/风险警告）· 备份 · 自动整理 · 字典只读预览 · 只读边界说明。
     *
     * **数据目录的四级优先级必须如实显示**（《架构说明》§六）：
     *   ① config.dataDir ② 环境变量 ③ 设置页选的 ④ 包内
     * ①② 生效时**搬家不生效**，必须直接说明改哪一行——这是《功能说明》§10.5 的硬要求
     * （「数据目录被部署配置锁定时，直接说明改哪一行」）。
     */
    function SettingsPage(props) {
      const t = translateOf(props)
      const api = props.api

      const [settings, setSettings] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [migrateTarget, setMigrateTarget] = React.useState('')
      const [migrateOpen, setMigrateOpen] = React.useState(false)
      const [notice, setNotice] = React.useState(null)

      const load = React.useCallback(function () {
        if (!api) return
        let alive = true
        setBusy(true)
        setError(null)
        Promise.resolve()
          .then(function () { return api.getSettings() })
          .then(function (value) { if (alive) setSettings(value || null) })
          .catch(function (err) {
            if (alive) setError(err && err.message ? err.message : String(err))
          })
          .then(function () { if (alive) setBusy(false) })
        return function () { alive = false }
      }, [api])

      React.useEffect(function () { return load() }, [load])

      // `api` 是惰性代理（永远非 null），用 `api.ready()` 判断命名空间是否真挂上
      const wired = !!(api && typeof api.ready === 'function' && api.ready())
      if (!wired && !error && settings === null) {
        return h(
          'div',
          { className: 'dtm-stack', 'data-dtm-page': 'settings' },
          h(
            'div',
            { className: 'dtm-section' },
            h(
              'div',
              { className: 'dtm-section-head' },
              h('p', { className: 'dtm-title' }, t('settingsTitle')),
              h('p', { className: 'dtm-desc' }, t('settingsDesc')),
            ),
            h(DtmWarn, null, t('entriesNoApi')),
            h(
              'div',
              { className: 'dtm-row', style: { marginTop: 8 } },
              h(
                'button',
                { type: 'button', className: 'dtm-btn', onClick: function () { load() } },
                t('retry'),
              ),
            ),
          ),
        )
      }

      const s = settings || {}
      // 数据目录来源：宿主直接给字符串（`resolveDataDir` 原生返回值，零转换）
      //   'config'   → 部署配置（优先级 ①，搬家不生效）
      //   'env'      → 环境变量（优先级 ②，搬家不生效）
      //   'settings' → 设置页选的
      //   'package'  → 插件包内（出厂默认，有被 pnpm 重装删掉的风险）
      const source = s.dataDirSource || 'package'
      const locked = s.dataDirLocked === true || source === 'config' || source === 'env'
      const sourceLabel = {
        config: t('dirSourceConfig'),
        env: t('dirSourceEnv'),
        settings: t('dirSourceSetting'),
        package: t('dirSourcePackage'),
      }[source] || t('dirSourcePackage')
      // 锁定时宿主直接给"改哪一行"的整句话；拿不到就前端兜一句同义文案（不空白）
      const lockedHint =
        s.dataDirLockedHint ||
        (source === 'config' ? t('warnLockedConfig') : t('warnLockedEnv'))

      function doMigrate() {
        if (!api) return
        setBusy(true)
        setError(null)
        // createApi 已把「外层 carrier 失败」和「内层业务失败」都转成 reject，
        // 所以这里成功分支拿到的必定是业务成功值，失败一律走 catch。
        Promise.resolve()
          .then(function () { return api.migrateDataDir({ target: migrateTarget.trim() }) })
          .then(function () {
            setMigrateOpen(false)
            setMigrateTarget('')
            setNotice(t('migrateDone'))
            return load()
          })
          .catch(function (err) {
            // 宿主在锁定时返回 DATA_DIR_LOCKED，message 就是"改哪一行"的整句话，直接展示
            setError(err && err.message ? err.message : String(err))
          })
          .then(function () { setBusy(false) })
      }

      return h(
        'div',
        { className: 'dtm-stack', 'data-dtm-page': 'settings' },

        error
          ? h(
              'div',
              { className: 'dtm-error', role: 'alert' },
              h('p', { className: 'dtm-error-title' }, t('settingsLoadFailed')),
              h('p', { className: 'dtm-error-body' }, error),
              h(
                'div',
                { className: 'dtm-row' },
                h('button', { type: 'button', className: 'dtm-btn', onClick: load }, t('retry')),
              ),
            )
          : null,

        notice ? h('p', { className: 'dtm-caption', role: 'status' }, notice) : null,

        // ---- ① 库位置 ----
        h(
          'div',
          { className: 'dtm-section', 'data-dtm-card': 'location' },
          h(
            'div',
            { className: 'dtm-section-head' },
            h('p', { className: 'dtm-title' }, t('cardLocationTitle')),
            h('p', { className: 'dtm-desc' }, t('cardLocationDesc')),
          ),
          h(
            'div',
            { className: 'dtm-kv' },
            h('span', { className: 'dtm-kv-key' }, t('dirPath')),
            h('code', { className: 'dtm-mono dtm-kv-val' }, s.dataDir || t('unknown')),
          ),
          h(
            'div',
            { className: 'dtm-kv' },
            h('span', { className: 'dtm-kv-key' }, t('dirSource')),
            h('span', { className: 'dtm-kv-val' }, sourceLabel),
          ),

          // 包内默认：给风险警告 + 搬家入口
          source === 'package'
            ? h(
                DtmWarn,
                null,
                t('warnPackageDir'),
              )
            : null,

          // ①② 锁定：直接用宿主给的整句话（说的是"改哪一行"），且不给搬家按钮（给了也没用）
          locked
            ? h(DtmWarn, null, lockedHint)
            : h(
                'div',
                { className: 'dtm-row' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dtm-btn',
                    disabled: !!busy,
                    'aria-expanded': migrateOpen ? 'true' : 'false',
                    onClick: function () { setMigrateOpen(!migrateOpen) },
                  },
                  t('migrateOpen'),
                ),
              ),

          migrateOpen && !locked
            ? h(
                'div',
                { className: 'dtm-inline-form' },
                h(
                  'label',
                  { className: 'dtm-field-label', htmlFor: 'dtm-migrate-target' },
                  t('migrateTargetLabel'),
                ),
                h('input', {
                  id: 'dtm-migrate-target',
                  className: 'dtm-input',
                  type: 'text',
                  value: migrateTarget,
                  disabled: !!busy,
                  autoComplete: 'off',
                  placeholder: t('migrateTargetPlaceholder'),
                  onChange: function (e) { setMigrateTarget(e.target.value) },
                }),
                h(DtmWarn, null, t('warnMigrateRisk')),
                h(
                  'div',
                  { className: 'dtm-row' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dtm-btn dtm-btn-primary',
                      disabled: !!busy || !migrateTarget.trim(),
                      onClick: doMigrate,
                    },
                    busy ? t('working') : t('migrateConfirm'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dtm-btn',
                      disabled: !!busy,
                      onClick: function () { setMigrateOpen(false); setMigrateTarget('') },
                    },
                    t('editorCancel'),
                  ),
                ),
              )
            : null,
        ),

        // ---- ② 备份 ----
        h(
          'div',
          { className: 'dtm-section', 'data-dtm-card': 'backup' },
          h(
            'div',
            { className: 'dtm-section-head' },
            h('p', { className: 'dtm-title' }, t('cardBackupTitle')),
            h('p', { className: 'dtm-desc' }, t('cardBackupDesc')),
          ),
          h(
            'div',
            { className: 'dtm-kv' },
            h('span', { className: 'dtm-kv-key' }, t('backupAuto')),
            h('span', { className: 'dtm-kv-val' }, s.backupAuto ? t('on') : t('off')),
          ),
          s.lastBackupAt
            ? h(
                'div',
                { className: 'dtm-kv' },
                h('span', { className: 'dtm-kv-key' }, t('backupLast')),
                h('span', { className: 'dtm-kv-val dtm-mono' }, s.lastBackupAt),
              )
            : null,
          h(
            'p',
            { className: 'dtm-caption' },
            t('backupViaDialog'),
          ),
        ),

        // ---- ③ 自动整理 ----
        h(
          'div',
          { className: 'dtm-section', 'data-dtm-card': 'tidying' },
          h(
            'div',
            { className: 'dtm-section-head' },
            h('p', { className: 'dtm-title' }, t('cardTidyTitle')),
            h('p', { className: 'dtm-desc' }, t('cardTidyDesc')),
          ),
          h(
            'div',
            { className: 'dtm-kv' },
            h('span', { className: 'dtm-kv-key' }, t('tidyEnabled')),
            h('span', { className: 'dtm-kv-val' }, s.tidyAuto ? t('on') : t('off')),
          ),
          s.tidyFrequency
            ? h(
                'div',
                { className: 'dtm-kv' },
                h('span', { className: 'dtm-kv-key' }, t('tidyFrequency')),
                h('span', { className: 'dtm-kv-val' }, s.tidyFrequency),
              )
            : null,
          // 《功能说明》§10.2 原文「频率与开关待定稿，开发期细化」——如实标注，不假装已定
          h('p', { className: 'dtm-caption' }, t('tidyPending')),
        ),

        // ---- ④ 标签字典只读预览 ----
        h(
          'div',
          { className: 'dtm-section', 'data-dtm-card': 'dict' },
          h(
            'div',
            { className: 'dtm-section-head' },
            h('p', { className: 'dtm-title' }, t('cardDictTitle')),
            h('p', { className: 'dtm-desc' }, t('cardDictDesc')),
          ),
          h(
            'div',
            { className: 'dtm-kv' },
            h('span', { className: 'dtm-kv-key' }, t('dictShapes')),
            h(
              'span',
              { className: 'dtm-kv-val dtm-chips' },
              SHAPES.map(function (x) { return h('span', { key: x, className: 'dtm-chip' }, x) }),
            ),
          ),
          h(
            'div',
            { className: 'dtm-kv' },
            h('span', { className: 'dtm-kv-key' }, t('dictStabilities')),
            h(
              'span',
              { className: 'dtm-kv-val dtm-chips' },
              STABILITIES.map(function (x) { return h('span', { key: x, className: 'dtm-chip' }, x) }),
            ),
          ),
          h(
            'div',
            { className: 'dtm-kv' },
            h('span', { className: 'dtm-kv-key' }, t('dictStatuses')),
            h(
              'span',
              { className: 'dtm-kv-val dtm-chips' },
              STATUSES.map(function (x) { return h('span', { key: x, className: 'dtm-chip' }, x) }),
            ),
          ),
          s.dictText
            ? h('pre', { className: 'dtm-dict-pre' }, s.dictText)
            : null,
        ),

        // ---- ⑤ 只读边界说明 ----
        h(
          'div',
          { className: 'dtm-section', 'data-dtm-card': 'readonly' },
          h(
            'div',
            { className: 'dtm-section-head' },
            h('p', { className: 'dtm-title' }, t('cardReadonlyTitle')),
          ),
          h(
            'ul',
            { className: 'dtm-list' },
            h('li', null, t('readonlyContentWhy')),
            h('li', null, t('readonlyIdWhy')),
            h('li', null, t('readonlyTickWhy')),
          ),
        ),
      )
    }


    // ===================================================================
    // 分区 5b：弹窗（备份 / 恢复 / 合并）
    //
    // 《功能说明》§10.4：备份 / 恢复 / 合并走弹窗，不占常驻空间。
    //
    // 官方 `practices.md` 要求：复制宿主控件时要保留用户依赖的行为，
    // 点名了 "Modal focus and Escape handling"。所以这里**自己实现**：
    //   - `role="dialog"` + `aria-modal="true"` + `aria-labelledby`
    //   - 打开时把焦点移到对话框内，关闭时还给触发元素
    //   - Escape 关闭
    //   - Tab 焦点循环在对话框内（不跑到背后的页面上）
    //   - 点遮罩关闭
    // 不引任何 primitives。
    // ===================================================================

    /** 收集可聚焦元素（宿主 Modal 的 Tab 循环行为）。 */
    function focusableIn(node) {
      if (!node || typeof node.querySelectorAll !== 'function') return []
      const sel = 'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
      return Array.prototype.slice.call(node.querySelectorAll(sel))
    }

    function DtmModal(props) {
      const t = translateOf(props)
      const { title, children, onClose, footer, busy } = props
      const dialogRef = React.useRef(null)
      const returnFocusRef = React.useRef(null)

      // 打开时记住触发元素，关闭时还焦点；同时把焦点移进对话框
      React.useEffect(function () {
        returnFocusRef.current = typeof document !== 'undefined' ? document.activeElement : null
        const node = dialogRef.current
        const list = focusableIn(node)
        if (list.length > 0) {
          list[0].focus()
        } else if (node && typeof node.focus === 'function') {
          node.focus()
        }
        return function () {
          const back = returnFocusRef.current
          if (back && typeof back.focus === 'function') back.focus()
        }
      }, [])

      function onKeyDown(event) {
        if (event.key === 'Escape') {
          event.preventDefault()
          if (!busy) onClose()
          return
        }
        if (event.key !== 'Tab') return
        const node = dialogRef.current
        const list = focusableIn(node)
        if (list.length === 0) return
        const first = list[0]
        const last = list[list.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }

      return h(
        'div',
        {
          className: 'dtm-overlay',
          onKeyDown: onKeyDown,
          onMouseDown: function (e) {
            // 只有点遮罩本身才关（点内容不关）
            if (e.target === e.currentTarget && !busy) onClose()
          },
        },
        h(
          'div',
          {
            className: 'dtm-modal',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'dtm-modal-title',
            tabIndex: -1,
            ref: dialogRef,
          },
          h(
            'div',
            { className: 'dtm-modal-head' },
            h('p', { className: 'dtm-title', id: 'dtm-modal-title' }, title),
            h(
              'button',
              {
                type: 'button',
                className: 'dtm-modal-x',
                'aria-label': t('modalClose'),
                disabled: !!busy,
                onClick: onClose,
              },
              '×',
            ),
          ),
          h('div', { className: 'dtm-modal-body' }, children),
          footer ? h('div', { className: 'dtm-modal-foot' }, footer) : null,
        ),
      )
    }

    /**
     * 备份 / 恢复 / 合并 弹窗组。
     *
     * 三个动作各自的表单在同一弹窗组件内按 `mode` 切换，避免三个几乎相同的组件。
     * 所有宿主调用都通过 `api`，失败显示在弹窗内不关闭，让用户看到原因。
     */
    function BackupDialogs(props) {
      const t = translateOf(props)
      const { mode, api, busy, error, onClose, onDone } = props
      const [path, setPath] = React.useState('')
      const [localBusy, setLocalBusy] = React.useState(false)
      const [localError, setLocalError] = React.useState(null)
      const [backups, setBackups] = React.useState(null)

      const isBusy = !!busy || localBusy
      const shown = error || localError

      // 恢复弹窗额外取一次备份列表：让用户从现有备份里选，而不是手打路径。
      // 宿主没提供 listBackups 或调用失败时，退回纯手输（不阻塞恢复流程）。
      React.useEffect(function () {
        if (mode !== 'restore' || !api) return
        let alive = true
        Promise.resolve()
          .then(function () { return api.listBackups() })
          .then(function (result) {
            if (alive) setBackups((result && result.backups) || [])
          })
          .catch(function () {
            if (alive) setBackups([])
          })
        return function () { alive = false }
      }, [mode, api])

      function run(method, payload) {
        if (!api) {
          setLocalError(t('editorNoApi'))
          return
        }
        setLocalBusy(true)
        setLocalError(null)
        // createApi 已把两层失败都转成 reject；成功分支即业务成功。
        Promise.resolve()
          .then(function () { return api[method](payload) })
          .then(function () { onDone(mode) })
          .catch(function (err) {
            setLocalError(err && err.message ? err.message : String(err))
          })
          .then(function () { setLocalBusy(false) })
      }

      if (!mode) return null

      const titleKey = mode === 'backup' ? 'backupTitle' : mode === 'restore' ? 'restoreTitle' : 'mergeTitle'
      const descKey = mode === 'backup' ? 'backupDesc' : mode === 'restore' ? 'restoreDesc' : 'mergeDesc'

      return h(
        DtmModal,
        {
          t: props.t,
          title: t(titleKey),
          busy: isBusy,
          onClose: onClose,
          footer: h(
            'div',
            { className: 'dtm-row' },
            mode === 'backup'
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'dtm-btn dtm-btn-primary',
                    disabled: isBusy,
                    onClick: function () { run('backupNow', undefined) },
                  },
                  isBusy ? t('working') : t('backupRun'),
                )
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'dtm-btn dtm-btn-primary',
                    disabled: isBusy || !path.trim(),
                    onClick: function () {
                      // 两个方法的入参键名不同（宿主契约）：
                      //   restore({ from })              —— 要恢复的备份路径
                      //   mergeLibrary({ path, dryRun } ) —— 要合并的库路径
                      if (mode === 'restore') {
                        run('restore', { from: path.trim() })
                      } else {
                        // dryRun:false = 真的合并（true 只预演，本轮 UI 不做预演）
                        run('mergeLibrary', { path: path.trim(), dryRun: false })
                      }
                    },
                  },
                  isBusy ? t('working') : t(mode === 'restore' ? 'restoreRun' : 'mergeRun'),
                ),
            h(
              'button',
              { type: 'button', className: 'dtm-btn', disabled: isBusy, onClick: onClose },
              t('editorCancel'),
            ),
          ),
        },
        h('p', { className: 'dtm-desc' }, t(descKey)),

        // 恢复：先列出已有备份供点选（省得用户记住路径）；点选即填入下面的路径框
        mode === 'restore' && backups && backups.length > 0
          ? h(
              'div',
              { className: 'dtm-field' },
              h('span', { className: 'dtm-field-label' }, t('restorePickBackup')),
              h(
                'div',
                { className: 'dtm-backup-list', role: 'list' },
                backups.map(function (b) {
                  const name = b && (b.name || b.path)
                  const selected = path.trim() !== '' && (b.path === path.trim() || b.name === path.trim())
                  return h(
                    'button',
                    {
                      key: (b && b.path) || name,
                      type: 'button',
                      role: 'listitem',
                      className: 'dtm-backup-item' + (selected ? ' dtm-backup-item-selected' : ''),
                      disabled: isBusy,
                      'aria-pressed': selected ? 'true' : 'false',
                      onClick: function () { setPath(b && b.path ? b.path : String(name || '')) },
                    },
                    h('span', { className: 'dtm-backup-name' }, String(name || '')),
                    b && b.mtime
                      ? h('span', { className: 'dtm-caption' }, String(b.mtime))
                      : null,
                  )
                }),
              ),
            )
          : null,

        mode === 'backup'
          ? null
          : h(
              'div',
              { className: 'dtm-field', style: { marginTop: 12 } },
              h('label', { className: 'dtm-field-label', htmlFor: 'dtm-dialog-path' },
                t(mode === 'restore' ? 'restorePathLabel' : 'mergePathLabel')),
              h('input', {
                id: 'dtm-dialog-path',
                className: 'dtm-input',
                type: 'text',
                value: path,
                disabled: isBusy,
                autoComplete: 'off',
                placeholder: t('dialogPathPlaceholder'),
                onChange: function (e) { setPath(e.target.value) },
              }),
            ),
        mode === 'merge'
          ? h(DtmWarn, null, t('mergeWarn'))
          : null,
        shown
          ? h('p', { className: 'dtm-error-body', role: 'alert' }, shown)
          : null,
      )
    }

    // ===================================================================
    // 分区 6：入口
    // ===================================================================


    /**
     * 页面壳：标签栏 + 两个面板。
     *
     * 注意：出错边界包在「面板」这一层而不是整页，这样即便某个页面崩了，
     * 用户仍能看到标签栏并切到另一个页面（§10.5「出错显示可读错误 + 切标签按钮」）。
     */
    function PageShell(props) {
      const t = translateOf(props)
      const [tab, setTab] = React.useState('entries')
      // 宿主门面：由 apply 传入（可能为 null = 尚未接线）
      const api = props.api || null

      const tabs = [
        { id: 'entries', labelKey: 'tabEntries' },
        { id: 'settings', labelKey: 'tabSettings' },
      ]

      return h(
        'div',
        { className: 'dtm-root', 'data-dtm-root': '1' },
        h('style', null, CSS),
        h(DtmTabs, { tabs, active: tab, onSelect: setTab, t }),
        tab === 'entries'
          ? h(
              'div',
              { role: 'tabpanel', id: 'dtm-panel-entries', 'aria-labelledby': 'dtm-tab-entries' },
              h(
                DtmErrorBoundary,
                { t, onRecover: function () { setTab('settings') } },
                h(EntriesPage, { t, api }),
              ),
            )
          : h(
              'div',
              { role: 'tabpanel', id: 'dtm-panel-settings', 'aria-labelledby': 'dtm-tab-settings' },
              h(
                DtmErrorBoundary,
                { t, onRecover: function () { setTab('entries') } },
                h(SettingsPage, { t, api }),
              ),
            ),
      )
    }

    /**
     * 最外层兜底：配置页拿到的 `view` 只有 `'page'`（bundle 配置不渲染 summary），
     * 这里仍然显式处理，避免宿主将来变化时白屏。
     */
    function BundleConfigPage(props) {
      if (props.view === 'summary') return null
      // `t` 不往下传具体字典，交给 translateOf 从 slot props 里取（拿不到就用静态中文）。
      return h(PageShell, { t: props.t, api: props.api })
    }

    // ---- locale 字典（中英各一份，key 一一对应）----
    // 官方要求：可见文案走 Client locale 服务，不硬编码。
    const LOCALE_ZH = {
      tabEntries: '记忆条目',
      tabSettings: '设置',
      tabsLabel: '标签记忆页面切换',

      entriesTitle: '记忆条目',
      entriesDesc: '库概况、筛选、表格列表、分页与导出。',
      entriesEmpty: '还没有符合筛选条件的条目。',

      // 概况
      statTotal: '条目总数',
      statDataDir: '数据目录',

      // 筛选
      filterShape: '形态',
      filterStatus: '状态',
      filterProject: '项目',
      filterAgent: '智能体',
      filterTags: '自由标签',
      filterTagsHint: '多个标签用空格分隔',
      filterAny: '全部',
      filterClear: '清除筛选',

      // 表头
      colId: '编号',
      colContent: '主要内容',
      colShape: '形态',
      colProject: '项目',
      colAgent: '智能体',
      colTags: '自由标签',
      colStability: '稳定性',
      colTick: '时距',
      colStatus: '状态',
      colActions: '操作',

      // 行操作
      actionEdit: '编辑',
      actionClose: '收起',

      // 编辑面板（§10.3）
      entriesLoadFailed: '读取条目失败',
      editorNoApi: '尚未连接到宿主，无法保存。',
      editorSaved: '已保存。',
      editorReadonlyHint: '以下三项只读：原文是一手材料、编号是唯一标识、时距是程序计数器。',
      editorNote: '只改标签，原文不动。保存后会记入 tidy.jsonl（action=user_edit）。',
      editorSave: '保存',
      editorSaving: '保存中…',
      editorCancel: '取消',
      tagAddHint: '输入标签后回车添加',
      tagRemove: '删除标签',
      tagCount: '已用 {n} / {max} 个标签',
      tagIllegalPipe: '标签里不能有竖线 |（它是多个标签的分隔符）',

      // 分页
      pageSummary: '第 {page} / {pages} 页，共 {total} 条',
      pageSize: '每页',
      pagePrev: '上一页',
      pageNext: '下一页',

      settingsTitle: '设置',
      settingsDesc: '记忆库位置、备份、自动整理与标签字典预览。',
      settingsLoadFailed: '读取设置失败',
      entriesNoApi: '尚未连接到宿主。页面已就绪，等宿主侧 Remote 命名空间挂上后即可显示数据。',

      // 通用
      on: '已开启',
      off: '已关闭',
      unknown: '未知',
      retry: '重试',
      working: '处理中…',

      // 库位置
      cardLocationTitle: '记忆库位置',
      cardLocationDesc: '记忆库本体、记录台账与备份都放在这个目录下。',
      dirPath: '当前目录',
      dirSource: '生效来源',
      dirSourceConfig: '部署配置（cordis.patch.yml 的 config.dataDir）',
      dirSourceEnv: '环境变量 DSH_TAG_MEMORY_DATA_DIR',
      dirSourceSetting: '设置页选择',
      dirSourcePackage: '插件包内目录（出厂默认）',
      warnPackageDir: '当前在插件包内。pnpm 重装或升级会连包目录一起删除，建议搬到包外。',
      warnLockedConfig: '数据目录被部署配置锁定了（优先级 ①）。要搬家请改 profile 的 cordis.patch.yml 里本插件那一行的 config.dataDir —— 在这个页面搬家不会生效。',
      warnLockedEnv: '数据目录被环境变量锁定了（优先级 ②）。要搬家请改环境变量 DSH_TAG_MEMORY_DATA_DIR —— 在这个页面搬家不会生效。',
      migrateOpen: '搬到包外…',
      migrateTargetLabel: '新的数据目录绝对路径',
      migrateTargetPlaceholder: '例如 D:\\dsh-data\\tag-memory',
      warnMigrateRisk: '搬家会把现有记忆库、台账与备份一起复制到新位置。请确认目标目录可写后再继续。',
      migrateConfirm: '开始搬家',
      migrateDone: '搬家完成。',

      // 备份
      cardBackupTitle: '备份',
      cardBackupDesc: '备份 / 恢复 / 合并都走弹窗，不占常驻空间。',
      backupAuto: '自动备份',
      backupLast: '上次备份',
      backupViaDialog: '用「备份 / 恢复 / 合并」按钮操作（弹窗形式）。',

      // 弹窗：备份 / 恢复 / 合并（§10.4）
      modalClose: '关闭',
      backupTitle: '备份记忆库',
      backupDesc: '把当前记忆库、台账一起备份到数据目录的 backup/ 下。',
      backupRun: '立即备份',
      restoreTitle: '恢复记忆库',
      restoreDesc: '用一份已有备份覆盖当前记忆库。覆盖前会先自动备份当前库。',
      restorePickBackup: '从已有备份里选',
      restorePathLabel: '备份文件路径',
      restoreRun: '开始恢复',
      mergeTitle: '合并记忆库',
      mergeDesc: '把另一份记忆库合并进来。冲突以「编号唯一、同号保留较新」处理。',
      mergePathLabel: '要合并的记忆库路径',
      mergeRun: '开始合并',
      mergeWarn: '合并会把对方的条目并入当前库，残留重复留给整理环节按相似度归并。建议先备份。',
      dialogPathPlaceholder: '绝对路径，例如 D:\\backup\\memory-20261105.csv',

      // 自动整理
      cardTidyTitle: '自动整理',
      cardTidyDesc: '定期归并重复、纠正标签、归档退场条目。',
      tidyEnabled: '自动整理',
      tidyFrequency: '频率',
      tidyPending: '频率与开关的取值域仍在细化中（《功能说明》§10.2 标注为待定稿），此处先如实显示宿主当前值。',

      // 字典
      cardDictTitle: '标签字典（只读）',
      cardDictDesc: '固定标签的取值域。自由标签不设词表，由模型按《标签字典》自行决定。',
      dictShapes: '形态',
      dictStabilities: '稳定性',
      dictStatuses: '状态',

      // 只读边界
      cardReadonlyTitle: '只读边界说明',
      readonlyContentWhy: '主要内容：原文是一手材料，改了就不是原始记录。',
      readonlyIdWhy: '编号：唯一标识，改了会断掉台账与取代链的引用。',
      readonlyTickWhy: '时距：程序计数器，由召回自动累加，不人工修改。',

      errorTitle: '这个页面渲染出错',
      errorSwitchTab: '切换到另一个标签页',
    }

    const LOCALE_EN = {
      tabEntries: 'Entries',
      tabSettings: 'Settings',
      tabsLabel: 'Tag Memory page switcher',

      entriesTitle: 'Memory entries',
      entriesDesc: 'Library overview, filters, table list, paging, and export.',
      entriesEmpty: 'No entries match the current filters.',

      statTotal: 'Total entries',
      statDataDir: 'Data directory',

      filterShape: 'Shape',
      filterStatus: 'Status',
      filterProject: 'Project',
      filterAgent: 'Agent',
      filterTags: 'Free tags',
      filterTagsHint: 'Separate multiple tags with spaces',
      filterAny: 'Any',
      filterClear: 'Clear filters',

      colId: 'ID',
      colContent: 'Content',
      colShape: 'Shape',
      colProject: 'Project',
      colAgent: 'Agent',
      colTags: 'Free tags',
      colStability: 'Stability',
      colTick: 'Tick',
      colStatus: 'Status',
      colActions: 'Actions',

      actionEdit: 'Edit',
      actionClose: 'Collapse',

      entriesLoadFailed: 'Failed to load entries',
      editorNoApi: 'Not connected to the host, so nothing can be saved.',
      editorSaved: 'Saved.',
      editorReadonlyHint: 'The three fields below are read-only: the original text is source material, the ID is the unique identity, and the tick is a program counter.',
      editorNote: 'Only tags change; the original text stays untouched. Saving records `action=user_edit` in tidy.jsonl.',
      editorSave: 'Save',
      editorSaving: 'Saving…',
      editorCancel: 'Cancel',
      tagAddHint: 'Type a tag and press Enter',
      tagRemove: 'Remove tag',
      tagCount: '{n} of {max} tags used',
      tagIllegalPipe: 'A tag cannot contain "|" (it separates multiple tags)',

      pageSummary: 'Page {page} of {pages}, {total} entries',
      pageSize: 'Per page',
      pagePrev: 'Previous',
      pageNext: 'Next',

      settingsTitle: 'Settings',
      settingsDesc: 'Library location, backup, auto-tidy, and a read-only tag dictionary preview.',
      settingsLoadFailed: 'Failed to read settings',
      entriesNoApi: 'Not connected to the host yet. The page is ready and will show data once the host Remote namespace is mounted.',

      on: 'On',
      off: 'Off',
      unknown: 'Unknown',
      retry: 'Retry',
      working: 'Working…',

      cardLocationTitle: 'Library location',
      cardLocationDesc: 'The library itself, its record ledgers, and backups all live in this directory.',
      dirPath: 'Current directory',
      dirSource: 'Effective source',
      dirSourceConfig: 'Deployment config (cordis.patch.yml config.dataDir)',
      dirSourceEnv: 'Environment variable DSH_TAG_MEMORY_DATA_DIR',
      dirSourceSetting: 'Chosen on this settings page',
      dirSourcePackage: 'Inside the plugin package (factory default)',
      warnPackageDir: 'The library is inside the plugin package. A pnpm reinstall or upgrade deletes the package directory too; moving it outside is recommended.',
      warnLockedConfig: 'The data directory is pinned by deployment config (priority 1). To move it, change config.dataDir on this plugin row in the profile cordis.patch.yml — moving it from this page will not take effect.',
      warnLockedEnv: 'The data directory is pinned by an environment variable (priority 2). To move it, change DSH_TAG_MEMORY_DATA_DIR — moving it from this page will not take effect.',
      migrateOpen: 'Move outside…',
      migrateTargetLabel: 'Absolute path of the new data directory',
      migrateTargetPlaceholder: 'e.g. D:\\dsh-data\\tag-memory',
      warnMigrateRisk: 'Moving copies the existing library, ledgers, and backups to the new location. Make sure the target directory is writable first.',
      migrateConfirm: 'Start moving',
      migrateDone: 'Move complete.',

      cardBackupTitle: 'Backup',
      cardBackupDesc: 'Backup, restore, and merge open as dialogs and take no permanent space.',
      backupAuto: 'Automatic backup',
      backupLast: 'Last backup',
      backupViaDialog: 'Use the Backup / Restore / Merge button (dialog).',

      modalClose: 'Close',
      backupTitle: 'Back up the library',
      backupDesc: 'Copies the current library and its ledgers into backup/ under the data directory.',
      backupRun: 'Back up now',
      restoreTitle: 'Restore the library',
      restoreDesc: 'Overwrites the current library with an existing backup. The current library is backed up first.',
      restorePickBackup: 'Pick an existing backup',
      restorePathLabel: 'Backup file path',
      restoreRun: 'Start restore',
      mergeTitle: 'Merge a library',
      mergeDesc: 'Merges another library into this one. Conflicts resolve by unique ID, keeping the newer row for the same ID.',
      mergePathLabel: 'Library path to merge',
      mergeRun: 'Start merge',
      mergeWarn: 'Merging pulls the other library\'s entries into this one; any leftovers are left for the tidy pass to merge by similarity. Backing up first is recommended.',
      dialogPathPlaceholder: 'Absolute path, e.g. D:\\backup\\memory-20261105.csv',

      cardTidyTitle: 'Auto-tidy',
      cardTidyDesc: 'Periodically merges duplicates, corrects tags, and archives retired entries.',
      tidyEnabled: 'Auto-tidy',
      tidyFrequency: 'Frequency',
      tidyPending: 'The frequency and switch value domain is still being finalized (marked as pending in the spec); this shows the host value as-is.',

      cardDictTitle: 'Tag dictionary (read-only)',
      cardDictDesc: 'Value domain of the fixed tags. Free tags have no vocabulary; the model decides them per the tag dictionary.',
      dictShapes: 'Shape',
      dictStabilities: 'Stability',
      dictStatuses: 'Status',

      cardReadonlyTitle: 'Read-only boundaries',
      readonlyContentWhy: 'Content: the original text is source material; editing it would stop it being the original record.',
      readonlyIdWhy: 'ID: the unique identity; changing it breaks ledger and supersede-chain references.',
      readonlyTickWhy: 'Tick: a program counter incremented by recall, never edited by hand.',

      errorTitle: 'This page failed to render',
      errorSwitchTab: 'Switch to the other tab',
    }

    return {
      // 只用官方服务：slots（注册）、locale（文案）、remote（挂载自有 Remote 命名空间）。
      //
      // ⚠️ **不要**把 `remote.tagMemory` 列进 inject：
      // 那是 `$mount` 之后才存在的子服务，静态列进 inject 会让整个插件在宿主
      // 没装好时起不来。正确姿势是运行时挂载后再用（官方 cot-translation 同款）。
      inject: ['slots', 'locale', 'remote'],
      apply(ctx) {

        // ---- remote 命名空间的跨渲染引用 ----
        //
        // ⚠️ 不能写 ctx.remote[REMOTE_NS]！
        // cordis 的 ctx proxy 对未在 inject 里声明的服务访问会直接抛：
        //   cannot get property "remote.tagMemory" without inject
        // 而 "remote.tagMemory" 是 $mount 之后才存在的**动态**子命名空间，静态写不进 inject。
        // 官方做法（cot-translation L1028）：ctx.inject(["remote.xxx"], (child) => ...) 在 child 上访问。
        // 所以这里用一个可变引用：UI 全读 nsRef.current，挂载晚到/重试都能反映当下真实状态。
        const nsRef = { current: null };
        // 字典注册是受 context 管理的 effect：插件卸载时自动撤销。
        ctx.effect(function () {
          return ctx.locale.register(NS, 'zh', LOCALE_ZH)
        })
        ctx.effect(function () {
          return ctx.locale.register(NS, 'en', LOCALE_EN)
        })

        // ---- 挂载自有 Remote 命名空间 `tagMemory` ----
        //
        // 官方 cot-translation 的同款姿势：
        //   await ctx.remote.$mount(contribution)  →  之后 ctx.remote.tagMemory.<method>() 可用
        //
        // 挂载失败**不能拖垮整个插件**：包在 catch 里，失败就只是"未接线"，
        // 页面照常渲染并如实说明，不会出现 slot entry crashed 或整个 client 起不来。
        // 这就是 spec 单独抽成 buildRemoteSpec() 的收益：换传输只改这一处。
        //
        // 不另设 `mounted` 标志：页面用 `hasApi(ctx)` 直接探 `ctx.remote.tagMemory`，
        // 探到就是真挂上了，比自己维护一份状态更少出错。
        //
        // ⚠️ 挂载是**异步**的：这段 Promise 可能在 slot 首次渲染之后才结算。
        // 所以页面**不能**在注册时存下 `hasApi(ctx)` 的快照（那样会永远拿到 false），
        // 必须用 `createLazyApi(ctx)`，每次调用时才探命名空间——见该函数注释。
        Promise.resolve()
          .then(function () {
            // 用内置 toContribution（不 import 任何 Harness Client 包，见其注释）
            return ctx.remote.$mount(toContribution(buildRemoteSpec()))
          })
          .then(function () {
            // 挂载成功：用 ctx.inject 拿到「有权访问 remote.tagMemory」的 child ctx。
            // child 是「依赖已满足」的子 fiber 上下文 —— 只有它上面访问才不触发 proxy 拦截。
            ctx.inject(['remote.' + REMOTE_NS], function (child) {
              nsRef.current = child.remote[REMOTE_NS]
              return function () { nsRef.current = null }
            })
          })
          .catch(function (err) {
            if (typeof console !== 'undefined' && console.warn) {
              console.warn('[dsh-tag-memory] remote namespace mount failed:', err && err.message ? err.message : err)
            }
          })

        // 槽位注册必须写在 inject 回调里：owner 塌陷时销毁，回来时重装。
        //
        // 注入面 `inject` 给页面提供宿主门面（惰性代理，见下）：
        //   - 命名空间已挂上 → `api.ready()` 为 true，页面取真实数据
        //   - 尚未挂上       → `api.ready()` 为 false，页面显示"未接线"说明
        //                      （**不伪造数据、不崩、可点重试**）
        ctx.slots.inject('plugins.bundle.config', function () {
          return ctx.slots.register(
            {
              name: 'plugins.bundle.config',
              key: 'dsh-tag-memory',
              locale: NS,
              // ⚠️ `inject` 是一个求值一次的面（官方两个同类插件也是 `inject: () => actions` 的
              // 稳定对象），**不能**在这里直接探 `hasApi(ctx)` 的快照：
              // 我们的 `$mount` 是异步的，首次注册时命名空间必然还不存在，
              // 那样页面会永远停在"未接线"。
              //
              // 正确做法：这里给一个**惰性代理**——每次 `api.xxx()` 被调用时才去探
              // `ctx.remote.tagMemory`。挂载晚到也能用上，探测永远反映当下真实状态。
              inject: function () {
                return { api: createLazyApi(nsRef) }
              },
            },
            BundleConfigPage,
          )
        })
      },
    }
  },
})
