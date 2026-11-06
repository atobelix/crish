// 输入隔离：编辑缓冲留在输入组件内。父级只在空与非空切换、
// 失焦和发送时收到全文，避免主页和会话视图模型逐字重渲染。
import { useState } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react-native';
import { Composer } from './Composer';
import {
  configureComposerDraftPersistence,
  peekComposerDraft,
  resetComposerDraftsForTest,
  type ComposerDraftPersist,
} from '@/domain/store/composerDraftStore';

class MemoryPersist implements ComposerDraftPersist {
  readonly map = new Map<string, string>();
  readonly setCalls: string[] = [];
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.setCalls.push(value);
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

function Parent(props: {
  onSubmit: (text?: string) => void;
  draftKey?: string;
  initial?: string;
  forced?: string | null;
  maxLength?: number;
  canSubmit?: boolean;
}) {
  const [value, setValue] = useState(props.initial ?? '');
  propsRef.renders += 1;
  const shown = props.forced ?? value;
  return (
    <Composer
      testID="composer"
      value={shown}
      onChangeText={setValue}
      onSubmit={props.onSubmit}
      canSubmit={props.canSubmit ?? shown.trim().length > 0}
      editable
      draftKey={props.draftKey}
      maxLength={props.maxLength}
    />
  );
}

const propsRef = { renders: 0 };

beforeEach(() => {
  propsRef.renders = 0;
  resetComposerDraftsForTest();
});

afterEach(() => {
  cleanup();
  resetComposerDraftsForTest();
});

describe('Composer 输入隔离', () => {
  it('连续键入只在空与非空切换时让父级重渲染，发送的是最新文本', async () => {
    const onSubmit = jest.fn();
    const view = await render(<Parent onSubmit={onSubmit} />);
    const baseline = propsRef.renders;
    const input = view.getByTestId('composer');
    await fireEvent.changeText(input, '你');
    await fireEvent.changeText(input, '你好');
    await fireEvent.changeText(input, '你好吗');
    expect(propsRef.renders).toBe(baseline + 1);
    expect(input.props.value).toBe('你好吗');
    await fireEvent.press(view.getByTestId('composer-send'));
    expect(onSubmit).toHaveBeenCalledWith('你好吗');
  });

  it('清空后不再通知中间文本，发送钮随空稿消失', async () => {
    const view = await render(<Parent onSubmit={jest.fn()} />);
    const input = view.getByTestId('composer');
    await fireEvent.changeText(input, 'a');
    const afterFirst = propsRef.renders;
    await fireEvent.changeText(input, '');
    expect(propsRef.renders).toBe(afterFirst + 1);
    expect(view.queryByTestId('composer-send')).toBeNull();
  });

  it('外部覆盖替换缓冲，发送不再使用被覆盖的旧文本', async () => {
    const onSubmit = jest.fn();
    const view = await render(<Parent onSubmit={onSubmit} />);
    await fireEvent.changeText(view.getByTestId('composer'), '正在打');
    await view.rerender(<Parent onSubmit={onSubmit} forced="语音回填" />);
    expect(view.getByTestId('composer').props.value).toBe('语音回填');
    await fireEvent.press(view.getByTestId('composer-send'));
    expect(onSubmit).toHaveBeenCalledWith('语音回填');
  });

  it('失焦把最新全文同步给父级，草稿内存即时、落盘在刷盘时', async () => {
    const persist = new MemoryPersist();
    configureComposerDraftPersistence(persist);
    const view = await render(
      <Parent onSubmit={jest.fn()} draftKey="remote:s-1" />
    );
    const input = view.getByTestId('composer');
    await fireEvent.changeText(input, '你');
    await fireEvent.changeText(input, '你好');
    expect(peekComposerDraft('remote:s-1')).toBe('你好');
    expect(persist.setCalls).toEqual([]);
    await fireEvent(input, 'blur');
    expect(peekComposerDraft('remote:s-1')).toBe('你好');
    expect(persist.map.get('chat.draft.remote:s-1')).toBe('你好');
  });

  it('组合字素与粘贴保持原文，选择变化不改写缓冲', async () => {
    const onSubmit = jest.fn();
    const view = await render(<Parent onSubmit={onSubmit} />);
    const input = view.getByTestId('composer');
    await fireEvent.changeText(input, 'e');
    await fireEvent.changeText(input, 'e\u0301');
    await fireEvent.changeText(input, '👨‍👩‍👧‍👦');
    await fireEvent(input, 'selectionChange', {
      nativeEvent: { selection: { start: 1, end: 2 } },
    });
    expect(input.props.selection).toBeUndefined();
    expect(input.props.value).toBe('👨‍👩‍👧‍👦');
    await fireEvent.changeText(input, '第一行\n第二行');
    await fireEvent.press(view.getByTestId('composer-send'));
    expect(onSubmit).toHaveBeenCalledWith('第一行\n第二行');
  });

  it('父级回填已恢复的草稿后，继续键入仍写回同一草稿键', async () => {
    const persist = new MemoryPersist();
    configureComposerDraftPersistence(persist);
    const view = await render(
      <Parent onSubmit={jest.fn()} draftKey="local:t-1" initial="已恢复" />
    );
    const input = view.getByTestId('composer');
    expect(input.props.value).toBe('已恢复');
    await fireEvent.changeText(input, '已恢复呀');
    expect(peekComposerDraft('local:t-1')).toBe('已恢复呀');
    await fireEvent(input, 'blur');
    expect(persist.map.get('chat.draft.local:t-1')).toBe('已恢复呀');
  });

  it('切换草稿键先刷旧键，新键不继承上一份缓冲', async () => {
    const persist = new MemoryPersist();
    configureComposerDraftPersistence(persist);
    const onSubmit = jest.fn();
    const view = await render(
      <Parent onSubmit={onSubmit} draftKey="remote:s-1" />
    );
    const input = view.getByTestId('composer');
    await fireEvent.changeText(input, '你');
    await fireEvent.changeText(input, '你好');
    await view.rerender(
      <Parent onSubmit={onSubmit} draftKey="remote:s-2" forced="" />
    );
    expect(view.getByTestId('composer').props.value).toBe('');
    expect(peekComposerDraft('remote:s-1')).toBe('你好');
    expect(persist.map.get('chat.draft.remote:s-1')).toBe('你好');
    expect(peekComposerDraft('remote:s-2')).toBe('');
    await fireEvent.changeText(view.getByTestId('composer'), '乙');
    expect(peekComposerDraft('remote:s-2')).toBe('乙');
    expect(peekComposerDraft('remote:s-1')).toBe('你好');
  });

  it('发送后父级不改值时缓冲仍保留全文', async () => {
    const onSubmit = jest.fn();
    const view = await render(<Parent onSubmit={onSubmit} />);
    await fireEvent.changeText(view.getByTestId('composer'), '待重试');
    await fireEvent.press(view.getByTestId('composer-send'));
    expect(onSubmit).toHaveBeenCalledWith('待重试');
    expect(view.getByTestId('composer').props.value).toBe('待重试');
  });

  it('超过 maxLength 的文本按输入框上限截断', async () => {
    const view = await render(
      <Parent onSubmit={jest.fn()} maxLength={2} canSubmit />
    );
    const input = view.getByTestId('composer');
    expect(input.props.maxLength).toBe(2);
    await fireEvent.changeText(input, '你好吗');
    expect(input.props.value).toBe('你好');
  });

  it('输入法组合过程只在空与非空切换时通知父级，提交用定稿', async () => {
    const onSubmit = jest.fn();
    const view = await render(<Parent onSubmit={onSubmit} />);
    const baseline = propsRef.renders;
    const input = view.getByTestId('composer');
    await fireEvent.changeText(input, 'n');
    await fireEvent.changeText(input, 'ni');
    await fireEvent.changeText(input, '你');
    expect(propsRef.renders).toBe(baseline + 1);
    expect(input.props.value).toBe('你');
    await fireEvent(input, 'endEditing');
    await fireEvent.press(view.getByTestId('composer-send'));
    expect(onSubmit).toHaveBeenCalledWith('你');
  });

  it('父级仍是首字快照时，重挂载从草稿真源恢复全文', async () => {
    const view = await render(
      <Parent onSubmit={jest.fn()} draftKey="remote:s-1" />
    );
    const input = view.getByTestId('composer');
    await fireEvent.changeText(input, '你');
    await fireEvent.changeText(input, '你好');
    await act(async () => {
      view.unmount();
    });
    const restored = await render(
      <Parent onSubmit={jest.fn()} draftKey="remote:s-1" initial="你" />
    );
    expect(restored.getByTestId('composer').props.value).toBe('你好');
  });

  it('外部清空会把草稿真源写成空串', async () => {
    const persist = new MemoryPersist();
    configureComposerDraftPersistence(persist);
    const view = await render(
      <Parent onSubmit={jest.fn()} draftKey="remote:s-1" />
    );
    const input = view.getByTestId('composer');
    await fireEvent.changeText(input, '待发');
    expect(peekComposerDraft('remote:s-1')).toBe('待发');
    await view.rerender(
      <Parent onSubmit={jest.fn()} draftKey="remote:s-1" forced="" />
    );
    expect(view.getByTestId('composer').props.value).toBe('');
    expect(peekComposerDraft('remote:s-1')).toBe('');
  });

  it('远程父级只持有空非空快照时，提交回调拿到缓冲全文', async () => {
    const sent: string[] = [];
    function RemoteParent() {
      const [prompt, setPrompt] = useState('');
      propsRef.renders += 1;
      const submit = (explicit?: string) => {
        const text = explicit ?? prompt;
        sent.push(text);
        setPrompt('');
      };
      return (
        <Composer
          testID="composer"
          value={prompt}
          onChangeText={setPrompt}
          onSubmit={submit}
          canSubmit={prompt.trim().length > 0}
          editable
          draftKey="remote:s-1"
        />
      );
    }
    const view = await render(<RemoteParent />);
    const baseline = propsRef.renders;
    const input = view.getByTestId('composer');
    await fireEvent.changeText(input, '旧');
    await fireEvent.changeText(input, '新稿');
    expect(propsRef.renders).toBe(baseline + 1);
    await fireEvent.press(view.getByTestId('composer-send'));
    expect(sent).toEqual(['新稿']);
  });
});
