#!/usr/bin/env node
/**
 * Engine contract bindings generator (R3 T6).
 *
 * Reads crates/conex-types/contracts/engine-events.json (the machine-readable
 * event registry whose source of truth is crates/conex-types/src/events.rs)
 * and emits TypeScript types + hand-written guards into
 * packages/shared-types/src/generated/engine/.
 *
 * Output files (fixed set, overwritten on every run; deterministic content):
 *   events.ts  - EngineEvent tagged union + per-event types + type-name list
 *   types.ts   - payload types (structs, tagged unions, enum literal unions)
 *   parser.ts  - ParseResult + per-type parsers + parseEngineEvent dispatcher
 *   index.ts   - barrel re-export
 *
 * Idempotency: no timestamps or randomness; run twice -> identical bytes.
 * This file is intentionally ASCII-only (no non-ASCII characters).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_PATH = join(
  ROOT,
  "crates",
  "conex-types",
  "contracts",
  "engine-events.json",
);
const OUT_DIR = join(
  ROOT,
  "packages",
  "shared-types",
  "src",
  "generated",
  "engine",
);

const HEADER = [
  "// =======================================================================",
  "// GENERATED FILE - DO NOT EDIT BY HAND.",
  "// Source of truth: crates/conex-types/src/events.rs (AgentEvent enum + payloads)",
  "// Registry: crates/conex-types/contracts/engine-events.json",
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
// types.ts
// ---------------------------------------------------------------------------

function emitTypes(reg) {
  const lines = [HEADER, "", 'import type { JsonValue } from "../../primitive-types";', ""];

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
// events.ts
// ---------------------------------------------------------------------------

function emitEvents(reg) {
  const lines = [HEADER, ""];

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
// parser.ts
// ---------------------------------------------------------------------------

const PARSER_PREAMBLE = [
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
  "function checkNumber(v: unknown): ParseResult<number> {",
  "  return typeof v === \"number\" && Number.isFinite(v)",
  "    ? parseOk(v)",
  "    : parseErr(\"expected a number\");",
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
].join("\n");

function fieldParserExpr(f) {
  const t = f.type;
  if (t === "string") return "checkString";
  if (t === "number") return "checkNumber";
  if (t === "boolean") return "checkBoolean";
  if (t === "JsonValue") return "checkJsonValue";
  if (t.endsWith("[]")) {
    const inner = t.slice(0, -2);
    const base =
      inner === "string"
        ? "checkString"
        : inner === "number"
          ? "checkNumber"
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

function emitParser(reg) {
  const lines = [HEADER, ""];

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
      `export function parse${name}(v: unknown): ParseResult<${name}> {`,
      `  if (typeof v === "string" && (${constName} as readonly string[]).includes(v)) {`,
      `    return parseOk(v as ${name});`,
      `  }`,
      `  return parseErr(${JSON.stringify(`${name}: expected one of `)} + ${constName}.join(", "));`,
      `}`,
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
// index.ts
// ---------------------------------------------------------------------------

function emitIndex() {
  return [HEADER, "", 'export * from "./events";', 'export * from "./types";', 'export * from "./parser";', ""].join("\n");
}

// ---------------------------------------------------------------------------

function main() {
  const reg = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  validateRegistry(reg);
  mkdirSync(OUT_DIR, { recursive: true });
  const files = {
    "events.ts": emitEvents(reg),
    "types.ts": emitTypes(reg),
    "parser.ts": emitParser(reg),
    "index.ts": emitIndex(),
  };
  for (const [fileName, content] of Object.entries(files)) {
    writeFileSync(join(OUT_DIR, fileName), content, "utf8");
  }
  console.log(
    `generate-engine-bindings: wrote ${Object.keys(files).length} files to ${OUT_DIR}`,
  );
  console.log(`  events: ${reg.events.length}, types: ${Object.keys(reg.types).length}, enums: ${Object.keys(reg.enums).length}`);
}

main();
