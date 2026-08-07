/**
 * 生成 parser 对抗性单测（T3.7 D7 / F8-01 / F8-41）——递归深度守卫。
 *
 * 缺陷（R2 §7 实测确认）：checkJsonValue 递归无深度上限（parser.ts:56-80），
 * 深层嵌套载荷抛 RangeError 逃逸 ParseResult，破坏 fail-closed 契约——
 * 实测 300 层嵌套仍正常返回 ok，5000 层即 "Maximum call stack size exceeded"。
 *
 * 修复契约：深度超过 256 返回 parseErr("nesting too deep")，不抛异常。
 *
 * 注：checkJsonValue / parseArrayOf 为生成器 PARSER_PREAMBLE 内部函数（未导出），
 * 以 parseEngineEvent 为唯一测试入口（AU-02 §T3.7 执行细节，不为测试暴露内部函数）。
 */
import { describe, expect, it } from 'vitest';
import { parseEngineEvent } from './parser';

/** 构造 depth 层「数组套数组」嵌套载荷（叶值 'leaf'，迭代构造无递归） */
function nestedArray(depth: number): unknown {
  let v: unknown = 'leaf';
  for (let i = 0; i < depth; i++) v = [v];
  return v;
}

/** 构造 depth 层「对象套对象」嵌套载荷（{ a: { a: ... { leaf: true } } }） */
function nestedObject(depth: number): unknown {
  let v: unknown = { leaf: true };
  for (let i = 0; i < depth; i++) v = { a: v };
  return v;
}

/** 携带 JsonValue 字段（tool-call block 的 input）的 message-delta 载荷 */
function messageDeltaWithInput(input: unknown): Record<string, unknown> {
  return {
    type: 'message-delta',
    sessionId: 's1',
    timestamp: 't1',
    messageId: 'm1',
    block: { type: 'tool-call', id: 'tc-1', toolName: 'shell_command', input },
  };
}

/** 断言：解析不抛异常（异常逃逸即红）且返回 ok:false、错误含关键字 */
function expectParseErrNoThrow(
  payload: Record<string, unknown>,
  keyword: string
): void {
  let thrown: unknown = null;
  let result: { ok: boolean; error?: string } | null = null;
  try {
    result = parseEngineEvent(payload);
  } catch (e) {
    thrown = e;
  }
  // 修复前深层载荷抛 RangeError（栈溢出），此断言红
  expect(thrown).toBeNull();
  expect(result).not.toBeNull();
  expect(result!.ok).toBe(false);
  expect(result!.ok === false ? result!.error : '').toContain(keyword);
}

describe('生成 parser 深度守卫（T3.7 D7）', () => {
  it('deeply_nested_array_payload_returns_parse_err_not_throw：300 层数组嵌套返回解析错误而非通过', () => {
    expectParseErrNoThrow(
      messageDeltaWithInput(nestedArray(300)),
      'nesting too deep'
    );
  });

  it('deeply_nested_object_payload_returns_parse_err_not_throw：300 层对象嵌套同契约', () => {
    expectParseErrNoThrow(
      messageDeltaWithInput(nestedObject(300)),
      'nesting too deep'
    );
  });

  it('extreme_depth_payload_does_not_stack_overflow：5000 层不栈溢出（修复前实测 RangeError）', () => {
    expectParseErrNoThrow(
      messageDeltaWithInput(nestedArray(5000)),
      'nesting too deep'
    );
  });

  it('normal_depth_payload_still_parses：常规 10 层 tool_call input 仍 parseOk（256 上限不误伤）', () => {
    const r = parseEngineEvent(messageDeltaWithInput(nestedObject(10)));
    expect(r.ok).toBe(true);
  });
});
