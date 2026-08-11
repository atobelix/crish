/**
 * ImeMachine + structureKeyGuard：
 * - composition 中 reject 结构 op / slash
 * - composition 中 unmount focus → 违规
 * - end composition 后允许
 *
 * 矩阵契约子集见 ime-matrix.contract.test.ts（A-IME-01 / A-IME-02）。
 */
import { describe, expect, it } from 'vitest';
import { PinViolationError } from '../viewport/pin';
import { ImeMachine } from './ImeMachine';
import {
  filterStructureIntents,
  guardStructureIntent,
  isStructureOrSlashIntent,
  type GuardableIntent,
} from './structureKeyGuard';

describe('IME ImeMachine 生命周期', () => {
  it('start → update → end 回到 idle', () => {
    const ime = new ImeMachine();
    expect(ime.isComposing()).toBe(false);

    const start = ime.startComposition('block-a');
    expect(start.ok).toBe(true);
    expect(ime.isComposing()).toBe(true);
    expect(ime.getComposingBlockId()).toBe('block-a');
    expect(ime.getSnapshot().groupId).toMatch(/^ime-g-/);

    ime.updateComposition('你好');
    expect(ime.getSnapshot().preview).toBe('你好');

    const end = ime.endComposition('你好世界');
    expect(end.committedText).toBe('你好世界');
    expect(end.blockId).toBe('block-a');
    expect(end.groupId).toBeTruthy();
    expect(ime.isComposing()).toBe(false);
    expect(ime.getComposingBlockId()).toBeNull();
    expect(ime.getSnapshot().phase).toBe('idle');
  });

  it('重复 start 拒绝', () => {
    const ime = new ImeMachine();
    expect(ime.startComposition('a').ok).toBe(true);
    const again = ime.startComposition('b');
    expect(again.ok).toBe(false);
  });

  it('空 blockId 拒绝', () => {
    const ime = new ImeMachine();
    expect(ime.startComposition('').ok).toBe(false);
  });
});

describe('IME composing 中 reject 结构 op / slash（A-IME-02）', () => {
  const structureOp: GuardableIntent = {
    type: 'op',
    ops: [{ kind: 'split_block' }],
    intentId: 'i-op-1',
  };
  const slash: GuardableIntent = {
    type: 'request_slash',
    blockId: 'b1',
    offset: 0,
    intentId: 'i-slash',
  };
  const structureKey: GuardableIntent = {
    type: 'structure_key',
    kind: 'split_block',
    blockId: 'b1',
  };
  const textEdit: GuardableIntent = {
    type: 'text_edit',
    blockId: 'b1',
    range: [0, 0],
    insert: 'x',
    intentId: 'i-text',
  };

  it('isStructureOrSlashIntent 分类正确', () => {
    expect(isStructureOrSlashIntent(structureOp)).toBe(true);
    expect(isStructureOrSlashIntent(slash)).toBe(true);
    expect(isStructureOrSlashIntent(structureKey)).toBe(true);
    expect(isStructureOrSlashIntent(textEdit)).toBe(false);
  });

  it('composition 中 tryAcceptIntent reject 结构 op', () => {
    const ime = new ImeMachine();
    ime.startComposition('b1');

    const rOp = ime.tryAcceptIntent(structureOp);
    expect(rOp.ok).toBe(false);
    if (!rOp.ok) {
      expect(rOp.code).toBe('composing_structure_op');
    }

    const rSlash = ime.tryAcceptIntent(slash);
    expect(rSlash.ok).toBe(false);
    if (!rSlash.ok) {
      expect(rSlash.code).toBe('composing_slash');
    }

    const rKey = ime.tryAcceptIntent(structureKey);
    expect(rKey.ok).toBe(false);
    if (!rKey.ok) {
      expect(rKey.code).toBe('composing_structure_key');
    }

    // text_edit 仍放行（合成缓冲路径；真实 commit 在 end 后）
    expect(ime.tryAcceptIntent(textEdit).ok).toBe(true);
  });

  it('filterStructureIntents composing 剔除结构', () => {
    const { allowed, rejected } = filterStructureIntents(true, [
      textEdit,
      structureOp,
      slash,
    ]);
    expect(allowed).toEqual([textEdit]);
    expect(rejected).toHaveLength(2);
  });

  it('Idle 时结构意图放行', () => {
    expect(guardStructureIntent(false, structureOp).ok).toBe(true);
    expect(guardStructureIntent(false, slash).ok).toBe(true);
  });
});

describe('IME composing 中 unmount focus → 违规', () => {
  it('assertUnmount 焦点块抛 PinViolationError', () => {
    const ime = new ImeMachine();
    ime.startComposition('focus-1');
    // 焦点与 composing 同块
    expect(() => ime.assertUnmount('focus-1', { focusId: 'focus-1' })).toThrow(
      PinViolationError
    );

    const r = ime.checkUnmount('focus-1', { focusId: 'focus-1' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // unmount_focus 优先于 unmount_composing
      expect(r.code === 'unmount_focus' || r.code === 'unmount_composing').toBe(
        true
      );
    }
  });

  it('composing 块进入 pin 集合', () => {
    const ime = new ImeMachine();
    ime.startComposition('comp-x');
    const pinned = ime.buildPinned('focus-y');
    expect(pinned.has('comp-x')).toBe(true);
    expect(pinned.has('focus-y')).toBe(true);
    expect(ime.ensureComposingInPin(pinned).ok).toBe(true);
  });

  it('composing 未 pin 的外部快照 → ensure 失败', () => {
    const ime = new ImeMachine();
    ime.startComposition('comp-x');
    const r = ime.ensureComposingInPin(new Set(['other']));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('composing_not_pinned');
    }
  });
});

describe('IME end composition 后允许结构 op 与 unmount', () => {
  it('end 后结构 op 放行', () => {
    const ime = new ImeMachine();
    ime.startComposition('b1');
    const reject = ime.tryAcceptIntent({
      type: 'op',
      ops: [{ kind: 'split_block' }],
      intentId: 'x',
    });
    expect(reject.ok).toBe(false);

    ime.endComposition('完');
    const allow = ime.tryAcceptIntent({
      type: 'op',
      ops: [{ kind: 'split_block' }],
      intentId: 'y',
    });
    expect(allow.ok).toBe(true);
  });

  it('end 后非 pin 块允许卸载', () => {
    const ime = new ImeMachine();
    ime.startComposition('b1');
    expect(ime.checkUnmount('b1', { focusId: 'b1' }).ok).toBe(false);

    ime.endComposition();
    // 无 composing、无 focus → 任意块可卸
    expect(ime.checkUnmount('b1', { focusId: null }).ok).toBe(true);
    // 仍有焦点时焦点块不可卸，其它可卸
    expect(ime.checkUnmount('other', { focusId: 'b1' }).ok).toBe(true);
  });

  it('end 后 slash 放行', () => {
    const ime = new ImeMachine();
    ime.startComposition('b1');
    expect(
      ime.tryAcceptIntent({
        type: 'request_slash',
        blockId: 'b1',
        offset: 0,
      }).ok
    ).toBe(false);
    ime.endComposition();
    expect(
      ime.tryAcceptIntent({
        type: 'request_slash',
        blockId: 'b1',
        offset: 0,
      }).ok
    ).toBe(true);
  });
});
