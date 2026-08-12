/**
 * IME 矩阵契约测试（Round8 + Round9 + **W6-B-S** Skeleton · 可执行化子集）
 *
 * 映射文档：`docs/block-workspace-architecture/plans/specs/ime-matrix.md`
 * 常量：`IME_MATRIX_CELLS` / `IME_MATRIX_PACKAGE_TRACK`
 *
 * ## 包轨（强制）
 * - 本文件 = **W6-B-S**（L0/L1/L1+ 自动化与矩阵契约加深）
 * - **≠ W6-B** Strict：不得用本文件绿灯关闭 WebView L2 必测格
 * - **≠ 叶子核锁定门禁**：`imeMatrixLeafCoreLockEligible()` 在本轨应 false
 * - **≠ EL**：不关闭任何 EL（表 E 仍开；IME 锁定仅认 W6-B）
 *
 * 覆盖 **可自动化语义**（不依赖真实 OS IME / WebView）：
 * - **A-IME-01**：长句合成不丢字；compositionend value 优先；提交后 idle
 * - **A-IME-02**：合成中结构键 / slash / 结构 op 拒绝；合成提交后 idle 并放行
 * - **A-IME-03**：合成中滚动 pin；planScrollUnmount 不卸 composing/焦点
 * - **A-IME-04**：点另一块钉死 end_then_switch（先 end 再切）
 * - **A-IME-05**：多次 update 仅 end 产生一条 commit 边界（groupId）
 * - **W6-B-S 加深**：composing 边界（idle update / 空 final / 全结构键种）+
 *   状态迁移 + 矩阵格抽样（必测/抽样 · 端 · L1+ · 无 e2e）
 *
 * WebView 端 e2e 必测格后置 **W6-B**，本文件不得被当作 L2 / 叶子核 / EL 关闭证据。
 */
import { describe, expect, it } from 'vitest';
import { buildPinSet, planScrollUnmount } from '../viewport/pin';
import { IME_FOCUS_SWITCH_STRATEGY, ImeMachine } from './ImeMachine';
import {
  IME_MATRIX_ASSERTS,
  IME_MATRIX_CELLS,
  IME_MATRIX_PACKAGE_TRACK,
  IME_MATRIX_STATUS_GLYPH,
  imeMatrixAnyE2e,
  imeMatrixCellsByStatus,
  imeMatrixCellsFor,
  imeMatrixCellsForPlatform,
  imeMatrixL1AssertIds,
  imeMatrixL1PlusAssertIds,
  imeMatrixL1PlusReady,
  imeMatrixL1Ready,
  imeMatrixLeafCoreLockEligible,
  imeMatrixOpenRequiredCells,
  imeMatrixStatusGlyph,
  type ImeMatrixAssertId,
  type ImeMatrixPlatform,
} from './imeMatrix';
import type { GuardableIntent, StructureKeyKind } from './structureKeyGuard';

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
// 矩阵常量自洽（L0 成型）+ W6-B-S 包轨边界
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

  it('A-IME-01…05 三端均为 automated（🟨自动化）；06–08 open；无 e2e', () => {
    const automatedIds: readonly ImeMatrixAssertId[] = [
      'A-IME-01',
      'A-IME-02',
      'A-IME-03',
      'A-IME-04',
      'A-IME-05',
    ];
    const automatedSet = new Set<ImeMatrixAssertId>(automatedIds);
    for (const id of automatedIds) {
      for (const cell of imeMatrixCellsFor(id)) {
        expect(cell.status).toBe('automated');
        expect(imeMatrixStatusGlyph(cell.status)).toBe('🟨自动化');
        expect(cell.automationRefs?.length).toBeGreaterThan(0);
      }
    }
    for (const cell of IME_MATRIX_CELLS) {
      if (automatedSet.has(cell.id)) continue;
      expect(cell.status).toBe('open');
      expect(IME_MATRIX_STATUS_GLYPH.open).toBe('☐');
    }
    // 全矩阵无 e2e——L2 仍后置 W6-B（≠ W6-B-S 可关）
    expect(IME_MATRIX_CELLS.every((c) => c.status !== 'e2e')).toBe(true);
    expect(imeMatrixAnyE2e()).toBe(false);
    expect(imeMatrixL1Ready()).toBe(true);
    // 必测未 e2e 的格仍存在 → L2 未关（含 Win 必测格）
    const openRequired = imeMatrixOpenRequiredCells();
    expect(openRequired.length).toBeGreaterThan(0);
    expect(
      openRequired.some(
        (c) => c.platform === 'win_webview2' && c.requirement === '必测'
      )
    ).toBe(true);
  });
});

