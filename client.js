// client.js —— 浏览器端的一半：设置 →「记忆」页。
//
// 格式是 DSH 的客户端模块加载器契约：本文件执行时只登记一个 factory，
// 真正的模块体（以及它注入的样式）要等模块被实例化才跑。React 来自平台
// 冻结的模块表，所以是 require 而不是 import。
//
// 挂在 `settings.section` 槽上：标签给设置导航，组件就是那一页。
// 数据全走 index.js 的只读 API（/tag-memory-api/*），本文件不碰磁盘。
window.__ModuleLoader__.load({
	id: 'dsh-tag-memory',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports

		const React = require('react')

		/** 与 index.js 的 ROUTE 一致。 */
		const API = '/tag-memory-api'
		/** 三处入口共用的 id：panellist 的 `id` 必须等于 main 面板的 `key`。 */
		const PANEL_ID = 'tag-memory'
		const SECTION_ID = PANEL_ID
		const SECTION_LABEL = '记忆'
		/** 侧边栏里的纵向位置：官方「插件」按钮是 0，排在它下面。 */
		const PANEL_ORDER = 5

		/** 详情里的字段顺序（只渲染非空项）。 */
		const DETAIL_FIELDS = ['类型', '深度', '稳定性', '距离', '角色', '项目', '状态', '时间', '环境', '原因', '依据', '关键词', '工具', '版本', '作用', '备注']
		/**
		 * 表格的列**照库自己的表头来**（`overview.header`），不另立一套——
		 * 库加一列，表格就多一列。这份只在 overview 还没回来时兜底。
		 */
		const FALLBACK_HEADER = ['id', '内容', '时间', '环境', '原因', '备注', '稳定性', '成熟度', '距离', '角色', '项目', '状态', '关键词', '工具', '版本', '依据']
		/**
		 * 默认摆出来的列。挑的是「一行看得完」的；环境/原因/备注/工具/版本/依据
		 * 这些长文本或常空的留在「详情」里，想要也能在「列」里勾出来。
		 */
		const DEFAULT_COLUMNS = ['id', '内容', '时间', '稳定性', '成熟度', '距离', '角色', '项目', '状态', '关键词']
		/** 列的显示宽窄：mono 等宽（id/时间）、wide 放宽（长文本）、其余按内容自适应。 */
		const COLUMN_KIND = {
			id: 'mono', 时间: 'mono',
			内容: 'wide', 环境: 'wide', 原因: 'wide', 备注: 'wide', 关键词: 'wide',
		}
		/** 表格单元格里长文本的截断长度（够看个大概，全文走 title 与「详情」）。 */
		const CELL_CLIP = 56
		/** 正文超过这么多字先折叠。 */
		const CONTENT_CLIP = 120
		const PAGE_SIZES = [20, 50, 100, 200]
		const SORTS = [['time_desc', '时间 ↓'], ['time_asc', '时间 ↑'], ['id_desc', 'id ↓'], ['id_asc', 'id ↑']]
		/** 状态的兜底全集——overview 还没回来时用。 */
		const STATUS_FALLBACK = ['生效', '被取代', '已归档']
		const asArr = (x) => (Array.isArray(x) ? x : [x])
		/** 视图偏好（条件/排序/每页数）的本地记忆键。 */
		const STORE_KEY = 'dsh-tag-memory:view'

		/** 读取上次的视图偏好；隐私模式等拿不到就返回 null。 */
		function loadView() {
			try {
				const raw = window.localStorage.getItem(STORE_KEY)
				if (raw === null) return null
				const parsed = JSON.parse(raw)
				return parsed !== null && typeof parsed === 'object' ? parsed : null
			} catch { return null }
		}

		const CSS = `
.tm-root{box-sizing:border-box;display:flex;flex-direction:column;gap:14px;padding:4px 2px 20px;
  color:var(--dsw-alias-label-primary)}
/* 主区页面（main 槽）。shell 的 .centerCol 是 flex column + overflow:hidden 且有确定高度，
   自己不滚 —— 面板必须自己当滚动容器，否则内容超出就被裁掉（见 ui-plugin-manager 的 .page）。
   顶部再让出窗口顶带（--dsh-frame-top-clearance），免得第一行压在标题栏/红绿灯下面。 */
.tm-panel{box-sizing:border-box;width:100%;height:100%;overflow:auto;scrollbar-gutter:stable;
  padding:calc(20px + var(--dsh-frame-top-clearance,0px)) clamp(24px,4vw,48px) 40px}
.tm-panel>.tm-root{max-width:1200px;margin:0 auto}
.tm-head{margin:0;font-size:16px;font-weight:700;line-height:24px}
.tm-sub{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:-8px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tm-stats{display:flex;flex-wrap:wrap;gap:10px}
.tm-stat{flex:1 1 120px;min-width:110px;padding:12px 14px;border-radius:12px;
  background:var(--dsw-alias-interactive-bg-hover)}
.tm-stat-n{font-size:20px;font-weight:700;line-height:1.2}
.tm-stat-l{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.tm-card{padding:14px 16px;border-radius:12px;
  background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-base));
  box-shadow:inset 0 0 0 1px var(--dsw-alias-separator,rgba(127,127,127,.18))}
.tm-card-h{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.tm-card-t{margin:0;font-size:13px;font-weight:600;flex:auto}
.tm-note{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.tm-err{color:var(--dsw-alias-label-error,inherit)}
.tm-memrow{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:8px;
  font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  background:var(--dsw-alias-interactive-bg-hover);margin-bottom:6px}
.tm-dot{flex:none;width:8px;height:8px;border-radius:999px;background:var(--dsw-alias-label-secondary)}
.tm-dot[data-ok]{background:#39b54a}
.tm-dot[data-missing]{background:#e0a800}
.tm-memrow .tm-tag{margin-left:auto;font:11px/1.4 inherit;color:var(--dsw-alias-label-secondary)}
.tm-btn{flex:none;height:28px;padding:0 14px;border:none;border-radius:8px;cursor:pointer;
  font:inherit;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-interactive-bg-active)}
.tm-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tm-btn[disabled]{opacity:.5;cursor:default}
.tm-field{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.tm-input{flex:1 1 200px;min-width:160px;height:32px;padding:0 12px;box-sizing:border-box;
  border:1px solid var(--dsw-alias-separator,rgba(127,127,127,.22));border-radius:8px;
  background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-base));color:inherit;font:inherit;font-size:13px}
.tm-select{height:32px;padding:0 8px;border-radius:8px;font:inherit;font-size:13px;
  border:1px solid var(--dsw-alias-separator,rgba(127,127,127,.22));
  background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-base));color:inherit}
/* 维度筛选：一个维度一个下拉，横向排一行，不再一个维度占一大块。 */
.tm-filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.tm-fsel{max-width:180px}
.tm-chip{height:24px;padding:0 10px;border:none;border-radius:999px;cursor:pointer;
  font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);
  background:var(--dsw-alias-interactive-bg-hover);display:inline-flex;align-items:center;gap:6px}
.tm-chip:hover{color:var(--dsw-alias-label-primary)}
.tm-chip[data-on]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-active);font-weight:600}
.tm-list{display:flex;flex-direction:column;gap:8px}
.tm-item{padding:10px 12px;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover)}
.tm-item-h{display:flex;gap:8px;align-items:baseline}
.tm-id{flex:none;font:11px/1.6 ui-monospace,Menlo,Consolas,monospace;color:var(--dsw-alias-label-secondary)}
.tm-content{font-size:13px;line-height:1.6;word-break:break-word}
.tm-meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.tm-mtag{padding:1px 8px;border-radius:999px;font-size:11px;
  color:var(--dsw-alias-label-secondary);box-shadow:inset 0 0 0 1px var(--dsw-alias-separator,rgba(127,127,127,.25))}
.tm-mtag b{font-weight:600;color:var(--dsw-alias-label-primary)}
.tm-link{border:none;background:none;padding:0;margin-left:6px;cursor:pointer;
  font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);opacity:.75;text-decoration:underline}
.tm-link:hover{opacity:1}
.tm-detail-btn{display:block;margin-top:6px}
.tm-actions{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-top:6px}
.tm-actions .tm-link{margin-left:0}
.tm-detail{margin-top:8px;padding-top:8px;display:grid;grid-template-columns:auto 1fr;gap:4px 12px;
  font-size:12px;line-height:1.6;border-top:1px solid var(--dsw-alias-separator,rgba(127,127,127,.18))}
.tm-detail-k{color:var(--dsw-alias-label-secondary);white-space:nowrap}
.tm-detail-v{word-break:break-word}
.tm-more{display:block;width:100%;height:32px;margin-top:10px;border:none;border-radius:8px;
  cursor:pointer;font:inherit;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-interactive-bg-hover)}
.tm-more:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-active)}
.tm-more[disabled]{opacity:.55;cursor:default}
.tm-crumbs{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:10px}
.tm-crumb{display:inline-flex;align-items:center;padding:2px 4px 2px 10px;border-radius:999px;font-size:12px;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-active)}
.tm-crumb-x{border:none;background:none;padding:0 4px;cursor:pointer;font:inherit;font-size:13px;line-height:1;
  color:var(--dsw-alias-label-secondary)}
.tm-crumb-x:hover{color:var(--dsw-alias-label-primary)}
.tm-check{flex:none;width:14px;height:14px;margin:0;cursor:pointer}
/* ── 表格视图 ── 自己滚：横向列多，纵向配 sticky 表头。 */
.tm-tablewrap{overflow:auto;overscroll-behavior:contain;max-height:min(68vh,860px);border-radius:10px;
  box-shadow:inset 0 0 0 1px var(--dsw-alias-separator,rgba(127,127,127,.18))}
.tm-table{border-collapse:separate;border-spacing:0;width:100%;font-size:12px;line-height:1.6}
.tm-table th,.tm-table td{padding:5px 9px;text-align:left;vertical-align:top;white-space:nowrap;
  border-bottom:1px solid var(--dsw-alias-separator,rgba(127,127,127,.14))}
.tm-table thead th{position:sticky;top:0;z-index:1;font-weight:600;white-space:nowrap;
  background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-base));
  border-bottom:1px solid var(--dsw-alias-separator,rgba(127,127,127,.32))}
.tm-table tbody tr:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tm-table tbody tr:last-child td{border-bottom:none}
.tm-col-check{width:1%}
.tm-td-id{font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:var(--dsw-alias-label-secondary)}
.tm-clip{display:block;max-width:32ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tm-clip-wide{max-width:52ch}
.tm-td-ops{white-space:nowrap}
.tm-td-ops .tm-link{margin-left:0;margin-right:12px}
.tm-td-ops .tm-link:last-child{margin-right:0}
.tm-tr-detail>td{white-space:normal;background:var(--dsw-alias-interactive-bg-hover)}
.tm-tools{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
.tm-count{font-size:12px;color:var(--dsw-alias-label-secondary)}

/* ── 备份 / 恢复 / 合并 ──
   按钮不另占一张卡：跟标题同一行，右对齐 —— 主位留给「要看的条目」。 */
.tm-headrow{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.tm-headrow>.tm-head{flex:auto;margin:0}
.tm-barbtns{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.tm-bkline{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);
  display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.tm-bkline b{font-weight:600;color:var(--dsw-alias-label-primary)}
.tm-bkline>span{overflow-wrap:anywhere}
.tm-warn{color:#e0a800}
.tm-ok{color:#39b54a}
.tm-bad{color:var(--dsw-alias-label-error,inherit)}
.tm-pane{margin-top:10px;padding:12px 14px;border-radius:12px;
  background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-base));
  box-shadow:inset 0 0 0 1px var(--dsw-alias-separator,rgba(127,127,127,.18))}
.tm-pane-h{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.tm-pane-t{margin:0;font-size:13px;font-weight:600;flex:auto}
/* 内建目录浏览：系统选择框弹不出来时的兜底 */
.tm-browse{margin-top:10px;padding:10px;border-radius:10px;
  background:var(--dsw-alias-bg-base,transparent);
  box-shadow:inset 0 0 0 1px var(--dsw-alias-separator,rgba(127,127,127,.18))}
.tm-crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:2px;font-size:12px;margin-bottom:8px}
.tm-crumb-wrap{display:inline-flex;align-items:center;gap:2px}
.tm-crumb-sep{color:var(--dsw-alias-label-secondary);opacity:.6}
.tm-crumb{border:none;background:none;padding:2px 6px;border-radius:6px;cursor:pointer;
  font:inherit;font-size:12px;color:var(--dsw-alias-label-primary)}
.tm-crumb:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tm-browse-list{display:flex;flex-wrap:wrap;gap:6px;max-height:200px;overflow:auto}
.tm-dir{flex:0 1 auto;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  height:26px;padding:0 10px;border:none;border-radius:8px;cursor:pointer;font:inherit;font-size:12px;
  background:var(--dsw-alias-interactive-bg,var(--dsw-alias-bg-overlay));
  color:var(--dsw-alias-label-primary)}
.tm-dir:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tm-bkrow{display:flex;align-items:center;gap:10px;padding:6px 0;font-size:12px;line-height:1.6;
  border-top:1px solid var(--dsw-alias-separator,rgba(127,127,127,.14))}
.tm-bkrow:first-of-type{border-top:none}
.tm-bkrow .tm-mono{font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.tm-bkrow .tm-tag{margin-left:auto}
.tm-fold{border:none;background:none;padding:0;cursor:pointer;font:inherit;font-size:12px;
  color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;gap:6px}
.tm-fold:hover{color:var(--dsw-alias-label-primary)}
.tm-kv{display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:1.6}
.tm-kv-row{display:grid;grid-template-columns:auto 1fr;gap:12px}
.tm-kv-k{color:var(--dsw-alias-label-secondary);white-space:nowrap}
.tm-kv-v{word-break:break-word}
`

		/** 样式表每个文档注入一次。 */
		function ensureStyles() {
			if (document.getElementById('dsh-tag-memory-css') !== null) return
			const tag = document.createElement('style')
			tag.id = 'dsh-tag-memory-css'
			tag.textContent = CSS
			document.head.appendChild(tag)
		}

		/**
		 * 把服务端的原始错误译成人话。
		 *
		 * **`unknown op "/xxx"` = 宿主的版本比界面旧**：DSH 只在**启动时**装载插件的服务端半边，
		 * 而客户端模块会**热更**——所以很容易出现「界面已经是新版、路由表还是老版」。
		 * 这时任何新加的路由都会回 `unknown op`，把这句话直接甩给用户，人只会一头雾水
		 * （真踩过：新界面调 `POST /backup/dir` 存地址，旧宿主没这条路，界面弹的是一句
		 * `unknown op "/backup/dir"`，看着像自己填错了）。
		 */
		function humanError(raw, url) {
			const text = String(raw ?? '')
			if (/unknown op/.test(text)) {
				const op = String(url ?? '').replace(/^.*\/tag-memory-api/, '') || '这条'
				return `这台 DSH 的服务端还是旧版（路由表里没有 ${op}）——界面已经更新，重启一次 DSH 就好。`
			}
			return text
		}

		/** 取一份 JSON；网络/非 JSON 都抛成人话。 */
		async function loadJSON(url, init) {
			const response = await fetch(url, {
				headers: { accept: 'application/json' },
				...init,
			})
			const data = await response.json()
			if (data && data.error !== undefined && data.error !== null) throw new Error(humanError(data.error, url))
			return data
		}

		/**
		 * POST 一份 JSON 并**原样**拿回结果。
		 * 备份/恢复/合并这几个接口把「失败」也当事返回（`{ok:false, code, error}`），
		 * 界面要按 code 分派（比如 NO_DIR 就切进设置地址的状态），所以这里不替它抛。
		 */
		async function postJSON(url, body) {
			const response = await fetch(url, {
				method: 'POST',
				headers: { accept: 'application/json', 'content-type': 'application/json' },
				body: JSON.stringify(body ?? {}),
			})
			let data
			try { data = await response.json() } catch {
				throw new Error(`服务端没回 JSON（HTTP ${response.status}）`)
			}
			// 失败也照样返回（调用方按 code 分派），只把 `unknown op` 这种协议黑话先译成人话。
			if (data !== null && typeof data === 'object' && typeof data.error === 'string') {
				data.error = humanError(data.error, url)
			}
			return data
		}

		/** 字节数说成人话。 */
		function humanBytes(n) {
			if (n === null || n === undefined || !Number.isFinite(n)) return ''
			const units = ['B', 'KB', 'MB', 'GB', 'TB']
			let v = n, i = 0
			while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
			return `${i === 0 ? v : v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`
		}

		/** `2026-10-14T08:42:03+08:00` → `2026-10-14 08:42`。 */
		function shortTime(text) {
			const s = String(text ?? '')
			return s.length >= 16 ? `${s.slice(0, 10)} ${s.slice(11, 16)}` : s
		}

		function Stat(props) {
			return React.createElement(
				'div',
				{ className: 'tm-stat' },
				React.createElement('div', { className: 'tm-stat-n' }, props.value),
				React.createElement('div', { className: 'tm-stat-l' }, props.label),
			)
		}

		/**
		 * 设置里的「记忆」页：库概况 + 按维度浏览 + 关键词搜 + 记忆文件托管状态。
		 * 只读——写入由智能体通过 memory_write 工具做。
		 */
		function MemorySection(props) {
			const [overview, setOverview] = React.useState(null)
			const [items, setItems] = React.useState([])
			const [total, setTotal] = React.useState(0)
			const [hasMore, setHasMore] = React.useState(false)
			const [loading, setLoading] = React.useState(true)
			const [loadingMore, setLoadingMore] = React.useState(false)
			const [saved] = React.useState(() => loadView() ?? {})
			const [q, setQ] = React.useState('')
			const [cond, setCond] = React.useState(() => (saved.cond !== null && typeof saved.cond === 'object' ? saved.cond : {}))
			const [limit, setLimit] = React.useState(() => (typeof saved.limit === 'number' && PAGE_SIZES.includes(saved.limit) ? saved.limit : 50))
			const [sort, setSort] = React.useState(() => (SORTS.some(([value]) => value === saved.sort) ? saved.sort : 'time_desc'))
			const [includeArchived, setIncludeArchived] = React.useState(() => saved.includeArchived === true)
			/**
			 * 表格 / 卡片两种视图。默认值看宿主：主区宽，给表格；设置页窄，给卡片。
			 * localStorage 里存过就听用户的。
			 */
			const fallbackView = props !== null && props !== undefined && props.defaultView === 'cards' ? 'cards' : 'table'
			const [view, setView] = React.useState(() => (saved.view === 'cards' || saved.view === 'table' ? saved.view : fallbackView))
			const [expanded, setExpanded] = React.useState({})
			const [fullText, setFullText] = React.useState({})
			const [selected, setSelected] = React.useState({})
			const [tip, setTip] = React.useState('')
			const searchRef = React.useRef(null)

			// 视图偏好落本地，重开设置页还在。
			React.useEffect(() => {
				try {
					window.localStorage.setItem(STORE_KEY, JSON.stringify({ cond, sort, limit, includeArchived, view }))
				} catch { /* 隐私模式/配额，忽略 */ }
			}, [cond, sort, limit, includeArchived, view])

			// 键盘：`/` 聚焦搜索框，`Esc` 清空全部条件与关键词。
			React.useEffect(() => {
				function onKey(event) {
					const target = event.target
					const tag = target !== null && target !== undefined ? target.tagName : ''
					const typing = tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable === true
					if (event.key === '/' && !typing) {
						event.preventDefault()
						if (searchRef.current !== null) searchRef.current.focus()
						return
					}
					if (event.key === 'Escape') {
						setCond({})
						setIncludeArchived(false)
						setQ('')
					}
				}
				window.addEventListener('keydown', onKey)
				return () => window.removeEventListener('keydown', onKey)
			}, [])
			const [error, setError] = React.useState(null)
			const [busy, setBusy] = React.useState(false)
			const [note, setNote] = React.useState('')

			// ── 备份 / 恢复 / 合并 ──
			const [bk, setBk] = React.useState(null)
			/** 正在跑的备份动作（'' | 'backup' | 'dir' | 'restore' | 'merge'），按钮据此转圈。 */
			const [bkBusy, setBkBusy] = React.useState('')
			const [bkNote, setBkNote] = React.useState(null)
			/** 设置备份地址那一小块。没地址时点「立即备份」会把它打开——降级，不是弹提醒。 */
			const [dirOpen, setDirOpen] = React.useState(false)
			const [dirValue, setDirValue] = React.useState('')
			/** 系统文件夹选择框开着的时候为 true（它一次只能开一个）。 */
			const [pickerBusy, setPickerBusy] = React.useState(false)
			/** 系统框拿不到时的兜底：内建目录浏览（listDirectory 给的一层）。 */
			const [browse, setBrowse] = React.useState(null)
			const [browseBusy, setBrowseBusy] = React.useState(false)
			const dirRef = React.useRef(null)
			const [restoreOpen, setRestoreOpen] = React.useState(false)
			const [mergeOpen, setMergeOpen] = React.useState(false)
			const [mergePath, setMergePath] = React.useState('')
			const [mergeReport, setMergeReport] = React.useState(null)
			/** 维护区（托管状态 + 备份历史）默认收起——次位的东西不占主显示区。 */
			const [maintOpen, setMaintOpen] = React.useState(false)
			/** 改号 → 重新取第一页（恢复 / 合并换过库之后要重读）。 */
			const [reloadKey, setReloadKey] = React.useState(0)
			const reloadEntries = () => setReloadKey((k) => k + 1)

			React.useEffect(() => {
				ensureStyles()
			}, [])

			// 概况（含维度取值与计数），只在挂载时取一次。
			React.useEffect(() => {
				let alive = true
				loadJSON(`${API}/overview`)
					.then((data) => { if (alive) setOverview(data) })
					.catch((failure) => { if (alive) setError(String((failure && failure.message) || failure)) })
				return () => { alive = false }
			}, [])

			/**
			 * 实发条件：开了「含已归档」就把**全部状态取值 + 留白**显式写进去——
			 * core 只在条件「没提状态」时才默认排除 被取代/已归档，显式写了就不排除。
			 */
			const statusAll =
				overview !== null && Array.isArray(overview.statusValues) && overview.statusValues.length > 0
					? overview.statusValues
					: STATUS_FALLBACK
			const effectiveCond = (function () {
				const next = { ...cond }
				if (includeArchived) {
					const base = next['状态'] !== undefined ? asArr(next['状态']) : statusAll.concat('留白')
					next['状态'] = Array.from(new Set(base.concat(['被取代', '已归档'])))
				}
				return next
			})()
			const condKey = JSON.stringify(effectiveCond)

			/** 拼一页的查询串；offset=0 即首页。 */
			function pageQuery(offset) {
				const params = new URLSearchParams()
				if (condKey !== '{}') params.set('cond', condKey)
				if (q.trim() !== '') params.set('q', q.trim())
				params.set('sort', sort)
				params.set('limit', String(limit))
				params.set('offset', String(offset))
				return params.toString()
			}

			// 条件/关键词/排序/每页数一变就回到首页重取。
			React.useEffect(() => {
				let alive = true
				setLoading(true)
				loadJSON(`${API}/entries?${pageQuery(0)}`)
					.then((result) => {
						if (!alive) return
						setItems(Array.isArray(result.hits) ? result.hits : [])
						setTotal(result.total ?? 0)
						setHasMore(result.hasMore === true)
						setError(null)
					})
					.catch((failure) => { if (alive) setError(String((failure && failure.message) || failure)) })
					.finally(() => { if (alive) setLoading(false) })
				return () => { alive = false }
			}, [condKey, q, limit, sort, reloadKey])

			/** 「加载更多」：从已示条数接着取下一页。 */
			async function loadMore() {
				setLoadingMore(true)
				try {
					const result = await loadJSON(`${API}/entries?${pageQuery(items.length)}`)
					setItems((prev) => prev.concat(Array.isArray(result.hits) ? result.hits : []))
					setTotal(result.total ?? 0)
					setHasMore(result.hasMore === true)
				} catch (failure) {
					setError(String((failure && failure.message) || failure))
				} finally {
					setLoadingMore(false)
				}
			}

			async function heal() {
				setBusy(true)
				setNote('')
				try {
					const result = await loadJSON(`${API}/heal`, { method: 'POST' })
					setOverview((prev) => (prev === null ? prev : { ...prev, notice: result.notice }))
					const s = result.summary ?? {}
					setNote(s.written > 0 ? `已补写 ${s.written} 个记忆文件的说明块` : `说明块均在位（核对了 ${s.checked ?? 0} 个）`)
				} catch (failure) {
					setNote(`自愈失败：${String((failure && failure.message) || failure)}`)
				} finally {
					setBusy(false)
				}
			}

			// ── 备份 / 恢复 / 合并的动作 ────────────────────

			/** 拉一次备份现状。只读，进来就拉。 */
			async function refreshBackup() {
				try {
					const data = await loadJSON(`${API}/backup`)
					setBk(data)
				} catch (failure) {
					setBk({ available: false, error: String((failure && failure.message) || failure) })
				}
			}

			React.useEffect(() => {
				let alive = true
				loadJSON(`${API}/backup`)
					.then((data) => { if (alive) setBk(data) })
					.catch((failure) => { if (alive) setBk({ available: false, error: String((failure && failure.message) || failure) }) })
				return () => { alive = false }
			}, [])

			/** 宿主给的目录选择能力（由 apply 注入；拿不到就是 null，走兜底）。 */
			const hostPick = typeof props?.pickDir === 'function' ? props.pickDir : null
			const hostList = typeof props?.listDir === 'function' ? props.listDir : null

			/**
			 * 这台 DSH 的目录选择是**哪一套后端**——问宿主（`/tag-memory-api/picker`）。
			 *
			 * 两套是**互斥**的，开机时定死：`native` 只响应 `pickDirectory()`（弹系统框），
			 * `browse` 只响应 `listDirectory()`（列目录）。所以「哪颗按钮有用」不是偏好问题，
			 * 是这台机器的事实——问清楚再决定点哪个，别去撞那扇注定关着的门。
			 * `null` = 还没问出来（或老宿主没有这条路由），此时按老办法：先试系统框，失败了再兜底。
			 */
			const [pickerKind, setPickerKind] = React.useState(null)
			React.useEffect(() => {
				let alive = true
				loadJSON(`${API}/picker`)
					.then((data) => { if (alive) setPickerKind(typeof data?.kind === 'string' ? data.kind : null) })
					.catch(() => { /* 问不出来就按未知处理，不影响别的 */ })
				return () => { alive = false }
			}, [])

			/**
			 * 面板开着时，**「现在存着的地址」一变就摆进格子**。
			 *
			 * 这条是「选完就丢」的另一半病根：格子原来恒从空串起步，重开面板 / 刷新后
			 * 明明 `backup.json` 里存着地址，格子里却是空的——看着就像没存上。
			 * 现在格子跟着**库里真正存着的那个值**走（`bk.dir` 来自宿主，进来就拉）。
			 * 只在没有保存动作进行时同步，免得打断正在手输的内容。
			 */
			React.useEffect(() => {
				if (!dirOpen || bkBusy !== '') return
				setDirValue(typeof bk?.dir === 'string' ? bk.dir : '')
			}, [dirOpen, bk?.dir, bkBusy])

			/** 点「设置备份地址」——把面板打开，并直接弹系统的「选择文件夹」框。 */
			function openDirForm() {
				setDirOpen(true)
				setBkNote(null)
				try { window.setTimeout(() => dirRef.current?.focus(), 0) } catch { /* 没有 ref 就算了 */ }
				pickDir()
			}

			/**
			 * 弹系统的「选择文件夹」——用 DSH 自己的那道门（`uiWorkspace.pickDirectory()`），
			 * 也就是开新会话选工作区时弹的同一个框。
			 *
			 * **不自己 spawn 进程**：试过，框开在别的窗口后面（Windows 只把前台激活权给前台进程，
			 * DSH 的原生选择框还得先合成一次 Alt 按键才抢得到）。
			 *
			 * 返回 `null` = 人点了取消，什么都不说；抛异常 = 这台 DSH 没有原生选择能力，
			 * 退回**内建目录浏览**（走 `uiWorkspace.listDirectory()`），两条路都断就还剩手填。
			 */
			async function pickDir() {
				if (pickerBusy) return
				// 这台 DSH 定的是 browse 后端时，`pickDirectory()` **必然**抛错（互斥：browse 只给 list）。
				// 别去撞那扇注定关着的门——直接开内建浏览，省一条没用的报错。
				if (pickerKind === 'browse') {
					if (hostList === null) {
						setBkNote({ kind: 'bad', text: '这台 DSH 选择的是「列目录」那套后端，但这个入口拿不到它——手填绝对路径吧。' })
						return
					}
					setBkNote(null)
					openBrowse()
					return
				}
				if (hostPick === null) {
					setBkNote({ kind: 'bad', text: '这个入口拿不到目录选择服务——用下面的目录浏览，或手填绝对路径。' })
					openBrowse()
					return
				}
				setPickerBusy(true)
				try {
					const picked = await hostPick()
					if (typeof picked === 'string' && picked.trim() !== '') {
						setDirValue(picked.trim())
						setBrowse(null)
						// **选 = 存**：选中即落笔（写进插件的 `store/backup.json`），
						// 不用再点第二颗按钮——用户对「选一次就记住」的预期就是这个。
						await commitDir(picked.trim())
					}
				} catch (failure) {
					// 打一份到控制台：这句是给「真弹不出来」时排查用的，界面上只留一句人话。
					try { console.warn('[dsh-tag-memory] 系统目录选择框没弹出来：', failure) } catch { /* 没控制台就算了 */ }
					// 兜底往下走：DSH 的目录选择有两套后端——native 给「弹系统框」，browse 只给
					// listDirectory。本机是 native（绑 127.0.0.1 + win32），但换台机器 / 换成远程访问
					// 就可能是 browse。所以这儿不猜，直接把内建浏览摊开，列不列得出来它自己会说。
					setBkNote({ kind: 'bad', text: `系统选择框没弹出来（${String((failure && failure.message) || failure)}）——改用下面的目录浏览，或手填绝对路径。` })
					openBrowse()
				} finally {
					setPickerBusy(false)
				}
			}

			/** 内建目录浏览：列一层，点进去，最后「就选这里」。 */
			async function openBrowse(path) {
				if (hostList === null) {
					// 不能一声不响地 return——点了没反应比报错更难受。
					setBrowse({ listing: null, error: '这个入口拿不到目录浏览服务（listDir）' })
					return
				}
				setBrowseBusy(true)
				try {
					const listing = await hostList(path)
					setBrowse({ listing, error: '' })
				} catch (failure) {
					setBrowse({ listing: null, error: String((failure && failure.message) || failure) })
				} finally {
					setBrowseBusy(false)
				}
			}

			/**
			 * 点「立即备份」。
			 * **没设地址不是弹提醒**——直接降级成「设置备份地址」那个状态（同一块面板）。
			 */
			async function doBackup() {
				if (bk === null || bk.dirSet !== true) { openDirForm(); return }
				setBkBusy('backup')
				setBkNote(null)
				try {
					const r = await postJSON(`${API}/backup`, {})
					if (r.ok) {
						const n = r.result?.entryCount ?? 0
						const extra = [
							r.result?.shifted > 0 ? '那个时间点已有内容不同的同名文件，这一份往后挪了几秒（备份从不覆盖已有内容）' : null,
							r.result?.rotated?.length ? `轮转清掉 ${r.result.rotated.length} 份旧档` : null,
						].filter(Boolean)
						setBkNote({ kind: 'ok', text: `备份好了：${n} 条 → ${r.result?.stamp ?? ''}${extra.length > 0 ? `（${extra.join('；')}）` : ''}` })
						if (r.status) setBk(r.status)
					} else {
						setBkNote({ kind: 'bad', text: `备份没成：${r.error ?? r.code}` })
						if (r.status) setBk(r.status)
					}
				} catch (failure) {
					setBkNote({ kind: 'bad', text: `备份没成：${String((failure && failure.message) || failure)}` })
				} finally {
					setBkBusy('')
				}
			}

			/**
			 * **把备份地址落进插件**——写 `store/backup.json` 的 `backupDir`。
			 *
			 * 这是地址的**唯一落笔点**：「选择文件夹…」和「就选这个目录」选中后自动走这里，
			 * 手填也在「保存这个地址」里走这里。**落笔之后刷新 / 重开界面都读得到**
			 * （面板顶上就摆着「当前地址」那一行），直到下一次重新选 / 重新保存为止。
			 *
			 * **只存地址，不顺手备份**——备份是另一件事，归标题行的「立即备份」管。
			 * 之前把两件事捆在一颗「存下并立刻备份」上，用户根本分不清到底存没存上：
			 * 选完就丢，正是那颗按钮的锅（选完不点它，地址就没落笔）。
			 */
			async function commitDir(value) {
				const dir = String(value ?? '').trim()
				if (dir === '') {
					// 空着点保存：把选择框弹出来让人选，别干等着。
					setBkNote({ kind: 'bad', text: '还没选目录呢——挑一个，或者把绝对路径粘进上面那格。' })
					return false
				}
				setBkBusy('dir')
				setBkNote(null)
				try {
					const r = await postJSON(`${API}/backup/dir`, { dir })
					if (!r.ok) {
						setBkNote({ kind: 'bad', text: r.error ?? '地址没存上' })
						return false
					}
					setDirValue(r.dir)
					if (r.status) setBk(r.status)
					setBkNote({
						kind: 'ok',
						text: `备份地址已保存：${r.dir}${r.created ? '（已新建目录）' : ''}。以后打开界面都是这儿；要立刻备份就点上面的「立即备份」。`,
					})
					return true
				} catch (failure) {
					setBkNote({ kind: 'bad', text: `地址没存上：${String((failure && failure.message) || failure)}` })
					return false
				} finally {
					setBkBusy('')
				}
			}

			/** 从某一份备份**整体替换**当前库；服务端会先强制留档再换。 */
			async function doRestore(stamp) {
				setBkBusy('restore')
				setBkNote(null)
				try {
					const r = await postJSON(`${API}/restore`, { stamp })
					if (r.ok) {
						setBkNote({ kind: 'ok', text: `已整体替换成 ${stamp} 那一版（${r.entryCount} 条）。替换前的那一版留档在 ${r.preBackup}。` })
						setRestoreOpen(false)
						if (r.status) setBk(r.status)
						await reloadEntries()
					} else {
						setBkNote({ kind: 'bad', text: `恢复没成：${r.error ?? r.code}` })
					}
				} catch (failure) {
					setBkNote({ kind: 'bad', text: `恢复没成：${String((failure && failure.message) || failure)}` })
				} finally {
					setBkBusy('')
				}
			}

			/** 合并预演 / 真合并。预演不落笔。 */
			async function doMerge(apply) {
				const path = String(mergePath ?? '').trim()
				if (path === '') { setBkNote({ kind: 'bad', text: '先填另一台机器那份 memory.csv 的绝对路径' }); return }
				setBkBusy('merge')
				setBkNote(null)
				try {
					const r = await postJSON(`${API}/merge`, { path, apply: apply === true })
					if (!r.ok) { setBkNote({ kind: 'bad', text: `合并没成：${r.error ?? r.code}` }); return }
					setMergeReport(r)
					if (r.dryRun === false) {
						setBkNote({ kind: 'ok', text: `合并完成：新增 ${r.appended?.length ?? 0} 条，跳过重复 ${r.counts?.duplicate ?? 0} 条；合并前那一版留档在 ${r.preBackup}。` })
						if (r.status) setBk(r.status)
						await reloadEntries()
					}
				} catch (failure) {
					setBkNote({ kind: 'bad', text: `合并没成：${String((failure && failure.message) || failure)}` })
				} finally {
					setBkBusy('')
				}
			}

			/**
			 * 点某个维度值：选中 / 取消。同一维度多值 = 或，维度之间 = 与。
			 * 值一律存成数组，正好对上 core `matchKey` 的「多值」写法。
			 */
			function toggleDim(dim, value) {
				setCond((current) => {
					const next = { ...current }
					const list = next[dim] === undefined ? [] : asArr(next[dim])
					const after = list.includes(value) ? list.filter((v) => v !== value) : list.concat(value)
					if (after.length === 0) delete next[dim]
					else next[dim] = after
					return next
				})
			}

			/** 该维度值是否已选中（cond 里存的是数组）。 */
			function dimOn(dim, value) {
				return asArr(cond[dim] ?? []).includes(value)
			}

			/** 勾选 / 取消一条；存整行，方便后面复制导出。 */
			function toggleSelect(row) {
				setSelected((prev) => {
					const next = { ...prev }
					if (next[row.id] !== undefined) delete next[row.id]
					else next[row.id] = row
					return next
				})
			}

			/** 复制一段文本：先试剪贴板 API，失败退回临时 textarea + execCommand。 */
			async function copyText(text) {
				try {
					if (navigator.clipboard && navigator.clipboard.writeText) {
						await navigator.clipboard.writeText(text)
						return true
					}
				} catch { /* 落到兜底 */ }
				try {
					const area = document.createElement('textarea')
					area.value = text
					area.style.position = 'fixed'
					area.style.opacity = '0'
					document.body.appendChild(area)
					area.select()
					const done = document.execCommand('copy')
					area.remove()
					return done
				} catch { return false }
			}

			/** 选中条目 → Markdown 列表。 */
			function rowsToMarkdown(rows) {
				return rows
					.map((row) => {
						const meta = DETAIL_FIELDS
							.map((name) => (row[name] ? `${name}=${row[name]}` : null))
							.filter(Boolean)
							.join(' · ')
						return `- **${row.id}** ${row.内容 || ''}${meta ? `\n  - ${meta}` : ''}`
					})
					.join('\n')
			}

			/** 选中条目 → CSV（字段与设置页一致）。 */
			function rowsToCSV(rows) {
				const cols = ['id', '内容', ...DETAIL_FIELDS]
				const esc = (value) => {
					const s = String(value ?? '')
					return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
				}
				return [cols.join(','), ...rows.map((row) => cols.map((c) => esc(row[c])).join(','))].join('\n')
			}

			/** 把当前页的条目并入选择。 */
			function selectAllVisible() {
				toggleAllVisible(true)
			}

			/** 表头那个复选框：一次选中/取消本页全部。 */
			function toggleAllVisible(on) {
				setSelected((prev) => {
					const next = { ...prev }
					for (const row of items) {
						if (on) next[row.id] = row
						else delete next[row.id]
					}
					return next
				})
			}

			/** 复制选中条目为 Markdown。 */
			async function copySelected() {
				const rows = Object.values(selected)
				if (rows.length === 0) return setTip('先勾选条目，再复制。')
				const ok = await copyText(rowsToMarkdown(rows))
				setTip(ok ? `已复制 ${rows.length} 条为 Markdown` : '复制失败：浏览器未授予剪贴板权限')
			}

			/** 导出选中条目为 CSV 文件。 */
			function exportSelected() {
				const rows = Object.values(selected)
				if (rows.length === 0) return setTip('先勾选条目，再导出。')
				const blob = new Blob([rowsToCSV(rows)], { type: 'text/csv;charset=utf-8' })
				const url = URL.createObjectURL(blob)
				const link = document.createElement('a')
				link.href = url
				link.download = `tag-memory-${new Date().toISOString().slice(0, 10)}.csv`
				document.body.appendChild(link)
				link.click()
				link.remove()
				URL.revokeObjectURL(url)
				setTip(`已导出 ${rows.length} 条`)
			}

			/** 复制单条为 Markdown。 */
			async function copyOne(row) {
				const ok = await copyText(rowsToMarkdown([row]))
				setTip(ok ? `已复制 ${row.id}` : '复制失败：浏览器未授予剪贴板权限')
			}

			/** 当前条件的面包屑：每个标签可单独撤掉。 */
			function renderCrumbs() {
				const chips = []
				for (const [dim, values] of Object.entries(cond)) {
					for (const value of asArr(values)) {
						chips.push(
							React.createElement(
								'span',
								{ key: `${dim}=${value}`, className: 'tm-crumb' },
								`${dim}=${value}`,
								React.createElement(
									'button',
									{ type: 'button', className: 'tm-crumb-x', title: '移除这个条件', onClick: () => toggleDim(dim, value) },
									'×',
								),
							),
						)
					}
				}
				if (includeArchived) {
					chips.push(
						React.createElement(
							'span',
							{ key: '含已归档', className: 'tm-crumb' },
							'含已归档',
							React.createElement(
								'button',
								{ type: 'button', className: 'tm-crumb-x', title: '移除这个条件', onClick: () => setIncludeArchived(false) },
								'×',
							),
						),
					)
				}
				return chips.length === 0 ? null : React.createElement('div', { className: 'tm-crumbs' }, chips)
			}

			/** 翻转一个 {id: true} 形态的开关表（详情展开 / 正文展开）。 */
			function toggleFlag(setter, key) {
				setter((prev) => ({ ...prev, [key]: prev[key] !== true }))
			}

			/**
			 * 一条记忆的详情：全部非空字段（正文也在里面）。
			 * 卡片视图铺在卡片底部，表格视图铺在那一行下面——两处共用。
			 */
			function renderDetail(row) {
				const detail = DETAIL_FIELDS
					.map((name) => [name, row[name]])
					.filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
				return React.createElement(
					'div',
					{ className: 'tm-detail' },
					detail.length === 0
						? React.createElement('span', { className: 'tm-detail-k' }, '（无其它字段）')
						: detail.map(([name, value]) =>
								React.createElement(
									React.Fragment,
									{ key: name },
									React.createElement('span', { className: 'tm-detail-k' }, name),
									React.createElement('span', { className: 'tm-detail-v' }, String(value)),
								),
							),
				)
			}

			/** 表格单元格的文本：多行压成一行，过长截断（全文在 title 与「详情」里）。 */
			function cellText(value) {
				const text = String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim()
				return text.length > CELL_CLIP ? text.slice(0, CELL_CLIP) + '…' : text
			}

			/** 一条记忆：正文过长可折叠，点「详情」就地展开全部非空字段。 */
			function renderItem(row, index) {
				const id = row.id || String(index)
				const content = row.内容 || '（无内容）'
				const isLong = content.length > CONTENT_CLIP
				const showFull = fullText[id] === true
				const shown = isLong && !showFull ? content.slice(0, CONTENT_CLIP) + '…' : content

				const tags = []
				for (const name of ['类型', '深度', '稳定性', '距离', '角色', '项目', '状态']) {
					if (row[name]) tags.push(React.createElement('span', { key: name, className: 'tm-mtag' }, `${name} `, React.createElement('b', null, row[name])))
				}
				if (row.时间) tags.push(React.createElement('span', { key: '时间', className: 'tm-mtag' }, row.时间))

				const open = expanded[id] === true

				return React.createElement(
					'div',
					{ key: id, className: 'tm-item' },
					React.createElement(
						'div',
						{ className: 'tm-item-h' },
						React.createElement('input', {
							type: 'checkbox',
							className: 'tm-check',
							checked: selected[id] !== undefined,
							onChange: () => toggleSelect(row),
						}),
						React.createElement('span', { className: 'tm-id' }, row.id),
						React.createElement(
							'span',
							{ className: 'tm-content' },
							shown,
							isLong
								? React.createElement(
										'button',
										{ type: 'button', className: 'tm-link', onClick: () => toggleFlag(setFullText, id) },
										showFull ? '收起' : '展开',
									)
								: null,
						),
					),
					tags.length > 0 ? React.createElement('div', { className: 'tm-meta' }, tags) : null,
					React.createElement(
						'div',
						{ className: 'tm-actions' },
						React.createElement(
							'button',
							{ type: 'button', className: 'tm-link', onClick: () => toggleFlag(setExpanded, id) },
							open ? '收起详情' : '详情',
						),
						React.createElement(
							'button',
							{ type: 'button', className: 'tm-link', onClick: () => copyOne(row) },
							'复制',
						),
					),
					open ? renderDetail(row) : null,
				)
			}

			/**
			 * 表格视图：库本来就是 CSV，一行一条、一列一个字段，比卡片省地方得多。
			 * 表头 + 首列（勾选）常驻，横向可滚；行内「详情」展开这一行的全部字段。
			 */
			function renderTable() {
				const ids = items.map((row) => row.id)
				const allOn = ids.length > 0 && ids.every((id) => selected[id] !== undefined)

				/**
				 * 列名与列序都照库自己的表头（`overview.header`），只是挑了其中一拨显示。
				 * 库改了列名/挪了列序，表格跟着走；表头里没有的列（老库）自动跳过。
				 * 个别维度名与列名不同（`成熟度` 列在 schema 里叫 `深度`），所以行对象里
				 * 的键要经维度映射——表头显示列名，筛选下拉显示维度名。
				 */
				const header = overview !== null && Array.isArray(overview.header) && overview.header.length > 0
					? overview.header
					: FALLBACK_HEADER
				const picked = DEFAULT_COLUMNS.filter((name) => header.includes(name))
				const columns = (picked.length > 0 ? picked : header.slice(0, 12)).map((name) => {
					const dim = dims.find((d) => d.column === name)
					return {
						name,
						key: dim === undefined ? name : dim.name,
						hint: dim === undefined ? '' : `（维度「${dim.name}」）`,
						kind: COLUMN_KIND[name] ?? '',
					}
				})

				const head = React.createElement(
					'thead',
					null,
					React.createElement(
						'tr',
						null,
						React.createElement(
							'th',
							{ className: 'tm-col-check' },
							React.createElement('input', {
								type: 'checkbox',
								className: 'tm-check',
								checked: allOn,
								title: allOn ? '取消全选本页' : '全选本页',
								onChange: () => toggleAllVisible(!allOn),
							}),
						),
						columns.map((col) => React.createElement('th', { key: col.name, title: col.hint || undefined }, col.name)),
						React.createElement('th', null, '操作'),
					),
				)

				const body = React.createElement(
					'tbody',
					null,
					items.flatMap((row, index) => {
						const id = row.id || String(index)
						const open = expanded[id] === true
						const main = React.createElement(
							'tr',
							{ key: id },
							React.createElement(
								'td',
								{ className: 'tm-col-check' },
								React.createElement('input', {
									type: 'checkbox',
									className: 'tm-check',
									checked: selected[id] !== undefined,
									onChange: () => toggleSelect(row),
								}),
							),
							columns.map((col) =>
								React.createElement(
									'td',
									{ key: col.name, className: col.kind === 'mono' ? 'tm-td-id' : undefined },
									React.createElement(
										'span',
										{
											className: col.kind === 'wide' ? 'tm-clip tm-clip-wide' : 'tm-clip',
											title: String(row[col.key] === undefined || row[col.key] === null ? '' : row[col.key]),
										},
										cellText(row[col.key]) || '—',
									),
								),
							),
							React.createElement(
								'td',
								{ className: 'tm-td-ops' },
								React.createElement(
									'button',
									{ type: 'button', className: 'tm-link', onClick: () => toggleFlag(setExpanded, id) },
									open ? '收起' : '详情',
								),
								React.createElement(
									'button',
									{ type: 'button', className: 'tm-link', onClick: () => copyOne(row) },
									'复制',
								),
							),
						)
						if (!open) return [main]
						return [
							main,
							React.createElement(
								'tr',
								{ key: `${id}-detail`, className: 'tm-tr-detail' },
								React.createElement('td', { colSpan: columns.length + 2 }, renderDetail(row)),
							),
						]
					}),
				)

				return React.createElement(
					'div',
					{ className: 'tm-tablewrap' },
					React.createElement('table', { className: 'tm-table' }, head, body),
				)
			}

			// ── 备份相关的几块 ─────────────────────────────

			/** 标题右边那一排按钮。备份是「用户要点的」，所以放在主位、跟标题同一行。 */
			function renderBarButtons() {
				const set = bk !== null && bk.dirSet === true
				return React.createElement(
					'div',
					{ className: 'tm-barbtns' },
					React.createElement(
						'button',
						{ type: 'button', className: 'tm-btn', disabled: bkBusy !== '', onClick: doBackup },
						bkBusy === 'backup' ? '备份中…' : '立即备份',
					),
					React.createElement(
						'button',
						{
							type: 'button',
							className: 'tm-btn',
							disabled: bkBusy !== '' || !set,
							title: set ? '拿某一份备份把当前记忆库整体换掉' : '先设置备份地址',
							onClick: () => { setRestoreOpen((v) => !v); setMergeOpen(false); setBkNote(null) },
						},
						'恢复…',
					),
					React.createElement(
						'button',
						{
							type: 'button',
							className: 'tm-btn',
							disabled: bkBusy !== '',
							title: '把另一台机器的 memory.csv 并进来（只追加，不删不改）',
							onClick: () => { setMergeOpen((v) => !v); setRestoreOpen(false); setBkNote(null) },
						},
						'合并…',
					),
					React.createElement(
						'button',
						{ type: 'button', className: 'tm-btn tm-primary', disabled: bkBusy !== '', onClick: openDirForm },
						'设置备份地址…',
					),
				)
			}

			/** 标题下面那行备份现状：地址 / 上次 / 条数差 / 份数。 */
			function renderBackupLine() {
				if (bk === null) return React.createElement('div', { className: 'tm-bkline' }, '备份：读取中…')
				if (bk.available === false) {
					return React.createElement(
						'div',
						{ className: 'tm-bkline' },
						React.createElement('span', { className: 'tm-bad' }, `备份功能不可用：${bk.error ?? ''}`),
					)
				}
				const parts = []
				parts.push(React.createElement('span', { key: 'dir' },
					React.createElement('span', null, '备份地址：'),
					bk.dirSet
						? React.createElement('b', null, bk.dir)
						: React.createElement('span', { className: 'tm-warn' }, '未设置'),
				))
				parts.push(React.createElement('span', { key: 'when' },
					React.createElement('span', null, '上次备份：'),
					bk.lastBackupAt === ''
						? React.createElement('span', { className: 'tm-warn' }, '从未')
						: React.createElement('b', null, shortTime(bk.lastBackupAt)),
				))
				if (bk.dirSet) {
					const delta = bk.delta
					parts.push(React.createElement('span', { key: 'count' },
						`库里 ${bk.currentCount} 条`,
						typeof delta === 'number' && delta !== 0 ? `（比上次 ${delta > 0 ? '+' : ''}${delta}）` : '',
					))
					parts.push(React.createElement('span', { key: 'copies' },
						`备份 ${bk.copies} 份${bk.totalBytes > 0 ? ` / ${humanBytes(bk.totalBytes)}` : ''}`,
					))
					if (bk.freeBytes !== null && bk.freeBytes !== undefined) {
						parts.push(React.createElement('span', { key: 'free' }, `盘上余 ${humanBytes(bk.freeBytes)}`))
					}
					if (bk.dirError !== '') parts.push(React.createElement('span', { key: 'err', className: 'tm-warn' }, bk.dirError))
					if (bk.due) parts.push(React.createElement('span', { key: 'due', className: 'tm-warn' }, `该备份了：${bk.dueReason.join('；')}`))
				}
				return React.createElement('div', { className: 'tm-bkline' }, parts)
			}

			/**
			 * 设置备份地址。**没有默认目录**——地址由人给。
			 * 点「立即备份」而地址为空时，打开的就是这一块（降级），而不是弹一句提醒。
			 */
			function renderDirPane() {
				if (!dirOpen) return null
				return React.createElement(
					'div',
					{ className: 'tm-pane' },
					React.createElement(
						'div',
						{ className: 'tm-pane-h' },
						React.createElement('h2', { className: 'tm-pane-t' }, '设置备份地址'),
						React.createElement(
							'button',
							{ type: 'button', className: 'tm-btn', onClick: () => setDirOpen(false) },
							'收起',
						),
					),
					// 一打开就摆出**库里真正存着的那个地址**——不然空格子让人以为没存上。
					React.createElement(
						'div',
						{ className: 'tm-field', style: { marginBottom: '8px' } },
						React.createElement('span', null, '当前地址：'),
						typeof bk?.dir === 'string' && bk.dir.trim() !== ''
							? React.createElement('b', null, bk.dir)
							: React.createElement('span', { className: 'tm-warn' }, '还没设置'),
					),
					React.createElement(
						'div',
						{ className: 'tm-note', style: { marginBottom: '8px' } },
						'**选一次就记住**：点「浏览」（或下面的目录浏览）选中即存，以后打开界面都是它，直到你重新选。也可以手填绝对路径，按右边「保存这个地址」。备份会往这个目录里写 `memory-<日期>-<时分秒>.csv` 之类的一整套文件；目录不存在会自动新建。别两个引擎共用一个目录——备份本身从不覆盖（戳撞上会往后挪），但**轮转只留最近几份**，共用会让两边互相清掉旧档。',
					),
					// 注意：这里是 div 不是 form。**form 的默认动作是提交导航，会把整页刷掉**——
					// 之前用 form + type=submit，空输入一点就整页重载，等于白点。
					React.createElement(
						'div',
						{ className: 'tm-field' },
						React.createElement('input', {
							className: 'tm-input',
							type: 'text',
							ref: dirRef,
							placeholder: '绝对路径，例如 D:\\backup\\记忆库',
							value: dirValue,
							onChange: (event) => setDirValue(event.target.value),
							onKeyDown: (event) => {
								if (event.key === 'Enter') { event.preventDefault(); commitDir(dirValue) }
							},
						}),
						// 两条路都没接上时就别摆这颗按钮了——点了没反应比没有更难受。
						// 输入框还在，手填绝对路径照样能用。
						(hostPick === null && hostList === null)
							? null
							: React.createElement(
								'button',
								{
									type: 'button',
									className: 'tm-btn',
									disabled: pickerBusy || bkBusy !== '',
									onClick: pickDir,
									// 按钮叫什么、点了会发生什么，取决于**这台 DSH 定的是哪套后端**（互斥）：
									// browse 后端点它开的是内建目录浏览，不是系统框。
									title: pickerKind === 'browse'
										? '这台 DSH 用的是「列目录」后端——点开会在这儿列出目录，点进去再「就选这个目录」'
										: '弹系统的「选择文件夹」框（DSH 自己的 uiWorkspace.pickDirectory）',
								},
								pickerBusy ? '选择框开着…' : (pickerKind === 'browse' ? '浏览目录…' : '浏览…'),
							),
						React.createElement(
							'button',
							{ type: 'button', className: 'tm-btn tm-primary', disabled: bkBusy !== '', onClick: () => commitDir(dirValue) },
							bkBusy === 'dir' ? '保存中…' : '保存这个地址',
						),
					),
					renderBrowse(),
				)
			}

			/**
			 * 内建目录浏览——系统选择框弹不出来时的兜底（也是唯一的「到处都能用」的那条路）。
			 * 数据是宿主 `uiWorkspace.listDirectory()` 给的：当前层 + 面包屑，客户端不自己拼路径。
			 */
			function renderBrowse() {
				if (browse === null) return null
				if (browse.error !== '') {
					return React.createElement('div', { className: 'tm-note tm-warn', style: { marginTop: '8px' } }, `列不出目录：${browse.error}`)
				}
				const l = browse.listing
				const crumbs = Array.isArray(l?.crumbs) ? l.crumbs : []
				const entries = Array.isArray(l?.entries) ? l.entries : []
				return React.createElement(
					'div',
					{ className: 'tm-browse' },
					React.createElement(
						'div',
						{ className: 'tm-crumbs' },
						crumbs.map((c, i) =>
							React.createElement(
								'span',
								{ key: c.path, className: 'tm-crumb-wrap' },
								i > 0 ? React.createElement('span', { className: 'tm-crumb-sep' }, '/') : null,
								React.createElement(
									'button',
									{ type: 'button', className: 'tm-crumb', disabled: browseBusy, onClick: () => openBrowse(c.path) },
									c.name,
								),
							),
						),
					),
					React.createElement(
						'div',
						{ className: 'tm-browse-list' },
						browseBusy
							? React.createElement('div', { className: 'tm-note' }, '读着…')
							: entries.length === 0
								? React.createElement('div', { className: 'tm-note' }, '这一层没有子目录。')
								: entries.map((e) =>
										React.createElement(
											'button',
											{ key: e.path, type: 'button', className: 'tm-dir', onClick: () => openBrowse(e.path) },
											`📁 ${e.name}`,
										),
									),
					),
					React.createElement(
						'div',
						{ className: 'tm-field', style: { marginTop: '8px' } },
						React.createElement(
							'button',
							{
								type: 'button',
								className: 'tm-btn tm-primary',
								disabled: browseBusy || !l?.path,
								onClick: () => { const p = String(l.path); setDirValue(p); setBrowse(null); commitDir(p) },
							},
							'就选这个目录',
						),
						React.createElement(
							'button',
							{ type: 'button', className: 'tm-btn', disabled: browseBusy, onClick: () => openBrowse(l?.path) },
							'刷新',
						),
						React.createElement(
							'button',
							{ type: 'button', className: 'tm-btn', disabled: browseBusy, onClick: () => setBrowse(null) },
							'收起浏览',
						),
					),
				)
			}

			/** 恢复：列出手上有的备份，点一下就把整库换成那一版。 */
			function renderRestorePane() {
				if (!restoreOpen) return null
				const recent = bk !== null && Array.isArray(bk.recent) ? bk.recent : []
				return React.createElement(
					'div',
					{ className: 'tm-pane' },
					React.createElement(
						'div',
						{ className: 'tm-pane-h' },
						React.createElement('h2', { className: 'tm-pane-t' }, '恢复（整体替换）'),
						React.createElement('button', { type: 'button', className: 'tm-btn', onClick: () => setRestoreOpen(false) }, '收起'),
					),
					React.createElement(
						'div',
						{ className: 'tm-note', style: { marginBottom: '8px' } },
						'恢复是**整体替换**：把当前记忆库换成选中的那一版，不是往上面补。所以点下去之前，服务端会先把现在这一版自动留档一份，换完还要再核对一遍记录数；对不上就报错并告诉你用哪一份回退。',
					),
					recent.length === 0
						? React.createElement('div', { className: 'tm-note' }, '备份目录里还没有可恢复的备份。')
						: recent.map((row) => React.createElement(
								'div',
								{ key: row.stamp, className: 'tm-bkrow' },
								React.createElement('span', { className: 'tm-mono' }, row.stamp),
								React.createElement('span', null, row.at !== '' ? shortTime(row.at) : '—'),
								React.createElement('span', null, row.count !== null ? `${row.count} 条` : ''),
								row.label !== '' ? React.createElement('span', { className: 'tm-note' }, row.label) : null,
								React.createElement('span', { className: 'tm-tag' }, row.complete ? humanBytes(row.bytes) : '不完整'),
								React.createElement(
									'button',
									{
										type: 'button',
										className: 'tm-btn',
										disabled: bkBusy !== '' || !row.complete,
										onClick: () => doRestore(row.stamp),
									},
									bkBusy === 'restore' ? '恢复中…' : '用这一份',
								),
							)),
				)
			}

			/** 合并：先预演出报告，人看过再点「确认合并」。 */
			function renderMergePane() {
				if (!mergeOpen) return null
				const r = mergeReport
				return React.createElement(
					'div',
					{ className: 'tm-pane' },
					React.createElement(
						'div',
						{ className: 'tm-pane-h' },
						React.createElement('h2', { className: 'tm-pane-t' }, '合并另一份记忆库'),
						React.createElement('button', { type: 'button', className: 'tm-btn', onClick: () => { setMergeOpen(false); setMergeReport(null) } }, '收起'),
					),
					React.createElement(
						'div',
						{ className: 'tm-note', style: { marginBottom: '8px' } },
						'填另一台机器／另一份库里 `store/memory.csv` 的绝对路径。规矩是：**先留档、只追加、不重写、不删任何条目**；id 撞号按「内容」判——内容一样就跳过，不一样就另给新号。来源里不合规的（内容空、必填缺项）**预演时就会挑出来**，不会等真合并才一条条失败。',
					),
					React.createElement(
						'div',
						{ className: 'tm-field' },
						React.createElement('input', {
							className: 'tm-input',
							type: 'text',
							placeholder: '例如 D:\\other\\skills\\marsma101-tag-memory\\store\\memory.csv',
							value: mergePath,
							onChange: (event) => setMergePath(event.target.value),
						}),
						React.createElement(
							'button',
							{ type: 'button', className: 'tm-btn', disabled: bkBusy !== '', onClick: () => doMerge(false) },
							bkBusy === 'merge' ? '读着…' : '先预演（不落笔）',
						),
						r !== null && r.dryRun !== false
							? React.createElement(
									'button',
									{ type: 'button', className: 'tm-btn tm-primary', disabled: bkBusy !== '' || (r.counts?.new ?? 0) === 0, onClick: () => doMerge(true) },
									`确认合并（新增 ${r.counts?.new ?? 0} 条）`,
								)
							: null,
					),
					r === null ? null : renderMergeReport(r),
				)
			}

			/** §6.4 要的那份交代：新增 / 跳过 / 改号 / 标签差异 / 冲突。 */
			function renderMergeReport(r) {
				const rows = [
					['来源', r.source],
					['带上来的条目', `${r.incomingTotal} 条（本地 ${r.localTotal} 条）`],
					['新增', `${r.counts.new} 条`],
					['重复跳过', `${r.counts.duplicate} 条`],
					['id 撞号改新号', `${r.counts.idCollision} 条`],
					['内容空 / 必填缺项（加不进去）', `${r.counts.invalid} 条`],
					['同一条但标签不一样', `${r.counts.tagDiff} 条`],
				]
				return React.createElement(
					'div',
					{ style: { marginTop: '10px' } },
					r.headerMismatch
						? React.createElement('div', { className: 'tm-note tm-warn' }, `表头和本地不完全一样${r.missingColumns.length > 0 ? `；本地有而来源没有的列：${r.missingColumns.join('、')}（按空处理）` : ''}`)
						: React.createElement('div', { className: 'tm-note tm-ok' }, '表头和本地一致。'),
					React.createElement(
						'div',
						{ className: 'tm-kv', style: { marginTop: '8px' } },
						rows.map(([k, v]) => React.createElement(
							'div',
							{ key: k, className: 'tm-kv-row' },
							React.createElement('div', { className: 'tm-kv-k' }, k),
							React.createElement('div', { className: 'tm-kv-v' }, v),
						)),
					),
					r.newList.length === 0 ? null : React.createElement(
						'div',
						{ style: { marginTop: '10px' } },
						React.createElement('div', { className: 'tm-note' }, `要新增的（最多列 50）：`),
						r.newList.map((it) => React.createElement(
							'div',
							{ key: `${it.id}-${it.preview}`, className: 'tm-bkrow' },
							React.createElement('span', { className: 'tm-mono' }, it.时间 || it.id),
							React.createElement('span', null, it.preview),
							it.why !== '' ? React.createElement('span', { className: 'tm-tag' }, it.why) : null,
						)),
					),
					Array.isArray(r.invalidList) && r.invalidList.length > 0 ? React.createElement(
						'div',
						{ style: { marginTop: '10px' } },
						React.createElement('div', { className: 'tm-note tm-warn' }, `这几条**没进来**（来源里就不合规，本地一个字节没动）：`),
						r.invalidList.map((it, i) => React.createElement(
							'div',
							{ key: `bad-${i}-${it.id}`, className: 'tm-bkrow' },
							React.createElement('span', { className: 'tm-mono' }, it.id || '（无 id）'),
							React.createElement('span', null, it.preview || ''),
							React.createElement('span', { className: 'tm-tag' }, it.why),
						)),
					) : null,
					r.tagDiffs.length === 0 ? null : React.createElement(
						'div',
						{ style: { marginTop: '10px' } },
						React.createElement('div', { className: 'tm-note' }, '内容一样但标签不一样（**不删**，按标签区分；想改就手改库）：'),
						r.tagDiffs.map((it) => React.createElement(
							'div',
							{ key: it.id, className: 'tm-bkrow' },
							React.createElement('span', { className: 'tm-mono' }, it.id),
							React.createElement('span', null, it.preview),
							React.createElement('span', { className: 'tm-tag' }, it.diffs.map((d) => `${d.field}: ${d.local || '空'}→${d.incoming || '空'}`).join(' · ')),
						)),
					),
					Array.isArray(r.appended) && r.appended.length > 0
						? React.createElement('div', { className: 'tm-note tm-ok', style: { marginTop: '8px' } }, `已追加 ${r.appended.length} 条：${r.appended.map((a) => a.id).join('、')}`)
						: null,
					Array.isArray(r.failed) && r.failed.length > 0
						? React.createElement('div', { className: 'tm-note tm-bad', style: { marginTop: '8px' } }, `有 ${r.failed.length} 条没进来：${r.failed.map((f) => `${f.preview}（${f.why}）`).join('；')}`)
						: null,
				)
			}

			/**
			 * 维护区（次位）：托管状态 + 备份历史，默认收起。
			 * 这两样都是「出事了才看」的，按主位通则不该占着正文的位置。
			 */
			function renderMaintenance() {
				const recent = bk !== null && Array.isArray(bk.recent) ? bk.recent : []
				const extra = bk !== null && Array.isArray(bk.log) ? bk.log.length : 0
				return React.createElement(
					'div',
					{ className: 'tm-card' },
					React.createElement(
						'button',
						{ type: 'button', className: 'tm-fold', onClick: () => setMaintOpen((v) => !v) },
						`${maintOpen ? '▾' : '▸'} 维护与状态（记忆文件托管 · 备份历史）`,
						React.createElement('span', { className: 'tm-note' }, `${hosted}/${files.length} 个记忆文件已托管 · 备份 ${bk?.copies ?? 0} 份${extra > 0 ? ` · 日志 ${extra} 行` : ''}`),
					),
					maintOpen
						? React.createElement(
								'div',
								{ style: { marginTop: '10px' } },
								React.createElement(
									'div',
									{ className: 'tm-pane-h' },
									React.createElement('h2', { className: 'tm-pane-t' }, '记忆文件托管'),
									React.createElement(
										'button',
										{ type: 'button', className: 'tm-btn', disabled: busy || !enabled, onClick: heal },
										busy ? '核对中…' : '核对并补回',
									),
								),
								React.createElement(
									'div',
									{ className: 'tm-note', style: { marginBottom: '8px' } },
									enabled
										? '这是给**别的智能体**看的一块说明：告诉它们这儿有一套标签记忆、怎么查、能存什么。你不用管也不用碰——每次挂载会自动核对，缺了就补回，块外面的内容一个字都不动。'
										: '记忆文件托管已关闭（config.notice=false）。',
								),
								note !== '' ? React.createElement('div', { className: 'tm-note', style: { marginBottom: '8px' } }, note) : null,
								files.length === 0
									? React.createElement('div', { className: 'tm-note' }, '没有探测到记忆文件。')
									: files.map((f) => React.createElement(
											'div',
											{ key: `${f.agent}/${f.file}`, className: 'tm-memrow' },
											React.createElement('span', {
												className: 'tm-dot',
												'data-ok': f.hasNotice ? 'true' : undefined,
												'data-missing': f.hasNotice ? undefined : 'true',
											}),
											React.createElement('span', null, `${f.agent}/${f.file}`),
											React.createElement('span', { className: 'tm-tag' },
												[f.hasNotice ? '已托管' : '缺块', f.backups > 0 ? `${f.backups} 个备份` : null].filter(Boolean).join(' · ')),
										)),
								React.createElement('h2', { className: 'tm-pane-t', style: { margin: '12px 0 6px' } }, '手上的备份'),
								recent.length === 0
									? React.createElement('div', { className: 'tm-note' }, '还没有备份。')
									: recent.map((row) => React.createElement(
											'div',
											{ key: row.stamp, className: 'tm-bkrow' },
											React.createElement('span', { className: 'tm-mono' }, row.stamp),
											React.createElement('span', null, row.at !== '' ? shortTime(row.at) : '—'),
											React.createElement('span', null, row.count !== null ? `${row.count} 条` : ''),
											row.label !== '' ? React.createElement('span', { className: 'tm-note' }, row.label) : null,
											React.createElement('span', { className: 'tm-tag' }, `${humanBytes(row.bytes)}${row.complete ? '' : ' · 不完整'}`),
										)),
							)
						: null,
				)
			}

			if (overview !== null && overview.ready === false) {
				return React.createElement(
					'div',
					{ className: 'tm-root' },
					React.createElement('h1', { className: 'tm-head' }, SECTION_LABEL),
					React.createElement(
						'div',
						{ className: 'tm-card' },
						React.createElement('div', { className: 'tm-note tm-err' }, '记忆技能未就绪：找不到技能目录或真库 store/memory.csv。'),
						React.createElement('div', { className: 'tm-note', style: { marginTop: '8px' } }, `技能目录：${overview.skillDir}`),
						React.createElement('div', { className: 'tm-note' }, `库文件：${overview.csvPath}`),
					),
				)
			}

			const notice = overview !== null ? overview.notice : null
			const enabled = notice !== null && notice.enabled !== false
			const files = notice !== null && Array.isArray(notice.files) ? notice.files : []
			const hosted = files.filter((f) => f.hasNotice).length

			const dims = overview !== null && Array.isArray(overview.dimensions) ? overview.dimensions : []
			const counts = overview !== null ? overview.byDimension ?? {} : {}

			const hits = items
			const selectedCount = Object.keys(selected).length

			return React.createElement(
				'div',
				{ className: 'tm-root' },
				React.createElement(
					'div',
					{ className: 'tm-headrow' },
					React.createElement('h1', { className: 'tm-head' }, SECTION_LABEL),
					renderBarButtons(),
				),
				React.createElement(
					'div',
					{ className: 'tm-sub' },
					overview === null ? '读取中…' : `标签记忆库 · ${overview.csvPath}`,
				),
				renderBackupLine(),
				bkNote !== null
					? React.createElement('div', { className: `tm-note tm-${bkNote.kind === 'ok' ? 'ok' : 'bad'}` }, bkNote.text)
					: null,
				renderDirPane(),
				renderRestorePane(),
				renderMergePane(),

				error !== null
					? React.createElement('div', { className: 'tm-note tm-err' }, `读取失败：${error}`)
					: null,

				overview === null
					? React.createElement('div', { className: 'tm-note' }, '读取概况…')
					: React.createElement(
							'div',
							{ className: 'tm-stats' },
							React.createElement(Stat, { value: overview.active, label: '生效条目' }),
							React.createElement(Stat, { value: overview.total, label: '总条目' }),
							React.createElement(Stat, { value: `${hosted}/${files.length}`, label: '记忆文件已托管' }),
							React.createElement(Stat, { value: dims.filter((d) => d.column !== null).length, label: '可筛维度' }),
						),

				// ── 记忆条目（主位：要看的 + 要筛要搜的，全在这一张卡里）──
				React.createElement(
					'div',
					{ className: 'tm-card' },
					React.createElement(
						'div',
						{ className: 'tm-card-h' },
						React.createElement('h2', { className: 'tm-card-t' }, '记忆条目'),
						React.createElement(
							'span',
							{ className: 'tm-note' },
							loading ? '读取中…' : `命中 ${total} 条${hits.length < total ? `（已示 ${hits.length}）` : ''}`,
						),
						Object.keys(cond).length > 0 || includeArchived
							? React.createElement(
									'button',
									{
										type: 'button',
										className: 'tm-btn',
										onClick: () => { setCond({}); setIncludeArchived(false) },
									},
									'清除条件',
								)
							: null,
						React.createElement(
							'button',
							{
								type: 'button',
								className: 'tm-btn',
								title: view === 'table' ? '换成一条一张的卡片' : '换成一行一条的表格',
								onClick: () => setView(view === 'table' ? 'cards' : 'table'),
							},
							view === 'table' ? '卡片视图' : '表格视图',
						),
					),
					// 维度下拉压成一行：选一个取值就叠一条条件（同维多值 = 或，维间 = 与）。
					React.createElement(
						'div',
						{ className: 'tm-filters', style: { marginBottom: '10px' } },
						dims.map((dim) => {
							const list = Object.entries(counts[dim.name] ?? {})
							const filterable = dim.column !== null && list.length > 0
							const trailing = dim.column === null ? '（未落列）' : list.length === 0 ? '（无数据）' : ''
							return React.createElement(
								'select',
								{
									key: dim.name,
									className: 'tm-select tm-fsel',
									value: '',
									disabled: !filterable,
									title: filterable ? `按「${dim.name}」叠加条件` : `「${dim.name}」不可筛选`,
									onChange: (event) => {
										if (event.target.value !== '') toggleDim(dim.name, event.target.value)
									},
								},
								React.createElement('option', { value: '' }, `${dim.name} ＋${trailing}`),
								// 已选中的值打 ✓；再选一次就是取消（toggleDim 本来就是开关）。
								list.map(([value, count]) =>
									React.createElement(
										'option',
										{ key: value, value },
										`${dimOn(dim.name, value) ? '✓ ' : ''}${value}（${count}）`,
									),
								),
							)
						}),
					),
					renderCrumbs(),
					React.createElement(
						'div',
						{ className: 'tm-field', style: { marginBottom: '10px' } },
						React.createElement('input', {
							className: 'tm-input',
							type: 'search',
							placeholder: '关键词（在命中的条目里全文搜）',
							value: q,
							ref: searchRef,
							onChange: (event) => setQ(event.target.value),
						}),
						React.createElement(
							'select',
							{ className: 'tm-select', value: sort, onChange: (event) => setSort(event.target.value) },
							SORTS.map(([value, text]) => React.createElement('option', { key: value, value }, text)),
						),
						React.createElement(
							'select',
							{ className: 'tm-select', value: String(limit), onChange: (event) => setLimit(parseInt(event.target.value, 10)) },
							PAGE_SIZES.map((n) => React.createElement('option', { key: n, value: String(n) }, `${n} 条`)),
						),
						React.createElement(
							'button',
							{
								type: 'button',
								className: 'tm-chip',
								'data-on': includeArchived ? 'true' : undefined,
								onClick: () => setIncludeArchived((value) => !value),
							},
							includeArchived ? '含已归档' : '不含已归档',
						),
					),
					React.createElement(
						'div',
						{ className: 'tm-tools' },
						React.createElement('button', { type: 'button', className: 'tm-btn', onClick: selectAllVisible }, '全选本页'),
						React.createElement('button', { type: 'button', className: 'tm-btn', onClick: () => setSelected({}) }, '清空选择'),
						React.createElement(
							'button',
							{ type: 'button', className: 'tm-btn', disabled: selectedCount === 0, onClick: copySelected },
							'复制 Markdown',
						),
						React.createElement(
							'button',
							{ type: 'button', className: 'tm-btn', disabled: selectedCount === 0, onClick: exportSelected },
							'导出 CSV',
						),
						React.createElement('span', { className: 'tm-count' }, tip !== '' ? tip : `选中 ${selectedCount} 条`),
					),
					hits.length === 0
						? React.createElement(
								'div',
								{ className: 'tm-note' },
								loading ? '读取中…' : '没有命中。（默认排除 `被取代` / `已归档`，可点上面的「含已归档」看。）',
							)
						: view === 'table'
							? renderTable()
							: React.createElement(
									'div',
									{ className: 'tm-list' },
									hits.map((row, index) => renderItem(row, index)),
								),
					hits.length > 0
						? React.createElement(
								'button',
								{ type: 'button', className: 'tm-more', disabled: !hasMore || loadingMore, onClick: loadMore },
								hasMore ? (loadingMore ? '加载中…' : `加载更多（还有 ${total - hits.length} 条）`) : '已全部加载',
							)
						: null,
				),

				// ── 维护与状态（次位，默认收起：托管 + 备份历史）──
				renderMaintenance(),
			)
		}

		/**
		 * 侧边栏那个按钮的图标。用内联 SVG，不去 require 平台的图标包——
		 * 少一个会随宿主版本漂移的依赖。
		 */
		function MemoryIcon(props) {
			const size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 18
			return React.createElement(
				'svg',
				{
					width: size,
					height: size,
					viewBox: '0 0 24 24',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.8,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': 'true',
				},
				React.createElement('path', { d: 'M20.6 13.6 13.6 20.6a2 2 0 0 1-2.8 0L3 12.8V4a1 1 0 0 1 1-1h8.8l7.8 7.8a2 2 0 0 1 0 2.8Z' }),
				React.createElement('circle', { cx: '7.5', cy: '7.5', r: '1.4' }),
			)
		}

		/** 主区面板里的「记忆」页：加留白与限宽（设置页那份不需要），主区宽 → 默认表格。 */
		function MemoryPanel(props) {
			return React.createElement(
				'div',
				{ className: 'tm-panel' },
				React.createElement(MemorySection, { defaultView: 'table', pickDir: props?.pickDir, listDir: props?.listDir }),
			)
		}

		/** 设置页那一栏：设置面板窄，一行放不下表格，默认给卡片。 */
		function MemorySettingsPane(props) {
			return React.createElement(MemorySection, { defaultView: 'cards', pickDir: props?.pickDir, listDir: props?.listDir })
		}

		exports.name = 'tag-memory'
		exports.inject = ['slots']

		exports.apply = function apply(ctx) {
			const slots = ctx.slots ?? ctx.get('slots')
			if (slots === undefined || slots === null) return

			/**
			 * 取 DSH 的目录选择服务（`uiWorkspace`）。
			 *
			 * **只能走 `ctx.get('uiWorkspace')`，绝不能写 `ctx.uiWorkspace`。**
			 * cordis 的属性访问是顺着**本 fiber 的祖先链**往上找的（vendor/cordis/src/reflect.ts 里
			 * `ReflectService.handler.get` 那个 while 循环）：`uiWorkspace` 是**别的插件在兄弟 fiber 上**
			 * 提供的，不在本插件的祖先链里，找不到就**抛** `cannot get property "uiWorkspace" without inject`
			 * ——写在 `??` 左边的话右边根本没机会跑，整句直接炸。
			 * 官方 `ui-directory-picker-native` 敢写 `ctx.uiWorkspace`，是因为它把 `uiWorkspace`
			 * 写进了自己的 `inject`；本插件不写 inject（不想给「没有这服务的 DSH」加硬依赖），
			 * 所以必须用那条不看 fiber 位置的读法——`ReflectService.get` 的注释原文就是
			 * “Read a service from the store without the inject requirement”。
			 *
			 * 拿不到就抛，界面退回内建目录浏览 / 手填。
			 */
			const workspace = () => {
				const ws = ctx.get?.('uiWorkspace')
				if (ws === undefined || ws === null) {
					throw new Error('这个 DSH 没挂目录选择服务（uiWorkspace）——手填绝对路径吧。')
				}
				return ws
			}
			const pickDir = async () => await workspace().pickDirectory()
			const listDir = async (path) => await workspace().listDirectory(path)

			// ① 主区面板：侧边栏按钮切过去的就是这一页。
			slots.inject('main', () =>
				slots.register({ name: 'main', key: PANEL_ID, inject: () => ({ pickDir, listDir }) }, MemoryPanel),
			)

			// ② 侧边栏按钮：紧挨在官方「插件」按钮（order 0）下面。
			slots.inject('sidebar.panellist', () =>
				slots.register(
					{ name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: () => SECTION_LABEL },
					MemoryIcon,
				),
			)

			// ③ 设置里也留一栏（第二入口，同一个组件，只是默认给卡片视图）。
			slots.inject('settings.section', () =>
				slots.register(
					{
						name: 'settings.section',
						id: SECTION_ID,
						order: 60,
						label: () => SECTION_LABEL,
						inject: () => ({ pickDir, listDir }),
					},
					MemorySettingsPane,
				),
			)
		}

		return module.exports
	},
})
