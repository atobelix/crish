// useSkillsVm 测试（G7）：技能目录数据面（只读浏览口径）
// 模式同 useComposerContextVm.test：renderHook + 真实 connectionStore +
// 注入假技能上下文。锁定：未连接不拉取、就绪自动拉取一次并给出真实
// 计数、失败落 error 态且计数为 null（不编造）、重试恢复、openList
// 仅在缺失/失败时刷新。
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { SkillEntry } from '@crish/shared-types';
import { connectionStore } from '@/domain/store/connectionStore';
import { SkillsCommandError } from '@/adapters/wiring/skillsRepository';
import type { SkillsContext } from '@/adapters/wiring/skillsWiring';
import { useSkillsVm } from './useSkillsVm';

const SKILLS: SkillEntry[] = [
  {
    id: 'skill_95cfb221d00f',
    name: 'my-skill',
    description: '演示技能',
    scope: 'project',
    system: false,
  },
  {
    id: 'skill_aaaaaaaaaaaa',
    name: 'global-skill',
    description: '',
    scope: 'global',
    system: true,
    fileActivation: 'recommended',
  },
];

function fakeSkillsContext() {
  const repository = {
    listSkills: jest.fn(async () => ({ skills: SKILLS })),
  };
  return {
    repository,
    ctx: { repository } as unknown as SkillsContext,
  };
}

describe('useSkillsVm（G7）', () => {
  beforeEach(() => {
    connectionStore.setState({ phase: 'disconnected' });
  });

  it('未连接：不拉取，计数为 null（不编造）', async () => {
    const skills = fakeSkillsContext();
    const { result } = await renderHook(() => useSkillsVm(skills.ctx));
    expect(result.current.connected).toBe(false);
    expect(result.current.skills).toBeNull();
    expect(result.current.skillsCount).toBeNull();
    expect(skills.repository.listSkills).not.toHaveBeenCalled();
  });

  it('连接就绪：自动拉取一次，计数 = 目录总数', async () => {
    const skills = fakeSkillsContext();
    connectionStore.setState({ phase: 'ready' });
    const { result } = await renderHook(() => useSkillsVm(skills.ctx));
    await waitFor(() => expect(result.current.status).toBe('loaded'));
    expect(skills.repository.listSkills).toHaveBeenCalledTimes(1);
    expect(result.current.skillsCount).toBe(2);
    expect(result.current.skills?.[0]!.name).toBe('my-skill');
    expect(result.current.errorCode).toBeNull();
  });

  it('拉取失败：status=error、错误码落位、计数保持 null', async () => {
    const skills = fakeSkillsContext();
    skills.repository.listSkills.mockRejectedValueOnce(
      new SkillsCommandError('internal', 'boom', false)
    );
    connectionStore.setState({ phase: 'ready' });
    const { result } = await renderHook(() => useSkillsVm(skills.ctx));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.errorCode).toBe('internal');
    expect(result.current.skillsCount).toBeNull();
  });

  it('失败后 retry：重新拉取并恢复 loaded', async () => {
    const skills = fakeSkillsContext();
    skills.repository.listSkills.mockRejectedValueOnce(
      new SkillsCommandError('internal', 'boom', false)
    );
    connectionStore.setState({ phase: 'ready' });
    const { result } = await renderHook(() => useSkillsVm(skills.ctx));
    await waitFor(() => expect(result.current.status).toBe('error'));
    await act(async () => {
      result.current.retry();
    });
    await waitFor(() => expect(result.current.status).toBe('loaded'));
    expect(result.current.skillsCount).toBe(2);
  });

  it('openList：已加载时不重复拉取', async () => {
    const skills = fakeSkillsContext();
    connectionStore.setState({ phase: 'ready' });
    const { result } = await renderHook(() => useSkillsVm(skills.ctx));
    await waitFor(() => expect(result.current.status).toBe('loaded'));
    await act(async () => {
      result.current.openList();
    });
    expect(skills.repository.listSkills).toHaveBeenCalledTimes(1);
  });

  it('接线未启动（context 为 null）：保持未连接投影，不抛错', async () => {
    connectionStore.setState({ phase: 'ready' });
    const { result } = await renderHook(() => useSkillsVm(null));
    expect(result.current.skills).toBeNull();
    expect(result.current.skillsCount).toBeNull();
    expect(result.current.status).toBe('idle');
  });
});
