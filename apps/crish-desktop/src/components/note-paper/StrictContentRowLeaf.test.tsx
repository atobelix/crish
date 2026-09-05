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
  BlockChromeModel,
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
import { NotePaperStrictBody } from './NotePaperStrictBody';
import { EditSessionRegistry } from '../../api/editSession';

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
    const sessions = new EditSessionRegistry();
    render(
      <StrictContentRowLeaf
        blockId="b-wr"
        flavour="paragraph"
        text=""
        turnIntoSink={mock.sink}
        mdPrefixWriteMode="writable"
        mdPrefixSinkSource="injected-sink"
        onMdPrefixCommit={onCommit}
        editSession={sessions}
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
    // R2-a②：commit 成功后编辑会话已关闭（显式复位 dirty，投影可再写入）
    expect(sessions.isOpen('b-wr')).toBe(false);
  });

  it('conn_d3_leaf_composing_input_no_sink', async () => {
    const mock = createMockTurnIntoSink();
    render(
      <StrictContentRowLeaf
        blockId="b-ime"
        flavour="paragraph"
        text=""
        turnIntoSink={mock.sink}
        editSession={new EditSessionRegistry()}
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

  it('conn_d3_leaf_commit_then_projection_refresh_rewrites', async () => {
    // R2-a② 验收：本地编辑 commit 成功后，投影再次刷新能写入该叶
    // （dirty 后投影可重覆盖——dirty-after-commit 不再永久脱节）。
    const mock = createMockTurnIntoSink();
    const sessions = new EditSessionRegistry();
    const props = {
      blockId: 'b-reproj',
      flavour: 'paragraph',
      turnIntoSink: mock.sink,
      mdPrefixWriteMode: 'writable' as const,
      mdPrefixSinkSource: 'injected-sink' as const,
      editSession: sessions,
      baseRev: 2,
    };
    const { rerender } = render(<StrictContentRowLeaf {...props} text="" />);
    const leaf = screen.getByTestId('note-strict-leaf-b-reproj');
    expect(sessions.isOpen('b-reproj')).toBe(false);

    // 本地编辑行首 `# ` → commit 成功 → 会话关闭（baseRev 2 → committedRev 3）
    await act(async () => {
      leaf.textContent = '# ';
      fireEvent.input(leaf);
    });
    await waitFor(() => {
      expect(mock.calls).toHaveLength(1);
    });
    expect(sessions.isOpen('b-reproj')).toBe(false);

    // 投影再次刷新（远端合并/回退/元数据更新）→ 叶可被覆盖写入
    rerender(<StrictContentRowLeaf {...props} text="远端合并后的正文" />);
    expect(leaf.textContent).toBe('远端合并后的正文');
  });

  it('conn_d3_leaf_session_open_blocks_projection_until_invalidate', async () => {
    // R2-a②：会话持有期内投影不覆盖本地编辑；invalidate（撤回/截断/conflict）
    // 后会话关闭，投影可重写入——编辑会话关闭即复位（非开环）。
    const mock = createMockTurnIntoSink();
    const sessions = new EditSessionRegistry();
    const props = {
      blockId: 'b-hold',
      flavour: 'paragraph',
      turnIntoSink: mock.sink,
      mdPrefixWriteMode: 'writable' as const,
      mdPrefixSinkSource: 'injected-sink' as const,
      editSession: sessions,
    };
    const { rerender } = render(<StrictContentRowLeaf {...props} text="" />);
    const leaf = screen.getByTestId('note-strict-leaf-b-hold');

    // 输入无前缀普通文本：会话 open；commit 被库拒（无完整前缀）→ 会话保持 open
    await act(async () => {
      leaf.textContent = '本地编辑未提交';
      fireEvent.input(leaf);
    });
    expect(sessions.isOpen('b-hold')).toBe(true);

    // 投影刷新（外部变更）→ 持有期内不覆盖本地编辑
    rerender(<StrictContentRowLeaf {...props} text="远端投影正文" />);
    expect(leaf.textContent).toBe('本地编辑未提交');

    // 外部失效（collab conflict 事件）→ 编辑面立即失效、会话关闭
    sessions.invalidate('b-hold', 'collab-conflict');
    expect(sessions.isOpen('b-hold')).toBe(false);

    // 失效后投影刷新可重写入
    rerender(<StrictContentRowLeaf {...props} text="失效后投影正文" />);
    expect(leaf.textContent).toBe('失效后投影正文');
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

// ---------------------------------------------------------------------------
// 普通文本输入与空笔记态直接编辑交互
// ---------------------------------------------------------------------------

describe('StrictContentRowLeaf & NotePaperStrictBody · 直接编辑交互', () => {
  it('strict_leaf_plain_text_input_triggers_callbacks_and_not_blocked', async () => {
    const onTextChange = vi.fn();
    const onTextCommit = vi.fn();
    const sessions = new EditSessionRegistry();
    render(
      <StrictContentRowLeaf
        blockId="leaf-plain"
        flavour="paragraph"
        text=""
        turnIntoSink={createMockTurnIntoSink().sink}
        onTextChange={onTextChange}
        onTextCommit={onTextCommit}
        editSession={sessions}
      />
    );
    const leaf = screen.getByTestId('note-strict-leaf-leaf-plain');

    // 键入普通中文文本（非 Markdown 前缀）
    await act(async () => {
      leaf.textContent = '普通汉字文本输入内容';
      fireEvent.input(leaf);
    });

    // 正常更新状态并触发 onTextChange 回调，不被阻断
    expect(onTextChange).toHaveBeenCalledWith(
      'leaf-plain',
      '普通汉字文本输入内容'
    );
    expect(sessions.isOpen('leaf-plain')).toBe(true);

    // 回车提交
    await act(async () => {
      fireEvent.keyDown(leaf, { key: 'Enter' });
    });
    expect(onTextCommit).toHaveBeenCalledWith(
      'leaf-plain',
      '普通汉字文本输入内容'
    );

    // 失焦提交
    await act(async () => {
      fireEvent.blur(leaf);
    });
    expect(onTextCommit).toHaveBeenCalledTimes(2);
  });

  it('strict_body_empty_click_initializes_first_row_and_focuses', async () => {
    const onInit = vi.fn();
    const chrome = new BlockChromeModel();
    render(
      <NotePaperStrictBody
        status="empty"
        errorReason={null}
        errorCode={null}
        blocks={[]}
        renderReactRows={true}
        chrome={chrome}
        onInitFirstBlock={onInit}
      />
    );

    const empty = screen.getByTestId('note-paper-strict-empty');
    expect(empty).toBeInTheDocument();

    // 点击空白正文区域
    await act(async () => {
      fireEvent.click(empty);
    });

    // 自动初始化第一行
    expect(onInit).toHaveBeenCalledTimes(1);
    const firstBlock = screen.getByTestId('note-strict-block-init-first-block');
    expect(firstBlock).toBeInTheDocument();
    const editableLeaf = screen.getByTestId(
      'note-strict-leaf-init-first-block'
    );
    expect(editableLeaf).toHaveAttribute('contenteditable', 'true');
  });
});
