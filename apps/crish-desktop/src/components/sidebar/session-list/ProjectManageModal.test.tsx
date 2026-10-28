// @vitest-environment jsdom
import React, { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import {
  addProjectFromPaths,
  getActiveProjectId,
  getWorkspacePath,
  listProjects,
  openProject,
  type ProjectEntry,
} from '../../../api/projectStore';
import { __resetWorkspaceAccessApiForTests } from '../../../api/workspaceAccessApi';
import { mockTauriCommand } from '../../../test-setup';
import { ProjectManageModal } from './ProjectManageModal';

const ACTIVE_PATH = 'D:/projects/alpha';
const INACTIVE_PATH = 'E:/projects/beta';
const NEXT_PATH = 'F:/projects/updated';

type HostProps = {
  project: ProjectEntry;
  events: string[];
};

function ProjectManageHost({ project, events }: HostProps) {
  const [open, setOpen] = useState(true);
  const [visibleProject, setVisibleProject] = useState(project);
  const [visibleWorkspace, setVisibleWorkspace] = useState(getWorkspacePath());

  useEffect(() => {
    const refreshWorkspace = () => setVisibleWorkspace(getWorkspacePath());
    window.addEventListener('crish-project-changed', refreshWorkspace);
    return () =>
      window.removeEventListener('crish-project-changed', refreshWorkspace);
  }, []);

  return (
    <>
      <output aria-label="当前工作区">{visibleWorkspace}</output>
      <output aria-label="项目列表项">
        {visibleProject.name}：{visibleProject.path}
      </output>
      <ProjectManageModal
        mode="manage"
        open={open}
        project={project}
        onClose={() => {
          events.push('close');
          setOpen(false);
        }}
        onProjectSaved={(entry) => {
          events.push('saved');
          setVisibleProject(entry);
        }}
        onOpenProject={(projectId) => events.push(`open:${projectId}`)}
      />
    </>
  );
}

function seedProjects() {
  localStorage.clear();
  __resetWorkspaceAccessApiForTests();
  const active = addProjectFromPaths([ACTIVE_PATH], 'Alpha');
  const inactive = addProjectFromPaths([INACTIVE_PATH], 'Beta');
  openProject(active.id);
  return { active, inactive };
}

function replacePrimaryFolder() {
  fireEvent.click(screen.getByRole('button', { name: /移除文件夹/ }));
  fireEvent.click(screen.getByRole('button', { name: /点击选择项目文件夹/ }));
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

beforeEach(() => {
  __resetWorkspaceAccessApiForTests();
});

describe('ProjectManageModal 工作区授权与提交状态', () => {
  it('编辑活动项目时先经原生授权激活新主根，再更新可见项目并关闭', async () => {
    const { active } = seedProjects();
    const events: string[] = [];
    let rustActiveRoot = ACTIVE_PATH;

    mockTauriCommand('workbench_pick_workspace_folders', (args) => {
      events.push('native-picker');
      expect(args).toEqual({ activateFirst: false });
      return [NEXT_PATH];
    });
    mockTauriCommand('workbench_open_workspaces', (args) => {
      const request = args as {
        paths: string[];
        primaryPath: string;
        activatePrimary: boolean;
      };
      events.push(`native-authorize:${request.activatePrimary}`);
      expect(request).toEqual({
        paths: [NEXT_PATH],
        primaryPath: NEXT_PATH,
        activatePrimary: true,
      });
      if (request.activatePrimary) rustActiveRoot = request.primaryPath;
      return { path: request.primaryPath };
    });

    render(<ProjectManageHost project={active} events={events} />);
    replacePrimaryFolder();
    expect(await screen.findByText(NEXT_PATH)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => {
      expect(screen.getByLabelText('项目列表项')).toHaveTextContent(
        `Alpha：${NEXT_PATH}`
      );
      expect(screen.getByLabelText('当前工作区')).toHaveTextContent(NEXT_PATH);
      expect(events).toEqual([
        'native-picker',
        'native-authorize:true',
        'saved',
        'close',
      ]);
    });
    expect(rustActiveRoot).toBe(NEXT_PATH);
    expect(getActiveProjectId()).toBe(active.id);
    expect(getWorkspacePath()).toBe(NEXT_PATH);
    expect(listProjects().find((entry) => entry.id === active.id)?.path).toBe(
      NEXT_PATH
    );
  });

  it('编辑非活动项目时只更新该项目，当前工作区根保持不变', async () => {
    const { active, inactive } = seedProjects();
    const events: string[] = [];
    let rustActiveRoot = ACTIVE_PATH;

    mockTauriCommand('workbench_pick_workspace_folders', (args) => {
      events.push('native-picker');
      expect(args).toEqual({ activateFirst: false });
      return [NEXT_PATH];
    });
    mockTauriCommand('workbench_open_workspaces', (args) => {
      const request = args as {
        paths: string[];
        primaryPath: string;
        activatePrimary: boolean;
      };
      events.push(`native-authorize:${request.activatePrimary}`);
      expect(request).toEqual({
        paths: [NEXT_PATH],
        primaryPath: NEXT_PATH,
        activatePrimary: false,
      });
      if (request.activatePrimary) rustActiveRoot = request.primaryPath;
      return { path: request.primaryPath };
    });

    render(<ProjectManageHost project={inactive} events={events} />);
    fireEvent.click(screen.getByRole('button', { name: /移除文件夹/ }));
    fireEvent.click(screen.getByRole('button', { name: /点击选择项目文件夹/ }));
    expect(await screen.findByText(NEXT_PATH)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => {
      expect(screen.getByLabelText('项目列表项')).toHaveTextContent(
        `Beta：${NEXT_PATH}`
      );
      expect(screen.getByLabelText('当前工作区')).toHaveTextContent(
        ACTIVE_PATH
      );
      expect(events).toEqual([
        'native-picker',
        'native-authorize:false',
        'saved',
        'close',
      ]);
    });
    expect(rustActiveRoot).toBe(ACTIVE_PATH);
    expect(getActiveProjectId()).toBe(active.id);
    expect(getWorkspacePath()).toBe(ACTIVE_PATH);
    expect(listProjects().find((entry) => entry.id === inactive.id)?.path).toBe(
      NEXT_PATH
    );
  });

  it('原生目录选择器取消时保留原表单和活动项目，不触发保存', async () => {
    const { active } = seedProjects();
    const events: string[] = [];
    let pickerCalled = false;
    mockTauriCommand('workbench_pick_workspace_folders', (args) => {
      pickerCalled = true;
      expect(args).toEqual({ activateFirst: false });
      return null;
    });

    render(<ProjectManageHost project={active} events={events} />);
    fireEvent.click(screen.getByRole('button', { name: /添加更多文件夹/ }));

    await waitFor(() => expect(pickerCalled).toBe(true));
    expect(
      within(screen.getByRole('dialog')).getByText(ACTIVE_PATH)
    ).toBeInTheDocument();
    expect(screen.getByLabelText('项目名称')).toHaveValue('Alpha');
    expect(screen.getByRole('button', { name: '保存修改' })).toBeDisabled();
    expect(screen.getByLabelText('项目列表项')).toHaveTextContent(
      `Alpha：${ACTIVE_PATH}`
    );
    expect(screen.getByLabelText('当前工作区')).toHaveTextContent(ACTIVE_PATH);
    expect(events).toEqual([]);
    expect(getActiveProjectId()).toBe(active.id);
    expect(getWorkspacePath()).toBe(ACTIVE_PATH);
  });

  it('编辑草稿后取消弹窗时不保存项目或切换工作区', async () => {
    const { active } = seedProjects();
    const events: string[] = [];
    mockTauriCommand('workbench_pick_workspace_folders', (args) => {
      events.push('native-picker');
      expect(args).toEqual({ activateFirst: false });
      return [NEXT_PATH];
    });

    render(<ProjectManageHost project={active} events={events} />);
    replacePrimaryFolder();
    expect(await screen.findByText(NEXT_PATH)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('项目名称'), {
      target: { value: '未保存的名称' },
    });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    await waitFor(() => expect(events).toEqual(['native-picker', 'close']));
    expect(screen.getByLabelText('项目列表项')).toHaveTextContent(
      `Alpha：${ACTIVE_PATH}`
    );
    expect(screen.getByLabelText('当前工作区')).toHaveTextContent(ACTIVE_PATH);
    expect(getActiveProjectId()).toBe(active.id);
    expect(getWorkspacePath()).toBe(ACTIVE_PATH);
    expect(
      listProjects().find((entry) => entry.id === active.id)
    ).toMatchObject({
      name: 'Alpha',
      path: ACTIVE_PATH,
      paths: [ACTIVE_PATH],
    });
  });

  it('授权拒绝时显示错误并保留原项目/工作区，不发布部分保存或关闭', async () => {
    const { active } = seedProjects();
    const events: string[] = [];
    const rustActiveRoot = ACTIVE_PATH;

    mockTauriCommand('workbench_pick_workspace_folders', (args) => {
      events.push('native-picker');
      expect(args).toEqual({ activateFirst: false });
      return [NEXT_PATH];
    });
    mockTauriCommand('workbench_open_workspaces', (args) => {
      const request = args as {
        paths: string[];
        primaryPath: string;
        activatePrimary: boolean;
      };
      events.push('native-authorize:denied');
      expect(request).toEqual({
        paths: [NEXT_PATH],
        primaryPath: NEXT_PATH,
        activatePrimary: true,
      });
      throw new Error('workspace_not_granted: denied');
    });

    render(<ProjectManageHost project={active} events={events} />);
    replacePrimaryFolder();
    expect(await screen.findByText(NEXT_PATH)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('项目名称'), {
      target: { value: 'Alpha 新名称' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '该项目目录尚未授权，请重新选择项目文件夹。'
    );
    expect(screen.getByText(NEXT_PATH)).toBeInTheDocument();
    expect(screen.getByLabelText('项目名称')).toHaveValue('Alpha 新名称');
    expect(screen.getByLabelText('项目列表项')).toHaveTextContent(
      `Alpha：${ACTIVE_PATH}`
    );
    expect(screen.getByLabelText('当前工作区')).toHaveTextContent(ACTIVE_PATH);
    expect(
      screen.getByRole('dialog', { name: '项目管理' })
    ).toBeInTheDocument();
    expect(events).toEqual(['native-picker', 'native-authorize:denied']);
    expect(rustActiveRoot).toBe(ACTIVE_PATH);
    expect(getActiveProjectId()).toBe(active.id);
    expect(getWorkspacePath()).toBe(ACTIVE_PATH);
    expect(
      listProjects().find((entry) => entry.id === active.id)
    ).toMatchObject({
      name: 'Alpha',
      path: ACTIVE_PATH,
      paths: [ACTIVE_PATH],
    });
  });
});
