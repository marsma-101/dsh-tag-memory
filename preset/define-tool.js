/**
 * define-tool.js — 自带的 defineTool（**零外部依赖**）
 *
 * ── 为什么不用官方的 @deepseek-ai/dsh-tools ────────────────────────
 *   官方 `defineTool` 只能在**装了 dsh 的那棵 node_modules 里**解析到。
 *   插件一旦被放到别处（实测：`/opt/dsh/plugins/dsh-tag-memory/preset/tools.js`），
 *   顶层 `import { defineTool } from '@deepseek-ai/dsh-tools'` 就
 *   `ERR_MODULE_NOT_FOUND`，**整个 preset 挂不上**，10 个 dtm_* 工具全丢。
 *   目标机器上这个包有没有、装在哪，插件控制不了 —— 所以不依赖它。
 *   把需要的这部分逻辑内联进来，插件因此**零运行时依赖**：
 *   装在 profile 的 node_modules 里能跑，拷到任何目录也能跑。
 *
 * ── 行为对齐 ──────────────────────────────────────────────────────
 *   逻辑移植自 `@deepseek-ai/dsh-tools`（MIT，见包内 LICENSE），只保留本插件
 *   用到的子集，语义保持一致：
 *     · 参数 DSL：每个属性写 `required: true` → 编译成根节点 `required: [...]` 数组
 *       （子节点上不再保留 `required`，与官方一致）
 *     · `output.schema` 走同一套编译
 *     · `execute` 前先校验实参，违规抛 `INVALID_ARGS`
 *
 * ── 与官方的一处已知差异 ──────────────────────────────────────────
 *   官方 `ToolArgsError` 继承 `HarnessError`，宿主能据此拿到结构化
 *   `{name, code}`。本文件拿不到那个基类，抛的是带 `code` 属性的普通 Error。
 *   模型看到的错误文本与官方一致（`invalid arguments: ...`），
 *   只是宿主日志里少了结构化 code 字段 —— 属可接受的降级，不是功能缺失。
 *
 * ── 支持的 DSL 子集 ───────────────────────────────────────────────
 *   type: string | number | integer | boolean | null | array | object | json
 *   以及 oneOf / properties / required / additionalProperties / items /
 *   enum / const；注解 description / title / default / examples。
 *   本插件实际只用到 string / array / integer / boolean + enum + items + required。
 */

/** 注解键：不参与校验，只透传给模型看 */
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'];

/** 合法类型 */
const SCHEMA_TYPES = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'null',
  'array',
  'object',
  'json',
]);

