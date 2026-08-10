#!/usr/bin/env node
/**
 * 契约绑定生成器（R0-03 多注册表分发泛化，前身 R3 T6 引擎绑定生成器）。
 *
 * 扫描 crates/conex-types/contracts/*.json 注册表，按 `contract` 字段分发：
 * - engine-events  → packages/shared-types/src/generated/engine/
 *   （41 事件注册表，真源 crates/conex-types/src/events.rs，行为与 R3 T6 一致）
 * - device-protocol → packages/shared-types/src/generated/device/
 *   （多端互通 103 kind 注册表，真源 crates/conex-types/src/device/**）
 *
 * 输出纪律（两个注册表共用）：
 * - 幂等：无时间戳/随机数，两次运行字节一致；
 * - 确定性：迭代顺序 = 注册表文件内声明顺序（JSON.parse 保序）；
 * - 生成产物 ASCII-only（描述性中文文本只留在注册表，不进生成文件）；
 * - 生成产物禁止手改（文件头标注真源与再生命令）。
 *
 * CLI 参数化（供漂移测试/单表再生）：
 *   node scripts/generate-engine-bindings.mjs                     # 全注册表
 *   node scripts/generate-engine-bindings.mjs --registry <path>   # 单注册表
 *   node scripts/generate-engine-bindings.mjs --only <contract>   # 按契约过滤
 *   node scripts/generate-engine-bindings.mjs --out <dir>         # 覆盖输出目录
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACTS_DIR = join(ROOT, "crates", "conex-types", "contracts");
const GENERATED_DIR = join(ROOT, "packages", "shared-types", "src", "generated");

/** 注册表契约 → 输出子目录分发表（新增注册表在此登记） */
const REGISTRY_TARGETS = {
  "engine-events": "engine",
  "device-protocol": "device",
};

/** engine 产物文件头（保持与 R3 T6 逐字节一致） */
const HEADER = [
  "// =======================================================================",
  "// GENERATED FILE - DO NOT EDIT BY HAND.",
  "// Source of truth: crates/conex-types/src/events.rs (AgentEvent enum + payloads)",
  "// Registry: crates/conex-types/contracts/engine-events.json",
  "// Generator: scripts/generate-engine-bindings.mjs",
  "// Regenerate: node scripts/generate-engine-bindings.mjs",
  "// =======================================================================",
].join("\n");

/** device 产物文件头（ASCII-only 纪律与 engine 一致） */
const DEVICE_HEADER = [
  "// =======================================================================",
  "// GENERATED FILE - DO NOT EDIT BY HAND.",
  "// Source of truth: crates/conex-types/src/device/**",
  "// Registry: crates/conex-types/contracts/device-protocol.json",
  "// Generator: scripts/generate-engine-bindings.mjs",
  "// Regenerate: node scripts/generate-engine-bindings.mjs",
  "// =======================================================================",
].join("\n");

const PRIMITIVES = new Set(["string", "number", "boolean", "JsonValue"]);

function fail(message) {
  throw new Error(message);
}

function kebabToPascal(s) {
  return s
    .split("-")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join("");
}

function constNameOf(tsName) {
  // AgentMessageRole -> AGENT_MESSAGE_ROLE_VALUES
  const snake = tsName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
  return `${snake}_VALUES`;
}

function tsTypeName(t) {
  if (t === "string") return "string";
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  if (t === "JsonValue") return "JsonValue";
  if (t.endsWith("[]")) return `${tsTypeName(t.slice(0, -2))}[]`;
  return t;
}

function referencedName(t) {
  if (t.endsWith("[]")) return referencedName(t.slice(0, -2));
  if (PRIMITIVES.has(t)) return null;
  return t;
}

const BACKPRESSURE_LEVELS = new Set(["delta", "soft", "critical"]);

function validateRegistry(reg) {
  if (reg.contract !== "engine-events") {
    fail(`registry contract must be "engine-events", got ${reg.contract}`);
  }
  if (reg.schemaVersion !== 1) {
    fail(`unsupported registry schemaVersion ${reg.schemaVersion}`);
  }
  if (reg.eventCount !== reg.events.length) {
    fail("registry eventCount does not match events array length");
  }
  const known = new Set([
    ...Object.keys(reg.types),
    ...Object.keys(reg.enums),
  ]);
  for (const name of known) {
    if (PRIMITIVES.has(name)) fail(`registry entry shadows primitive type: ${name}`);
  }
  const checkFields = (where, fields) => {
    for (const f of fields) {
      const ref = referencedName(f.type);
      if (ref !== null && !known.has(ref)) {
        fail(`registry references unknown type "${f.type}" at ${where}`);
      }
      // F8-07: number 字段必须显式声明 integer（true=整数 / false=浮点），
      // 生成 parser 的整数校验依赖该标记；漏标即生成期失败
      if (f.type === "number" || f.type === "number[]") {
        if (typeof f.integer !== "boolean") {
          fail(`registry number field "${f.name}" at ${where} must declare integer (true|false)`);
        }
      }
    }
  };
  reg.events.forEach((ev, idx) => {
    if (ev.id !== idx + 1) fail(`event id must be sequential from 1 (got ${ev.id})`);
    if (!ev.rustVariant) fail(`event ${ev.type} missing rustVariant`);
    if (!Array.isArray(ev.fields) || ev.fields.length === 0) {
      fail(`event ${ev.type} must declare fields`);
    }
    // I5-M7：每事件必须标注背压级别（delta/soft/critical，静态可判定）
    if (!BACKPRESSURE_LEVELS.has(ev.backpressure)) {
      fail(`event ${ev.type} must declare backpressure in {delta, soft, critical}`);
    }
    // I5-M7：subagent-event 必须带 kind 级背压映射（枚举值全覆盖）
    if (ev.type === "subagent-event") {
      const kindSpec = reg.enums["SubagentEventKind"];
      if (!kindSpec) fail(`event subagent-event requires enum SubagentEventKind`);
      if (!ev.kindBackpressure || typeof ev.kindBackpressure !== "object") {
        fail(`event subagent-event requires kindBackpressure mapping`);
      }
      for (const v of kindSpec.values) {
        if (!BACKPRESSURE_LEVELS.has(ev.kindBackpressure[v])) {
          fail(`event subagent-event kindBackpressure[${v}] must be in {delta, soft, critical}`);
        }
      }
      if (Object.keys(ev.kindBackpressure).length !== kindSpec.values.length) {
        fail(`event subagent-event kindBackpressure must cover every SubagentEventKind value`);
      }
    }
    checkFields(`event ${ev.type}`, ev.fields);
  });
  for (const [name, spec] of Object.entries(reg.types)) {
    if (spec.kind === "struct") {
      checkFields(`type ${name}`, spec.fields);
    } else if (spec.kind === "tagged") {
      if (!spec.tag) fail(`tagged type ${name} missing tag`);
      if (!Array.isArray(spec.variants) || spec.variants.length === 0) {
        fail(`tagged type ${name} must declare variants`);
      }
      for (const v of spec.variants) {
        checkFields(`type ${name}.${v.name}`, v.fields);
      }
    } else {
      fail(`unknown type kind ${spec.kind} for ${name}`);
    }
  }
  for (const [name, spec] of Object.entries(reg.enums)) {
    if (!Array.isArray(spec.values) || spec.values.length === 0) {
      fail(`enum ${name} must declare values`);
    }
  }
}

