/**
 * W3-F Strict 子集 · chrome StructureIntent → **createCollabApplySink**（真 apply 形状）。
 *
 * ## 轨声明（诚实 · 09 §0.4 / plans/05 §3 / G-INV-3）
 *
 * | 可宣称 | 禁止宣称 |
 * | ------ | -------- |
 * | slash_insert / delete_blocks：`submitIntent` → **`createCollabApplySink`** → 合法 collab wire → 注入 `applyOps` | **EL-01** / A-BLK-02/04/05 **全关** / A-BLK 全表 e2e |
 * | 关闭证据 = wire 形状合法 + applyOps 被调用且 ok；**不得**用 mock.calls | A-BLK-02/04/05 **产品 e2e 全关** / EL-01 |
 * | 交叉 RS：`w3_f_*` / `w3_d_*` 证明对应 op 真 `DocSession::apply` | 「Notion chrome 完成」「块工作区完成」 |
 *
 * ## 与 W3-F-S / mock / DOM 分轨
 *
 * - `chrome.w3f.test.ts` 仍用 `createMockIntentSink`：**仅**形状 / IME 守卫；**不得**作本 Strict 关闭证据
 * - `chrome.w3f_dom.test.ts` = DOM 余量（把手/多选框/落点线/slash 宿主）；**DOM ≠ EL-01**
 * - 本文件 **禁止** 断言 `mock.calls` 关闭 W3-F；**不得**回退 mock 默认
 *
 * ## 未交付（诚实边界 · 精确）
 *
 * - **桌面 React chrome 挂载已交**（`BlockChromeDomMount` / Strict 槽）
 * - **仍未交**：真 Pointer 拖拽产品 e2e / A-BLK-02/04/05 **产品 e2e**（jsdom ≠ e2e）
 * - 桌面 Tauri `note_apply_ops` IPC 产品挂载（adapter 形状已备；挂载属 W5-B 方向）
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  collabOpsFromJson,
  isCollabOpWire,
  type CollabOpWire,
} from '@crish/block-paper-contract';
import {
  createCollabApplySink,
  submitIntent,
  type ApplyOpsAdapter,
  type IntentSinkResult,
} from '../leaves/intentBridge';
import { resetIntentIdSeqForTests } from '../intentId';
import { BlockChromeModel } from './BlockChrome';
import { SlashMenuModel } from './SlashMenuModel';

/** 与 RS `w3_d_*` / `w3_f_*` fixture 对齐的稳定 UUID */
const ID_ANCHOR = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ID_SLASH_NEW = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const ID_DEL_A = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ID_DEL_B = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

/** 可注入内存 adapter：解析 wire 并累计（模拟 DocSession 前的 IPC 面） */
function createRecordingApplyAdapter(opts?: { result?: IntentSinkResult }): {
  applyOps: ApplyOpsAdapter;
  appliedJson: string[];
  appliedOps: CollabOpWire[][];
} {
  const appliedJson: string[] = [];
  const appliedOps: CollabOpWire[][] = [];
  const result: IntentSinkResult = opts?.result ?? { ok: true };

  const applyOps: ApplyOpsAdapter = async (opsJson, _meta) => {
    appliedJson.push(opsJson);
    const ops = collabOpsFromJson(opsJson);
    appliedOps.push(ops);
    for (const op of ops) {
      expect(isCollabOpWire(op)).toBe(true);
    }
    const r: IntentSinkResult = { ok: result.ok };
    if (result.reason !== undefined) r.reason = result.reason;
    return r;
  };

  return { applyOps, appliedJson, appliedOps };
}

beforeEach(() => {
  resetIntentIdSeqForTests();
});

// ---------------------------------------------------------------------------
// W3-F Strict：slash_insert → createCollabApplySink
// ---------------------------------------------------------------------------

