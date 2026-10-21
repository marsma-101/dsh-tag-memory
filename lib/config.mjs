// config.mjs —— 两个插件入口共享的配置 schema。
//
// DSH 在装载插件行时用导出的 `Config` 校验并填充默认值；设置界面的配置表单
// 也读取同一份 schema。两个入口各自拥有一行配置，所以分成 HostConfig /
// PresetConfig 两份，不把无关字段混在一起。
import Schema from '@deepseek-ai/schemastery'

/** `index.js`（Host 半）的配置。 */
export const HostConfig = Schema.object({
  libraryDir: Schema.string(),
  presetRoot: Schema.string(),
  memoryFileNames: Schema.array(Schema.string()),
  notice: Schema.boolean().default(true),
  // 兼容旧字段；新配置只写 `notice`。
  noticeEnabled: Schema.boolean(),
  migrateLegacyDict: Schema.boolean().default(true),
  skillName: Schema.string(),
  pluginName: Schema.string(),
  tools: Schema.array(Schema.string()),
})

/** `preset.js`（智能体半）的配置。 */
export const PresetConfig = Schema.object({
  agent: Schema.string(),
  libraryDir: Schema.string(),
  // 旧安装器/手工配置可能留下 dir，这个字段仍参与 resolveAgentId。
  dir: Schema.string(),
  snapshot: Schema.object({
    enabled: Schema.boolean().default(true),
    maxPinned: Schema.natural().default(6),
    maxBodyChars: Schema.natural().default(4000),
    maxIndexLines: Schema.natural().default(40),
  }),
})
