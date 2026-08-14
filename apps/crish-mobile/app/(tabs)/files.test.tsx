// 文件页路由测试（R2-06b 页面级冒烟 + R2-16 §3.2 第 11 项热区修复）：
// - 渲染冒烟：标题「文件」+ 工作区按钮存在；未连接 → FileBrowser 投影
//   「未连接」错误态（bootstrap/loadDir effect 依赖 phase ready 不触发，
//   渲染冒烟无需连接，任务书口径）；
// - 热区断言（R2-16 §3.2 表项 11）：工作区按钮视觉 minHeight 36 →
//   dualHitSlop(36) 补足 iOS 44pt（全向补 4）/ Android 48dp（全向补 6）；
// - press 工作区按钮 → workspace-sheet 出现（不依赖连接：openWorkspaceList
//   未接线直接返回，本地 workspaceOpen 态弹出工作区选择器）。
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { connectionStore } from '@/domain/store/connectionStore';
import { filesStore } from '@/domain/store/filesStore';
import { resetFilesContextForTest } from '@/adapters/wiring/filesWiring';
import FilesScreen from './files';

// jest-expo 默认解析 ios 平台（haste defaultPlatform=ios）；Android 分支用例临时改写 Platform.OS
const ORIGINAL_OS = Platform.OS;

beforeEach(() => {
  connectionStore.setState({ phase: 'disconnected' });
  filesStore.getState().resetWorkspace(null);
  resetFilesContextForTest();
});

afterEach(() => {
  Platform.OS = ORIGINAL_OS;
});

describe('文件页（R2-06b）', () => {
  it('渲染冒烟：标题「文件」+ 工作区按钮 + 未连接错误态（无需连接）', async () => {
    await render(<FilesScreen />);
    expect(screen.getByText('文件')).toBeTruthy();
    expect(screen.getByTestId('files-workspace-button')).toBeTruthy();
    expect(screen.getByText(/选择工作区/)).toBeTruthy();
    expect(screen.getByTestId('files-error-state')).toBeTruthy();
    expect(screen.getByText('未连接')).toBeTruthy();
  });

  it('热区（R2-16 §3.2 第 11 项）：iOS 视觉 36 + dualHitSlop(36) 全向补 4 → 44pt', async () => {
    await render(<FilesScreen />);
    expect(screen.getByTestId('files-workspace-button').props.hitSlop).toEqual({
      top: 4,
      bottom: 4,
      left: 4,
      right: 4,
    });
  });

  it('热区（Android 48dp）：视觉 36 全向补 6 → 命中热区 48dp', async () => {
    Platform.OS = 'android';
    await render(<FilesScreen />);
    expect(screen.getByTestId('files-workspace-button').props.hitSlop).toEqual({
      top: 6,
      bottom: 6,
      left: 6,
      right: 6,
    });
  });

  it('press 工作区按钮 → workspace-sheet 出现（不依赖连接）', async () => {
    await render(<FilesScreen />);
    await fireEvent.press(screen.getByTestId('files-workspace-button'));
    expect(screen.getByTestId('workspace-sheet')).toBeTruthy();
  });
});
