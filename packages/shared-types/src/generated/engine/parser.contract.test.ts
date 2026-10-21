/**
 * 生成 parser ↔ 注册表契约测试（engine-events.json 驱动）。
 *
 * 目的：逐事件、逐字段验证 packages/shared-types/src/generated/engine/parser.ts
 * 的 fail-closed 行为与注册表（crates/conex-types/contracts/engine-events.json，
 * Rust AgentEvent 的机器可读导出）一致——不是只看「生成产物字节没漂移」
 * （drift.test.ts 已覆盖），而是看「生成出来的解析器在运行时是否真按契约拒/收」。
 *
 * 对每个事件：
 *   1. 全字段合法载荷 → ok，且输出与输入逐字段相等（未知字段被丢弃）；
 *   2. 仅必填字段 → ok，可选字段不出现在输出里（不注入 undefined 键）；
 *   3. 删除任一必填字段 → err，报 missing required field '<name>'；
 *   4. 任一字段（必填/可选）换成错误类型 → err；
 *   5. integer 字段给小数 → err（F8-07）；枚举字段给非法值 → err，并列出合法值；
 *   6. 结构体/tagged 嵌套字段：内部必填字段缺失、tag 未知 → err。
 *
 * 样本完全由注册表推导，不手写 57 份 fixture；注册表新增事件或字段时本测试自动覆盖。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as parser from './parser';
import { parseEngineEvent } from './parser';

interface RegistryField {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly integer?: boolean;
}
interface RegistryStruct {
  readonly kind: 'struct';
  readonly fields: readonly RegistryField[];
}
interface RegistryTagged {
  readonly kind: 'tagged';
  readonly tag: string;
  readonly variants: readonly { readonly name: string; readonly fields: readonly RegistryField[] }[];
}
type RegistryType = RegistryStruct | RegistryTagged;
interface Registry {
  readonly eventCount: number;
  readonly events: readonly { readonly type: string; readonly fields: readonly RegistryField[] }[];
  readonly types: Readonly<Record<string, RegistryType>>;
  readonly enums: Readonly<Record<string, { readonly values: readonly string[] }>>;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../');
const REGISTRY = JSON.parse(
  readFileSync(join(ROOT, 'crates', 'conex-types', 'contracts', 'engine-events.json'), 'utf8')
) as Registry;

const JSON_SAMPLE = { nested: [1, 'two', null, true, { deep: 0.5 }] };

/** 由注册表类型推导一个合法样本值（结构体填满全部字段）。 */
function sampleOf(type: string, integer = false, onlyRequired = false): unknown {
  if (type.endsWith('[]')) return [sampleOf(type.slice(0, -2), integer, onlyRequired)];
  switch (type) {
    case 'string':
      return 'sample-string';
    case 'number':
      // 非 integer 字段用小数，顺带证明 f64 字段不会被误判为 integer
      return integer ? 7 : 0.25;
    case 'boolean':
      return true;
    case 'JsonValue':
      return JSON_SAMPLE;
  }
  const en = REGISTRY.enums[type];
  if (en) return en.values[0];
  const t = REGISTRY.types[type];
  if (!t) throw new Error(`registry type not handled by test: ${type}`);
  if (t.kind === 'struct') return objectOf(t.fields, onlyRequired);
  const variant = t.variants[0]!;
  return { [t.tag]: variant.name, ...objectOf(variant.fields, onlyRequired) };
}

function objectOf(fields: readonly RegistryField[], onlyRequired = false): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (onlyRequired && !f.required) continue;
    out[f.name] = sampleOf(f.type, f.integer === true, onlyRequired);
  }
  return out;
}

/** 与字段类型确定不兼容的值。 */
function wrongValueOf(type: string): unknown {
  if (type.endsWith('[]')) return 'not-an-array';
  switch (type) {
    case 'string':
      return 42;
    case 'number':
      return 'not-a-number';
    case 'boolean':
      return 'true';
    case 'JsonValue':
      // undefined/函数都不是 JSON 值；对象内嵌函数可绕过 optField 的 undefined 短路
      return { fn: () => 1 };
  }
  if (REGISTRY.enums[type]) return '__not_a_valid_variant__';
  return 'not-an-object';
}

function eventPayload(type: string, fields: readonly RegistryField[], onlyRequired = false) {
  return { type, ...objectOf(fields, onlyRequired) };
}

function expectErr(result: parser.ParseResult<unknown>): string {
  expect(result.ok).toBe(false);
  return result.ok ? '' : result.error;
}

