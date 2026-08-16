/**
 * W3-D Strict · 真 apply sink 工厂形状测（TS 侧）。
 *
 * ## 轨声明（诚实 · 09 §0.4 / plans/05 §2）
 *
 * | 可宣称 | 禁止宣称 |
 * | ------ | -------- |
 * | `createCollabApplySink`：Intent → wire → 注入 `applyOps`（生产默认形状） | EL-01 / A-BLK 全表 e2e |
 * | TextEditIntent + StructureIntent 均走 wire 再 applyOps（非 mock.calls 关闭） | 桌面 IPC 全链路已接线（若未实现则见 RS 证真） |
 * | mock sink 仅形状测 | 用 mock.calls 计 W3-D 关闭 |
 *
 * 真 `DocSession::apply` + 树/`read_text` 可观测变化在 RS：
 * `crates/conex-doc-collab/tests/w3_d_structure_intent_or_wire_apply.rs`
 * （测名含 `w3_d_strict_text_and_structure_intent_true_apply`）。
 *
 * 本文件 adapter 模拟后端：解析 wire、记录 ops，**不断言 mock.calls 为 apply 证据**——
 * 关闭证据 = wire 形状合法 + applyOps 被调用且返回 ok + 交叉引用 RS 真 session。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  collabOpsFromJson,
  isCollabOpWire,
  type CollabOpWire,
} from '@crish/block-paper-contract';
import {
  buildDeleteBlocksIntent,
  buildInsertBlockIntent,
} from '../chrome/structureIntents';
import {
  createCollabApplySink,
  createDocSessionApplySink,
  createMockIntentSink,
  submitIntent,
  type ApplyOpsAdapter,
  type IntentSinkResult,
} from './intentBridge';
import { resetIntentIdSeqForTests } from './TextLeafModel';

const ID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

/** 可注入内存 adapter：解析 wire 并累计（模拟 DocSession 前的 IPC 面） */
function createRecordingApplyAdapter(opts?: {
  result?: IntentSinkResult;
  throwOnCall?: boolean;
}): {
  applyOps: ApplyOpsAdapter;
  appliedJson: string[];
  appliedOps: CollabOpWire[][];
} {
  const appliedJson: string[] = [];
  const appliedOps: CollabOpWire[][] = [];
  const result: IntentSinkResult = opts?.result ?? { ok: true };

  const applyOps: ApplyOpsAdapter = async (opsJson, _meta) => {
    if (opts?.throwOnCall) {
      throw new Error('applyOps simulated failure');
    }
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

describe('createCollabApplySink（W3-D 生产默认形状）', () => {
  it('缺 applyOps 时 fail-closed 抛错', () => {
    expect(() =>
      // @ts-expect-error 故意缺 applyOps
      createCollabApplySink({})
    ).toThrow(/必须注入 applyOps/);
  });

  it('TextEditIntent → wire JSON → applyOps（非 mock.calls）', async () => {
    const rec = createRecordingApplyAdapter();
    const collab = createCollabApplySink({ applyOps: rec.applyOps });

    const textIntent = {
      type: 'text_edit' as const,
      blockId: ID_A,
      range: [0, 0] as [number, number],
      insert: 'hello-w3d',
      intentId: 'w3d-text-apply',
    };

    const submitted = await submitIntent(textIntent, collab.sink);
    expect(submitted.ok).toBe(true);

    expect(collab.wireCalls).toHaveLength(1);
    expect(rec.appliedJson).toHaveLength(1);
    expect(rec.appliedJson[0]).toBe(collab.wireCalls[0]);

    const ops = rec.appliedOps[0]!;
    expect(ops).toEqual([
      {
        op: 'text_edit',
        id: ID_A,
        start: 0,
        end: 0,
        insert: 'hello-w3d',
      },
    ]);
    // 与 RS w3_d_* fixture 键一致（可喂 ops_from_json）
    expect(collab.wireCalls[0]).toContain('"op":"text_edit"');
    expect(collab.wireCalls[0]).toContain('hello-w3d');
    expect(collab.results[0]).toEqual({ ok: true });
  });

  it('StructureIntent insert → wire → applyOps；树变证据在 RS 交叉引用', async () => {
    const rec = createRecordingApplyAdapter();
    const collab = createCollabApplySink({
      applyOps: rec.applyOps,
      resolveOrder: () => 'a0',
    });

    const insert = buildInsertBlockIntent({
      parentId: null,
      flavour: 'paragraph',
      blockIds: [ID_A],
      createIntentId: () => 'w3d-ins-apply',
    });

    const submitted = await submitIntent(insert, collab.sink);
    expect(submitted.ok).toBe(true);

    expect(rec.appliedOps[0]).toEqual([
      {
        op: 'insert',
        id: ID_A,
        parent: null,
        order: 'a0',
        kind: 'paragraph',
        props: { attrs: {} },
      },
    ]);
    expect(collab.wireCalls[0]).toContain('"op":"insert"');
    expect(collab.wireCalls[0]).toContain(ID_A);
  });

  it('StructureIntent delete → wire → applyOps', async () => {
    const rec = createRecordingApplyAdapter();
    const collab = createCollabApplySink({ applyOps: rec.applyOps });

    const del = buildDeleteBlocksIntent({
      blockIds: [ID_B],
      createIntentId: () => 'w3d-del-apply',
    });
    const submitted = await submitIntent(del, collab.sink);
    expect(submitted.ok).toBe(true);
    expect(rec.appliedOps[0]).toEqual([{ op: 'delete', id: ID_B }]);
  });

  it('TextEdit + Structure 串联走同一 collab sink（双路径形状）', async () => {
    const rec = createRecordingApplyAdapter();
    const collab = createCollabApplySink({
      applyOps: rec.applyOps,
      resolveOrder: () => 'a0',
    });

    const insert = buildInsertBlockIntent({
      parentId: null,
      flavour: 'paragraph',
      blockIds: [ID_A],
      createIntentId: () => 'chain-ins',
    });
    const text = {
      type: 'text_edit' as const,
      blockId: ID_A,
      range: [0, 0] as [number, number],
      insert: 'chain-text',
      intentId: 'chain-text',
    };

    expect((await submitIntent(insert, collab.sink)).ok).toBe(true);
    expect((await submitIntent(text, collab.sink)).ok).toBe(true);

    expect(collab.wireCalls).toHaveLength(2);
    expect(rec.appliedOps[0]![0]!.op).toBe('insert');
    expect(rec.appliedOps[1]![0]!.op).toBe('text_edit');
  });

  it('applyOps 返回 ok:false → submitIntent sink_reject', async () => {
    const rec = createRecordingApplyAdapter({
      result: { ok: false, reason: 'conflict' },
    });
    const collab = createCollabApplySink({ applyOps: rec.applyOps });
    const text = {
      type: 'text_edit' as const,
      blockId: ID_A,
      range: [0, 0] as [number, number],
      insert: 'x',
      intentId: 'rej',
    };
    const r = await submitIntent(text, collab.sink);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('sink_reject');
      expect(r.reason).toMatch(/conflict/);
    }
  });

  it('applyOps 抛错 → sink ok:false', async () => {
    const rec = createRecordingApplyAdapter({ throwOnCall: true });
    const collab = createCollabApplySink({ applyOps: rec.applyOps });
    const text = {
      type: 'text_edit' as const,
      blockId: ID_A,
      range: [0, 0] as [number, number],
      insert: 'x',
      intentId: 'throw',
    };
    const r = await collab.sink(text);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/simulated failure/);
  });

  it('createDocSessionApplySink 与 createCollabApplySink 同义', () => {
    expect(createDocSessionApplySink).toBe(createCollabApplySink);
  });
});

