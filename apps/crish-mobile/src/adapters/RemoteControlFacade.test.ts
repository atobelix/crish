// RemoteControlFacade 单元测试：统一控制门面全能力验证
import {
  RemoteControlFacade,
  remoteErrorTextOf,
  runTaskErrorTextOf,
  runControlErrorTextOf,
} from './RemoteControlFacade';
import type { WsGateway } from '@/network/WsGateway';

describe('RemoteControlFacade', () => {
  let mockInvoke: jest.Mock;
  let mockGateway: WsGateway;
  let facade: RemoteControlFacade;

  beforeEach(() => {
    mockInvoke = jest.fn();
    mockGateway = {
      invoke: mockInvoke,
    } as unknown as WsGateway;
    facade = new RemoteControlFacade();
    facade.setGatewaySourceForTest(() => mockGateway);
  });

  afterEach(() => {
    facade.resetForTest();
    jest.clearAllMocks();
  });

  describe('网关可用性检查', () => {
    it('当代网关存在且 open 时返回 true', () => {
      expect(facade.isAvailable()).toBe(true);
    });

    it('网关返回 null 时返回 false', () => {
      facade.setGatewaySourceForTest(() => null);
      expect(facade.isAvailable()).toBe(false);
    });
  });

  describe('运行控制面 (runTask / stopRun / cancelRun / resumeRun)', () => {
    it('runTask 发送请求并正确解析响应', async () => {
      mockInvoke.mockResolvedValueOnce({
        runId: 'run-101',
        sessionId: 'sess-202',
      });

      const res = await facade.runTask({
        prompt: '测试任务',
        sessionId: 'sess-202',
        permissionMode: 'ask',
      });

      expect(res).toEqual({ runId: 'run-101', sessionId: 'sess-202' });
      expect(mockInvoke).toHaveBeenCalledWith(
        'remote.runTask',
        {
          command: 'runTask',
          params: expect.objectContaining({
            prompt: '测试任务',
            sessionId: 'sess-202',
          }),
        },
        undefined
      );
    });

    it('stopRun 发送 L2 cooperative_stop 打断指令', async () => {
      mockInvoke.mockResolvedValueOnce({ ok: true });

      const res = await facade.stopRun('run-101', 'sess-202', 'test-stop');
      expect(res).toEqual({ ok: true });
      expect(mockInvoke).toHaveBeenCalledWith(
        'remote.runControl',
        {
          command: 'runControl',
          params: expect.objectContaining({
            level: 'cooperative_stop',
            runId: 'run-101',
            sessionId: 'sess-202',
            reason: 'test-stop',
          }),
        },
        undefined
      );
    });

    it('resumeRun 发送 L0 continue 恢复指令', async () => {
      mockInvoke.mockResolvedValueOnce({ ok: true });

      const res = await facade.resumeRun('run-101', 'sess-202');
      expect(res).toEqual({ ok: true });
      expect(mockInvoke).toHaveBeenCalledWith(
        'remote.runControl',
        {
          command: 'runControl',
          params: expect.objectContaining({
            level: 'continue',
            runId: 'run-101',
          }),
        },
        undefined
      );
    });

    it('cancelRun 发送取消请求', async () => {
      mockInvoke.mockResolvedValueOnce({
        ok: true,
        runId: 'run-101',
      });

      const res = await facade.cancelRun('run-101', 'sess-202', 'user-abort');
      expect(res.ok).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith(
        'remote.cancelRun',
        {
          command: 'cancelRun',
          params: expect.objectContaining({
            runId: 'run-101',
            reason: 'user-abort',
          }),
        },
        undefined
      );
    });
  });

  describe('会话管理面 (rename / pin / archive / delete)', () => {
    it('renameSession 重命名会话', async () => {
      mockInvoke.mockResolvedValueOnce({ ok: true });

      const res = await facade.renameSession({
        sessionId: 'sess-1',
        title: '新标题',
      });
      expect(res).toEqual({ ok: true });
      expect(mockInvoke).toHaveBeenCalledWith(
        'remote.renameSession',
        {
          command: 'renameSession',
          params: { sessionId: 'sess-1', title: '新标题' },
        },
        undefined
      );
    });

    it('setSessionPinned 置顶会话', async () => {
      mockInvoke.mockResolvedValueOnce({ ok: true });

      const res = await facade.setSessionPinned({
        sessionId: 'sess-1',
        pinned: true,
      });
      expect(res).toEqual({ ok: true });
    });

    it('setSessionArchived 归档会话', async () => {
      mockInvoke.mockResolvedValueOnce({ ok: true });

      const res = await facade.setSessionArchived({
        sessionId: 'sess-1',
        archived: true,
      });
      expect(res).toEqual({ ok: true });
    });

    it('deleteSession 删除会话', async () => {
      mockInvoke.mockResolvedValueOnce({ ok: true });

      const res = await facade.deleteSession({
        sessionId: 'sess-1',
      });
      expect(res).toEqual({ ok: true });
    });
  });

  describe('模型与扩展面 (listModels / setActiveModel / listSkills)', () => {
    it('listModels 拉取模型列表', async () => {
      mockInvoke.mockResolvedValueOnce({
        activeModel: {
          providerId: 'openai',
          modelId: 'gpt-4o',
          displayName: 'GPT-4o',
        },
        models: [
          {
            providerId: 'openai',
            modelId: 'gpt-4o',
            displayName: 'GPT-4o',
            active: true,
          },
        ],
      });

      const res = await facade.listModels();
      expect(res.activeModel?.modelId).toBe('gpt-4o');
      expect(res.models).toHaveLength(1);
    });

    it('setActiveModel 设置全局默认模型', async () => {
      mockInvoke.mockResolvedValueOnce({
        ok: true,
        activeModel: {
          providerId: 'anthropic',
          modelId: 'claude-3-5',
          displayName: 'Claude 3.5',
        },
      });

      const res = await facade.setActiveModel({
        providerId: 'anthropic',
        modelId: 'claude-3-5',
      });
      expect(res.activeModel.modelId).toBe('claude-3-5');
    });

    it('listSkills 读取技能目录', async () => {
      mockInvoke.mockResolvedValueOnce({
        skills: [
          {
            id: 'skill-1',
            name: 'web-search',
            description: '搜索',
            scope: 'system',
            system: true,
          },
        ],
      });

      const res = await facade.listSkills();
      expect(res.skills).toHaveLength(1);
      expect(res.skills[0]?.name).toBe('web-search');
    });
  });

  describe('工作区与文件面 (listWorkspaces / listDir / readFile)', () => {
    it('listWorkspaces 获取工作区列表', async () => {
      mockInvoke.mockResolvedValueOnce({
        workspaces: [{ root: 'C:\\proj', name: 'proj', active: true }],
      });

      const res = await facade.listWorkspaces();
      expect(res.workspaces).toHaveLength(1);
    });

    it('listDir 读取目录', async () => {
      mockInvoke.mockResolvedValueOnce({
        entries: [
          {
            name: 'src',
            isDir: true,
            path: 'src',
            size: 0,
            mtimeMs: 1000,
          },
        ],
      });

      const res = await facade.listDir({ path: '' });
      expect(res.entries).toHaveLength(1);
    });

    it('readFile 分块读取文件', async () => {
      mockInvoke.mockResolvedValueOnce({
        path: 'a.txt',
        content: 'hello',
        startLine: 1,
        lineCount: 1,
        totalLines: 1,
        truncated: false,
      });

      const res = await facade.readFile({ path: 'a.txt' });
      expect(res.content).toBe('hello');
    });
  });

  describe('错误归一化与人话文案映射', () => {
    it('人话文案正确映射常用错误码', () => {
      expect(remoteErrorTextOf('transport.closed')).toContain('未连接桌面');
      expect(remoteErrorTextOf('cmd.timeout')).toContain('超时');
      expect(remoteErrorTextOf('cmd.session_busy')).toContain('桌面正在处理');
      expect(runTaskErrorTextOf('cmd.invalid')).toContain('无效');
      expect(runControlErrorTextOf('internal')).toContain('失败');
    });

    it('未知错误码诚实透传', () => {
      expect(remoteErrorTextOf('custom.err')).toBe('操作失败（custom.err）');
    });
  });
});