/** schema 写错时抛这个（作者侧错误，不是模型侧） */
function authorError(message) {
  throw new Error(`dsh-tag-memory: 工具 schema 不合法：${message}`);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 拒绝节点上出现未支持的键（写错字段名时立刻报，而不是静默忽略） */
function assertAuthorKeys(source, path, allowed) {
  for (const key of Object.keys(source)) {
    if (allowed.includes(key)) continue;
    authorError(
      `${path}.${key} 不在支持的值 schema DSL 里` +
        '（支持 type/oneOf/properties/required/additionalProperties/items/enum/const' +
        ' + description/title/default/examples）',
    );
  }
}

function copyAnnotations(source, target) {
  for (const key of ANNOTATION_KEYS) {
    if (Object.hasOwn(source, key)) target[key] = source[key];
  }
}

/**
 * 编译「属性名 → 值 schema」的表，并收集必填键。
 *
 * @returns {{properties: object, required?: string[]}}
 */
function compilePropertyMap(spec, path) {
  if (!isRecord(spec)) authorError(`${path} 必须是「属性名 → 值 schema」的对象`);

  const properties = {};
  const required = [];

  for (const [key, property] of Object.entries(spec)) {
    if (!isRecord(property)) authorError(`${path}.${key} 必须是值 schema 对象`);
    // 作者侧的 required 只允许字面 true（不是 JSON Schema 的数组）
    if (Object.hasOwn(property, 'required') && property.required !== true) {
      authorError(`${path}.${key}.required 只能是 true（要写"可选"就整个省略这个键）`);
    }
    if (property.required === true) required.push(key);

    // 用 defineProperty 赋值，避免 __proto__ 这类键改变原型
    Object.defineProperty(properties, key, {
      value: compileValue(property, `${path}.${key}`, true),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  return required.length > 0 ? { properties, required } : { properties };
}

/**
 * 编译一个作者侧 schema 节点成 raw JSON Schema。
 *
 * @param {object} spec
 * @param {string} path  报错用的路径
 * @param {boolean} allowRequired  只有属性位置才允许写 `required: true`
 */
function compileValue(spec, path, allowRequired = false) {
  if (!isRecord(spec)) authorError(`${path} 必须是值 schema 对象`);

  const authorKeys = allowRequired ? [...ANNOTATION_KEYS, 'required'] : [...ANNOTATION_KEYS];
  const node = {};

  /* ---------------- oneOf ---------------- */
  if (Object.hasOwn(spec, 'oneOf')) {
    assertAuthorKeys(spec, path, [...authorKeys, 'oneOf', 'type']);
    if (Object.hasOwn(spec, 'type')) authorError(`${path} 不能同时声明 type 与 oneOf`);
    if (!Array.isArray(spec.oneOf) || spec.oneOf.length < 2) {
      authorError(`${path}.oneOf 至少要两个分支`);
    }
    copyAnnotations(spec, node);
    node.oneOf = spec.oneOf.map((branch, index) => compileValue(branch, `${path}.oneOf[${index}]`));
    return node;
  }

  /* ---------------- type ---------------- */
  const type = Object.hasOwn(spec, 'type') ? spec.type : undefined;
  if (typeof type !== 'string' || !SCHEMA_TYPES.has(type)) {
    authorError(`${path}.type 必须是 string/number/integer/boolean/null/array/object/json，或用 oneOf`);
  }

  switch (type) {
    /* json：只留注解，不带 type → 校验时按"任意可无损序列化的 JSON" */
    case 'json': {
      assertAuthorKeys(spec, path, [...authorKeys, 'type']);
      copyAnnotations(spec, node);
      return node;
    }

    case 'object': {
      assertAuthorKeys(spec, path, [...authorKeys, 'type', 'properties', 'additionalProperties']);
      // 官方要求显式写，避免"以为关了其实开着"
      if (typeof spec.additionalProperties !== 'boolean') {
        authorError(`${path}.additionalProperties 必须显式写 true 或 false`);
      }
      node.type = 'object';
      copyAnnotations(spec, node);
      node.additionalProperties = spec.additionalProperties;
      if (Object.hasOwn(spec, 'properties')) {
        const compiled = compilePropertyMap(spec.properties, `${path}.properties`);
        node.properties = compiled.properties;
        if (compiled.required !== undefined) node.required = compiled.required;
      }
      return node;
    }

    case 'array': {
      assertAuthorKeys(spec, path, [...authorKeys, 'type', 'items']);
      node.type = 'array';
      copyAnnotations(spec, node);
      if (Object.hasOwn(spec, 'items')) {
        node.items = compileValue(spec.items, `${path}.items`);
      }
      return node;
    }

    default: {
      assertAuthorKeys(spec, path, [...authorKeys, 'type', 'enum', 'const']);
      node.type = type;
      copyAnnotations(spec, node);
      if (Object.hasOwn(spec, 'enum')) {
        if (!Array.isArray(spec.enum) || spec.enum.length === 0) {
          authorError(`${path}.enum 必须是非空数组`);
        }
        node.enum = Array.from(spec.enum);
      }
      if (Object.hasOwn(spec, 'const')) node.const = spec.const;
      return node;
    }
  }
}

/* ------------------------------------------------------------------ *
 * 校验
 * ------------------------------------------------------------------ */

/** 诊断里根路径的显示名（与官方一致） */
function label(path) {
  return path === '' ? 'arguments' : path;
}

function childPath(path, key) {
  return path === '' ? key : `${path}.${key}`;
}

/** 是否是可无损序列化的 JSON 值（undefined/函数/循环/NaN 都不算） */
function isLosslessJson(value, seen = new Set()) {
  if (value === null) return true;

  const type = typeof value;
  if (type === 'string' || type === 'boolean') return true;
  if (type === 'number') return Number.isFinite(value);
  if (type !== 'object') return false;

  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const entry of value) if (!isLosslessJson(entry, seen)) return false;
      return true;
    }
    for (const key of Object.keys(value)) {
      if (!isLosslessJson(value[key], seen)) return false;
    }
    return true;
  } finally {
    seen.delete(value);
  }
}

/**
 * 按 schema 校验值，把违规信息推进 `violations`（空数组 = 通过）。
 *
 * 与官方一致：**值为 undefined 的属性视为未提供**（跳过校验，交给必填检查）。
 */
function validateValue(schema, value, path, violations) {
  /* ---------------- oneOf ---------------- */
  if (Object.hasOwn(schema, 'oneOf')) {
    const matched = schema.oneOf.filter((branch) => {
      const sub = [];
      validateValue(branch, value, path, sub);
      return sub.length === 0;
    }).length;
    if (matched !== 1) {
      violations.push(`"${label(path)}" 必须恰好匹配 oneOf 的一个分支（实际匹配 ${matched} 个）`);
    }
    return;
  }

  /* ---------------- 无 type（json 或纯注解） ---------------- */
  if (!Object.hasOwn(schema, 'type')) {
    if (!isLosslessJson(value)) violations.push(`"${label(path)}" 必须是可无损序列化的 JSON 值`);
    return;
  }

  switch (schema.type) {
    case 'object': {
      if (!isRecord(value)) {
        violations.push(`"${label(path)}" 必须是对象`);
        return;
      }
      const properties = schema.properties ?? {};

      for (const key of schema.required ?? []) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) {
          violations.push(`缺少必填属性 "${childPath(path, key)}"`);
        }
      }
      for (const [key, child] of Object.entries(properties)) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) continue;
        validateValue(child, value[key], childPath(path, key), violations);
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(properties, key)) {
            violations.push(`"${childPath(path, key)}" 不是已声明的属性（additionalProperties: false）`);
          }
        }
      }
      return;
    }

    case 'array': {
      if (!Array.isArray(value)) {
        violations.push(`"${label(path)}" 必须是数组`);
        return;
      }
      if (schema.items !== undefined) {
        value.forEach((entry, index) => {
          validateValue(schema.items, entry, `${path}[${index}]`, violations);
        });
      }
      return;
    }

    default: {
      const ok =
        schema.type === 'string'
          ? typeof value === 'string'
          : schema.type === 'number'
            ? typeof value === 'number' && Number.isFinite(value)
            : schema.type === 'integer'
              ? Number.isInteger(value)
              : schema.type === 'boolean'
                ? typeof value === 'boolean'
                : value === null;

      if (!ok) {
        violations.push(`"${label(path)}" 必须是 ${schema.type}`);
        return;
      }
      if (schema.enum !== undefined && !schema.enum.includes(value)) {
        violations.push(`"${label(path)}" 必须是 ${JSON.stringify(schema.enum)} 之一`);
      }
      if (Object.hasOwn(schema, 'const') && value !== schema.const) {
        violations.push(`"${label(path)}" 必须是 ${JSON.stringify(schema.const)}`);
      }
    }
  }
}