// ---------------------------------------------------------------------------
// device 注册表校验（R0-03：结构性自洽 + 与 engine 注册表交叉校验）
// ---------------------------------------------------------------------------

const DEVICE_FAMILIES = new Set([
  "pair",
  "auth",
  "device",
  "events",
  "remote",
  "result",
  "stream",
  "heartbeat",
  "error",
]);
const DEVICE_DIRECTIONS = new Set([
  "mobile-to-desktop",
  "desktop-to-mobile",
  "both",
]);
const DEVICE_AUTH_PHASES = new Set(["pairing", "handshake", "session", "both"]);
const DEVICE_STRATEGIES = new Set(["transparent", "redacted", "tuple"]);
const DEVICE_PUSH_LEVELS = new Set(["p0", "p1", "p2", "none"]);
const DEVICE_FAMILY_COUNTS = { pair: 4, auth: 3, device: 4, events: 11, remote: 37, result: 37, stream: 4, heartbeat: 2, error: 1 };

function validateDeviceRegistry(reg, engineReg) {
  if (reg.contract !== "device-protocol") {
    fail(`registry contract must be "device-protocol", got ${reg.contract}`);
  }
  if (reg.schemaVersion !== 1) {
    fail(`unsupported device registry schemaVersion ${reg.schemaVersion}`);
  }
  if (reg.protocolVersion !== 1) {
    fail(`unsupported device protocolVersion ${reg.protocolVersion}`);
  }
  if (reg.messageCount !== 103) {
    fail(`device registry messageCount must be 103 (M6 §1.1), got ${reg.messageCount}`);
  }
  if (reg.messageCount !== reg.kinds.length || reg.messageCount !== reg.messages.length) {
    fail("device registry messageCount does not match kinds/messages length");
  }

  // 类型/枚举引用自洽（与 engine 同纪律）
  const known = new Set([...Object.keys(reg.types), ...Object.keys(reg.enums)]);
  for (const name of known) {
    if (PRIMITIVES.has(name)) fail(`device registry entry shadows primitive type: ${name}`);
  }
  const checkFields = (where, fields) => {
    for (const f of fields) {
      const ref = referencedName(f.type);
      if (ref !== null && !known.has(ref)) {
        fail(`device registry references unknown type "${f.type}" at ${where}`);
      }
      if (f.type === "number" || f.type === "number[]") {
        if (typeof f.integer !== "boolean") {
          fail(`device registry number field "${f.name}" at ${where} must declare integer (true|false)`);
        }
      }
    }
  };

  // kinds：103 条、编号连续、kind 唯一、字段域合法
  const seenKinds = new Set();
  reg.kinds.forEach((k, idx) => {
    if (k.messageId !== idx + 1) {
      fail(`device kind messageId must be sequential from 1 (got ${k.messageId})`);
    }
    if (!k.kind || seenKinds.has(k.kind)) fail(`device kind duplicated or empty: ${k.kind}`);
    seenKinds.add(k.kind);
    if (!DEVICE_FAMILIES.has(k.family)) fail(`device kind ${k.kind} unknown family ${k.family}`);
    if (!DEVICE_DIRECTIONS.has(k.direction)) fail(`device kind ${k.kind} unknown direction ${k.direction}`);
    if (!DEVICE_AUTH_PHASES.has(k.authPhase)) fail(`device kind ${k.kind} unknown authPhase ${k.authPhase}`);
  });

  // family 账目（M6 §1.1：37+37+11+4+4+3+4+2+1 = 103）
  const familyCounts = {};
  for (const k of reg.kinds) {
    familyCounts[k.family] = (familyCounts[k.family] || 0) + 1;
  }
  for (const [family, expected] of Object.entries(DEVICE_FAMILY_COUNTS)) {
    if (familyCounts[family] !== expected) {
      fail(`device family ${family} count ${familyCounts[family]} != expected ${expected}`);
    }
  }

  // messages：与 kinds 一一对应；body 类型必须可解析（types 或命令信封）
  reg.messages.forEach((m, idx) => {
    const k = reg.kinds[idx];
    if (m.id !== idx + 1 || m.kind !== k.kind) {
      fail(`device message[${idx}] id/kind mismatch with kinds (${m.id}/${m.kind} vs ${k.id}/${k.kind})`);
    }
    const bodyRef = m.rustVariant;
    if (!bodyRef) fail(`device message ${m.kind} missing rustVariant`);
    if (!reg.types[bodyRef] && !["CommandRequest", "CommandResult"].includes(bodyRef)) {
      fail(`device message ${m.kind} rustVariant ${bodyRef} not defined in types`);
    }
    if (m.fields) {
      checkFields(`message ${m.kind}`, m.fields);
      if (m.paramsType || m.resultType) {
        fail(`device message ${m.kind} must not mix fields with paramsType/resultType`);
      }
    } else {
      if (!reg.types[m.paramsType]) fail(`device message ${m.kind} paramsType ${m.paramsType} not defined`);
      if (!reg.types[m.resultType]) fail(`device message ${m.kind} resultType ${m.resultType} not defined`);
    }
  });

  // types/enums 基本形状
  for (const [name, spec] of Object.entries(reg.types)) {
    if (spec.kind === "struct") {
      checkFields(`type ${name}`, spec.fields);
    } else if (spec.kind === "tagged") {
      if (!spec.tag) fail(`tagged type ${name} missing tag`);
      if (!Array.isArray(spec.variants) || spec.variants.length === 0) {
        fail(`tagged type ${name} must declare variants`);
      }
      for (const v of spec.variants) checkFields(`type ${name}.${v.name}`, v.fields);
    } else {
      fail(`unknown type kind ${spec.kind} for ${name}`);
    }
  }
  for (const [name, spec] of Object.entries(reg.enums)) {
    if (!Array.isArray(spec.values) || spec.values.length === 0) {
      fail(`device enum ${name} must declare values`);
    }
  }

  // commands：37 条、编号 C01-C37、kind/tauriCommand 非空、引用类型/错误码存在
  if (!Array.isArray(reg.commands) || reg.commands.length !== 37) {
    fail(`device registry must declare 37 commands, got ${reg.commands.length}`);
  }
  const errorCodeSet = new Set(allDeviceErrorCodes(reg));
  reg.commands.forEach((c, idx) => {
    const expectedNumber = `C${String(idx + 1).padStart(2, "0")}`;
    if (c.number !== expectedNumber) fail(`command ${c.kind} number must be ${expectedNumber}`);
    if (!c.name || c.kind !== `remote.${c.name}`) {
      fail(`command kind must be remote.<name> (got ${c.kind})`);
    }
    if (!c.tauriCommand) fail(`command ${c.kind} missing tauriCommand`);
    if (!c.idempotencyKey) fail(`command ${c.kind} missing idempotencyKey`);
    const asciiKey = asciiIdempotencyKey(c.idempotencyKey);
    if (!asciiKey) fail(`command ${c.kind} idempotencyKey 规范化后为空`);
    if (!/^[\x20-\x7e]+$/.test(asciiKey)) {
      fail(`command ${c.kind} idempotencyKey 规范化后含非 ASCII 字符`);
    }
    if (!reg.types[c.paramsType]) fail(`command ${c.kind} paramsType ${c.paramsType} not defined`);
    if (!reg.types[c.resultType]) fail(`command ${c.kind} resultType ${c.resultType} not defined`);
    for (const code of c.errorCodes) {
      if (!errorCodeSet.has(code)) {
        fail(`command ${c.kind} references unregistered error code ${code}`);
      }
    }
  });

  // events：41 条、编号连续、策略合法，且与 engine 注册表 41 变体同名同序
  if (!Array.isArray(reg.events) || reg.events.length !== 41) {
    fail(`device registry must declare 41 events, got ${reg.events.length}`);
  }
  const engineTypes = engineReg.events.map((ev) => ev.type);
  reg.events.forEach((ev, idx) => {
    if (ev.id !== idx + 1) fail(`device event id must be sequential from 1 (got ${ev.id})`);
    if (ev.type !== engineTypes[idx]) {
      fail(`device event[${idx}] ${ev.type} != engine registry ${engineTypes[idx]} (同名同序)`);
    }
    if (!DEVICE_STRATEGIES.has(ev.strategy)) fail(`device event ${ev.type} unknown strategy ${ev.strategy}`);
    if (typeof ev.sync !== "boolean") fail(`device event ${ev.type} sync must be boolean`);
    if (!DEVICE_PUSH_LEVELS.has(ev.pushLevel)) fail(`device event ${ev.type} unknown pushLevel ${ev.pushLevel}`);
    if (typeof ev.realtime?.push !== "boolean") fail(`device event ${ev.type} realtime.push must be boolean`);
    if (!BACKPRESSURE_LEVELS.has(ev.realtime?.backpressure)) {
      fail(`device event ${ev.type} realtime.backpressure must be in {delta, soft, critical}`);
    }
  });

  // errors：common 为字符串数组且全部在 protocol|business 中登记（去重一致性）
  if (!Array.isArray(reg.errors.commonToAllCommands)) fail("device errors.commonToAllCommands must be an array");
  const protocolBusiness = new Set([
    ...reg.errors.protocol.map((e) => e.code),
    ...reg.errors.business.map((e) => e.code),
  ]);
  for (const code of reg.errors.commonToAllCommands) {
    if (!protocolBusiness.has(code)) {
      fail(`device common error code ${code} must be re-declared in protocol|business`);
    }
  }

  // capabilities：17 位、唯一、owner/commands 引用合法
  if (!Array.isArray(reg.capabilities) || reg.capabilities.length !== 17) {
    fail(`device registry must declare 17 capabilities, got ${reg.capabilities.length}`);
  }
  const seenCaps = new Set();
  for (const cap of reg.capabilities) {
    if (!cap.name || seenCaps.has(cap.name)) fail(`capability duplicated or empty: ${cap.name}`);
    seenCaps.add(cap.name);
    if (!["desktop", "mobile", "both"].includes(cap.owner)) {
      fail(`capability ${cap.name} unknown owner ${cap.owner}`);
    }
    // commands 引用面较宽（C 编号 / kind 字面量 / 通配符如 stream.*，亦可为空），
    // 只做形状检查；引用有效性由 R0-05 对拍与护栏测试锁定
    if (!Array.isArray(cap.commands)) {
      fail(`capability ${cap.name} must declare commands`);
    }
  }
}

