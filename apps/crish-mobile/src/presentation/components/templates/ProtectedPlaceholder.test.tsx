// 受保护占位页冒烟测试（D4 §8.6 深链守卫）：未配对 → 跳配对页；已配对 → 渲染占位
import { render, screen } from '@testing-library/react-native';
import { authStore } from '@/domain/store/authStore';
import ProtectedPlaceholder from './ProtectedPlaceholder';

// Redirect 来自 expo-router（jest 环境无 router 上下文）——mock 为可断言组件
jest.mock('expo-router', () => ({
  Redirect: () => null,
}));

function resetAuth(): void {
  authStore.setState({ pairState: 'unpaired', hydrated: true });
}

beforeEach(() => {
  resetAuth();
});

describe('ProtectedPlaceholder（深链守卫，D4 §8.6）', () => {
  it('未配对 → Redirect 到 /pair/welcome（不渲染占位内容）', async () => {
    await render(
      <ProtectedPlaceholder title="会话详情" description="深链内容" />
    );
    expect(screen.queryByText('会话详情')).toBeNull();
  });

  it('已配对 → 渲染占位标题与描述', async () => {
    authStore.setState({ pairState: 'paired' });
    await render(
      <ProtectedPlaceholder title="会话详情" description="深链内容" />
    );
    expect(screen.getByText('会话详情')).toBeTruthy();
    expect(screen.getByText('深链内容')).toBeTruthy();
  });

  it('配对中（pairing）→ 仍守卫跳配对页（仅 paired 放行）', async () => {
    authStore.setState({ pairState: 'pairing' });
    await render(
      <ProtectedPlaceholder title="会话详情" description="深链内容" />
    );
    expect(screen.queryByText('会话详情')).toBeNull();
  });
});
