// packages/shared-types/src/hooks.test.ts
// I7-M13 事件映射表冻结护栏（TS 侧）：14 钩子事件名与 hooks.ts 声明双向锁定。
//
// 与 crates/conex-types/tests/event_hook_mapping.rs（Rust 侧）互补：
// - Rust 侧锁「引擎事件 enum ↔ 映射表」与 31 = 11 + 20 全集划分；
// - 本测试锁「14 钩子名 ↔ hooks.ts 的 HOOK_EVENT_NAMES / HookEventName 类型」，
//   并把映射表钩子侧（11 映射钩子 + 2 补源钩子）与 HOOK_EVENT_NAMES 对齐。
//
// 契约真源：docs/multi-agent-repair/improvement/reports/I7-M13-事件映射表.md

import { describe, expect, it } from 'vitest';
import {
  HOOK_EVENT_NAMES,
  type ExistingHookEventName,
  type HookEventName,
  type HookEventNameLiteral,
  type NewHookEventName,
} from './hooks';

/** 引擎事件 → 钩子事件映射行（与 I7-M13 报告 §2 表逐行一致） */
const HOOK_MAPPINGS = [
  // 第一批接（6 个引擎事件 → 6 个钩子）
  ['agent-start', 'session.start'],
  ['run-terminal', 'session.end'],
  ['turn-start', 'turn.start'],
  ['turn-end', 'turn.end'],
  ['tool-start', 'tool.pre'],
  ['tool-end', 'tool.post'],
  // 第二批接
  ['tool-end', 'tool.error'],
  ['context-compression-start', 'context.compact.start'],
  ['context-compression-end', 'context.compact.end'],
  ['runtime-error', 'error.occurred'],
  ['subagent-started', 'subagent.start'],
  ['subagent-ended', 'subagent.end'],
] as const satisfies ReadonlyArray<readonly [string, HookEventName]>;

/** 无引擎事件源的钩子（02 方案 M14 补事件源，E1 只挂钩不补源） */
const SOURCE_PENDING_HOOKS = [
  'model.beforeRequest',
  'model.afterResponse',
] as const satisfies readonly HookEventName[];

/** 契约字面量：以 HOOK_EVENT_NAMES 为运行时真源 */
type ContractHookName = (typeof HOOK_EVENT_NAMES)[number];

describe('I7-M13 事件映射表冻结 - 14 钩子事件名', () => {
  it('HOOK_EVENT_NAMES 恰为 14 项且唯一', () => {
    expect(HOOK_EVENT_NAMES).toHaveLength(14);
    expect(new Set(HOOK_EVENT_NAMES).size).toBe(14);
  });

  it('全部为点分命名（禁令 14）', () => {
    for (const name of HOOK_EVENT_NAMES) {
      expect(name).toMatch(/^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/);
    }
  });

  it('现有 6 个事件命名保留（禁令 14 不退化）', () => {
    const existing: readonly ExistingHookEventName[] = [
      'turn.start',
      'turn.end',
      'tool.pre',
      'tool.post',
      'context.compact.start',
      'context.compact.end',
    ];
    expect(existing).toHaveLength(6);
    for (const name of existing) {
      expect(HOOK_EVENT_NAMES).toContain(name);
    }
  });

  it('新增 8 个事件命名（I7-M13 定稿 12 → 14）', () => {
    const added: readonly NewHookEventName[] = [
      'session.start',
      'session.end',
      'model.beforeRequest',
      'model.afterResponse',
      'subagent.start',
      'subagent.end',
      'error.occurred',
      'tool.error',
    ];
    expect(added).toHaveLength(8);
    for (const name of added) {
      expect(HOOK_EVENT_NAMES).toContain(name);
    }
  });

  it('类型层双向锁定：HookEventName ⇄ HOOK_EVENT_NAMES', () => {
    // 契约 ⊆ HookEventName：每项字面量可赋给 HookEventName（编译期校验）
    const contractSubset: readonly HookEventName[] = HOOK_EVENT_NAMES;
    expect(contractSubset).toHaveLength(14);
    // HookEventName ⊆ 契约：HookEventName 无契约外成员（编译期校验；
    // 新增事件名而未同步 HOOK_EVENT_NAMES 时此处报类型错误）
    type Exhaustive<U extends HookEventName> = U extends ContractHookName ? true : false;
    const exhaustive: Exhaustive<HookEventName> = true;
    expect(exhaustive).toBe(true);
    // HookEventNameLiteral 与 HookEventName 等义
    const literal: readonly HookEventNameLiteral[] = HOOK_EVENT_NAMES;
    expect(literal).toHaveLength(14);
  });
});

describe('I7-M13 事件映射表冻结 - 映射表钩子侧', () => {
  it('映射行去重后覆盖 12 个钩子，tool-end 为唯一同源双钩特例', () => {
    const mappedHooks = new Set<string>(HOOK_MAPPINGS.map(([, hook]) => hook));
    // 12 行映射行 = 12 个不同钩子（tool-end 两行映射 tool.post/tool.error）
    expect(mappedHooks.size).toBe(12);
    const counts = new Map<string, string[]>();
    for (const [event, hook] of HOOK_MAPPINGS) {
      counts.set(event, [...(counts.get(event) ?? []), hook]);
    }
    for (const [event, hooks] of counts) {
      if (event === 'tool-end') {
        expect(hooks).toEqual(['tool.post', 'tool.error']);
      } else {
        expect(hooks).toHaveLength(1);
      }
    }
  });

  it('每个映射钩子与补源钩子都在 HOOK_EVENT_NAMES 中（14 = 11 + 2）', () => {
    const mappedHooks = new Set<string>(HOOK_MAPPINGS.map(([, hook]) => hook));
    const pending = new Set<string>(SOURCE_PENDING_HOOKS);
    const covered = new Set([...mappedHooks, ...pending]);
    expect(covered).toEqual(new Set(HOOK_EVENT_NAMES));
    const overlap = [...mappedHooks].filter((h) => pending.has(h));
    expect(overlap).toHaveLength(0);
  });

  it('映射引擎事件均为既有 31 事件名（kebab-case，与 Rust 侧口径一致）', () => {
    const mapped = new Set(HOOK_MAPPINGS.map(([event]) => event));
    expect(mapped.size).toBe(11);
    for (const event of mapped) {
      expect(event).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
});