describe('engine parser ↔ engine-events.json 注册表契约', () => {
  it('注册表事件数与 eventCount 声明一致，且每个事件都有对应的导出解析器', () => {
    expect(REGISTRY.events).toHaveLength(REGISTRY.eventCount);
    for (const ev of REGISTRY.events) {
      const name = 'parseEngine' + ev.type.split('-').map((s) => s[0]!.toUpperCase() + s.slice(1)).join('') + 'Event';
      expect(typeof (parser as Record<string, unknown>)[name], name).toBe('function');
    }
  });

  describe.each(REGISTRY.events.map((e) => [e.type, e] as const))('%s', (type, ev) => {
    it('全字段合法载荷被接受，输出与输入逐字段相等且丢弃未知字段', () => {
      const payload = eventPayload(type, ev.fields);
      const result = parseEngineEvent({ ...payload, __unknownExtra: 'drop-me' });
      expect(result).toEqual({ ok: true, data: payload });
    });

    it('仅必填字段的载荷被接受，可选字段不以 undefined 键出现', () => {
      const payload = eventPayload(type, ev.fields, true);
      const result = parseEngineEvent(payload);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(Object.keys(result.data).sort()).toEqual(Object.keys(payload).sort());
      for (const f of ev.fields.filter((x) => !x.required)) {
        expect(f.name in result.data, f.name).toBe(false);
      }
    });

    const required = ev.fields.filter((f) => f.required);
    if (required.length > 0) {
      it.each(required.map((f) => [f.name, f] as const))('缺少必填字段 %s → err', (name) => {
        const payload: Record<string, unknown> = eventPayload(type, ev.fields);
        delete payload[name];
        expect(expectErr(parseEngineEvent(payload))).toBe(`missing required field '${name}'`);
      });
    }

    it.each(ev.fields.map((f) => [f.name, f] as const))('字段 %s 类型错误 → err', (name, f) => {
      const payload: Record<string, unknown> = eventPayload(type, ev.fields);
      payload[name] = wrongValueOf(f.type);
      expect(expectErr(parseEngineEvent(payload)).length).toBeGreaterThan(0);
    });

    const integers = ev.fields.filter((f) => f.integer === true);
    if (integers.length > 0) {
      it.each(integers.map((f) => [f.name] as const))('integer 字段 %s 拒绝小数/NaN/Infinity', (name) => {
        for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
          const payload: Record<string, unknown> = eventPayload(type, ev.fields);
          payload[name] = bad;
          expect(expectErr(parseEngineEvent(payload))).toMatch(/expected an? (integer|number)/);
        }
      });
    }

    const enumFields = ev.fields.filter((f) => REGISTRY.enums[f.type]);
    if (enumFields.length > 0) {
      it.each(enumFields.map((f) => [f.name, f] as const))('枚举字段 %s：每个合法值都接受，非法值报出合法值清单', (name, f) => {
        const values = REGISTRY.enums[f.type]!.values;
        for (const value of values) {
          const payload: Record<string, unknown> = eventPayload(type, ev.fields);
          payload[name] = value;
          const r = parseEngineEvent(payload);
          expect(r.ok ? (r.data as unknown as Record<string, unknown>)[name] : r.error).toBe(value);
        }
        const payload: Record<string, unknown> = eventPayload(type, ev.fields);
        payload[name] = values[0]!.toUpperCase() + '-X';
        expect(expectErr(parseEngineEvent(payload))).toBe(`${f.type}: expected one of ${values.join(', ')}`);
      });
    }
  });
});

