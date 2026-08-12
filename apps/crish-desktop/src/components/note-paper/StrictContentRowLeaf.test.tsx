// @vitest-environment jsdom
/**
 * CONN-D3 · Strict content-row 叶 → mdPrefix 产品路径
 *
 * | 可宣称 | 禁止宣称 |
 * | ------ | -------- |
 * | 可写叶键入 `# `/`- ` → commitProduct* / sink | A-BLK-08/09 全 e2e / EL-01 |
 * | disabled 叶静态、不假转块 | pending = 真 kind UI |
 * | composing 不进 sink | 真 PM View HiddenInput 全链 |
 * | 与 slash 通道分 sink 不互抹 | 打开完成 |
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  buildSlashInsertIntent,
  createMockIntentSink,
  createMockTurnIntoSink,
  submitIntent,
  type ApplyOpsAdapter,
} from '@crish/block-paper';
import {
  createFixtureHydrateTransport,
  makeHydratedBlock,
} from './hydrateProjection';
import {
  createProductMdPrefixBinding,
  simulateProductMdPrefixSubmit,
} from './noteMdPrefixBridge';
import {
  StrictContentRowLeaf,
  tryCommitStrictLeafMdPrefix,
} from './StrictContentRowLeaf';
import { NotePaperStrictPanel } from './NotePaperStrictPanel';

// ---------------------------------------------------------------------------
// 纯逻辑
// ---------------------------------------------------------------------------

describe('tryCommitStrictLeafMdPrefix · CONN-D3', () => {
  it('conn_d3_leaf_commit_hash_to_sink', async () => {
    const mock = createMockTurnIntoSink();
    const binding = createProductMdPrefixBinding({ turnIntoSink: mock.sink });
    const r = await tryCommitStrictLeafMdPrefix({
      blockId: 'leaf-1',
      text: '# ',
      fromFlavour: 'paragraph',
      isComposing: false,
      binding,
      createIntentId: () => 'leaf-h1',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent.flavour).toBe('heading-1');
    expect(mock.calls).toHaveLength(1);
  });

  it('conn_d3_leaf_commit_composing_rejects', async () => {
    const mock = createMockTurnIntoSink();
    const binding = createProductMdPrefixBinding({ turnIntoSink: mock.sink });
    const r = await tryCommitStrictLeafMdPrefix({
      blockId: 'leaf-ime',
      text: '# ',
      fromFlavour: 'paragraph',
      isComposing: true,
      binding,
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.stage === 'fast_path') {
      expect(r.code).toBe('composing');
    }
    expect(mock.calls).toHaveLength(0);
  });

  it('conn_d3_leaf_commit_disabled_no_fake', async () => {
    const binding = createProductMdPrefixBinding();
    const r = await tryCommitStrictLeafMdPrefix({
      blockId: 'leaf-ro',
      text: '# ',
      fromFlavour: 'paragraph',
      isComposing: false,
      binding,
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.stage === 'product') {
      expect(r.code).toBe('disabled');
    }
  });
});

// ---------------------------------------------------------------------------
// StrictContentRowLeaf 组件
// ---------------------------------------------------------------------------

describe('StrictContentRowLeaf · DOM 叶宿主', () => {
  it('conn_d3_leaf_disabled_static_no_contenteditable', () => {
    render(
      <StrictContentRowLeaf
        blockId="b-ro"
        flavour="paragraph"
        text="static body"
        mdPrefixWriteMode="disabled"
      />
    );
    const leaf = screen.getByTestId('note-strict-leaf-b-ro');
    expect(leaf).toHaveAttribute('data-md-prefix-leaf-mode', 'disabled');
    expect(leaf).toHaveAttribute('data-strict-leaf-input', '0');
    expect(leaf).not.toHaveAttribute('contenteditable', 'true');
    expect(leaf.textContent).toBe('static body');
  });

  it('conn_d3_leaf_writable_input_hash_calls_sink', async () => {
    const mock = createMockTurnIntoSink();
    const onCommit = vi.fn();
    render(
      <StrictContentRowLeaf
        blockId="b-wr"
        flavour="paragraph"
        text=""
        turnIntoSink={mock.sink}
        mdPrefixWriteMode="writable"
        mdPrefixSinkSource="injected-sink"
        onMdPrefixCommit={onCommit}
      />
    );
    const leaf = screen.getByTestId('note-strict-leaf-b-wr');
    expect(leaf).toHaveAttribute('data-md-prefix-leaf-mode', 'writable');
    expect(leaf).toHaveAttribute('data-strict-leaf-input', '1');
    expect(leaf).toHaveAttribute('contenteditable', 'true');

    // 模拟 HiddenInput 方向键入行首 `# `
    await act(async () => {
      leaf.textContent = '# ';
      fireEvent.input(leaf);
    });

    await waitFor(() => {
      expect(mock.calls).toHaveLength(1);
    });
    expect(mock.calls[0]!.flavour).toBe('heading-1');
    expect(mock.calls[0]!.trigger).toBe('md_prefix');
    expect(onCommit).toHaveBeenCalled();
    const last = onCommit.mock.calls.at(-1)?.[0];
    expect(last?.ok).toBe(true);
    // 剥离后叶缓冲清空；**不**改 data-from-flavour（kind 仍 paragraph 投影）
    expect(leaf).toHaveAttribute('data-from-flavour', 'paragraph');
    expect(leaf.textContent).toBe('');
  });

  it('conn_d3_leaf_composing_input_no_sink', async () => {
    const mock = createMockTurnIntoSink();
    render(
      <StrictContentRowLeaf
        blockId="b-ime"
        flavour="paragraph"
        text=""
        turnIntoSink={mock.sink}
      />
    );
    const leaf = screen.getByTestId('note-strict-leaf-b-ime');
    await act(async () => {
      fireEvent.compositionStart(leaf);
      leaf.textContent = '# ';
      fireEvent.input(leaf);
    });
    // composition 中不 commit
    expect(mock.calls).toHaveLength(0);

    await act(async () => {
      fireEvent.compositionEnd(leaf);
    });
    // end 后会尝试；此时 text 仍是 `# `
    await waitFor(() => {
      expect(mock.calls.length).toBeGreaterThanOrEqual(0);
    });
    // compositionEnd 后应提交（双守卫仅 composing 中拒绝）
    await waitFor(() => {
      expect(mock.calls).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// StrictPanel 接线 + 与 slash 不互抹
// ---------------------------------------------------------------------------

describe('NotePaperStrictPanel · CONN-D3 叶路径接线', () => {
  it('conn_d3_panel_default_leaf_disabled', async () => {
    const transport = createFixtureHydrateTransport({
      'doc-d3-ro': {
        rev: 1,
        blocks: [
          makeHydratedBlock({
            id: 'p1',
            flavour: 'paragraph',
            text: 'hello',
            index: 0,
          }),
        ],
      },
    });
    render(
      <NotePaperStrictPanel
        docId="doc-d3-ro"
        hydrateTransport={transport}
        presentationMode="react-rows"
      />
    );
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'ready'
      );
    });
    const panel = screen.getByTestId('note-paper-strict-panel');
    expect(panel).toHaveAttribute('data-md-prefix-write-mode', 'disabled');
    expect(panel).toHaveAttribute('data-md-prefix-leaf-path', 'product');
    const leaf = screen.getByTestId('note-strict-leaf-p1');
    expect(leaf).toHaveAttribute('data-md-prefix-leaf-mode', 'disabled');
    expect(leaf).toHaveAttribute('data-strict-leaf-input', '0');
  });

  it('conn_d3_panel_writable_leaf_bullet_to_pending_wire', async () => {
    const applied: string[] = [];
    const applyOps: ApplyOpsAdapter = async (opsJson) => {
      applied.push(opsJson);
      return { ok: true };
    };
    const binding = createProductMdPrefixBinding({ applyOps });
    const commits: unknown[] = [];

    const transport = createFixtureHydrateTransport({
      'doc-d3-wr': {
        rev: 1,
        blocks: [
          makeHydratedBlock({
            id: 'p-wr',
            flavour: 'paragraph',
            text: '',
            index: 0,
          }),
        ],
      },
    });

    render(
      <NotePaperStrictPanel
        docId="doc-d3-wr"
        hydrateTransport={transport}
        presentationMode="react-rows"
        mdPrefixBinding={binding}
        onMdPrefixCommit={(r) => commits.push(r)}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-md-prefix-write-mode',
        'writable'
      );
    });

    const leaf = screen.getByTestId('note-strict-leaf-p-wr');
    expect(leaf).toHaveAttribute('data-md-prefix-leaf-mode', 'writable');

    await act(async () => {
      leaf.textContent = '- ';
      fireEvent.input(leaf);
    });

    await waitFor(() => {
      expect(binding.collab!.wireCalls.length).toBe(1);
    });
    expect(binding.collab!.wireCalls[0]).toContain('pending_turn_into_flavour');
    expect(binding.collab!.wireCalls[0]).toContain('bullet');
    expect(applied).toHaveLength(1);
    // 行 flavour 仍来自投影，**不**因 pending 变 bullet
    const row = screen.getByTestId('note-strict-block-p-wr');
    expect(row).toHaveAttribute('data-flavour', 'paragraph');
    expect(commits.some((c) => (c as { ok?: boolean }).ok === true)).toBe(true);
  });

  it('conn_d3_slash_and_mdprefix_channels_do_not_wipe', async () => {
    // IntentSink ∥ TurnIntoSink 分通道；mdPrefix 产品路径与 slash 并列不互抹
    const slashMock = createMockIntentSink();
    const mdMock = createMockTurnIntoSink();
    const mdBinding = createProductMdPrefixBinding({
      turnIntoSink: mdMock.sink,
    });

    const slash = buildSlashInsertIntent({
      blockId: 'x',
      offset: 0,
      flavour: 'code',
      catalogItemId: 'code',
      createIntentId: () => 'slash-1',
    });
    const slashSubmit = await submitIntent(slash, slashMock.sink, {
      isComposing: false,
    });
    expect(slashSubmit.ok).toBe(true);
    expect(slashMock.calls).toHaveLength(1);

    const sim = await simulateProductMdPrefixSubmit({
      blockId: 'x',
      prefixText: '# ',
      fromFlavour: 'paragraph',
      binding: mdBinding,
      createIntentId: () => 'md-1',
    });
    expect(sim.commit.ok).toBe(true);

    // 两侧各自保留；md 不得抹 slash
    expect(slashMock.calls).toHaveLength(1);
    expect(slashMock.calls[0]).toMatchObject({
      type: 'slash_insert',
      intentId: 'slash-1',
    });
    expect(mdMock.calls).toHaveLength(1);
    expect(mdMock.calls[0]!.flavour).toBe('heading-1');
  });
});
