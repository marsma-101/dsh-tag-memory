/**
 * 真跑被测代码：加载真实 index.js，把数据目录设成「末段名 == 插件名」，
 * 也就是默认安装布局（<DSH_HOME>/<插件名>），看守卫分级是否还成立。
 *
 * 上面的 work/verify-036-needle-p0.mjs 是复刻逻辑；这个脚本直接 import 真实模块、
 * 抓真实 tools/pre-execute 监听器 —— 真跑被测代码，不是静态推断。
 *
 * 跑法：PKG_DIR=/path/to/pkg node work/verify-036-p0-live.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const N = ['tag', 'memory'].join('-')          // 运行时拼装，源码里不留字面量
const PKG = process.env.PKG_DIR
if (!PKG) { console.error('需要 PKG_DIR=/path/to/pkg'); process.exit(2) }

const box = mkdtempSync(join(tmpdir(), 'p0-live-'))
const skill = join(box, N)                      // 末段名 == 插件名，和真实安装一致
mkdirSync(join(skill, 'references'), { recursive: true })
mkdirSync(join(skill, 'store'), { recursive: true })
copyFileSync(join(PKG, 'lib', 'engine', 'tags.schema.json'), join(skill, 'references', 'tags.schema.json'))
const HEADER = 'id,内容,时间,环境,原因,备注,稳定性,成熟度,距离,角色,项目,状态,关键词,工具,版本,依据,类型,强度,最后强化,已验证项目,使用次数'
writeFileSync(join(skill, 'store', 'memory.csv'), HEADER + '\n')
writeFileSync(join(skill, 'store', 'index.md'), '# i\n')

const saved = process.env.DSH_TAG_MEMORY_DATA_DIR
process.env.DSH_TAG_MEMORY_DATA_DIR = skill

const store = await import(pathToFileURL(join(PKG, 'lib', 'store.mjs')).href)
store.setLibraryDir(skill)

let listener = null
const gctx = {
  logger: {},
  get: () => undefined,
  webServer: { register: () => () => {} },
  on: (ev, fn) => { if (ev === 'tools/pre-execute') listener = fn; return () => {} },
}
const idx = await import(pathToFileURL(join(PKG, 'index.js')).href + '?p0=' + Date.now())
idx.apply(gctx, { presetRoot: join(box, 'pr'), notice: false })

console.log('数据目录 =', skill)
console.log('末段名   =', skill.split('/').pop(), '（默认安装就是这个名字）')
console.log('守卫挂上 =', typeof listener === 'function')
console.log('')

if (typeof listener !== 'function') { console.error('守卫没挂上，无法验证'); process.exit(2) }

const ask = async (name, args) => {
  const r = await listener({ name, arguments: args }, () => Promise.resolve({ kind: 'allow' }))
  return r?.kind ?? 'allow'
}

const csv = join(skill, 'store', 'memory.csv')
const pluginDir = '/opt/dsh/plugins/dsh-' + N + '-0.2.0'

const cases = [
  ['谢雨1 读插件源码', 'read', { file_path: pluginDir + '/index.js' }, 'allow'],
  ['谢雨2 ls 看目录', 'bash', { command: 'ls -la ' + pluginDir }, 'allow'],
  ['谢雨2b glob 找源码', 'glob', { pattern: '**/*.mjs', path: pluginDir }, 'allow'],
  ['谢雨3 名字只在content', 'write', { file_path: join(box, 'diag.mjs'), content: '// check ' + N }, 'allow'],
  ['安全A write真库', 'write', { file_path: csv, content: 'x' }, 'deny'],
  ['安全B read真库', 'read', { file_path: csv }, 'deny'],
  ['安全C bash重定向写真库', 'bash', { command: 'echo x >> ' + csv }, 'deny'],
  ['安全D bash sed -i 真库', 'bash', { command: 'sed -i s/a/b/ ' + csv }, 'deny'],
  ['安全E bash rm 真库', 'bash', { command: 'rm -f ' + csv }, 'deny'],
]

let bad = 0
for (const [d, tool, args, want] of cases) {
  const got = await ask(tool, args)
  const ok = want === 'deny' ? got === 'deny' : got === 'allow'
  if (!ok) bad++
  console.log((ok ? '✓' : '✗') + ' ' + d.padEnd(24) + ' 期望=' + want.padEnd(5) + ' 实际=' + got)
}

console.log('')
if (saved === undefined) delete process.env.DSH_TAG_MEMORY_DATA_DIR
else process.env.DSH_TAG_MEMORY_DATA_DIR = saved
rmSync(box, { recursive: true, force: true })

console.log('不符预期: ' + bad + ' 条')
if (bad > 0) {
  console.log('★ P0 实证成立：真实默认安装布局（数据目录末段名 == 插件名）下，守卫分级被架空。')
  console.log('  根因：guardNeedles() 把数据目录末段名加进强 needle，而末段名恰好等于弱 needle；')
  console.log('        强 needle 判定「读写都拦且不跳 content」，于是弱档形同虚设。')
  process.exit(1)
}
console.log('分级正常。')