/** 模型给的实参不合法。带 `code: 'INVALID_ARGS'`，便于日志检索。 */
class ToolArgsError extends Error {
  constructor(violations) {
    super(`invalid arguments: ${violations.join('; ')}`);
    this.name = 'ToolArgsError';
    this.code = 'INVALID_ARGS';
    this.violations = violations;
  }
}

/** 校验实参，返回违规列表（空 = 通过） */
export function validateArgs(spec, args) {
  const violations = [];
  validateValue(parameterSchemaSpecToJsonSchema(spec), args, '', violations);
  return violations;
}

/** 参数 DSL → raw JSON Schema（根是 object，不带 additionalProperties，与官方一致） */
export function parameterSchemaSpecToJsonSchema(spec) {
  const compiled = compilePropertyMap(spec, 'parameters');
  return {
    type: 'object',
    properties: compiled.properties,
    ...(compiled.required === undefined ? {} : { required: compiled.required }),
  };
}

/** 值 schema DSL → raw JSON Schema */
export function valueSchemaSpecToJsonSchema(spec) {
  return compileValue(spec, 'schema');
}

/**
 * 定义一个工具（与官方 `defineTool` 同形）。
 *
 * @param {object} options
 * @param {string} options.name
 * @param {string} options.description
 * @param {object} options.parameters      作者侧参数 DSL
 * @param {{schema: object, render: Function, presentationMeta?: Function}} options.output
 * @param {Function} options.execute
 * @returns 可直接交给 `ctx.tools.register` 的定义
 */
export function defineTool(options) {
  const userExecute = options.execute;
  const userFinalizeContent = options.finalizeContent;
  const userProjectContent = options.projectContent;
  const userRender = options.output.render;
  const userPresentationMeta = options.output.presentationMeta;
  const userPresentCall = options.presentCall;
  const userPresentResult = options.presentResult;
  const userIsConcurrencySafe = options.isConcurrencySafe;

  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error(`defineTool(${options.name}): timeoutMs 必须是正的有限数`);
  }

  const parameters = parameterSchemaSpecToJsonSchema(options.parameters);
  const outputSchema = valueSchemaSpecToJsonSchema(options.output.schema);

  const validate = (args) => {
    const violations = [];
    validateValue(parameters, args, '', violations);
    return violations;
  };

  const tool = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render(args, value) {
        return userRender(args, value);
      },
      ...(userPresentationMeta === undefined
        ? {}
        : {
            presentationMeta(args, value) {
              return userPresentationMeta(args, value);
            },
          }),
    },
    ...(options.deferLoading === true ? { deferLoading: options.deferLoading } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),

    async execute(args, exec) {
      const violations = validate(args);
      if (violations.length > 0) throw new ToolArgsError(violations);
      return userExecute(args, exec);
    },
  };

  if (userProjectContent) tool.projectContent = (exec, result) => userProjectContent(exec, result);
  if (userFinalizeContent) tool.finalizeContent = (exec, result) => userFinalizeContent(exec, result);
  if (userPresentCall) {
    tool.presentCall = (args) => (validate(args).length > 0 ? undefined : userPresentCall(args));
  }
  if (userPresentResult) {
    tool.presentResult = (args, result) =>
      validate(args).length > 0 ? undefined : userPresentResult(args, result);
  }
  if (userIsConcurrencySafe) {
    tool.isConcurrencySafe = (args) => (validate(args).length > 0 ? false : userIsConcurrencySafe(args));
  }

  return tool;
}

export default { defineTool, validateArgs, parameterSchemaSpecToJsonSchema, valueSchemaSpecToJsonSchema };
