// qa 测试用 shim：@deepseek-ai/dsh-tools 的最小替身
//
// defineTool 在官方实现里就是"标记 + 校验并返回原对象"（探明结论 §1）。
// 这里只保留 qa 需要观察的结构，**不伪造任何执行语义**。
// 被测代码只在注册阶段碰它；真正 execute 由我们自己的测试直接调用。

export function defineTool(def) {
  // 保留原始字段，便于 qa 检查 name / parameters / output
  return { ...def, __isTool: true }
}

export default { defineTool }