describe('嵌套结构体与 tagged 类型（经事件入口与直接解析器双入口）', () => {
  const structTypes = Object.entries(REGISTRY.types).filter(
    (e): e is [string, RegistryStruct] => e[1].kind === 'struct'
  );
  const taggedTypes = Object.entries(REGISTRY.types).filter(
    (e): e is [string, RegistryTagged] => e[1].kind === 'tagged'
  );

  function directParser(typeName: string): (v: unknown) => parser.ParseResult<unknown> {
    const fn = (parser as Record<string, unknown>)['parse' + typeName];
    expect(typeof fn, 'parse' + typeName).toBe('function');
    return fn as (v: unknown) => parser.ParseResult<unknown>;
  }

  describe.each(structTypes)('struct %s', (typeName, t) => {
    const parse = directParser(typeName);

    it('全字段/仅必填字段合法样本均被接受且保真', () => {
      const full = objectOf(t.fields);
      expect(parse(full)).toEqual({ ok: true, data: full });
      const minimal = objectOf(t.fields, true);
      expect(parse(minimal)).toEqual({ ok: true, data: minimal });
    });

    it('非对象输入（null/数组/字符串/数字）一律拒绝', () => {
      for (const bad of [null, undefined, [], 'str', 3]) {
        expect(expectErr(parse(bad))).toBe(`${typeName}: payload must be an object`);
      }
    });

    it.each(t.fields.map((f) => [f.name, f] as const))('字段 %s：缺失（若必填）与类型错误被拒', (name, f) => {
      if (f.required) {
        const missing = objectOf(t.fields);
        delete missing[name];
        expect(expectErr(parse(missing))).toBe(`missing required field '${name}'`);
      }
      const wrong = objectOf(t.fields);
      wrong[name] = wrongValueOf(f.type);
      expect(expectErr(parse(wrong)).length).toBeGreaterThan(0);
      if (f.type.endsWith('[]')) {
        const badItem = objectOf(t.fields);
        badItem[name] = [sampleOf(f.type.slice(0, -2)), wrongValueOf(f.type.slice(0, -2))];
        expect(expectErr(parse(badItem))).toMatch(/^array item 1: /);
      }
      if (f.integer) {
        const frac = objectOf(t.fields);
        frac[name] = 2.5;
        expect(expectErr(parse(frac))).toBe('expected an integer');
      }
    });
  });

  describe.each(taggedTypes)('tagged %s', (typeName, t) => {
    const parse = directParser(typeName);

    it.each(t.variants.map((v) => [v.name, v] as const))('变体 %s：合法样本保真，缺必填字段/字段类型错误被拒', (name, variant) => {
      const full = { [t.tag]: name, ...objectOf(variant.fields) };
      expect(parse(full)).toEqual({ ok: true, data: full });
      for (const f of variant.fields) {
        if (f.required) {
          const missing: Record<string, unknown> = { ...full };
          delete missing[f.name];
          expect(expectErr(parse(missing))).toBe(`missing required field '${f.name}'`);
        }
        const wrong: Record<string, unknown> = { ...full, [f.name]: wrongValueOf(f.type) };
        expect(expectErr(parse(wrong)).length).toBeGreaterThan(0);
      }
    });

    it('未知 tag 与非对象被拒', () => {
      expect(expectErr(parse({ [t.tag]: '__unknown__' }))).toBe(`${typeName}: unknown ${t.tag} '__unknown__'`);
      expect(expectErr(parse('x'))).toBe(`${typeName}: payload must be an object`);
    });

    it.each(t.variants.map((v) => [v.name] as const))('变体专用解析器 %s 拒绝其他 tag', (name) => {
      const camel = name.split('-').map((s) => s[0]!.toUpperCase() + s.slice(1)).join('');
      const variantParse = directParser(typeName + camel);
      expect(expectErr(variantParse({ [t.tag]: name + '-other' }))).toBe(`${typeName}${camel}: ${t.tag} mismatch`);
      expect(expectErr(variantParse(null))).toBe(`${typeName}${camel}: payload must be an object`);
    });
  });

  it('事件内嵌套结构体的内部字段错误会冒泡为事件解析失败（fail-closed 不吞）', () => {
    const ev = REGISTRY.events.find((e) => e.type === 'message-start')!;
    const payload = eventPayload('message-start', ev.fields) as unknown as { message: Record<string, unknown> };
    delete payload.message['role'];
    expect(expectErr(parseEngineEvent(payload))).toBe("missing required field 'role'");
  });
});

describe('parseEngineEvent 入口防御', () => {
  it('非对象、缺 type、type 非字符串、未知 type 均返回 err 而不抛出', () => {
    expect(expectErr(parseEngineEvent(null))).toBe('engine event must be an object');
    expect(expectErr(parseEngineEvent([{ type: 'agent-start' }]))).toBe('engine event must be an object');
    expect(expectErr(parseEngineEvent({}))).toBe('engine event missing type');
    expect(expectErr(parseEngineEvent({ type: 5 }))).toBe('engine event missing type');
    expect(expectErr(parseEngineEvent({ type: 'no-such-event' }))).toBe("unknown engine event type 'no-such-event'");
  });

  it('单事件解析器拒绝其他事件 type（不会因字段恰好相同而误收）', () => {
    expect(expectErr(parser.parseEngineAgentStartEvent({ type: 'agent-end', sessionId: 's', timestamp: 't' }))).toBe(
      'EngineAgentStartEvent: type mismatch'
    );
  });

  it('ParseResult 守卫正反例', () => {
    const okR = parser.parseOk(1);
    const errR = parser.parseErr('boom');
    expect(parser.isParseOk(okR)).toBe(true);
    expect(parser.isParseErr(okR)).toBe(false);
    expect(parser.isParseOk(errR)).toBe(false);
    expect(parser.isParseErr(errR)).toBe(true);
    expect(errR).toEqual({ ok: false, error: 'boom' });
  });
});
