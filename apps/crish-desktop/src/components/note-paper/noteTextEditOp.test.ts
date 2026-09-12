/**
 * noteTextEditOp 穷举单测（audit-repair-202609 · T8）。
 * 覆盖：无变化、纯插入、纯删除、中段替换、全量替换、空↔非空、
 * 重复字符歧义、CJK、emoji（代理对 / 多码点字素）、双侧共缀。
 */
import { describe, expect, it } from 'vitest';
import { computeTextEditOp } from './noteTextEditOp';

describe('computeTextEditOp', () => {
  it('identical_text_returns_null', () => {
    expect(computeTextEditOp('b1', 'abc', 'abc')).toBeNull();
    expect(computeTextEditOp('b1', '', '')).toBeNull();
  });

  it('empty_to_text_is_pure_insert_at_0', () => {
    expect(computeTextEditOp('b1', '', 'hello')).toEqual({
      op: 'text_edit',
      id: 'b1',
      start: 0,
      end: 0,
      insert: 'hello',
    });
  });

  it('text_to_empty_is_pure_delete', () => {
    expect(computeTextEditOp('b1', 'hello', '')).toEqual({
      op: 'text_edit',
      id: 'b1',
      start: 0,
      end: 5,
      insert: '',
    });
  });

  it('append_at_tail', () => {
    expect(computeTextEditOp('b1', 'abc', 'abcxyz')).toEqual({
      op: 'text_edit',
      id: 'b1',
      start: 3,
      end: 3,
      insert: 'xyz',
    });
  });

  it('prepend_at_head', () => {
    expect(computeTextEditOp('b1', 'abc', 'xyzabc')).toEqual({
      op: 'text_edit',
      id: 'b1',
      start: 0,
      end: 0,
      insert: 'xyz',
    });
  });

  it('replace_middle_segment', () => {
    // 'abc' → 'aXbc'：prefix=1，suffix=2（尾部 'bc' 对齐），等价于位置 1 处
    // 纯插入 'X'——比替换 'b' 更小的单 op 表示
    expect(computeTextEditOp('b1', 'abc', 'aXbc')).toEqual({
      op: 'text_edit',
      id: 'b1',
      start: 1,
      end: 1,
      insert: 'X',
    });
  });

  it('full_replace_when_no_common_affix', () => {
    expect(computeTextEditOp('b1', '初始正文', '修改后的正文内容')).toEqual({
      op: 'text_edit',
      id: 'b1',
      start: 0,
      end: 4,
      insert: '修改后的正文内容',
    });
  });

  it('repeated_characters_take_valid_split', () => {
    // 'aaa' → 'aaaa'：prefix 吃满 3，suffix 为 0，等价于尾部插入 'a'
    expect(computeTextEditOp('b1', 'aaa', 'aaaa')).toEqual({
      op: 'text_edit',
      id: 'b1',
      start: 3,
      end: 3,
      insert: 'a',
    });
    // 'aaaa' → 'aaa'：等价于尾部删除 1 个标量
    expect(computeTextEditOp('b1', 'aaaa', 'aaa')).toEqual({
      op: 'text_edit',
      id: 'b1',
      start: 3,
      end: 4,
      insert: '',
    });
  });

  it('cjk_offsets_count_code_points_not_utf16_units', () => {
    // 全部 CJK：UTF-16 长度 = 码点数，此处验证区间语义
    expect(computeTextEditOp('b1', '你好世界', '你好，世界')).toEqual({
      op: 'text_edit',
      id: 'b1',
      start: 2,
      end: 2,
      insert: '，',
    });
  });

  it('surrogate_pairs_are_single_scalars', () => {
    // 4 字节字符为 2 个 UTF-16 码元、1 个 Unicode 标量：偏移必须按标量计
    const scalarChar = '\u{1F44D}';
    expect(computeTextEditOp('b1', scalarChar, `${scalarChar}!`)).toEqual({
      op: 'text_edit',
      id: 'b1',
      start: 1,
      end: 1,
      insert: '!',
    });
    // 删除 4 字节字符：end - start = 1（而非 UTF-16 的 2）
    expect(computeTextEditOp('b1', `a${scalarChar}b`, 'ab')).toEqual({
      op: 'text_edit',
      id: 'b1',
      start: 1,
      end: 2,
      insert: '',
    });
  });

  it('shared_affix_on_both_sides_minimizes_replacement', () => {
    // 'common-head TAIL-tail' → 'common-head TAIL2-tail'：
    // prefix=16（'common-head TAIL'），suffix=5（'-tail'），
    // 等价于位置 16 处纯插入 '2'
    const result = computeTextEditOp(
      'b1',
      'common-head TAIL-tail',
      'common-head TAIL2-tail'
    );
    expect(result).toEqual({
      op: 'text_edit',
      id: 'b1',
      start: 16,
      end: 16,
      insert: '2',
    });
  });

  it('roundtrip_apply_reproduces_new_text', () => {
    // 正逆向对称：old + op 应用结果 === newText
    const cases: Array<[string, string]> = [
      ['abc', 'aXbc'],
      ['hello world', 'hello brave world'],
      ['你好世界', '你好'],
      ['', 'seed'],
      ['seed', ''],
      ['\u{1F44D}\u{1F3FB}混合text', '\u{1F44D}\u{1F3FB}混合text!'],
    ];
    for (const [oldText, newText] of cases) {
      const op = computeTextEditOp('b1', oldText, newText);
      if (op === null) {
        expect(oldText).toBe(newText);
        continue;
      }
      const oldPts = Array.from(oldText);
      const applied =
        oldPts.slice(0, op.start).join('') +
        op.insert +
        oldPts.slice(op.end).join('');
      expect(applied).toBe(newText);
    }
  });
});
