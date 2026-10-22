/**
 * 设备协议生成 parser ↔ 注册表契约测试（device-protocol.json 驱动）。
 *
 * drift.test.ts 锁的是「生成产物与注册表字节一致」；本文件锁的是生成出来的
 * 解析器在运行时的 fail-closed 行为：
 *   - 115 个 struct：全字段/仅必填字段合法样本被接受且保真；非对象被拒；
 *     逐字段缺失（必填）、类型错误、数组元素错误、integer 给小数均被拒；
 *   - 枚举解析器：注册表每个合法值都接受，大小写变体/非字符串被拒；
 *   - 103 个消息 kind：经 parseDeviceFrame 走「信封 → kind 分派 → body」全链路，
 *     remote.* 的 body.command 必须等于 kind 后缀（否则 mismatch）；
 *   - 信封：v≠1、未知 kind、非整数 ts、非法 Endpoint、缺 auth 等全部拒绝。
 * 样本全部由注册表推导，注册表新增类型/消息时自动纳入。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEVICE_KINDS } from './kinds';
import * as parser from './parser';
import type { ParseResult } from './parser';
import { parseDeviceEnvelope, parseDeviceFrame, parseDeviceMessage } from './parser';

interface RegistryField {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly integer?: boolean;
}
interface Registry {
  readonly messageCount: number;
  readonly messages: readonly { readonly kind: string; readonly rustVariant: string }[];
  readonly extensions: readonly { readonly kind: string }[];
  readonly types: Readonly<Record<string, { readonly kind: 'struct'; readonly fields: readonly RegistryField[] }>>;
  readonly enums: Readonly<Record<string, { readonly values: readonly string[] }>>;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../');
const REGISTRY = JSON.parse(
  readFileSync(join(ROOT, 'crates', 'conex-types', 'contracts', 'device-protocol.json'), 'utf8')
) as Registry;

type AnyParser = (v: unknown) => ParseResult<unknown>;
function parserFor(name: string): AnyParser {
  const fn = (parser as Record<string, unknown>)['parse' + name];
  expect(typeof fn, 'parse' + name).toBe('function');
  return fn as AnyParser;
}

function sampleOf(type: string, integer = false, onlyRequired = false): unknown {
  if (type.endsWith('[]')) return [sampleOf(type.slice(0, -2), integer, onlyRequired)];
  switch (type) {
    case 'string':
      return 'sample';
    case 'number':
      return integer ? 3 : 0.5;
    case 'boolean':
      return false;
    case 'JsonValue':
      return { k: ['v', 1, null] };
  }
  const en = REGISTRY.enums[type];
  if (en) return en.values[en.values.length - 1];
  const t = REGISTRY.types[type];
  if (!t) throw new Error(`registry type not handled by test: ${type}`);
  return objectOf(t.fields, onlyRequired);
}

function objectOf(fields: readonly RegistryField[], onlyRequired = false): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (onlyRequired && !f.required) continue;
    out[f.name] = sampleOf(f.type, f.integer === true, onlyRequired);
  }
  return out;
}

function wrongValueOf(type: string): unknown {
  if (type.endsWith('[]')) return { notAn: 'array' };
  switch (type) {
    case 'string':
      return true;
    case 'number':
      return '12';
    case 'boolean':
      return 0;
    case 'JsonValue':
      return { bad: Symbol('not-json') };
  }
  if (REGISTRY.enums[type]) return 'NOT_A_VARIANT';
  return 42;
}

function errorOf(r: ParseResult<unknown>): string {
  expect(r.ok).toBe(false);
  return r.ok ? '' : r.error;
}

describe('device struct 解析器 ↔ 注册表 types', () => {
  // DeviceEnvelope 有 v=1 / kind 白名单等额外语义，由下方「parseDeviceEnvelope 信封校验」专项覆盖
  const structs = Object.entries(REGISTRY.types).filter(([name]) => name !== 'DeviceEnvelope');
  it('DeviceEnvelope 之外的每个 struct 都存在同名解析器', () => {
    expect(structs.length).toBe(Object.keys(REGISTRY.types).length - 1);
  });
  describe.each(structs)('%s', (typeName, t) => {
    const parse = parserFor(typeName);

    it('全字段与仅必填字段样本都被接受且逐字段保真（未知字段丢弃）', () => {
      const full = objectOf(t.fields);
      expect(parse({ ...full, __extra: 1 })).toEqual({ ok: true, data: full });
      const minimal = objectOf(t.fields, true);
      expect(parse(minimal)).toEqual({ ok: true, data: minimal });
    });

    it('非对象（null/数组/字符串）被拒', () => {
      for (const bad of [null, [], 'x']) {
        expect(errorOf(parse(bad))).toBe(`${typeName}: payload must be an object`);
      }
    });

    if (t.fields.length > 0) {
      it.each(t.fields.map((f) => [f.name, f] as const))('字段 %s 的缺失/类型/数组元素/整数约束', (name, f) => {
        if (f.required) {
          const missing = objectOf(t.fields);
          delete missing[name];
          expect(errorOf(parse(missing))).toBe(`missing required field '${name}'`);
        } else {
          const absent = objectOf(t.fields);
          delete absent[name];
          const r = parse(absent);
          expect(r.ok && !(name in (r.data as object))).toBe(true);
        }
        const wrong = objectOf(t.fields);
        wrong[name] = wrongValueOf(f.type);
        expect(errorOf(parse(wrong)).length).toBeGreaterThan(0);
        if (f.type.endsWith('[]')) {
          const inner = f.type.slice(0, -2);
          const badItem = objectOf(t.fields);
          badItem[name] = [sampleOf(inner, f.integer === true), wrongValueOf(inner)];
          expect(errorOf(parse(badItem))).toMatch(/^array item 1: /);
        }
        if (f.integer === true) {
          const frac = objectOf(t.fields);
          frac[name] = f.type.endsWith('[]') ? [1.5] : 1.5;
          expect(errorOf(parse(frac))).toContain('expected an integer');
        }
      });
    }
  });
});

describe('device 枚举解析器 ↔ 注册表 enums', () => {
  it.each(Object.entries(REGISTRY.enums))('%s：全部合法值接受，非法值与非字符串拒绝', (enumName, en) => {
    const parse = parserFor(enumName);
    for (const value of en.values) expect(parse(value)).toEqual({ ok: true, data: value });
    expect(errorOf(parse(en.values[0]!.toUpperCase() + '_'))).toBe(`${enumName}: expected one of ${en.values.join(', ')}`);
    expect(errorOf(parse(null))).toContain(enumName);
    expect(errorOf(parse(1))).toContain(enumName);
  });
});

function envelope(kind: string, body: unknown): Record<string, unknown> {
  return {
    v: 1,
    kind,
    msgId: 'msg-00000001',
    ts: 1_700_000_000_000,
    from: 'mobile',
    to: 'desktop',
    auth: sampleOf('AuthHeader'),
    body,
  };
}

function bodyFor(kind: string, rustVariant: string): Record<string, unknown> {
  const body = objectOf(REGISTRY.types[rustVariant]!.fields);
  if (kind.startsWith('remote.')) body['command'] = kind.slice('remote.'.length);
  return body;
}

describe('parseDeviceFrame：消息 kind 全链路分派', () => {
  it('DEVICE_KINDS 与注册表 messages 一一对应（数量 = messageCount）', () => {
    expect([...DEVICE_KINDS]).toEqual(REGISTRY.messages.map((m) => m.kind));
    expect(DEVICE_KINDS).toHaveLength(REGISTRY.messageCount);
  });

  it.each(REGISTRY.messages.map((m) => [m.kind, m.rustVariant] as const))('%s（body=%s）合法帧被接受且 body 保真', (kind, variant) => {
    const body = bodyFor(kind, variant);
    const frame = envelope(kind, body);
    expect(parseDeviceFrame(frame)).toEqual({ ok: true, data: frame });
  });

  it.each(REGISTRY.messages.map((m) => [m.kind, m.rustVariant] as const))('%s：body 非对象被拒（错误不会被信封层吞掉）', (kind, variant) => {
    expect(errorOf(parseDeviceFrame(envelope(kind, 'not-an-object')))).toBe(`${variant}: payload must be an object`);
  });

  const remoteKinds = REGISTRY.messages.filter((m) => m.kind.startsWith('remote.')).map((m) => [m.kind] as const);
  it.each(remoteKinds)('%s：body.command 与 kind 后缀不符 → mismatch', (kind) => {
    const body = { command: 'someOtherCommand', params: {} };
    expect(errorOf(parseDeviceMessage(kind as (typeof DEVICE_KINDS)[number], body))).toBe(`${kind}: body.command mismatch`);
  });

  it('注册表扩展 kind（如 auth.rotate）不在 v1 路由表内：信封层按未知 kind 拒绝', () => {
    for (const ext of REGISTRY.extensions) {
      expect(errorOf(parseDeviceEnvelope(envelope(ext.kind, {})))).toBe(`device envelope unknown kind '${ext.kind}'`);
    }
  });

  it('parseDeviceMessage 对运行时伪造的未知 kind 返回 err 而非抛出', () => {
    expect(errorOf(parseDeviceMessage('bogus.kind' as (typeof DEVICE_KINDS)[number], {}))).toBe("unknown device kind 'bogus.kind'");
  });
});

describe('parseDeviceEnvelope 信封校验', () => {
  const good = () => envelope('heartbeat', objectOf(REGISTRY.types['Heartbeat']!.fields));

  it('合法信封被接受', () => {
    expect(parseDeviceEnvelope(good())).toEqual({ ok: true, data: good() });
  });

  it('非对象被拒', () => {
    expect(errorOf(parseDeviceEnvelope(null))).toBe('device envelope must be an object');
    expect(errorOf(parseDeviceEnvelope([good()]))).toBe('device envelope must be an object');
  });

  it('协议版本：v 必须是整数 1（0/2/1.5/"1" 均拒绝）', () => {
    expect(errorOf(parseDeviceEnvelope({ ...good(), v: 2 }))).toBe('device envelope unsupported protocol version 2');
    expect(errorOf(parseDeviceEnvelope({ ...good(), v: 0 }))).toBe('device envelope unsupported protocol version 0');
    expect(errorOf(parseDeviceEnvelope({ ...good(), v: 1.5 }))).toBe('expected an integer');
    expect(errorOf(parseDeviceEnvelope({ ...good(), v: '1' }))).toBe('expected an integer');
  });

  it.each(['v', 'kind', 'msgId', 'ts', 'from', 'to', 'auth', 'body'])('缺少 %s 被拒', (key) => {
    const e: Record<string, unknown> = good();
    delete e[key];
    expect(errorOf(parseDeviceEnvelope(e))).toBe(`missing required field '${key}'`);
  });

  it('字段类型/取值错误被拒', () => {
    expect(errorOf(parseDeviceEnvelope({ ...good(), kind: 7 }))).toBe('expected a string');
    expect(errorOf(parseDeviceEnvelope({ ...good(), kind: 'HEARTBEAT' }))).toBe("device envelope unknown kind 'HEARTBEAT'");
    expect(errorOf(parseDeviceEnvelope({ ...good(), ts: 1.25 }))).toBe('expected an integer');
    expect(errorOf(parseDeviceEnvelope({ ...good(), from: 'server' }))).toContain('Endpoint');
    expect(errorOf(parseDeviceEnvelope({ ...good(), to: null }))).toContain('Endpoint');
    expect(errorOf(parseDeviceEnvelope({ ...good(), auth: 'token' }))).toBe('AuthHeader: payload must be an object');
    expect(errorOf(parseDeviceEnvelope({ ...good(), body: { f: () => 0 } }))).toBe('expected a JSON value');
  });

  it('深层嵌套 body 返回 nesting too deep 而不是栈溢出', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 400; i++) deep = [deep];
    expect(errorOf(parseDeviceEnvelope({ ...good(), body: deep }))).toBe('nesting too deep');
  });
});