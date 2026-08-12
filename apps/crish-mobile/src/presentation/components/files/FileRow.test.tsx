// FileRow 组件测试（R2-06b）：图标/名称/meta/敏感标记/点击回调
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { FileEntry } from '@/domain/types/domain';
import { FileRow, rowMetaText } from './FileRow';

const NOW = 1_800_000_000_000;

function makeEntry(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    name: 'a.ts',
    isDir: false,
    size: 3277,
    modified: String(NOW - 2 * 3_600_000),
    relPath: 'a.ts',
    receivedAtMs: NOW,
    ...overrides,
  };
}

describe('rowMetaText（F4-F17 meta 文案）', () => {
  it('文件：大小 · 相对时间', () => {
    expect(rowMetaText(makeEntry(), NOW)).toBe('3.2K · 2 小时前');
  });

  it('目录：空文案', () => {
    expect(rowMetaText(makeEntry({ isDir: true }), NOW)).toBe('');
  });

  it('缺 size/modified：只显示存在项', () => {
    expect(
      rowMetaText(makeEntry({ size: undefined, modified: undefined }), NOW)
    ).toBe('');
    expect(rowMetaText(makeEntry({ size: undefined }), NOW)).toBe('2 小时前');
    expect(rowMetaText(makeEntry({ modified: undefined }), NOW)).toBe('3.2K');
  });
});

describe('FileRow', () => {
  it('目录行：📁 图标 + 名称，无 meta', async () => {
    const onPress = jest.fn();
    await render(
      <FileRow
        entry={makeEntry({ name: 'src', isDir: true, relPath: 'src' })}
        rowHeight={48}
        onPress={onPress}
      />
    );
    expect(screen.getByTestId('file-row-dir')).toBeTruthy();
    expect(screen.getByText('📁')).toBeTruthy();
    expect(screen.getByText('src')).toBeTruthy();
    expect(screen.queryByTestId('file-row-meta')).toBeNull();
  });

  it('文件行：类型字形 + 名称 + meta（大小 · 相对时间）', async () => {
    // FileRow 内部用真实时钟 Date.now()，modified 相对真实 now（固定 epoch 会落在过去/未来）
    await render(
      <FileRow
        entry={makeEntry({ modified: String(Date.now() - 2 * 3_600_000) })}
        rowHeight={48}
        onPress={jest.fn()}
      />
    );
    expect(screen.getByTestId('file-row')).toBeTruthy();
    expect(screen.getByText('📄')).toBeTruthy();
    expect(screen.getByText('a.ts')).toBeTruthy();
    expect(screen.getByText('3.2K · 2 小时前')).toBeTruthy();
  });

  it('敏感文件：显示「敏感」徽标（F4 §7.1）', async () => {
    await render(
      <FileRow
        entry={makeEntry({ name: '.env', relPath: '.env' })}
        rowHeight={48}
        onPress={jest.fn()}
      />
    );
    expect(screen.getByTestId('file-row-sensitive')).toBeTruthy();
    expect(screen.getByText('敏感')).toBeTruthy();
  });

  it('普通文件：无敏感徽标', async () => {
    await render(
      <FileRow entry={makeEntry()} rowHeight={48} onPress={jest.fn()} />
    );
    expect(screen.queryByTestId('file-row-sensitive')).toBeNull();
  });

  it('点击 → onPress(entry)', async () => {
    const onPress = jest.fn();
    const entry = makeEntry();
    await render(<FileRow entry={entry} rowHeight={56} onPress={onPress} />);
    await fireEvent.press(screen.getByTestId('file-row'));
    expect(onPress).toHaveBeenCalledWith(entry);
  });

  it('行高由 rowHeight 控制（密度三档 44/48/56，R2UX-06-01）', async () => {
    await render(
      <FileRow entry={makeEntry()} rowHeight={44} onPress={jest.fn()} />
    );
    const row = screen.getByTestId('file-row');
    expect(row.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ height: 44 })])
    );
  });
});
