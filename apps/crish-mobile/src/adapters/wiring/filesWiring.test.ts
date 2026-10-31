// filesWiring 单测（R2-06b 文件域接线装配）：
// - createFilesContext：仓库 + 目录缓存 + 预览缓存三件套装配（时钟注入）；
// - getFilesContext 单例语义：首取装配 / 复用 / 接线未启动 → null / 测试复位；
// - joinRelPath / workspaceNameOf 纯函数（根级/多级/尾斜杠/空串兜底）。
import { WsGateway } from '@/network/WsGateway';
import { authStore } from '@/domain/store/authStore';
import {
  createFilesContext,
  getFilesContext,
  resetFilesContextForTest,
} from './filesWiring';
import { joinRelPath, workspaceNameOf } from '@/domain/pure/workspacePath';
import type { WsSocket } from '@/network/ReconnectingWsClient';
import {
  ensureObservationWiring,
  resetObservationWiringForTest,
} from './observationWiring';

function makeGateway(): WsGateway {
  return new WsGateway({ send: () => {} });
}

/** mock socket（ReconnectingWsClient 工厂注入面，避免 jest 环境真实 WS） */
function mockSocketFactory(): WsSocket {
  return {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: () => {},
    close: () => {},
  };
}

beforeEach(() => {
  resetFilesContextForTest();
  resetObservationWiringForTest();
  // ensureObservationWiring 经 authStore.host 解析端点（host 为空 → 不启动返回 null）
  authStore.setState({ host: '192.168.1.100', pairState: 'paired' });
});

afterEach(() => {
  // 收口未打开的连接（握手看门狗等句柄），杜绝 jest worker 强退告警
  resetObservationWiringForTest();
});

describe('createFilesContext（R2-06b 装配）', () => {
  it('装配 repository + dirCache + previewCache 三件套', () => {
    const ctx = createFilesContext(makeGateway(), () => 1000);
    expect(ctx.repository).toBeDefined();
    expect(ctx.dirCache).toBeDefined();
    expect(ctx.previewCache).toBeDefined();
    // 缓存规格（F4 §5.2 / R2UX-06-02）由 filesCache 缺省保证，此处验证装配面完整
    expect(typeof ctx.repository.listDir).toBe('function');
  });

  it('时钟不注入时走 Date.now 缺省', () => {
    const ctx = createFilesContext(makeGateway());
    expect(ctx.dirCache).toBeDefined();
  });
});

describe('getFilesContext 单例语义', () => {
  it('接线未启动 → null（VM 投影「未连接」错误态）', () => {
    expect(getFilesContext()).toBeNull();
  });

  it('接线启动后首取装配；重复调用复用同一单例', () => {
    ensureObservationWiring({
      gateway: makeGateway(),
      factory: mockSocketFactory,
    });
    const first = getFilesContext();
    const second = getFilesContext();
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it('resetFilesContextForTest 清空单例（下次调用重新装配）', () => {
    ensureObservationWiring({
      gateway: makeGateway(),
      factory: mockSocketFactory,
    });
    expect(getFilesContext()).not.toBeNull();
    resetFilesContextForTest();
    expect(getFilesContext()).not.toBeNull();
    expect(getFilesContext()).not.toBeNull(); // 复位后重新装配仍可用
  });
});

describe('joinRelPath（F4 §1.2 relPath 语义）', () => {
  it('根级：父路径为空 → 直接条目名', () => {
    expect(joinRelPath('', 'src')).toBe('src');
  });

  it('多级：父目录 + 条目名以 / 拼接', () => {
    expect(joinRelPath('src', 'pages')).toBe('src/pages');
    expect(joinRelPath('src/pages', 'login.ts')).toBe('src/pages/login.ts');
  });
});

describe('workspaceNameOf（工作区根展示名）', () => {
  it('取路径叶名（POSIX 分隔）', () => {
    expect(workspaceNameOf('/workspace/project-a')).toBe('project-a');
  });

  it('取路径叶名（Windows 分隔）', () => {
    expect(workspaceNameOf('C:\\Software\\conex')).toBe('conex');
  });

  it('尾斜杠/根符号清理后兜底「工作区」', () => {
    expect(workspaceNameOf('/workspace/project-a/')).toBe('project-a');
    expect(workspaceNameOf('/')).toBe('工作区');
    expect(workspaceNameOf('')).toBe('工作区');
  });
});