describe('W3-F Strict · slash_insert → createCollabApplySink', () => {
  it('SlashMenuModel.selectItem → submitIntent → collab sink wire insert（非 mock.calls）', async () => {
    const rec = createRecordingApplyAdapter();
    const collab = createCollabApplySink({
      applyOps: rec.applyOps,
      allocateId: () => ID_SLASH_NEW,
      resolveOrder: () => 'a0',
    });

    const menu = new SlashMenuModel({
      createIntentId: () => 'w3f-slash-collab',
    });
    expect(menu.open(ID_ANCHOR, 3).ok).toBe(true);

    const sel = menu.selectItem('heading-1');
    expect(sel.ok).toBe(true);
    if (!sel.ok) return;

    expect(sel.intent).toMatchObject({
      type: 'slash_insert',
      blockId: ID_ANCHOR,
      offset: 3,
      flavour: 'heading-1',
      catalogItemId: 'heading-1',
      origin: 'slash',
      intentId: 'w3f-slash-collab',
    });

    const submitted = await submitIntent(sel.intent, collab.sink);
    expect(submitted.ok).toBe(true);

    // Strict 证据：wireCalls + applyOps，**不是** mock.calls
    expect(collab.wireCalls).toHaveLength(1);
    expect(rec.appliedJson).toHaveLength(1);
    expect(rec.appliedJson[0]).toBe(collab.wireCalls[0]);
    expect(collab.results[0]).toEqual({ ok: true });

    const ops = rec.appliedOps[0]!;
    expect(ops).toEqual([
      {
        op: 'insert',
        id: ID_SLASH_NEW,
        parent: null,
        order: 'a0',
        kind: { heading: { level: 1 } },
        props: { attrs: {} },
      },
    ]);
    // 可喂 RS ops_from_json（交叉：crates/.../w3_d_* + w3_f_*）
    expect(collab.wireCalls[0]).toContain('"op":"insert"');
    expect(collab.wireCalls[0]).toContain(ID_SLASH_NEW);
    expect(collab.wireCalls[0]).toContain('heading');
  });

  it('slash_insert composing 仍被桥拒绝，不调用 applyOps', async () => {
    const rec = createRecordingApplyAdapter();
    const collab = createCollabApplySink({
      applyOps: rec.applyOps,
      allocateId: () => ID_SLASH_NEW,
    });
    const menu = new SlashMenuModel({
      isComposing: () => true,
      createIntentId: () => 'w3f-slash-comp',
    });
    expect(menu.open(ID_ANCHOR, 0).ok).toBe(false);

    // 伪造 intent 直接 submit 亦拒
    const forged = {
      type: 'slash_insert' as const,
      intentId: 'forged-w3f',
      origin: 'slash' as const,
      blockId: ID_ANCHOR,
      offset: 0,
      flavour: 'paragraph',
      catalogItemId: 'paragraph',
    };
    const r = await submitIntent(forged, collab.sink, {
      isComposing: () => true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('composing_structure_op');
    expect(rec.appliedJson).toHaveLength(0);
    expect(collab.wireCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// W3-F Strict：delete_blocks → createCollabApplySink
// ---------------------------------------------------------------------------

describe('W3-F Strict · delete_blocks → createCollabApplySink', () => {
  it('BlockChromeModel 多选删除 → submitIntent → collab sink wire delete', async () => {
    const rec = createRecordingApplyAdapter();
    const collab = createCollabApplySink({ applyOps: rec.applyOps });

    const chrome = new BlockChromeModel({
      createIntentId: () => 'w3f-del-collab',
    });
    chrome.setMultiSelected([ID_DEL_A, ID_DEL_B, ID_DEL_A]);

    const del = chrome.requestDeleteSelected();
    expect(del.ok).toBe(true);
    if (!del.ok) return;

    expect(del.intent).toMatchObject({
      type: 'delete_blocks',
      origin: 'batch',
      blockIds: [ID_DEL_A, ID_DEL_B],
      intentId: 'w3f-del-collab',
    });

    const submitted = await submitIntent(del.intent, collab.sink);
    expect(submitted.ok).toBe(true);

    expect(collab.wireCalls).toHaveLength(1);
    expect(rec.appliedOps[0]).toEqual([
      { op: 'delete', id: ID_DEL_A },
      { op: 'delete', id: ID_DEL_B },
    ]);
    expect(collab.wireCalls[0]).toContain('"op":"delete"');
    expect(collab.wireCalls[0]).toContain(ID_DEL_A);
    expect(collab.wireCalls[0]).toContain(ID_DEL_B);
    // 叙事钉死：本测无 mock.calls 字段
    expect('calls' in collab).toBe(false);
    expect('wireCalls' in collab).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 双路径串联（chrome 产品面子集）
// ---------------------------------------------------------------------------

describe('W3-F Strict · slash + delete 共用 createCollabApplySink', () => {
  it('slash_insert 与 delete_blocks 顺序 wire → applyOps（非 mock）', async () => {
    const rec = createRecordingApplyAdapter();
    const collab = createCollabApplySink({
      applyOps: rec.applyOps,
      allocateId: () => ID_SLASH_NEW,
      resolveOrder: () => 'a0',
    });

    const menu = new SlashMenuModel({ createIntentId: () => 'w3f-e2e-slash' });
    const chrome = new BlockChromeModel({
      createIntentId: () => 'w3f-e2e-del',
    });

    menu.open(ID_ANCHOR, 1);
    const sel = menu.selectItem('paragraph');
    expect(sel.ok).toBe(true);
    if (!sel.ok) return;
    expect((await submitIntent(sel.intent, collab.sink)).ok).toBe(true);

    chrome.setMultiSelected([ID_DEL_A]);
    const del = chrome.requestDeleteSelected();
    expect(del.ok).toBe(true);
    if (!del.ok) return;
    expect((await submitIntent(del.intent, collab.sink)).ok).toBe(true);

    expect(collab.wireCalls).toHaveLength(2);
    expect(rec.appliedOps[0]![0]!.op).toBe('insert');
    expect(rec.appliedOps[1]![0]).toEqual({ op: 'delete', id: ID_DEL_A });

    // 交叉 RS 锚点（真树变化在库侧，不在本 adapter 内存）
    // - w3_f_slash_insert_or_delete_blocks_true_apply
    // - w3_d_strict_text_and_structure_intent_true_apply（insert + delete 同源 wire）
  });
});
