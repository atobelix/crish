/**
 * IME 矩阵契约测试（Round8 · 可执行化子集）
 *
 * 映射文档：`docs/block-workspace-architecture/plans/specs/ime-matrix.md`
 * 常量：`IME_MATRIX_CELLS`
 *
 * 覆盖 **可自动化语义**（不依赖真实 OS IME / WebView）：
 * - **A-IME-01**：长句合成不丢字；compositionend value 优先；提交后 idle
 * - **A-IME-02**：合成中结构键 / slash / 结构 op 拒绝；合成提交后 idle 并放行
 *
 * WebView 端 e2e 必测格后置 **W6-B**，本文件不得被当作 L2 关闭证据。
 */
import { describe, expect, it } from 'vitest';
import { ImeMachine } from './ImeMachine';
import {
  IME_MATRIX_CELLS,
  IME_MATRIX_STATUS_GLYPH,
  imeMatrixCellsFor,
  imeMatrixL1Ready,
  imeMatrixOpenRequiredCells,
  imeMatrixStatusGlyph,
} from './imeMatrix';
import type { GuardableIntent } from './structureKeyGuard';

const LONG_PREVIEW =
  '这是一句很长的中文合成预览候选内容用于验证多码点与标点，。！？「」' +
  'あいうえお漢字カタカナ' +
  '한글테스트긴문장' +
  '0123456789'.repeat(20);

const LONG_FINAL = LONG_PREVIEW + '——最终提交全文，value 优先不得丢字。';

const structureOp: GuardableIntent = {
  type: 'op',
  ops: [{ kind: 'split_block' }],
  intentId: 'mat-op-1',
};

const slash: GuardableIntent = {
  type: 'request_slash',
  blockId: 'b-ime-01',
  offset: 0,
  intentId: 'mat-slash-1',
};

const structureKey: GuardableIntent = {
  type: 'structure_key',
  kind: 'split_block',
  blockId: 'b-ime-01',
  intentId: 'mat-key-1',
};

const textEdit: GuardableIntent = {
  type: 'text_edit',
  blockId: 'b-ime-01',
  range: [0, 0],
  insert: 'x',
  intentId: 'mat-text-1',
};

// ---------------------------------------------------------------------------
// 矩阵常量自洽（L0 成型）
// ---------------------------------------------------------------------------

