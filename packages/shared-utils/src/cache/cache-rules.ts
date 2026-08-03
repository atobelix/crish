//! 缓存规则纯函数（R1 工具排序 / R2 schema 规范化 / R3 缓存键推导）
//!
//! 规则真源：`docs/cache-optimization/03-plans/P6-ts-shell-sync.md` §3.1
//!（R1-R5 是 TS/Rust 双侧共享规范，约束 C10；本文件与 Rust 侧逐条对齐——
//! P1 的 `canonicalize_schema`（crates/agent-provider/src/request/schema.rs）、
//! P2 的 `CacheKey::from_session_id`（request/cache.rs）行为冲突即视为 bug）。
//!
//! 本文件为纯函数（无 DOM/Node 依赖）：降级路径（directFetchBridge）与
//! 前端主路径消费点共用；排序一律按 UTF-8 码点序（禁止 localeCompare，
//! ICU 环境差异会破坏跨侧字节一致性，R1/C10）。

/**
 * 工具名比较：按 UTF-8 码点序（Rust `String::cmp` 语义，R1）。
 *
 * 禁止使用 `localeCompare` / locale 相关比较：ICU 环境差异（宿主实现不同）
 * 会破坏 TS/Rust 双侧字节一致性。JS 字符串 `<`/`>` 比较按 UTF-16 码元，
 * 对 BMP 字符（含中文）与码点序一致；跨侧字节一致性由 rust-parity
 * 样例表（BMP 域）钉死。
 */
export function compareToolNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 工具定义（R1 输入形态；与 directFetchBridge.formatStableTools 输入一致） */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

/** R1 排序输出：按 name 码点升序的新数组（不改动输入，排序稳定） */
export function sortToolsByName<T extends { name: string }>(
  tools: readonly T[]
): T[] {
  return [...tools].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
}

/** R1 + 固定输出形状（wire 形态 `{type:'function', function:{...}}`，P6 §3.2 契约） */
export interface StableTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** R1 + 固定输出形状：排序后映射为 wire 工具定义（替代 directFetchBridge 旧实现） */
export function formatStableTools(
  tools?: ToolDefinition[]
): StableTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return sortToolsByName(tools).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: canonicalizeJsonSchema(t.inputSchema),
    },
  }));
}

/**
 * 递归规范化 JSON Schema：确定性重建（幂等）。
 *
 * 规则（P6 §3.1 R2.1-R2.9，与 Rust `canonicalize_schema` 逐条对齐）：
 * - R2.1：非对象 / 空 schema → 归一为 `{"type":"object","properties":{}}`；
 * - R2.2：布尔 schema → `{"type":"string"}`（对齐 opencode sanitizeOpenAISchema）；
 * - R2.3：`type` 数组 → 过滤合法类型（object/array/string/number/integer/
 *   boolean/null）去重 + 白名单固定序（type 数组语义无序，语义等价输入
 *   必须收敛到相同字节）；过滤后单元素 → 收敛为单值字符串；
 *   过滤后为空 → 丢弃该键；非数组 → 保留；
 * - R2.4：`properties` 键按码点升序，值递归应用本表；非对象 → 丢弃该键；
 * - R2.5：`required` 数组去重 + 码点升序（过滤非字符串项）；非数组 → 丢弃该键；
 * - R2.6：`const` → `enum: [const值]` 并删除 const 键（与既有 enum 并存时
 *   const 覆盖，字面语义）；
 * - R2.7：`$defs` / `definitions` 键按码点排序，每个定义递归应用本表；
 * - R2.8：其余键原值保留；`items` / `oneOf` / `anyOf` / `allOf` 为数组/对象
 *   时递归应用本表（数组顺序保留——顺序是语义）；`additionalProperties`（对象）/
 *   `not` / `if` / `then` / `else` 递归（Rust 侧一致性扩展）；
 * - `$ref`：视为叶子，原样保留、不深入（无法解析远端引用）；
 * - R2.9：输出键序固定：`type` → `properties` → `required` → `items` → `enum`
 *   → `$defs` → 其余键按码点升序——不是全量字典序，必须与 Rust 侧字节一致。
 *
 * 已知限制：JS `JSON.stringify` 对整数型对象键（如 `"2"`/`"10"`）按数值序
 * 重排，与码点序在整数型属性名上可能不一致（Rust 侧无此行为）；常规工具
 * schema 的属性名均为非整数型键，跨侧字节一致性由 rust-parity 样例表钉死。
 */
