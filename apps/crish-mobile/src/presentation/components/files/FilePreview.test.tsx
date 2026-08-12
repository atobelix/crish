// FilePreview 组件测试（R2-06b）：文本渲染 / 占位态（过大/二进制/编码）/
// 错误重试 / 续读截断（F4-F27）/ 敏感横幅（F4-F28）/ 返回
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { FileEntry } from '@/domain/types/domain';
import type { FilePreviewVm } from '@/adapters/viewmodels/useFilePreviewVm';
import { FilePreview, numberedLines } from './FilePreview';

function makeFile(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    name: 'a.ts',
    isDir: false,
    size: 3277,
    modified: String(1_800_000_000_000),
    relPath: 'src/a.ts',
    receivedAtMs: 1_800_000_000_000,
    ...overrides,
  };
}

function makeVm(overrides: Partial<FilePreviewVm> = {}): FilePreviewVm {
  return {
    file: makeFile(),
    status: 'loaded',
    errorCode: null,
    content: 'line1\nline2\nline3',
    lineCount: 3,
    truncated: false,
    sensitive: false,
    lineBudget: 400,
    atCap: false,
    loadMore: jest.fn(),
    retry: jest.fn(),
    ...overrides,
  };
}

describe('numberedLines（行号渲染，F4-F20）', () => {
  it('行号从 1 开始、4 位补零、双空格分隔', () => {
    expect(numberedLines('a\nbb')).toEqual(['   1  a', '   2  bb']);
  });

  it('空内容 → 一行空行', () => {
    expect(numberedLines('')).toEqual(['   1  ']);
  });

  it('startLine 偏移', () => {
    expect(numberedLines('x', 400)).toEqual([' 401  x']);
  });
});

describe('FilePreview', () => {
  it('头部：文件名 + 相对路径 + 返回键', async () => {
    await render(<FilePreview vm={makeVm()} onBack={jest.fn()} />);
    expect(screen.getByText('a.ts')).toBeTruthy();
    expect(screen.getByText('src/a.ts')).toBeTruthy();
    expect(screen.getByTestId('preview-back')).toBeTruthy();
  });

  it('返回 → onBack', async () => {
    const onBack = jest.fn();
    await render(<FilePreview vm={makeVm()} onBack={onBack} />);
    await fireEvent.press(screen.getByTestId('preview-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('文本内容渲染（行号 + 内容）', async () => {
    await render(<FilePreview vm={makeVm()} onBack={jest.fn()} />);
    expect(screen.getByTestId('preview-content')).toBeTruthy();
    expect(screen.getByText('   1  line1')).toBeTruthy();
    expect(screen.getByText('   2  line2')).toBeTruthy();
    expect(screen.getByText('   3  line3')).toBeTruthy();
  });

  it('加载态', async () => {
    await render(
      <FilePreview
        vm={makeVm({ status: 'loading', content: '' })}
        onBack={jest.fn()}
      />
    );
    expect(screen.getByTestId('preview-loading')).toBeTruthy();
  });

  it('过大占位：1MB 超限文案（R2UX-06-02）', async () => {
    await render(
      <FilePreview
        vm={makeVm({
          status: 'too-large',
          errorCode: 'file_too_large',
          content: '',
        })}
        onBack={jest.fn()}
      />
    );
    expect(screen.getByTestId('preview-too-large')).toBeTruthy();
    expect(screen.getByText('文件过大，无法预览')).toBeTruthy();
  });

  it('二进制占位（F4-F26）', async () => {
    await render(
      <FilePreview
        vm={makeVm({ status: 'binary', errorCode: 'binary_file', content: '' })}
        onBack={jest.fn()}
      />
    );
    expect(screen.getByTestId('preview-binary')).toBeTruthy();
    expect(screen.getByText('二进制文件，无法预览')).toBeTruthy();
  });

  it('编码不支持占位', async () => {
    await render(
      <FilePreview
        vm={makeVm({
          status: 'unsupported-encoding',
          errorCode: 'unsupported_encoding',
          content: '',
        })}
        onBack={jest.fn()}
      />
    );
    expect(screen.getByTestId('preview-encoding')).toBeTruthy();
    expect(screen.getByText('文件编码不受支持')).toBeTruthy();
  });

  it('错误态：映射文案 + 重试 → onRetry', async () => {
    const vm = makeVm({
      status: 'error',
      errorCode: 'path_not_found',
      content: '',
    });
    await render(<FilePreview vm={vm} onBack={jest.fn()} />);
    expect(screen.getByTestId('preview-error')).toBeTruthy();
    expect(screen.getByText('文件或目录不存在')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('preview-retry'));
    expect(vm.retry).toHaveBeenCalledTimes(1);
  });

  it('未连接错误文案（transport.closed）', async () => {
    await render(
      <FilePreview
        vm={makeVm({
          status: 'error',
          errorCode: 'transport.closed',
          content: '',
        })}
        onBack={jest.fn()}
      />
    );
    expect(screen.getByText('未连接')).toBeTruthy();
  });

  it('截断：显示行数 + 继续加载 → onLoadMore（F4-F27）', async () => {
    const vm = makeVm({ truncated: true, lineCount: 400 });
    await render(<FilePreview vm={vm} onBack={jest.fn()} />);
    expect(screen.getByText('已显示前 400 行')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('preview-load-more'));
    expect(vm.loadMore).toHaveBeenCalledTimes(1);
  });

  it('已达 5000 行硬顶：显示「已达预览上限」，无继续加载（F4-F27）', async () => {
    const vm = makeVm({ truncated: true, lineCount: 5000, atCap: true });
    await render(<FilePreview vm={vm} onBack={jest.fn()} />);
    expect(screen.getByTestId('preview-limit')).toBeTruthy();
    expect(screen.queryByTestId('preview-load-more')).toBeNull();
  });

  it('敏感文件：警示横幅（F4-F28）', async () => {
    await render(
      <FilePreview
        vm={makeVm({
          file: makeFile({ name: '.env', relPath: '.env' }),
          sensitive: true,
        })}
        onBack={jest.fn()}
      />
    );
    expect(screen.getByTestId('preview-sensitive-banner')).toBeTruthy();
  });

  it('非敏感文件：无横幅', async () => {
    await render(<FilePreview vm={makeVm()} onBack={jest.fn()} />);
    expect(screen.queryByTestId('preview-sensitive-banner')).toBeNull();
  });

  it('file 为 null → 不渲染', async () => {
    await render(
      <FilePreview vm={makeVm({ file: null })} onBack={jest.fn()} />
    );
    expect(screen.queryByTestId('preview-back')).toBeNull();
  });
});
