// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react';
import { ExternalImportWorkbench } from './ExternalImportWorkbench';
import { ToastProvider } from '../../services/toast/ToastContext';
import { useSettingsStore } from '../../store/settingsStore';
import { clientApi } from '../../api/clientApi';
import * as skillsApi from '../../api/skillsApi';
import * as detectMcpApi from './detectExternalMcpServers';
import * as detectSkillsApi from './detectExternalSkills';

describe('ExternalImportWorkbench', () => {
  const onImportSuccess = vi.fn();
  const onRefresh = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.getState().setMcpServers([]);

    vi.spyOn(detectMcpApi, 'detectExternalMcpServers').mockResolvedValue([
      {
        id: 'mock-mcp-1',
        source: 'Antigravity',
        name: 'chrome-devtools-mcp',
        type: 'stdio',
        command: 'npx',
        args: ['chrome-devtools-mcp'],
        description: '浏览器自动化调试工具',
      },
    ]);

    vi.spyOn(detectSkillsApi, 'detectExternalSkills').mockResolvedValue([
      {
        id: 'mock-skill-1',
        source: 'Cursor',
        name: 'cursor-rules-sync',
        description: '同步 Cursor 项目规则配置',
        filePath: '/home/.cursor/skills/cursor-rules-sync/SKILL.md',
        skillDir: '',
      },
    ]);

    vi.spyOn(skillsApi, 'discoverSkills').mockResolvedValue({
      skills: [],
      errors: [],
    } as any);
    vi.spyOn(skillsApi, 'createProjectSkill').mockResolvedValue({
      ok: true,
      skillPath: '/workspace/.conex/skills/cursor-rules-sync/SKILL.md',
      skillDir: '/workspace/.conex/skills/cursor-rules-sync',
    });
    vi.spyOn(skillsApi, 'pickSkillDirectory').mockResolvedValue(
      '/custom/local/skill-dir'
    );
    vi.spyOn(skillsApi, 'addExtraSkillDir').mockImplementation(() => []);
    vi.spyOn(skillsApi, 'setSkillActivation').mockResolvedValue({
      ok: true,
      engineSynced: false,
    });
    vi.spyOn(skillsApi, 'createGlobalSkill').mockResolvedValue({
      ok: true,
      skillPath: '/home/.crish/skills/cursor-rules-sync/SKILL.md',
      skillDir: '/home/.crish/skills/cursor-rules-sync',
    });
    vi.spyOn(clientApi, 'saveSettingsEx').mockResolvedValue({} as any);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders header, SegmentedControl, and default MCP list without "all" or "plugin" tab', async () => {
    render(
      <ToastProvider>
        <ExternalImportWorkbench
          onImportSuccess={onImportSuccess}
          onRefresh={onRefresh}
        />
      </ToastProvider>
    );

    expect(screen.getByText('从其他应用导入')).toBeInTheDocument();
    expect(screen.getByText(/一键接入 MCP 服务/)).toBeInTheDocument();

    // 默认在 MCP 服务分类，尚未显示技能相关的文件夹导入按钮
    expect(
      screen.queryByRole('button', { name: /从文件夹导入\.\.\./ })
    ).not.toBeInTheDocument();

    // 验证无“全部”或“插件”大杂烩选项
    expect(screen.queryByText(/全部/)).not.toBeInTheDocument();
    expect(screen.queryByText(/插件/)).not.toBeInTheDocument();

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /重新扫描/ })
      ).toBeInTheDocument();
      const nameEl = screen.getByText('chrome-devtools-mcp');
      expect(nameEl).toBeInTheDocument();
      expect(nameEl).not.toHaveAttribute('title');

      const badgeEl = screen.getByText('Antigravity');
      expect(badgeEl).toBeInTheDocument();
      expect(badgeEl).toHaveAttribute('data-source', 'Antigravity');
    });

    // 技能项不应混杂在 MCP 服务列表中
    expect(screen.queryByText('cursor-rules-sync')).not.toBeInTheDocument();
  });

  it('switches between MCP 服务 and 技能 categories cleanly', async () => {
    render(
      <ToastProvider>
        <ExternalImportWorkbench
          onImportSuccess={onImportSuccess}
          onRefresh={onRefresh}
        />
      </ToastProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('chrome-devtools-mcp')).toBeInTheDocument();
    });

    // 切换至 技能
    fireEvent.click(screen.getByText(/技能 \(/));

    await waitFor(() => {
      expect(screen.getByText('cursor-rules-sync')).toBeInTheDocument();
      expect(screen.getByText('Cursor')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /从文件夹导入\.\.\./ })
      ).toBeInTheDocument();
    });
    expect(screen.queryByText('chrome-devtools-mcp')).not.toBeInTheDocument();

    // 切换回 MCP 服务
    fireEvent.click(screen.getByText(/MCP 服务 \(/));

    await waitFor(() => {
      expect(screen.getByText('chrome-devtools-mcp')).toBeInTheDocument();
    });
    expect(screen.queryByText('cursor-rules-sync')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /从文件夹导入\.\.\./ })
    ).not.toBeInTheDocument();
  });

  it('imports detected MCP server with one-click, writing to settingsStore and calling saveSettingsEx', async () => {
    render(
      <ToastProvider>
        <ExternalImportWorkbench
          onImportSuccess={onImportSuccess}
          onRefresh={onRefresh}
        />
      </ToastProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('chrome-devtools-mcp')).toBeInTheDocument();
    });

    const importBtn = screen.getByRole('button', {
      name: '导入 chrome-devtools-mcp',
    });
    fireEvent.click(importBtn);

    await waitFor(() => {
      const servers = useSettingsStore.getState().mcpServers || [];
      expect(servers.some((s) => s.name === 'chrome-devtools-mcp')).toBe(true);
      expect(
        screen.getByRole('button', { name: '卸载 chrome-devtools-mcp' })
      ).toBeInTheDocument();
    });

    expect(clientApi.saveSettingsEx).toHaveBeenCalledWith(
      '__global__',
      'global',
      expect.objectContaining({
        mcpServers: expect.any(Array),
      })
    );
    expect(onImportSuccess).toHaveBeenCalled();
    expect(onRefresh).toHaveBeenCalled();
  });

  it('imports detected Skill with one-click, invoking createProjectSkill and dispatching crish-skills-changed', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    render(
      <ToastProvider>
        <ExternalImportWorkbench
          onImportSuccess={onImportSuccess}
          onRefresh={onRefresh}
        />
      </ToastProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('chrome-devtools-mcp')).toBeInTheDocument();
    });

    // 切换至 技能
    fireEvent.click(screen.getByText(/技能 \(/));

    await waitFor(() => {
      expect(screen.getByText('cursor-rules-sync')).toBeInTheDocument();
    });

    const importBtn = screen.getByRole('button', {
      name: '导入 cursor-rules-sync',
    });
    fireEvent.click(importBtn);

    await waitFor(() => {
      expect(skillsApi.createProjectSkill).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'cursor-rules-sync',
          description: '同步 Cursor 项目规则配置',
        })
      );
      expect(skillsApi.setSkillActivation).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'cursor-rules-sync',
          activation: 'enabled',
        }),
        'enabled'
      );
    });

    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'crish-skills-changed' })
    );
    expect(onImportSuccess).toHaveBeenCalled();
  });

  it('imports skill with tilde path expanding real home directory, creating skill and enabling it', async () => {
    vi.spyOn(detectSkillsApi, 'detectExternalSkills').mockResolvedValue([
      {
        id: 'mock-skill-resume',
        source: 'Antigravity',
        name: 'resume-master',
        description: '简历生成技能',
        filePath: '~/.gemini/antigravity/skills/resume-master/SKILL.md',
        skillDir: '~/.gemini/antigravity/skills/resume-master',
      },
    ]);

    render(
      <ToastProvider>
        <ExternalImportWorkbench
          onImportSuccess={onImportSuccess}
          onRefresh={onRefresh}
        />
      </ToastProvider>
    );

    fireEvent.click(screen.getByText(/技能 \(/));

    await waitFor(() => {
      expect(screen.getByText('resume-master')).toBeInTheDocument();
    });

    const importBtn = screen.getByRole('button', {
      name: '导入 resume-master',
    });
    fireEvent.click(importBtn);

    await waitFor(() => {
      expect(skillsApi.createProjectSkill).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'resume-master',
          description: '简历生成技能',
        })
      );
      expect(skillsApi.setSkillActivation).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'resume-master',
          activation: 'enabled',
        }),
        'enabled'
      );
    });

    expect(onImportSuccess).toHaveBeenCalled();
  });

  it('imports skill directory from local file picker when in 技能 tab', async () => {
    render(
      <ToastProvider>
        <ExternalImportWorkbench
          onImportSuccess={onImportSuccess}
          onRefresh={onRefresh}
        />
      </ToastProvider>
    );

    // 切换至 技能 tab
    fireEvent.click(screen.getByText(/技能 \(/));

    const pickBtn = await screen.findByRole('button', {
      name: /从文件夹导入\.\.\./,
    });
    fireEvent.click(pickBtn);

    await waitFor(() => {
      expect(skillsApi.pickSkillDirectory).toHaveBeenCalled();
      expect(skillsApi.addExtraSkillDir).toHaveBeenCalledWith(
        '/custom/local/skill-dir'
      );
    });
    expect(onImportSuccess).toHaveBeenCalled();
  });

  it('shows 已导入 status for already existing resources', async () => {
    useSettingsStore.getState().setMcpServers([
      {
        id: 'existing-mcp-1',
        name: 'chrome-devtools-mcp',
        type: 'stdio',
        status: 'connected',
        tools: ['click'],
      },
    ]);

    vi.spyOn(skillsApi, 'discoverSkills').mockResolvedValue({
      skills: [
        {
          id: 'existing-skill-1',
          name: 'cursor-rules-sync',
          description: '已存在技能',
          activation: 'recommended',
          system: false,
        } as any,
      ],
      errors: [],
    } as any);

    render(
      <ToastProvider>
        <ExternalImportWorkbench
          onImportSuccess={onImportSuccess}
          onRefresh={onRefresh}
        />
      </ToastProvider>
    );

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '卸载 chrome-devtools-mcp' })
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByRole('button', { name: '导入 chrome-devtools-mcp' })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByText(/技能 \(/));

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '卸载 cursor-rules-sync' })
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByRole('button', { name: '导入 cursor-rules-sync' })
    ).not.toBeInTheDocument();
  });

  it('renders Claude Code and Codex badges with data-source and imports correctly', async () => {
    vi.spyOn(detectMcpApi, 'detectExternalMcpServers').mockResolvedValue([
      {
        id: 'mock-mcp-claudecode',
        source: 'Claude Code',
        name: 'github',
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        description: 'GitHub MCP 服务',
      },
      {
        id: 'mock-mcp-codex',
        source: 'Codex',
        name: 'fetch',
        type: 'stdio',
        command: 'uvx',
        args: ['mcp-server-fetch'],
        description: '网络获取 MCP 服务',
      },
    ]);

    render(
      <ToastProvider>
        <ExternalImportWorkbench
          onImportSuccess={onImportSuccess}
          onRefresh={onRefresh}
        />
      </ToastProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('github')).toBeInTheDocument();
      expect(screen.getByText('fetch')).toBeInTheDocument();
    });

    const claudeBadge = screen.getByText('Claude Code');
    expect(claudeBadge).toHaveAttribute('data-source', 'Claude Code');

    const codexBadge = screen.getByText('Codex');
    expect(codexBadge).toHaveAttribute('data-source', 'Codex');

    const importButtons = screen.getAllByRole('button', { name: /^导入 / });
    fireEvent.click(importButtons[0]);

    await waitFor(() => {
      const servers = useSettingsStore.getState().mcpServers || [];
      expect(servers.some((s) => s.name === 'github')).toBe(true);
    });
  });
});