export function canonicalizeJsonSchema(
  schema: unknown
): Record<string, unknown> {
  // R2.2：布尔 schema → {"type":"string"}（优先级高于 R2.1）
  if (typeof schema === 'boolean') {
    return { type: 'string' };
  }
  // R2.1：非对象（字符串/数字/数组/null/undefined）→ 归一为 {"type":"object","properties":{}}
  if (!isPlainObject(schema)) {
    return { type: 'object', properties: {} };
  }

  // 各固定槽位（R2.9 序列化顺序）与其余键收集
  let slotType: unknown;
  let slotProperties: unknown;
  let slotRequired: unknown;
  let slotItems: unknown;
  let slotEnum: unknown;
  let slotConst: unknown;
  let slotDefs: unknown;
  const rest: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(schema)) {
    switch (key) {
      case 'type':
        slotType = normalizeType(val);
        break;
      case 'properties':
        slotProperties = normalizeProperties(val);
        break;
      case 'required':
        slotRequired = normalizeRequired(val);
        break;
      // R2.8：items 对象/数组形态递归，其余形态原值保留
      case 'items':
        slotItems = normalizeSubschema(val);
        break;
      // R2.8：enum 原值保留（R2.9 固定键序槽位；const 存在时被 R2.6 覆盖）
      case 'enum':
        slotEnum = val;
        break;
      // R2.6：const → enum: [const 值]（与 enum 并存时 const 覆盖）
      case 'const':
        slotConst = val;
        break;
      // R2.7：$defs 固定槽位，键排序 + 递归
      case '$defs':
        slotDefs = normalizeDefs(val);
        break;
      // R2.7：definitions 同款处理；键位落"其余键"码点升序区（R2.9）
      case 'definitions':
        rest[key] = normalizeDefs(val);
        break;
      // R2.8：其余键原值保留；含递归的一致性扩展键
      default:
        rest[key] = normalizeOther(key, val);
        break;
    }
  }

  // R2.9：固定键序逐槽位插入（type → properties → required → items → enum → $defs）
  const out: Record<string, unknown> = {};
  if (slotType !== undefined) out.type = slotType;
  if (slotProperties !== undefined) out.properties = slotProperties;
  if (slotRequired !== undefined) out.required = slotRequired;
  if (slotItems !== undefined) out.items = slotItems;
  // R2.6：const → {enum: [const值]}（覆盖既有 enum，字面语义）
  if (slotConst !== undefined) {
    out.enum = [slotConst];
  } else if (slotEnum !== undefined) {
    out.enum = slotEnum;
  }
  if (slotDefs !== undefined) out.$defs = slotDefs;
  // 其余键按码点升序（R2.9 尾部；String 比较 = 码点序，禁止 localeCompare）
  for (const key of Object.keys(rest).sort(compareCodepoint)) {
    out[key] = rest[key];
  }

  // R2.1：处理后仍为空对象（如 required 非数组被丢弃、type 数组过滤后为空）
  // → 归一，保证幂等
  if (Object.keys(out).length === 0) {
    return { type: 'object', properties: {} };
  }
  return out;
}

/** 码点序比较（R2 各键排序共用；与 Rust `String::cmp` 语义一致） */
function compareCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 纯对象判定（排除 null / 数组） */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** R2.3：type 字段归一化。数组形态 → 过滤合法类型 + 去重，按白名单固定序
 * （type 数组语义无序：`["string","number"]` 与 `["number","string"]` 语义
 * 等价，必须收敛到相同字节）；过滤后单元素收敛为字符串；过滤后为空 →
 * undefined（丢弃该键）；非数组 → 原值保留。 */