/** 注册表错误码去重全集（common 优先序，与生成 errors.ts 同序） */
function allDeviceErrorCodes(reg) {
  const seen = new Set();
  const codes = [];
  for (const code of reg.errors.commonToAllCommands) {
    if (!seen.has(code)) {
      seen.add(code);
      codes.push(code);
    }
  }
  for (const sec of [reg.errors.protocol, reg.errors.business]) {
    for (const e of sec) {
      if (!seen.has(e.code)) {
        seen.add(e.code);
        codes.push(e.code);
      }
    }
  }
  return codes;
}

/**
 * idempotencyKey 的 ASCII 规范化：注册表允许带中文括号注释
 * （如 "natural (control-bus 幂等)"），生成产物必须 ASCII-only，
 * 故截取第一个括号/非 ASCII 字符之前的部分（语义 = 注释前的键名）。
 */
function asciiIdempotencyKey(raw) {
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code > 127 || raw[i] === "(" || raw[i] === "（") {
      return raw.slice(0, i).trim();
    }
  }
  return raw.trim();
}

// ---------------------------------------------------------------------------
// types.ts（engine 与 device 共用发射器；header 参数化，engine 字节不变）
// ---------------------------------------------------------------------------

function emitTypes(reg, header) {
  const lines = [header, "", 'import type { JsonValue } from "../../primitive-types";', ""];

  for (const [name, spec] of Object.entries(reg.enums)) {
    const constName = constNameOf(name);
    lines.push(`export const ${constName} = ${JSON.stringify(spec.values)} as const;`);
    lines.push(`export type ${name} = (typeof ${constName})[number];`);
    lines.push("");
  }

  for (const [name, spec] of Object.entries(reg.types)) {
    if (spec.kind === "struct") {
      lines.push(`export interface ${name} {`);
      for (const f of spec.fields) {
        lines.push(`  ${f.name}${f.required ? "" : "?"}: ${tsTypeName(f.type)};`);
      }
      lines.push("}");
      lines.push("");
    } else if (spec.kind === "tagged") {
      const variantTypes = [];
      for (const v of spec.variants) {
        const tname = `${name}${kebabToPascal(v.name)}`;
        variantTypes.push(tname);
        lines.push(`export interface ${tname} {`);
        lines.push(`  type: ${JSON.stringify(v.name)};`);
        for (const f of v.fields) {
          lines.push(`  ${f.name}${f.required ? "" : "?"}: ${tsTypeName(f.type)};`);
        }
        lines.push("}");
        lines.push("");
      }
      lines.push(`export type ${name} = ${variantTypes.join(" | ")};`);
      lines.push("");
    }
  }

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// events.ts（engine 专用；与 R3 T6 逐字节一致）
// ---------------------------------------------------------------------------

function emitEvents(reg, header) {
  const lines = [header, ""];

  const imported = new Set();
  const primitiveImports = new Set();
  for (const ev of reg.events) {
    for (const f of ev.fields) {
      const ref = referencedName(f.type);
      if (ref !== null && !PRIMITIVES.has(f.type)) imported.add(ref);
      // JsonValue 是 primitive-types 引用（非 types.ts）——task-heartbeat
      // 的 resource 等字段需单独 import（T-AB-17 引入后修复）
      const ts = tsTypeName(f.type);
      if (ts.includes("JsonValue")) primitiveImports.add("JsonValue");
    }
    // I5-M7：SUBAGENT_EVENT_KIND_BACKPRESSURE 的类型引用 SubagentEventKind
    // （types.ts），事件字段本身引用 SubagentEventPayload，需显式并入
    if (ev.type === "subagent-event") imported.add("SubagentEventKind");
  }
  if (imported.size > 0) {
    lines.push(
      `import type { ${[...imported].join(", ")} } from "./types";`,
      "",
    );
  }
  if (primitiveImports.size > 0) {
    lines.push(
      `import type { ${[...primitiveImports].join(", ")} } from "../../primitive-types";`,
      "",
    );
  }

  const eventTypeNames = [];
  for (const ev of reg.events) {
    const typeName = `Engine${kebabToPascal(ev.type)}Event`;
    eventTypeNames.push(typeName);
    lines.push(`export interface ${typeName} {`);
    lines.push(`  type: ${JSON.stringify(ev.type)};`);
    for (const f of ev.fields) {
      lines.push(`  ${f.name}${f.required ? "" : "?"}: ${tsTypeName(f.type)};`);
    }
    lines.push("}");
    lines.push("");
  }

  lines.push(
    `export type EngineEvent = ${eventTypeNames.join(" | ")};`,
    "",
    `export const ENGINE_EVENT_TYPES = ${JSON.stringify(reg.events.map((ev) => ev.type))} as const;`,
    `export type EngineEventType = (typeof ENGINE_EVENT_TYPES)[number];`,
    "",
  );

  // I5-M7：背压三级分类（04 报告 1e）——每事件 backpressure 级别 +
  // subagent-event 的 kind 级映射（前端 EventRouter 消费位）
  const bpEntries = reg.events.map((ev) => `  ${JSON.stringify(ev.type)}: ${JSON.stringify(ev.backpressure)}`);
  lines.push(
    `export const ENGINE_EVENT_BACKPRESSURE = {`,
    bpEntries.join(",\n"),
    `} as const;`,
    `export type EngineEventBackpressure = (typeof ENGINE_EVENT_BACKPRESSURE)[EngineEventType];`,
    "",
  );
  const kindEvent = reg.events.find((ev) => ev.type === "subagent-event");
  if (kindEvent) {
    const kindEntries = Object.entries(kindEvent.kindBackpressure)
      .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
      .join(",\n");
    lines.push(
      `export const SUBAGENT_EVENT_KIND_BACKPRESSURE = {`,
      kindEntries,
      `} as const;`,
      `export type SubagentEventKindBackpressure = (typeof SUBAGENT_EVENT_KIND_BACKPRESSURE)[SubagentEventKind];`,
      "",
    );
  }

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// parser.ts（engine 与 device 共用骨架：ParseResult/深度守卫/整数校验）
// ---------------------------------------------------------------------------

const PREAMBLE_HEAD = [
  "export type ParseResult<T> =",
  "  | { readonly ok: true; readonly data: T }",
  "  | { readonly ok: false; readonly error: string };",
  "",
  "export function parseOk<T>(data: T): ParseResult<T> {",
  "  return { ok: true, data };",
  "}",
  "",
  "export function parseErr(error: string): ParseResult<never> {",
  "  return { ok: false, error };",
  "}",
  "",
  "export function isParseOk<T>(",
  "  result: ParseResult<T>,",
  "): result is { readonly ok: true; readonly data: T } {",
  "  return result.ok === true;",
  "}",
  "",
  "export function isParseErr<T>(",
  "  result: ParseResult<T>,",
  "): result is { readonly ok: false; readonly error: string } {",
  "  return result.ok === false;",
  "}",
  "",
  "function isRecord(v: unknown): v is Record<string, unknown> {",
  "  return typeof v === \"object\" && v !== null && !Array.isArray(v);",
  "}",
  "",
  "function checkString(v: unknown): ParseResult<string> {",
  "  return typeof v === \"string\" ? parseOk(v) : parseErr(\"expected a string\");",
  "}",
  "",
];

const CHECK_NUMBER_FN = [
  "function checkNumber(v: unknown): ParseResult<number> {",
  "  return typeof v === \"number\" && Number.isFinite(v)",
  "    ? parseOk(v)",
  "    : parseErr(\"expected a number\");",
  "}",
  "",
];

const PREAMBLE_TAIL = [
  "// F8-07: integer fields (registry \"integer\": true) reject float/negative/",
  "// huge-tail values that would pollute integer-semantic state (turnIndex,",
  "// exitCode, tokens, ...). Fractional fields (f64 ratios) stay checkNumber.",
  "function checkInteger(v: unknown): ParseResult<number> {",
  "  return typeof v === \"number\" && Number.isFinite(v) && Number.isInteger(v)",
  "    ? parseOk(v)",
  "    : parseErr(\"expected an integer\");",
  "}",
  "",
  "function checkBoolean(v: unknown): ParseResult<boolean> {",
  "  return typeof v === \"boolean\" ? parseOk(v) : parseErr(\"expected a boolean\");",
  "}",
  "",
  "function checkJsonValue(v: unknown, depth = 0): ParseResult<JsonValue> {",
  "  // T3.7 D7 depth guard: deep payloads return parseErr(\"nesting too deep\")",
  "  // instead of recursing to a RangeError (stack overflow) that escapes ParseResult",
  "  if (depth > 256) return parseErr(\"nesting too deep\");",
  "  if (",
  "    v === null ||",
  "    typeof v === \"string\" ||",
  "    typeof v === \"number\" ||",
  "    typeof v === \"boolean\"",
  "  ) {",
  "    return parseOk(v);",
  "  }",
  "  if (Array.isArray(v)) {",
  "    for (const item of v) {",
  "      const r = checkJsonValue(item, depth + 1);",
  "      if (!r.ok) return r;",
  "    }",
  "    return parseOk(v);",
  "  }",
  "  if (isRecord(v)) {",
  "    for (const key of Object.keys(v)) {",
  "      const r = checkJsonValue(v[key], depth + 1);",
  "      if (!r.ok) return r;",
  "    }",
  "    return parseOk(v as JsonValue);",
  "  }",
  "  return parseErr(\"expected a JSON value\");",
  "}",
  "",
  "function parseArrayOf<T>(",
  "  v: unknown,",
  "  item: (x: unknown) => ParseResult<T>,",
  "  depth = 0,",
  "): ParseResult<T[]> {",
  "  // T3.7 D7 depth guard (generated arrays are single-level today; guards future nesting)",
  "  if (depth > 256) return parseErr(\"nesting too deep\");",
  "  if (!Array.isArray(v)) return parseErr(\"expected an array\");",
  "  const out: T[] = [];",
  "  for (let i = 0; i < v.length; i++) {",
  "    const r = item(v[i]);",
  "    if (!r.ok) return parseErr(\"array item \" + i + \": \" + r.error);",
  "    out.push(r.data);",
  "  }",
  "  return parseOk(out);",
  "}",
  "",
  "function reqField<T>(",
  "  obj: Record<string, unknown>,",
  "  key: string,",
  "  parser: (v: unknown) => ParseResult<T>,",
  "): ParseResult<T> {",
  "  if (!(key in obj)) return parseErr(\"missing required field '\" + key + \"'\");",
  "  return parser(obj[key]);",
  "}",
  "",
  "function optField<T>(",
  "  obj: Record<string, unknown>,",
  "  key: string,",
  "  parser: (v: unknown) => ParseResult<T>,",
  "): ParseResult<T | undefined> {",
  "  const v = obj[key];",
  "  if (v === undefined) return parseOk(undefined);",
  "  return parser(v);",
  "}",
];

/** engine parser 骨架（与 R3 T6 逐字节一致，含 checkNumber） */
const PARSER_PREAMBLE = [...PREAMBLE_HEAD, ...CHECK_NUMBER_FN, ...PREAMBLE_TAIL].join("\n");

/** device parser 骨架：无浮点字段时省略 checkNumber（noUnusedLocals 防红） */
function deviceParserPreamble(hasFloatFields) {
  return [...PREAMBLE_HEAD, ...(hasFloatFields ? CHECK_NUMBER_FN : []), ...PREAMBLE_TAIL].join("\n");
}

function fieldParserExpr(f) {
  const t = f.type;
  // F8-07: number 字段按注册表 integer 标记选择 checkInteger/checkNumber
  //（integer 缺失由 validateRegistry 拒绝，防手改注册表漏标）
  const numberChecker = (integer) => (integer ? "checkInteger" : "checkNumber");
  if (t === "string") return "checkString";
  if (t === "number") return numberChecker(f.integer);
  if (t === "boolean") return "checkBoolean";
  if (t === "JsonValue") return "checkJsonValue";
  if (t.endsWith("[]")) {
    const inner = t.slice(0, -2);
    const base =
      inner === "string"
        ? "checkString"
        : inner === "number"
          ? numberChecker(f.integer)
          : inner === "boolean"
            ? "checkBoolean"
            : inner === "JsonValue"
              ? "checkJsonValue"
              : `parse${inner}`;
    return `(x) => parseArrayOf(x, ${base})`;
  }
  return `parse${t}`;
}

function emitStructParser(name, fields, opts) {
  const lines = [];
  const wire = opts.wire; // discriminator value (events & variants)
  lines.push(`export function parse${name}(v: unknown): ParseResult<${name}> {`);
  lines.push(
    `  if (!isRecord(v)) return parseErr("${name}: payload must be an object");`,
  );
  if (wire !== undefined) {
    lines.push(
      `  if (v["type"] !== ${JSON.stringify(wire)}) return parseErr("${name}: type mismatch");`,
    );
  }
  for (const f of fields) {
    const accessor = f.required ? "reqField" : "optField";
    lines.push(
      `  const ${f.name} = ${accessor}(v, ${JSON.stringify(f.name)}, ${fieldParserExpr(f)});`,
    );
    lines.push(`  if (!${f.name}.ok) return ${f.name};`);
  }
  lines.push("  return parseOk({");
  if (wire !== undefined) {
    lines.push(`    type: ${JSON.stringify(wire)},`);
  }
  for (const f of fields) {
    if (f.required) {
      lines.push(`    ${f.name}: ${f.name}.data,`);
    } else {
      lines.push(
        `    ...(${f.name}.data !== undefined ? { ${f.name}: ${f.name}.data } : {}),`,
      );
    }
  }
  lines.push("  });");
  lines.push("}");
  return lines.join("\n");
}

function emitTaggedParser(name, spec) {
  const parts = [];
  for (const v of spec.variants) {
    const vname = `${name}${kebabToPascal(v.name)}`;
    parts.push(emitStructParser(vname, v.fields, { kind: "variant", wire: v.name }));
    parts.push("");
  }
  const lines = [
    `export function parse${name}(v: unknown): ParseResult<${name}> {`,
    `  if (!isRecord(v)) return parseErr("${name}: payload must be an object");`,
    `  const t = v["type"];`,
    `  switch (t) {`,
  ];
  for (const v of spec.variants) {
    lines.push(
      `    case ${JSON.stringify(v.name)}: return parse${name}${kebabToPascal(v.name)}(v);`,
    );
  }
  lines.push(
    `    default: return parseErr("${name}: unknown type '" + String(t) + "'");`,
    `  }`,
    `}`,
  );
  parts.push(lines.join("\n"));
  return parts.join("\n\n");
}

function emitEnumParser(name, constName) {
  return [
    `export function parse${name}(v: unknown): ParseResult<${name}> {`,
    `  if (typeof v === "string" && (${constName} as readonly string[]).includes(v)) {`,
    `    return parseOk(v as ${name});`,
    `  }`,
    `  return parseErr(${JSON.stringify(`${name}: expected one of `)} + ${constName}.join(", "));`,
    `}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// parser.ts（engine 专用发射器；与 R3 T6 逐字节一致）
// ---------------------------------------------------------------------------

function emitParser(reg, header) {
  const lines = [header, ""];

  const importedTypes = new Set();
  for (const name of Object.keys(reg.types)) {
    importedTypes.add(name);
    const spec = reg.types[name];
    if (spec.kind === "tagged") {
      for (const v of spec.variants) importedTypes.add(`${name}${kebabToPascal(v.name)}`);
    }
  }
  for (const name of Object.keys(reg.enums)) importedTypes.add(name);
  const importedEvents = new Set(
    reg.events.map((ev) => `Engine${kebabToPascal(ev.type)}Event`),
  );
  const importedEnumConsts = Object.keys(reg.enums).map(constNameOf);
  lines.push(
    `import type { EngineEvent, ${[...importedEvents].join(", ")} } from "./events";`,
    `import type { ${[...importedTypes].join(", ")} } from "./types";`,
    `import { ${importedEnumConsts.join(", ")} } from "./types";`,
    `import type { JsonValue } from "../../primitive-types";`,
    "",
    PARSER_PREAMBLE,
    "",
  );

  for (const [name] of Object.entries(reg.enums)) {
    const constName = constNameOf(name);
    lines.push(
      emitEnumParser(name, constName),
      "",
    );
  }

  for (const [name, spec] of Object.entries(reg.types)) {
    if (spec.kind === "struct") {
      lines.push(emitStructParser(name, spec.fields, { kind: "struct" }));
    } else if (spec.kind === "tagged") {
      lines.push(emitTaggedParser(name, spec));
    }
    lines.push("");
  }

  for (const ev of reg.events) {
    const typeName = `Engine${kebabToPascal(ev.type)}Event`;
    lines.push(emitStructParser(typeName, ev.fields, { kind: "event", wire: ev.type }));
    lines.push("");
  }

  lines.push(
    `export function parseEngineEvent(v: unknown): ParseResult<EngineEvent> {`,
    `  if (!isRecord(v)) return parseErr("engine event must be an object");`,
    `  const t = v["type"];`,
    `  if (typeof t !== "string") return parseErr("engine event missing type");`,
    `  switch (t) {`,
  );
  for (const ev of reg.events) {
    lines.push(
      `    case ${JSON.stringify(ev.type)}: return parseEngine${kebabToPascal(ev.type)}Event(v);`,
    );
  }
  lines.push(
    `    default: return parseErr("unknown engine event type '" + t + "'");`,
    `  }`,
    `}`,
    "",
  );

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// index.ts（engine 与 device 共用发射器；导出行参数化）
// ---------------------------------------------------------------------------

function emitIndex(header, exportLines) {
  return [header, "", ...exportLines.map((l) => `export * from ${JSON.stringify(l)};`), ""].join("\n");
}

// ---------------------------------------------------------------------------
// device 产物发射器（R0-03：kinds/commands/events/stream/errors/capabilities/
// types/parser/index 九件套）
// ---------------------------------------------------------------------------

/** kinds.ts：103 kind 字面量联合 + family 分组 + kind 元数据表 */
function emitDeviceKinds(reg) {
  const lines = [DEVICE_HEADER, ""];

  const kindNames = reg.kinds.map((k) => k.kind);
  lines.push(
    `export const DEVICE_KINDS = ${JSON.stringify(kindNames)} as const;`,
    `export type DeviceKind = (typeof DEVICE_KINDS)[number];`,
    "",
  );

  const families = {};
  for (const k of reg.kinds) {
    (families[k.family] ||= []).push(k.kind);
  }
  const familyEntries = Object.entries(families)
    .map(([family, kinds]) => `  ${JSON.stringify(family)}: ${JSON.stringify(kinds)}`)
    .join(",\n");
  lines.push(
    `export const DEVICE_KIND_FAMILIES = {`,
    familyEntries,
    `} as const;`,
    `export type DeviceKindFamily = keyof typeof DEVICE_KIND_FAMILIES;`,
    "",
  );

  const metaEntries = reg.kinds.map((k) => {
    const meta = { family: k.family, direction: k.direction, authPhase: k.authPhase, messageId: k.messageId };
    return `  ${JSON.stringify(k.kind)}: ${JSON.stringify(meta)}`;
  });
  lines.push(
    `export const KIND_METADATA = {`,
    metaEntries.join(",\n"),
    `} as const;`,
    `export type KindMetadata = (typeof KIND_METADATA)[DeviceKind];`,
    "",
  );

  return lines.join("\n") + "\n";
}

/** commands.ts：37 命令元数据 + 白名单常量 + 参数/结果类型映射 */
function emitDeviceCommands(reg) {
  const lines = [DEVICE_HEADER, ""];
  const importedCommandTypes = new Set(
    reg.commands.flatMap((c) => [c.paramsType, c.resultType]),
  );
  lines.push(
    `import type { ${[...importedCommandTypes].join(", ")} } from "./types";`,
    "",
  );

  const commandEntries = reg.commands.map((c) => {
    const meta = {
      number: c.number,
      name: c.name,
      kind: c.kind,
      tauriCommand: c.tauriCommand,
      surface: c.surface,
      registered: c.registered,
      domain: c.domain,
      write: c.write,
      outbox: c.outbox,
      idempotencyKey: asciiIdempotencyKey(c.idempotencyKey),
      paramsType: c.paramsType,
      resultType: c.resultType,
      errorCodes: c.errorCodes,
    };
    return `  ${JSON.stringify(meta)}`;
  });
  lines.push(
    `export const DEVICE_COMMANDS = [`,
    commandEntries.join(",\n"),
    `] as const;`,
    `export type DeviceCommand = (typeof DEVICE_COMMANDS)[number];`,
    `export type DeviceCommandKind = DeviceCommand["kind"];`,
    "",
  );

  // M6 §4.7 三重约束的 B/C 面：白名单 = registered=true ∩ surface=engine
  const whitelist = reg.commands
    .filter((c) => c.registered && c.surface === "engine")
    .map((c) => c.kind);
  lines.push(
    `export const COMMAND_WHITELIST = ${JSON.stringify(whitelist)} as const;`,
    `export type CommandWhitelistKind = (typeof COMMAND_WHITELIST)[number];`,
    "",
  );

  // 类型映射表按键去重（多个命令可共用同一 params/result 类型，如
  // C03/C04 共用 EventPageResult、approve/deny 共用 ApproveResult）
  const paramsEntries = [...new Set(reg.commands.map((c) => c.paramsType))]
    .map((t) => `  ${t}: ${t};`);
  const resultEntries = [...new Set(reg.commands.map((c) => c.resultType))]
    .map((t) => `  ${t}: ${t};`);
  lines.push(
    `export interface CommandParamsTypeMap {`,
    paramsEntries.join("\n"),
    `}`,
    "",
    `export interface CommandResultTypeMap {`,
    resultEntries.join("\n"),
    `}`,
    "",
    `export type CommandParamsOf<C extends DeviceCommand> = CommandParamsTypeMap[C["paramsType"]];`,
    `export type CommandResultOf<C extends DeviceCommand> = CommandResultTypeMap[C["resultType"]];`,
    "",
  );

  return lines.join("\n") + "\n";
}

/** events.ts：41 变体跨端双面策略（实时面/同步面）——事件体以 engine 注册表为真源 */
function emitDeviceEvents(reg) {
  const lines = [DEVICE_HEADER, ""];

  const eventEntries = reg.events.map((ev) => {
    const meta = {
      id: ev.id,
      type: ev.type,
      strategy: ev.strategy,
      realtime: { push: ev.realtime.push, backpressure: ev.realtime.backpressure },
      sync: ev.sync,
      pushLevel: ev.pushLevel,
    };
    return `  ${JSON.stringify(meta)}`;
  });
  lines.push(
    `export const DEVICE_EVENTS = [`,
    eventEntries.join(",\n"),
    `] as const;`,
    `export type DeviceEvent = (typeof DEVICE_EVENTS)[number];`,
    `export type DeviceEventType = DeviceEvent["type"];`,
    "",
  );

  const syncEligible = reg.events.filter((ev) => ev.sync).map((ev) => ev.type);
  lines.push(
    `export const EVENT_SYNC_ELIGIBLE = ${JSON.stringify(syncEligible)} as const;`,
    `export type EventSyncEligibleType = (typeof EVENT_SYNC_ELIGIBLE)[number];`,
    "",
  );

  const strategyCounts = {};
  for (const ev of reg.events) strategyCounts[ev.strategy] = (strategyCounts[ev.strategy] || 0) + 1;
  lines.push(
    `export const EVENT_STRATEGY_COUNTS = ${JSON.stringify(strategyCounts)} as const;`,
    "",
  );

  return lines.join("\n") + "\n";
}

/** stream.ts：4 个流 kind + 流限制常量（数值字段） */
function emitDeviceStream(reg) {
  const lines = [DEVICE_HEADER, ""];

  const kindEntries = reg.stream.kinds.map((k) => {
    const meta = { kind: k.kind, direction: k.direction, bodyType: k.bodyType, messageId: k.messageId };
    return `  ${JSON.stringify(meta)}`;
  });
  lines.push(
    `export const STREAM_KINDS = [`,
    kindEntries.join(",\n"),
    `] as const;`,
    `export type StreamKindName = (typeof STREAM_KINDS)[number]["kind"];`,
    "",
  );

  const numericLimits = {};
  for (const [key, value] of Object.entries(reg.stream.limits || {})) {
    if (typeof value === "number") numericLimits[key] = value;
  }
  lines.push(
    `export const STREAM_LIMITS = ${JSON.stringify(numericLimits)} as const;`,
    "",
  );

  return lines.join("\n") + "\n";
}

/** errors.ts：错误码枚举（common/protocol/business 分面 + 去重全集）+ CoreError 映射 */
function emitDeviceErrors(reg) {
  const lines = [DEVICE_HEADER, ""];

  const common = reg.errors.commonToAllCommands;
  const protocol = reg.errors.protocol.map((e) => e.code);
  const business = reg.errors.business.map((e) => e.code);
  lines.push(
    `export const DEVICE_ERROR_COMMON = ${JSON.stringify(common)} as const;`,
    `export const DEVICE_ERROR_PROTOCOL = ${JSON.stringify(protocol)} as const;`,
    `export const DEVICE_ERROR_BUSINESS = ${JSON.stringify(business)} as const;`,
    "",
    `export const DEVICE_ERROR_CODES = ${JSON.stringify(allDeviceErrorCodes(reg))} as const;`,
    `export type DeviceErrorCode = (typeof DEVICE_ERROR_CODES)[number];`,
    "",
  );

  const mappingEntries = Object.entries(reg.errors.coreErrorMapping)
    .map(([kind, codes]) => `  ${JSON.stringify(kind)}: ${JSON.stringify(codes)}`)
    .join(",\n");
  lines.push(
    `export const CORE_ERROR_MAPPING = {`,
    mappingEntries,
    `} as const;`,
    `export type CoreErrorKind = keyof typeof CORE_ERROR_MAPPING;`,
    "",
  );

  return lines.join("\n") + "\n";
}

/** capabilities.ts：17 位能力位字面量联合 + 能力元数据（owner/命令归属） */
function emitDeviceCapabilities(reg) {
  const lines = [DEVICE_HEADER, ""];

  const names = reg.capabilities.map((c) => c.name);
  lines.push(
    `export const DEVICE_CAPABILITIES = ${JSON.stringify(names)} as const;`,
    `export type DeviceCapability = (typeof DEVICE_CAPABILITIES)[number];`,
    "",
  );

  const metaEntries = reg.capabilities.map((c) => {
    const meta = { owner: c.owner, commands: c.commands };
    return `  ${JSON.stringify(c.name)}: ${JSON.stringify(meta)}`;
  });
  lines.push(
    `export const CAPABILITY_METADATA = {`,
    metaEntries.join(",\n"),
    `} as const;`,
    `export type CapabilityMetadata = (typeof CAPABILITY_METADATA)[DeviceCapability];`,
    "",
  );

  return lines.join("\n") + "\n";
}

/** parser.ts：信封/消息体解析 + 按 kind 分发（复用 engine 骨架，ASCII-only） */
function emitDeviceParser(reg) {
  const lines = [DEVICE_HEADER, ""];

  // 消息体类型全集：静态 29 条消息的 body 类型（按消息序去重）+ 命令信封两件
  const bodyTypes = [];
  for (const m of reg.messages) {
    if (!bodyTypes.includes(m.rustVariant)) bodyTypes.push(m.rustVariant);
  }
  const remoteKinds = reg.kinds.filter((k) => k.family === "remote").map((k) => k.kind);
  const resultKinds = reg.kinds.filter((k) => k.family === "result").map((k) => k.kind);

  const importedTypes = new Set(
    [...bodyTypes, ...Object.keys(reg.types), ...Object.keys(reg.enums)].filter(
      (t) => t !== "DeviceEnvelope",
    ),
  );
  const importedEnumConsts = Object.keys(reg.enums).map(constNameOf);
  const hasFloatFields = Object.values(reg.types)
    .flatMap((spec) => (spec.fields || []))
    .some((f) => (f.type === "number" || f.type === "number[]") && f.integer === false);
  lines.push(
    `import type { ${[...importedTypes].join(", ")} } from "./types";`,
    `import { ${importedEnumConsts.join(", ")} } from "./types";`,
    `import { DEVICE_KINDS } from "./kinds";`,
    `import type { DeviceKind } from "./kinds";`,
    `import type { JsonValue } from "../../primitive-types";`,
    "",
    deviceParserPreamble(hasFloatFields),
    "",
  );

  // 消息体类型联合（供 parseDeviceMessage 返回类型）
  lines.push(
    `export type DeviceMessageBody =`,
    bodyTypes.map((t) => `  | ${t}`).join("\n"),
    "",
    "",
  );

  // 信封解析产出类型：kind 收窄为 DeviceKind（types.ts 的 DeviceEnvelope 为 string）。
  // DeviceFrame 独立声明（不 extends DeviceEnvelopeFrame）：body 从 JsonValue 收窄为
  // DeviceMessageBody 时，接口继承属性类型必须可赋给基类属性，收窄会违反该约束。
  lines.push(
    `export interface DeviceEnvelopeFrame {`,
    `  v: number;`,
    `  kind: DeviceKind;`,
    `  msgId: string;`,
    `  ts: number;`,
    `  from: Endpoint;`,
    `  to: Endpoint;`,
    `  auth: AuthHeader;`,
    `  body: JsonValue;`,
    `}`,
    "",
    `export interface DeviceFrame {`,
    `  v: number;`,
    `  kind: DeviceKind;`,
    `  msgId: string;`,
    `  ts: number;`,
    `  from: Endpoint;`,
    `  to: Endpoint;`,
    `  auth: AuthHeader;`,
    `  body: DeviceMessageBody;`,
    `}`,
    "",
  );

  // 枚举 parser
  for (const [name] of Object.entries(reg.enums)) {
    lines.push(emitEnumParser(name, constNameOf(name)), "");
  }

  // 类型 parser（struct/tagged 全量；DeviceEnvelope 除外——其解析由
  // 下方严格信封 parser parseDeviceEnvelope 承担（kind 收窄 + v 校验））
  for (const [name, spec] of Object.entries(reg.types)) {
    if (name === "DeviceEnvelope") continue;
    if (spec.kind === "struct") {
      lines.push(emitStructParser(name, spec.fields, { kind: "struct" }));
    } else if (spec.kind === "tagged") {
      lines.push(emitTaggedParser(name, spec));
    }
    lines.push("");
  }

  // 信封 parser：v/kind/msgId/ts/from/to/auth/body 逐字段校验，kind 收窄
  lines.push(
    `export function parseDeviceEnvelope(v: unknown): ParseResult<DeviceEnvelopeFrame> {`,
    `  if (!isRecord(v)) return parseErr("device envelope must be an object");`,
    `  const v1 = reqField(v, "v", checkInteger);`,
    `  if (!v1.ok) return v1;`,
    `  if (v1.data !== 1) return parseErr("device envelope unsupported protocol version " + v1.data);`,
    `  const kind = reqField(v, "kind", checkString);`,
    `  if (!kind.ok) return kind;`,
    `  if (!(DEVICE_KINDS as readonly string[]).includes(kind.data)) {`,
    `    return parseErr("device envelope unknown kind '" + kind.data + "'");`,
    `  }`,
    `  const msgId = reqField(v, "msgId", checkString);`,
    `  if (!msgId.ok) return msgId;`,
    `  const ts = reqField(v, "ts", checkInteger);`,
    `  if (!ts.ok) return ts;`,
    `  const from = reqField(v, "from", parseEndpoint);`,
    `  if (!from.ok) return from;`,
    `  const to = reqField(v, "to", parseEndpoint);`,
    `  if (!to.ok) return to;`,
    `  const auth = reqField(v, "auth", parseAuthHeader);`,
    `  if (!auth.ok) return auth;`,
    `  const body = reqField(v, "body", checkJsonValue);`,
    `  if (!body.ok) return body;`,
    `  return parseOk({`,
    `    v: v1.data,`,
    `    kind: kind.data as DeviceKind,`,
    `    msgId: msgId.data,`,
    `    ts: ts.data,`,
    `    from: from.data,`,
    `    to: to.data,`,
    `    auth: auth.data,`,
    `    body: body.data,`,
    `  });`,
    `}`,
    "",
  );

  // 按 kind 分发消息体解析：静态 kind 直连 body parser；remote.* 校验
  // body.command 与 kind 后缀一致；result.* 统一 CommandResult 信封
  lines.push(
    `export function parseDeviceMessage(kind: DeviceKind, body: unknown): ParseResult<DeviceMessageBody> {`,
    `  switch (kind) {`,
  );
  for (const m of reg.messages) {
    if (m.family === "remote") {
      const suffix = m.kind.slice("remote.".length);
      lines.push(
        `    case ${JSON.stringify(m.kind)}: {`,
        `      const r = parseCommandRequest(body);`,
        `      if (!r.ok) return r;`,
        `      if (r.data.command !== ${JSON.stringify(suffix)}) {`,
        `        return parseErr(${JSON.stringify(`${m.kind}: body.command mismatch`)});`,
        `      }`,
        `      return r;`,
        `    }`,
      );
    } else if (m.family === "result") {
      lines.push(`    case ${JSON.stringify(m.kind)}: return parseCommandResult(body);`);
    } else {
      lines.push(`    case ${JSON.stringify(m.kind)}: return parse${m.rustVariant}(body);`);
    }
  }
  lines.push(
    `    default: return parseErr("unknown device kind '" + String(kind) + "'");`,
    `  }`,
    `}`,
    "",
  );

  // 信封 + 消息体一次解析（网关/移动端连接层消费位）
  lines.push(
    `export function parseDeviceFrame(v: unknown): ParseResult<DeviceFrame> {`,
    `  const envelope = parseDeviceEnvelope(v);`,
    `  if (!envelope.ok) return envelope;`,
    `  const body = parseDeviceMessage(envelope.data.kind, envelope.data.body);`,
    `  if (!body.ok) return body;`,
    `  return parseOk({ ...envelope.data, body: body.data });`,
    `}`,
    "",
  );

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// 主入口：注册表发现 → 契约分发 → 写入
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { registry: null, out: null, only: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--registry") opts.registry = resolve(argv[++i]);
    else if (a === "--out") opts.out = resolve(argv[++i]);
    else if (a === "--only") opts.only = argv[++i];
    else fail(`未知参数 ${a}（支持 --registry <path> / --out <dir> / --only <contract>）`);
  }
  return opts;
}

function emitEngine(reg, outDir) {
  validateRegistry(reg);
  mkdirSync(outDir, { recursive: true });
  const files = {
    "events.ts": emitEvents(reg, HEADER),
    "types.ts": emitTypes(reg, HEADER),
    "parser.ts": emitParser(reg, HEADER),
    "index.ts": emitIndex(HEADER, ["./events", "./types", "./parser"]),
  };
  for (const [fileName, content] of Object.entries(files)) {
    writeFileSync(join(outDir, fileName), content, "utf8");
  }
  console.log(
    `generate-engine-bindings: engine-events -> ${outDir} (${Object.keys(files).length} files)`,
  );
  console.log(`  events: ${reg.events.length}, types: ${Object.keys(reg.types).length}, enums: ${Object.keys(reg.enums).length}`);
  return Object.keys(files).length;
}

function emitDevice(reg, outDir, engineReg) {
  validateDeviceRegistry(reg, engineReg);
  mkdirSync(outDir, { recursive: true });
  const files = {
    "types.ts": emitTypes(reg, DEVICE_HEADER),
    "kinds.ts": emitDeviceKinds(reg),
    "commands.ts": emitDeviceCommands(reg),
    "events.ts": emitDeviceEvents(reg),
    "stream.ts": emitDeviceStream(reg),
    "errors.ts": emitDeviceErrors(reg),
    "capabilities.ts": emitDeviceCapabilities(reg),
    "parser.ts": emitDeviceParser(reg),
    "index.ts": emitIndex(DEVICE_HEADER, [
      "./types",
      "./kinds",
      "./commands",
      "./events",
      "./stream",
      "./errors",
      "./capabilities",
      "./parser",
    ]),
  };
  for (const [fileName, content] of Object.entries(files)) {
    writeFileSync(join(outDir, fileName), content, "utf8");
  }
  console.log(
    `generate-engine-bindings: device-protocol -> ${outDir} (${Object.keys(files).length} files)`,
  );
  console.log(
    `  kinds: ${reg.kinds.length}, messages: ${reg.messages.length}, commands: ${reg.commands.length}, events: ${reg.events.length}, types: ${Object.keys(reg.types).length}, enums: ${Object.keys(reg.enums).length}, errors: ${allDeviceErrorCodes(reg).length}, capabilities: ${reg.capabilities.length}`,
  );
  return Object.keys(files).length;
}

function main() {
  const opts = parseArgs(process.argv);

  let registryPaths;
  if (opts.registry) {
    registryPaths = [opts.registry];
  } else {
    registryPaths = readdirSync(CONTRACTS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => join(CONTRACTS_DIR, f));
  }

  // engine 注册表（device 事件段交叉校验真源；缺失时跳过交叉校验）
  let engineReg = null;
  try {
    engineReg = JSON.parse(readFileSync(join(CONTRACTS_DIR, "engine-events.json"), "utf8"));
  } catch {
    engineReg = null;
  }

  let totalFiles = 0;
  for (const path of registryPaths) {
    const reg = JSON.parse(readFileSync(path, "utf8"));
    const target = REGISTRY_TARGETS[reg.contract];
    if (!target) {
      fail(`未知注册表契约 ${reg.contract}（支持：${Object.keys(REGISTRY_TARGETS).join(", ")}）`);
    }
    if (opts.only && reg.contract !== opts.only) continue;
    const outDir = opts.out ?? join(GENERATED_DIR, target);
    if (reg.contract === "engine-events") {
      totalFiles += emitEngine(reg, outDir);
    } else if (reg.contract === "device-protocol") {
      if (!engineReg) fail("device-protocol 需要 engine-events.json 做事件段交叉校验");
      totalFiles += emitDevice(reg, outDir, engineReg);
    }
  }
  console.log(`generate-engine-bindings: total ${totalFiles} files`);
}

main();