describe('createCollabApplySink 冲突失效钩子（R2-b ⑥ · 详案 §1.2-⑥-3）', () => {
  const TEXT = {
    type: 'text_edit' as const,
    blockId: ID_A,
    range: [0, 0] as [number, number],
    insert: 'conflict-x',
    intentId: 'conflict-intent',
  };

  it('applyOps 返回 ok:false（conflict）→ onApplyRejected 携带 intent+reason，结果保持 ok:false 透传（不静默 LWW）', async () => {
    const onApplyRejected = vi.fn();
    const rec = createRecordingApplyAdapter({
      result: { ok: false, reason: 'Conflict { expect: 3 }' },
    });
    const collab = createCollabApplySink({
      applyOps: rec.applyOps,
      onApplyRejected,
    });

    const r = await submitIntent(TEXT, collab.sink);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('sink_reject');

    expect(onApplyRejected).toHaveBeenCalledTimes(1);
    expect(onApplyRejected).toHaveBeenCalledWith({
      intent: TEXT,
      reason: 'Conflict { expect: 3 }',
    });
    // 结果未被钩子改写：无自动合并、无静默覆盖
    expect(collab.results[0]).toEqual({
      ok: false,
      reason: 'Conflict { expect: 3 }',
    });
  });

  it('applyOps 抛错 → onApplyRejected 同样触发（本地乐观编辑未落地）', async () => {
    const onApplyRejected = vi.fn();
    const rec = createRecordingApplyAdapter({ throwOnCall: true });
    const collab = createCollabApplySink({
      applyOps: rec.applyOps,
      onApplyRejected,
    });

    const r = await collab.sink(TEXT);
    expect(r.ok).toBe(false);
    expect(onApplyRejected).toHaveBeenCalledTimes(1);
    expect(onApplyRejected).toHaveBeenCalledWith({
      intent: TEXT,
      reason: expect.stringMatching(/simulated failure/),
    });
  });

  it('applyOps ok:true → 不触发钩子', async () => {
    const onApplyRejected = vi.fn();
    const rec = createRecordingApplyAdapter();
    const collab = createCollabApplySink({
      applyOps: rec.applyOps,
      onApplyRejected,
    });

    const r = await submitIntent(TEXT, collab.sink);
    expect(r.ok).toBe(true);
    expect(onApplyRejected).not.toHaveBeenCalled();
  });

  it('钩子抛错不污染 sink 返回（异常隔离）', async () => {
    const rec = createRecordingApplyAdapter({
      result: { ok: false, reason: 'conflict' },
    });
    const collab = createCollabApplySink({
      applyOps: rec.applyOps,
      onApplyRejected: () => {
        throw new Error('hook boom');
      },
    });

    const r = await collab.sink(TEXT);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('conflict');
  });
});

describe('mock sink 边界（G-INV-3）', () => {
  it('createMockIntentSink 仅记录 calls，不产 wire / 不调 apply', async () => {
    const mock = createMockIntentSink();
    const text = {
      type: 'text_edit' as const,
      blockId: ID_A,
      range: [0, 0] as [number, number],
      insert: 'mock-only',
      intentId: 'mock-1',
    };
    await submitIntent(text, mock.sink);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual(text);
    // 叙事钉死：mock.calls ≠ 真 apply 关闭证据
    expect('wireCalls' in mock).toBe(false);
  });
});
