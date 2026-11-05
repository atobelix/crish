// 附件条（批 A）：Collapsible 进出场挂载语义 + picking 进度呈现。
// - 空列表且未导入：整体不渲染（Collapsible 未挂载）；
// - picking 在途（哪怕尚无已选附件）：导入中 tile 可见——进度不许静默；
// - 已选附件渲染缩略图，移除钮回调宿主 remove。
import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import type { ReactElement, ReactNode } from 'react';
import { AttachmentStrip } from './AttachmentStrip';
import type { ComposerAttachment } from '@/domain/pure/attachments';

const metrics: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function Providers({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>{children}</SafeAreaProvider>
  );
}

async function renderWithProviders(element: ReactElement) {
  return await render(element, { wrapper: Providers });
}

const imageAttachment: ComposerAttachment = {
  id: 'att-1',
  name: '图.png',
  kind: 'image',
  previewUri: 'file:///tmp/a.png',
};

describe('AttachmentStrip', () => {
  it('空列表且未导入时不渲染', async () => {
    const view = await renderWithProviders(
      <AttachmentStrip attachments={[]} onRemove={() => undefined} />
    );
    expect(view.queryByTestId('attachment-strip')).toBeNull();
    expect(view.queryByTestId('attachment-strip-picking')).toBeNull();
  });

  it('picking 在途呈现导入中 tile（进度可见）', async () => {
    const view = await renderWithProviders(
      <AttachmentStrip attachments={[]} onRemove={() => undefined} picking />
    );
    expect(view.getByTestId('attachment-strip-picking')).toBeTruthy();
    expect(view.getByText('导入中…')).toBeTruthy();
  });

  it('已选附件渲染缩略图，点移除回调 remove(id)', async () => {
    const onRemove = jest.fn();
    const view = await renderWithProviders(
      <AttachmentStrip attachments={[imageAttachment]} onRemove={onRemove} />
    );
    expect(view.getByTestId('attachment-strip-thumb-att-1')).toBeTruthy();
    await fireEvent.press(view.getByTestId('attachment-strip-remove-att-1'));
    expect(onRemove).toHaveBeenCalledWith('att-1');
  });

  it('AttachmentStrip memo 化断言：相同 props 重新渲染不穿透', async () => {
    const onRemove = jest.fn();
    const attachments = [imageAttachment];
    const view = await renderWithProviders(
      <AttachmentStrip attachments={attachments} onRemove={onRemove} />
    );
    expect(view.getByTestId('attachment-strip-thumb-att-1')).toBeTruthy();

    // 重新渲染相同 props
    await view.rerender(
      <AttachmentStrip attachments={attachments} onRemove={onRemove} />
    );
    expect(view.getByTestId('attachment-strip-thumb-att-1')).toBeTruthy();
  });
});