describe('IME matrix · L0 常量成型', () => {
  it('IME_MATRIX_CELLS 为 8×3=24 格且 ID 齐全', () => {
    expect(IME_MATRIX_CELLS).toHaveLength(24);
    const ids = new Set(IME_MATRIX_CELLS.map((c) => c.id));
    expect(ids).toEqual(
      new Set([
        'A-IME-01',
        'A-IME-02',
        'A-IME-03',
        'A-IME-04',
        'A-IME-05',
        'A-IME-06',
        'A-IME-07',
        'A-IME-08',
      ])
    );
    const platforms = new Set(IME_MATRIX_CELLS.map((c) => c.platform));
    expect(platforms).toEqual(
      new Set(['win_webview2', 'macos_wk', 'linux_webkit'])
    );
  });

  it('A-IME-01/02 三端均为 automated（🟨自动化）；其余 open', () => {
    for (const cell of imeMatrixCellsFor('A-IME-01')) {
      expect(cell.status).toBe('automated');
      expect(imeMatrixStatusGlyph(cell.status)).toBe('🟨自动化');
    }
    for (const cell of imeMatrixCellsFor('A-IME-02')) {
      expect(cell.status).toBe('automated');
      expect(cell.automationRefs?.length).toBeGreaterThan(0);
    }
    for (const cell of IME_MATRIX_CELLS) {
      if (cell.id === 'A-IME-01' || cell.id === 'A-IME-02') continue;
      expect(cell.status).toBe('open');
      expect(IME_MATRIX_STATUS_GLYPH.open).toBe('☐');
    }
    expect(imeMatrixL1Ready()).toBe(true);
    // 必测未 e2e 的格仍存在 → L2 未关
    expect(imeMatrixOpenRequiredCells().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// A-IME-01 长句合成不丢字 / value 优先 / end → idle
// ---------------------------------------------------------------------------

describe('IME matrix · A-IME-01 长句合成不丢字', () => {
  it('A-IME-01: 长 preview 多次 update 后 end(final) committedText 等于 final（value 优先）', () => {
    const ime = new ImeMachine();
    const start = ime.startComposition('block-long');
    expect(start.ok).toBe(true);

    // 模拟多帧 compositionupdate（长句分段）
    const chunks = [
      LONG_PREVIEW.slice(0, 20),
      LONG_PREVIEW.slice(0, 80),
      LONG_PREVIEW,
    ];
    for (const c of chunks) {
      ime.updateComposition(c);
      expect(ime.isComposing()).toBe(true);
      expect(ime.getSnapshot().preview).toBe(c);
    }

    const end = ime.endComposition(LONG_FINAL);
    expect(end.committedText).toBe(LONG_FINAL);
    expect(end.committedText.length).toBe(LONG_FINAL.length);
    expect(end.committedText).not.toBe(LONG_PREVIEW);
    expect(end.blockId).toBe('block-long');
    expect(end.groupId).toMatch(/^ime-g-/);

    // 提交后 idle、不丢会话关联键已返回、状态清空
    expect(ime.isComposing()).toBe(false);
    expect(ime.getSnapshot().phase).toBe('idle');
    expect(ime.getComposingBlockId()).toBeNull();
    expect(ime.getSnapshot().preview).toBe('');
    expect(ime.getSnapshot().groupId).toBeNull();
  });

  it('A-IME-01: end 省略 final 时用 preview；空闲 end 不污染', () => {
    const ime = new ImeMachine();
    ime.startComposition('b-prev');
    ime.updateComposition(LONG_PREVIEW);
    const end = ime.endComposition();
    expect(end.committedText).toBe(LONG_PREVIEW);
    expect(ime.getSnapshot().phase).toBe('idle');

    const idleEnd = ime.endComposition('should-not-apply');
    expect(idleEnd.committedText).toBe('');
    expect(idleEnd.blockId).toBeNull();
    expect(ime.getSnapshot().phase).toBe('idle');
  });

  it('A-IME-01: 一次合成一个 groupId；再次 start 新 group', () => {
    const ime = new ImeMachine();
    ime.startComposition('b1');
    const g1 = ime.getSnapshot().groupId;
    const e1 = ime.endComposition('甲');
    expect(e1.groupId).toBe(g1);
    expect(e1.committedText).toBe('甲');

    ime.startComposition('b1');
    const g2 = ime.getSnapshot().groupId;
    expect(g2).toBeTruthy();
    expect(g2).not.toBe(g1);
    const e2 = ime.endComposition('乙');
    expect(e2.committedText).toBe('乙');
    expect(ime.isComposing()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A-IME-02 合成中无 slash / 结构键；end 后 idle 放行
// ---------------------------------------------------------------------------

describe('IME matrix · A-IME-02 合成中无 slash/结构键', () => {
  it('A-IME-02: composing 时 structure_key / op / request_slash 全部拒绝', () => {
    const ime = new ImeMachine();
    ime.startComposition('b-ime-01');
    expect(ime.isComposing()).toBe(true);

    const rOp = ime.tryAcceptIntent(structureOp);
    expect(rOp.ok).toBe(false);
    if (!rOp.ok) {
      expect(rOp.code).toBe('composing_structure_op');
      expect(rOp.reason).toMatch(/A-IME-02|composing|IME/i);
    }

    const rKey = ime.tryAcceptIntent(structureKey);
    expect(rKey.ok).toBe(false);
    if (!rKey.ok) {
      expect(rKey.code).toBe('composing_structure_key');
    }

    const rSlash = ime.tryAcceptIntent(slash);
    expect(rSlash.ok).toBe(false);
    if (!rSlash.ok) {
      expect(rSlash.code).toBe('composing_slash');
    }

    // text_edit 守卫放行（缓冲路径；真实 commit 在 end）
    expect(ime.tryAcceptIntent(textEdit).ok).toBe(true);
  });

  it('A-IME-02: 合成提交后 idle，结构键与 slash 放行', () => {
    const ime = new ImeMachine();
    ime.startComposition('b-ime-01');
    expect(ime.tryAcceptIntent(slash).ok).toBe(false);

    const end = ime.endComposition('提交');
    expect(end.committedText).toBe('提交');
    expect(ime.isComposing()).toBe(false);
    expect(ime.getSnapshot().phase).toBe('idle');

    expect(ime.tryAcceptIntent(structureOp).ok).toBe(true);
    expect(ime.tryAcceptIntent(structureKey).ok).toBe(true);
    expect(ime.tryAcceptIntent(slash).ok).toBe(true);
  });

  it('A-IME-02: filterIntents composing 剔除结构，保留 text_edit', () => {
    const ime = new ImeMachine();
    ime.startComposition('b-ime-01');
    const { allowed, rejected } = ime.filterIntents([
      textEdit,
      structureOp,
      slash,
      structureKey,
    ]);
    expect(allowed).toEqual([textEdit]);
    expect(rejected).toHaveLength(3);
    expect(rejected.map((r) => r.code).sort()).toEqual(
      [
        'composing_slash',
        'composing_structure_key',
        'composing_structure_op',
      ].sort()
    );

    ime.endComposition('ok');
    const after = ime.filterIntents([textEdit, structureOp, slash]);
    expect(after.rejected).toHaveLength(0);
    expect(after.allowed).toHaveLength(3);
  });
});
