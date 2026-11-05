// 临时探针（qa 诊断用，非正式测试）
// 用途：确认 yaml 解析器在本机可用路径，避免 P5 因依赖缺失无法真解析
const candidates = [
  'yaml', // 本地 node_modules（当前不存在）
  'file:///C:/Users/Administrator/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/yaml/dist/index.js',
]

const yml = `# comment
- insert:
    - id: dsh-tag-memory
      name: 'dsh-tag-memory'
`

for (const spec of candidates) {
  try {
    const m = await import(spec)
    const doc = m.parse(yml)
    console.log('[OK]', spec)
    console.log('     parsed =', JSON.stringify(doc))
  } catch (e) {
    console.log('[FAIL]', spec, '=>', e.code || e.message)
  }
}
