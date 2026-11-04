// WebContentBlock 宿主断言（批 E)：占位高 → 回传定高；错误 / 超时回落
// 原文等宽呈现（不空白、不假图）。WebView 由 jest.setup 全局 mock 为
// 透传 props 的 View，本文件经实例树 queryAll 定位它、直调其 onMessage
// 注入回传——事件驱动须包在 await 过的 act 里（React 19 act 返回
// thenable，未 await 的 act 作用域会与后续 render 交错污染；fireEvent
// 对本 mock 的合成事件不达 handler 口径，2026-11-03 探针实测）。
import { act, render, screen } from '@testing-library/react-native';
import type { TestInstance } from 'test-renderer';
import { WebContentBlock } from './WebContentBlock';

function findWebViewInstance(): TestInstance {
  const root = screen.root;
  if (!root) throw new Error('尚未渲染');
  const matches = root.queryAll(
    (node) =>
      typeof (node.props?.source as { html?: unknown } | undefined)?.html ===
      'string'
  );
  const found = matches[0];
  if (!found) throw new Error('未找到 WebView 节点');
  return found;
}

function webViewStyleHeight(): number {
  const style = findWebViewInstance().props.style as { height?: number };
  return style.height ?? -1;
}

async function postMessage(data: unknown): Promise<void> {
  const onMessage = findWebViewInstance().props.onMessage as (event: {
    nativeEvent: { data: string };
  }) => void;
  await act(async () => {
    onMessage({ nativeEvent: { data: JSON.stringify(data) } });
  });
}

describe('WebContentBlock', () => {
  it('初始占位高 → 高度回传后定高', async () => {
    await render(
      <WebContentBlock kind="math" source="E = mc^2" testID="web-math" />
    );
    expect(screen.getByTestId('web-math')).toBeTruthy();
    expect(webViewStyleHeight()).toBe(56);
    await postMessage({ t: 'h', h: 123.4 });
    expect(webViewStyleHeight()).toBe(124);
  });

  it('渲染错误回传 → 回落原文等宽呈现', async () => {
    await render(
      <WebContentBlock kind="math" source="\bad{" testID="web-math" />
    );
    await postMessage({ t: 'err', m: 'KaTeX parse error' });
    expect(screen.getByTestId('web-math-fallback')).toBeTruthy();
    expect(screen.getByText('\\bad{')).toBeTruthy();
    expect(screen.queryByTestId('web-math')).toBeNull();
  });

  it('超时未回传高度 → 判失败回落', async () => {
    jest.useFakeTimers();
    try {
      await render(
        <WebContentBlock
          kind="mermaid"
          source="graph TD; A-->B;"
          testID="web-graph"
        />
      );
      expect(webViewStyleHeight()).toBe(192);
      await act(async () => {
        jest.advanceTimersByTime(5_000);
      });
      expect(screen.getByTestId('web-graph-fallback')).toBeTruthy();
      expect(screen.getByText('graph TD; A-->B;')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('非协议消息忽略，不影响呈现', async () => {
    await render(<WebContentBlock kind="math" source="x" testID="web-math" />);
    const onMessage = findWebViewInstance().props.onMessage as (event: {
      nativeEvent: { data: string };
    }) => void;
    await act(async () => {
      onMessage({ nativeEvent: { data: 'not-json' } });
    });
    expect(screen.getByTestId('web-math')).toBeTruthy();
    expect(screen.queryByTestId('web-math-fallback')).toBeNull();
  });
});