/**
 * W6-B-S 包叙事 + 矩阵格抽样（L0/L1 加深 · 可证伪）
 *
 * 显式边界（禁令对照 09 / ime-matrix / EL-dashboard 表 E）：
 * - **≠ W6-B**：无 e2e 格、openRequired 非空
 * - **≠ 叶子核锁定门禁**：leafCoreLockEligible === false
 * - **≠ EL**：本 describe 仅断言矩阵常量与机测语义，不写 EL 关闭
 */
describe('IME matrix · W6-B-S 包轨与矩阵格抽样（≠ W6-B / ≠ 叶子核 / ≠ EL）', () => {
  it('W6-B-S: 包轨字面量钉死为 W6-B-S（带 -S），禁止无 -S 别名', () => {
    expect(IME_MATRIX_PACKAGE_TRACK).toBe('W6-B-S');
    // 可证伪：去 -S 或改 Strict 字样即失败
    expect(IME_MATRIX_PACKAGE_TRACK.endsWith('-S')).toBe(true);
    expect(IME_MATRIX_PACKAGE_TRACK).not.toBe('W6-B');
    expect(IME_MATRIX_PACKAGE_TRACK.includes('Strict')).toBe(false);
  });

  it('W6-B-S: L1 与 L1+ 就绪；L2/叶子核未关（无 e2e · openRequired>0）', () => {
    expect(imeMatrixL1Ready()).toBe(true);
    expect(imeMatrixL1PlusReady()).toBe(true);
    expect(imeMatrixL1AssertIds()).toEqual(['A-IME-01', 'A-IME-02']);
    expect(imeMatrixL1PlusAssertIds()).toEqual([
      'A-IME-03',
      'A-IME-04',
      'A-IME-05',
    ]);

    // 状态桶抽样：15 automated（5×3）+ 9 open（3×3）；0 e2e
    expect(imeMatrixCellsByStatus('automated')).toHaveLength(15);
    expect(imeMatrixCellsByStatus('open')).toHaveLength(9);
    expect(imeMatrixCellsByStatus('e2e')).toHaveLength(0);
    expect(imeMatrixAnyE2e()).toBe(false);

    // 叶子核锁定门禁未达——**≠ L3**
    expect(imeMatrixLeafCoreLockEligible()).toBe(false);
    const openRequired = imeMatrixOpenRequiredCells();
    expect(openRequired.length).toBeGreaterThan(0);
    // 每一端至少有一条必测未 e2e（三端分端，不可 Win 绿勾全表）
    for (const platform of [
      'win_webview2',
      'macos_wk',
      'linux_webkit',
    ] as const satisfies readonly ImeMatrixPlatform[]) {
      expect(
        openRequired.some((c) => c.platform === platform),
        `平台 ${platform} 仍有必测未 e2e`
      ).toBe(true);
    }
  });

  it('W6-B-S: 端×要求强度与 IME_MATRIX_ASSERTS 一致（格抽样）', () => {
    // 每端恰 8 格
    for (const platform of [
      'win_webview2',
      'macos_wk',
      'linux_webkit',
    ] as const) {
      const cells = imeMatrixCellsForPlatform(platform);
      expect(cells).toHaveLength(8);
      for (const assert of IME_MATRIX_ASSERTS) {
        const cell = cells.find((c) => c.id === assert.id);
        expect(cell, `${assert.id}@${platform}`).toBeDefined();
        expect(cell!.requirement).toBe(assert.requirementByPlatform[platform]);
        expect(cell!.title).toBe(assert.title);
      }
    }

    // 钉死若干文档表抽样点（可证伪：改 asserts 表即红）
    // A-IME-03 linux=抽样；A-IME-06 win=必测 / mac=抽样；A-IME-07 三端必测
    expect(
      imeMatrixCellsFor('A-IME-03').find((c) => c.platform === 'linux_webkit')!
        .requirement
    ).toBe('抽样');
    expect(
      imeMatrixCellsFor('A-IME-06').find((c) => c.platform === 'win_webview2')!
        .requirement
    ).toBe('必测');
    expect(
      imeMatrixCellsFor('A-IME-06').find((c) => c.platform === 'macos_wk')!
        .requirement
    ).toBe('抽样');
    expect(
      imeMatrixCellsFor('A-IME-07').every((c) => c.requirement === '必测')
    ).toBe(true);
    // 06–08 仍 open（W6-B-S 不宣称 A-IME 全表）
    for (const id of ['A-IME-06', 'A-IME-07', 'A-IME-08'] as const) {
      expect(imeMatrixCellsFor(id).every((c) => c.status === 'open')).toBe(
        true
      );
    }
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

// ---------------------------------------------------------------------------
// A-IME-03 合成中滚动 pin：卸载候选不得误卸 composing
// ---------------------------------------------------------------------------

describe('IME matrix · A-IME-03 合成中滚动 pin', () => {
  it('A-IME-03: composing 时 pin 含合成块；滚动候选过滤后 composing 不进 allowed', () => {
    const ime = new ImeMachine();
    ime.startComposition('comp-scroll');
    const focusId = 'comp-scroll';
    const pinned = ime.buildPinned(focusId);

    expect(pinned.has('comp-scroll')).toBe(true);
    expect(ime.ensureComposingInPin(pinned).ok).toBe(true);

    // 模拟滚动：窗口移走，卸载候选含 composing + 窗外普通块
    const candidates = ['far-a', 'comp-scroll', 'far-b', 'window-edge'];
    const plan = ime.planScrollUnmount(candidates, { focusId, pinned });

    expect(plan.retained).toContain('comp-scroll');
    expect(plan.allowed).not.toContain('comp-scroll');
    expect(plan.allowed.sort()).toEqual(
      ['far-a', 'far-b', 'window-edge'].sort()
    );
    // composing 仍在机内
    expect(ime.isComposing()).toBe(true);
    expect(ime.getComposingBlockId()).toBe('comp-scroll');
  });

  it('A-IME-03: pin 模块 planScrollUnmount 与 ImeMachine 守卫组合一致', () => {
    const composingIds = ['c-ime'];
    const pinned = buildPinSet({
      focusId: 'c-ime',
      composingIds,
      extraPinned: ['sel-anchor'],
    });
    const raw = planScrollUnmount(
      ['c-ime', 'sel-anchor', 'scroll-out-1', 'scroll-out-2'],
      { focusId: 'c-ime', composingIds, pinned }
    );
    expect(raw.retained.sort()).toEqual(['c-ime', 'sel-anchor'].sort());
    expect(raw.allowed.sort()).toEqual(['scroll-out-1', 'scroll-out-2'].sort());

    const ime = new ImeMachine();
    ime.startComposition('c-ime');
    const viaMachine = ime.planScrollUnmount(
      ['c-ime', 'sel-anchor', 'scroll-out-1', 'scroll-out-2'],
      {
        focusId: 'c-ime',
        pinned: ime.buildPinned('c-ime', ['sel-anchor']),
      }
    );
    expect(viaMachine.retained.sort()).toEqual(raw.retained.sort());
    expect(viaMachine.allowed.sort()).toEqual(raw.allowed.sort());
  });

  it('A-IME-03: end 后 composing 离开 pin，原合成块可被滚动卸载', () => {
    const ime = new ImeMachine();
    ime.startComposition('was-comp');
    expect(
      ime.planScrollUnmount(['was-comp', 'other'], {
        focusId: 'was-comp',
      }).allowed
    ).not.toContain('was-comp');

    ime.endComposition('定稿');
    const after = ime.planScrollUnmount(['was-comp', 'other'], {
      focusId: null,
    });
    expect(after.allowed.sort()).toEqual(['other', 'was-comp'].sort());
    expect(after.retained).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A-IME-04 点另一块：钉死 end_then_switch
// ---------------------------------------------------------------------------

describe('IME matrix · A-IME-04 点另一块 end_then_switch', () => {
  it('A-IME-04: 策略常量钉死为 end_then_switch', () => {
    expect(IME_FOCUS_SWITCH_STRATEGY).toBe('end_then_switch');
  });

  it('A-IME-04: composing 点另一块 → 先 end 提交原块再 switched；无半切换', () => {
    const ime = new ImeMachine();
    ime.startComposition('block-a');
    ime.updateComposition('ni');
    ime.updateComposition('你好');
    const groupBefore = ime.getSnapshot().groupId;

    const r = ime.requestFocusSwitch('block-b', '你好');
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.strategy).toBe('end_then_switch');
    expect(r.switched).toBe(true);
    expect(r.fromBlockId).toBe('block-a');
    expect(r.toBlockId).toBe('block-b');
    expect(r.ended).not.toBeNull();
    expect(r.ended!.committedText).toBe('你好');
    expect(r.ended!.blockId).toBe('block-a');
    expect(r.ended!.groupId).toBe(groupBefore);

    // 无半切换：机内已 idle，composing 不再挂旧块
    expect(ime.isComposing()).toBe(false);
    expect(ime.getComposingBlockId()).toBeNull();
    expect(ime.getSnapshot().phase).toBe('idle');
  });

  it('A-IME-04: 同块点击不 end、不 switched；idle 直接允许切', () => {
    const ime = new ImeMachine();
    ime.startComposition('same');
    ime.updateComposition('半');
    const same = ime.requestFocusSwitch('same');
    expect(same.ok).toBe(true);
    if (same.ok) {
      expect(same.switched).toBe(false);
      expect(same.ended).toBeNull();
    }
    expect(ime.isComposing()).toBe(true);
    expect(ime.getSnapshot().preview).toBe('半');

    ime.endComposition('半成品提交');
    const idle = ime.requestFocusSwitch('other');
    expect(idle.ok).toBe(true);
    if (idle.ok) {
      expect(idle.switched).toBe(true);
      expect(idle.ended).toBeNull();
      expect(idle.fromBlockId).toBeNull();
      expect(idle.toBlockId).toBe('other');
    }
  });

  it('A-IME-04: 空 target 拒绝；切块后可在新块 start 新合成', () => {
    const ime = new ImeMachine();
    ime.startComposition('a');
    expect(ime.requestFocusSwitch('').ok).toBe(false);

    const sw = ime.requestFocusSwitch('b', '提交A');
    expect(sw.ok && sw.switched).toBe(true);
    const startB = ime.startComposition('b');
    expect(startB.ok).toBe(true);
    expect(ime.getComposingBlockId()).toBe('b');
  });
});

// ---------------------------------------------------------------------------
// A-IME-05 合成=一步撤销：仅 end 产生一条 commit 边界
// ---------------------------------------------------------------------------

describe('IME matrix · A-IME-05 合成=一步撤销 commit 边界', () => {
  it('A-IME-05: 多次 update 不产生边界；end 恰好一条且 groupId 贯穿', () => {
    const ime = new ImeMachine();
    ime.startComposition('undo-block');
    const g = ime.getSnapshot().groupId!;
    expect(g).toMatch(/^ime-g-/);

    // start 不写边界
    expect(ime.peekCommitBoundaries()).toHaveLength(0);

    const previews = ['n', 'ni', '你', '你好', '你好世界'];
    for (const p of previews) {
      ime.updateComposition(p);
      // update 永不写边界
      expect(ime.peekCommitBoundaries()).toHaveLength(0);
      expect(ime.getSnapshot().groupId).toBe(g);
    }

    const end = ime.endComposition('你好世界');
    expect(end.groupId).toBe(g);
    expect(end.committedText).toBe('你好世界');

    const boundaries = ime.drainCommitBoundaries();
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]).toEqual({
      kind: 'composition_end',
      groupId: g,
      blockId: 'undo-block',
      committedText: '你好世界',
    });
    // drain 后清空
    expect(ime.peekCommitBoundaries()).toHaveLength(0);
    expect(ime.drainCommitBoundaries()).toEqual([]);
  });

  it('A-IME-05: 两次合成 → 两条边界、不同 groupId（各一步撤销）', () => {
    const ime = new ImeMachine();

    ime.startComposition('b1');
    const g1 = ime.getSnapshot().groupId!;
    ime.updateComposition('甲');
    ime.updateComposition('甲乙');
    ime.endComposition('甲乙');

    ime.startComposition('b1');
    const g2 = ime.getSnapshot().groupId!;
    expect(g2).not.toBe(g1);
    ime.updateComposition('丙');
    ime.endComposition('丙');

    const all = ime.drainCommitBoundaries();
    expect(all).toHaveLength(2);
    expect(all[0]!.groupId).toBe(g1);
    expect(all[0]!.committedText).toBe('甲乙');
    expect(all[1]!.groupId).toBe(g2);
    expect(all[1]!.committedText).toBe('丙');
  });

  it('A-IME-05: idle end 不写边界；requestFocusSwitch end 计入一步', () => {
    const ime = new ImeMachine();
    ime.endComposition('noop');
    expect(ime.drainCommitBoundaries()).toEqual([]);

    ime.startComposition('from');
    const g = ime.getSnapshot().groupId!;
    ime.updateComposition('x');
    ime.updateComposition('xy');
    const sw = ime.requestFocusSwitch('to', 'xy');
    expect(sw.ok && sw.ended?.groupId).toBe(g);

    const b = ime.drainCommitBoundaries();
    expect(b).toHaveLength(1);
    expect(b[0]!.groupId).toBe(g);
    expect(b[0]!.blockId).toBe('from');
    expect(b[0]!.committedText).toBe('xy');
  });
});

// ---------------------------------------------------------------------------
// W6-B-S 加深 · composing 边界 / 状态迁移（L1 语义可证伪 · ≠ L2 e2e）
// ---------------------------------------------------------------------------

/**
 * composing 边界与相位迁移加深。
 * 仍属 🟨自动化语义子集；**≠ W6-B** WebView 时序；**≠ EL**。
 */
describe('IME matrix · W6-B-S composing 边界与状态迁移加深', () => {
  it('W6-B-S: idle 时 updateComposition no-op；空 final 仍 value 优先并写一条边界', () => {
    const ime = new ImeMachine();

    // idle update 不得污染 snapshot / 不得写边界
    const idleSnap = ime.updateComposition('幽灵候选');
    expect(idleSnap.phase).toBe('idle');
    expect(idleSnap.preview).toBe('');
    expect(idleSnap.composing).toBe(false);
    expect(ime.peekCommitBoundaries()).toHaveLength(0);

    // 空 block 拒绝后仍 idle
    expect(ime.startComposition('').ok).toBe(false);
    expect(ime.isComposing()).toBe(false);

    ime.startComposition('edge-empty');
    ime.updateComposition('半成品拼音');
    expect(ime.getSnapshot().preview).toBe('半成品拼音');

    // finalText === '' 显式 value 优先（覆盖 preview，允许提交空串）
    const endEmpty = ime.endComposition('');
    expect(endEmpty.committedText).toBe('');
    expect(endEmpty.committedText).not.toBe('半成品拼音');
    expect(endEmpty.blockId).toBe('edge-empty');
    expect(ime.getSnapshot().phase).toBe('idle');

    const boundaries = ime.drainCommitBoundaries();
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]!.committedText).toBe('');
    expect(boundaries[0]!.blockId).toBe('edge-empty');
    expect(boundaries[0]!.kind).toBe('composition_end');
  });

  it('W6-B-S: 全 StructureKeyKind 在 composing 拒绝；end 后结构键种放行', () => {
    const kinds: readonly StructureKeyKind[] = [
      'split_block',
      'merge_block',
      'indent',
      'outdent',
      'turn_into',
      'move_block',
      'delete_block',
      'insert_block',
      'structure_op',
    ];
    const ime = new ImeMachine();
    ime.startComposition('sk-all');
    expect(ime.isComposing()).toBe(true);

    for (const kind of kinds) {
      const intent: GuardableIntent = {
        type: 'structure_key',
        kind,
        blockId: 'sk-all',
        intentId: `sk-${kind}`,
      };
      const r = ime.tryAcceptIntent(intent);
      expect(r.ok, `composing 应拒 structure_key:${kind}`).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('composing_structure_key');
      }
    }

    ime.endComposition('定');
    expect(ime.isComposing()).toBe(false);
    for (const kind of kinds) {
      const intent: GuardableIntent = {
        type: 'structure_key',
        kind,
        blockId: 'sk-all',
      };
      expect(ime.tryAcceptIntent(intent).ok, `idle 应放行 ${kind}`).toBe(true);
    }
  });

  it('W6-B-S: 状态迁移——composing 仅拦合成块 unmount；切块 end 后结构立即放行且可新 start', () => {
    const ime = new ImeMachine();
    ime.startComposition('comp-mig');
    ime.updateComposition('迁');

    // 合成块不可卸；窗外普通块可卸（焦点另设）
    expect(ime.checkUnmount('comp-mig', { focusId: 'comp-mig' }).ok).toBe(
      false
    );
    expect(ime.checkUnmount('far-window', { focusId: 'comp-mig' }).ok).toBe(
      true
    );

    // 切到另一块：先 end 再 switched；机内 idle 后结构 op 立即放行
    const sw = ime.requestFocusSwitch('next-block', '迁');
    expect(sw.ok && sw.switched && sw.ended != null).toBe(true);
    expect(ime.isComposing()).toBe(false);
    expect(ime.getComposingBlockId()).toBeNull();
    expect(
      ime.tryAcceptIntent({
        type: 'op',
        ops: [{ kind: 'split_block' }],
        intentId: 'post-switch-op',
      }).ok
    ).toBe(true);
    expect(
      ime.tryAcceptIntent({
        type: 'request_slash',
        blockId: 'next-block',
        offset: 0,
      }).ok
    ).toBe(true);

    // 新块可 start；旧块无 composing 守卫时可卸
    const startNext = ime.startComposition('next-block');
    expect(startNext.ok).toBe(true);
    expect(ime.getComposingBlockId()).toBe('next-block');
    expect(ime.checkUnmount('comp-mig', { focusId: 'next-block' }).ok).toBe(
      true
    );
    expect(ime.checkUnmount('next-block', { focusId: 'next-block' }).ok).toBe(
      false
    );

    // 重复 start 仍拒绝（须先 end）——相位不变量
    expect(ime.startComposition('third').ok).toBe(false);
    ime.endComposition('新块定稿');
    expect(ime.drainCommitBoundaries()).toHaveLength(2); // 切块 end + 本 end
  });
});
