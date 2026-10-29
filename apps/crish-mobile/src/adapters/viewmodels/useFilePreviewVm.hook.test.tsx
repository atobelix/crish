// 文件预览 hook 测试：缓存命中、加载成功/失败、续读阶梯、竞态丢弃、敏感标记。
import { Pressable, Text } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { useFilePreviewVm, type FilePreviewVm } from './useFilePreviewVm';
import { filesStore } from '@/domain/store/filesStore';
import { FilesCommandError } from '@/adapters/wiring/filesRepository';
import type { FilesContext } from '@/adapters/wiring/filesWiring';
import type { FileEntry } from '@/domain/types/domain';

let latest: FilePreviewVm | null = null;
const contextRef: { value: FilesContext | null } = { value: null };
const fileRef: { value: FileEntry | null } = { value: null };

function Probe(): React.ReactElement {
  latest = useFilePreviewVm(fileRef.value, contextRef.value);
  return (
    <>
      <Text testID="status">{latest.status}</Text>
      <Text testID="content">{latest.content}</Text>
      <Text testID="budget">{latest.lineBudget}</Text>
      <Text testID="atCap">{String(latest.atCap)}</Text>
      <Pressable testID="loadMore" onPress={() => latest?.loadMore()}>
        <Text>more</Text>
      </Pressable>
      <Pressable testID="retry" onPress={() => latest?.retry()}>
        <Text>retry</Text>
      </Pressable>
    </>
  );
}

function fileEntry(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    name: 'a.ts',
    relPath: 'src/a.ts',
    kind: 'file',
    size: 100,
    modifiedAt: 0,
    ...overrides,
  } as FileEntry;
}

function makeContext(
  overrides: {
    readFile?: jest.Mock;
    cacheGet?: jest.Mock;
  } = {}
): FilesContext {
  return {
    repository: {
      readFile:
        overrides.readFile ??
        jest.fn(async () => ({
          content: 'line1\nline2',
          lineCount: 2,
          truncated: false,
          sensitive: false,
        })),
    },
    previewCache: {
      get: overrides.cacheGet ?? jest.fn(() => undefined),
      set: jest.fn(),
    },
  } as unknown as FilesContext;
}

beforeEach(() => {
  latest = null;
  jest.clearAllMocks();
  contextRef.value = null;
  fileRef.value = null;
  filesStore.setState({ activeWorkspaceRoot: '/w' });
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('未选择文件', () => {
  it('file 为 null 时保持 loading 且无内容', async () => {
    contextRef.value = makeContext();
    await render(<Probe />);
    expect(latest?.status).toBe('loading');
    expect(latest?.content).toBe('');
  });
});

describe('加载', () => {
  it('成功时进入 loaded 并填充内容', async () => {
    contextRef.value = makeContext();
    fileRef.value = fileEntry();
    const view = await render(<Probe />);
    await flush();

    expect(view.getByTestId('status').props.children).toBe('loaded');
    expect(view.getByTestId('content').props.children).toBe('line1\nline2');
  });

  it('缓存命中时不调用 readFile', async () => {
    const readFile = jest.fn();
    contextRef.value = makeContext({
      readFile,
      cacheGet: jest.fn(() => ({
        content: 'cached',
        lineCount: 1,
        truncated: false,
      })),
    });
    fileRef.value = fileEntry();
    const view = await render(<Probe />);
    await flush();

    expect(readFile).not.toHaveBeenCalled();
    expect(view.getByTestId('content').props.children).toBe('cached');
  });

  it('敏感文件标记 sensitive', async () => {
    contextRef.value = makeContext({
      readFile: jest.fn(async () => ({
        content: 'secret',
        lineCount: 1,
        truncated: false,
        sensitive: true,
      })),
    });
    fileRef.value = fileEntry();
    await render(<Probe />);
    await flush();

    expect(latest?.sensitive).toBe(true);
  });

  it('未接线时保持 loading（连接恢复后重试）', async () => {
    contextRef.value = null;
    fileRef.value = fileEntry();
    await render(<Probe />);
    await flush();

    expect(latest?.status).toBe('loading');
  });
});

describe('错误映射', () => {
  it('file.too_large → too-large 占位态', async () => {
    contextRef.value = makeContext({
      readFile: jest.fn(async () => {
        throw new FilesCommandError('file.too_large', 'too big');
      }),
    });
    fileRef.value = fileEntry();
    const view = await render(<Probe />);
    await flush();

    expect(view.getByTestId('status').props.children).toBe('too-large');
  });

  it('file.binary → binary 占位态', async () => {
    contextRef.value = makeContext({
      readFile: jest.fn(async () => {
        throw new FilesCommandError('file.binary', 'binary');
      }),
    });
    fileRef.value = fileEntry();
    const view = await render(<Probe />);
    await flush();

    expect(view.getByTestId('status').props.children).toBe('binary');
  });

  it('未知错误 → error 可重试态', async () => {
    contextRef.value = makeContext({
      readFile: jest.fn(async () => {
        throw new Error('boom');
      }),
    });
    fileRef.value = fileEntry();
    const view = await render(<Probe />);
    await flush();

    expect(view.getByTestId('status').props.children).toBe('error');
    expect(latest?.errorCode).toBe('internal');
  });
});

describe('续读阶梯', () => {
  it('truncated 时 loadMore 提升预算并重拉', async () => {
    const readFile = jest.fn(async () => ({
      content: 'x',
      lineCount: 400,
      truncated: true,
      sensitive: false,
    }));
    contextRef.value = makeContext({ readFile });
    fileRef.value = fileEntry();
    const view = await render(<Probe />);
    await flush();

    expect(latest?.lineBudget).toBe(400);
    fireEvent.press(view.getByTestId('loadMore'));
    await flush();

    expect(readFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ maxLines: 800 })
    );
  });
});