function normalizeType(val: unknown): unknown {
  if (!Array.isArray(val)) {
    return val;
  }
  const seen: string[] = [];
  for (const item of val) {
    if (
      typeof item === 'string' &&
      VALID_TYPE_VALUES.includes(item) &&
      !seen.includes(item)
    ) {
      seen.push(item);
    }
  }
  seen.sort(
    (a, b) => VALID_TYPE_VALUES.indexOf(a) - VALID_TYPE_VALUES.indexOf(b)
  );
  if (seen.length === 0) {
    return undefined;
  }
  if (seen.length === 1) {
    const first = seen[0];
    return first === undefined ? undefined : first;
  }
  return seen;
}

/** R2.4：properties 键按码点升序，值递归应用本表；非对象 → 丢弃该键。 */
function normalizeProperties(val: unknown): unknown {
  if (!isPlainObject(val)) {
    return undefined;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(val).sort(compareCodepoint)) {
    sorted[key] = canonicalizeJsonSchema(val[key]);
  }
  return sorted;
}

/** R2.5：required 数组去重 + 码点升序（过滤非字符串项）；非数组 → 丢弃该键。 */
function normalizeRequired(val: unknown): unknown {
  if (!Array.isArray(val)) {
    return undefined;
  }
  const names: string[] = [];
  for (const item of val) {
    if (typeof item === 'string' && !names.includes(item)) {
      names.push(item);
    }
  }
  names.sort(compareCodepoint);
  return names;
}

/** R2.7：$defs / definitions 键按码点排序，每个定义递归应用本表；
 * 非对象形态原值保留（R2.7 只定义对象形态）。 */
function normalizeDefs(val: unknown): unknown {
  if (!isPlainObject(val)) {
    return val;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(val).sort(compareCodepoint)) {
    sorted[key] = canonicalizeJsonSchema(val[key]);
  }
  return sorted;
}

/** R2.8：items / oneOf / anyOf / allOf —— 数组/对象形态递归应用本表，
 * 数组顺序保留（顺序是语义）；其余形态（布尔等）原值保留。 */
function normalizeSubschema(val: unknown): unknown {
  if (isPlainObject(val)) {
    return canonicalizeJsonSchema(val);
  }
  if (Array.isArray(val)) {
    return val.map((item) => canonicalizeJsonSchema(item));
  }
  return val;
}

/** R2.8 其余键：原值保留；其中 oneOf/anyOf/allOf 递归（数组/对象），
 * additionalProperties（对象形态）/ not / if / then / else 递归
 * （Rust 侧一致性扩展，保证深层键序确定）。 */
function normalizeOther(key: string, val: unknown): unknown {
  if (key === 'oneOf' || key === 'anyOf' || key === 'allOf') {
    return normalizeSubschema(val);
  }
  if (
    key === 'not' ||
    key === 'if' ||
    key === 'then' ||
    key === 'else' ||
    key === 'additionalProperties'
  ) {
    return isPlainObject(val) ? canonicalizeJsonSchema(val) : val;
  }
  return val;
}

/** 合法 JSON Schema type 取值（R2.3 过滤白名单；顺序即收敛后的固定序） */
const VALID_TYPE_VALUES: readonly string[] = [
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
];

/** R3：prompt_cache_key 最大长度（码点；对齐 Rust `CacheKey` 的 64 码点钳制） */
export const PROMPT_CACHE_KEY_MAX_LENGTH = 64;

/**
 * R3：会话 ID → prompt_cache_key（clamp64，P6 §3.1 R3）。
 *
 * 1. 输入为空/非字符串 → 不产生键（undefined）；
 * 2. trim 后按 Unicode 码点截取前 64 个码点（`Array.from` 不拆代理对、
 *    多字节 UTF-8 会话 ID（中文/emoji）不会截成半字符）；
 * 3. 长度 ≤ 64 码点 → 原样使用（不做哈希、不做前缀剥离、不追加命名空间）；
 * 4. 输出不做进一步编码（会话 ID 本身即 ASCII 域，保持原串）。
 *
 * 语义：同一会话所有轮次共享同一缓存键，服务端按键隔离缓存域
 *（opencode-cache-analysis.md:110-121、kimi-code-cache-analysis.md:95-107）。
 */
export function derivePromptCacheKey(sessionId: unknown): string | undefined {
  if (typeof sessionId !== 'string') {
    return undefined;
  }
  const trimmed = sessionId.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return Array.from(trimmed).slice(0, PROMPT_CACHE_KEY_MAX_LENGTH).join('');
}
