// @vitest-environment jsdom
/**
 * SkillsMoreMenu（ui/Menu 基座迁移版）交互测试：
 * 打开/选择/Esc/键盘漫游/禁用态
 */
import React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { SkillsMoreMenu } from './SkillsMoreMenu';
import type { DesktopSkill } from '../../api/skillsApi';

const SKILLS: DesktopSkill[] = [
  {
    id: 's1',
    name: '技能甲',
    description: '测试技能',
    filePath: '/tmp/s1/SKILL.md',
    baseDir: '/tmp/s1',
    content: '# 技能甲',
    raw: '# 技能甲',
    scope: 'workspace',
    activation: 'automatic',
    tags: [],
    appliesTo: [],
    disableModelInvocation: false,
  },
];

function Wrapper({
  onSync,
  onRefresh,
}: {
  onSync?: () => void;
  onRefresh?: () => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  return (
    <SkillsMoreMenu
      moreOpen={moreOpen}
      setMoreOpen={setMoreOpen}
      moreMenuId="more-menu-test"
      skills={SKILLS}
      filtered={SKILLS}
      syncBusy={false}
      loading={false}
      discoverBusy={false}
      enableCommands={true}
      setEnableCommands={() => {}}
      batch={{
        batchConfirm: 'none',
        batchBusy: false,
        batchEnableCount: 0,
        batchDisableCount: 0,
        runBatchActivation: async () => {},
      }}
      handleSyncAll={async () => onSync?.()}
      refresh={async () => onRefresh?.()}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SkillsMoreMenu（ui/Menu 基座）', () => {
  it('点击更多按钮打开菜单并渲染选项', async () => {
    render(<Wrapper />);
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    expect(await screen.findByText('同步到引擎')).toBeInTheDocument();
    expect(screen.getByText('发现新技能')).toBeInTheDocument();
    expect(screen.getByText('全部启用')).toBeInTheDocument();
  });

  it('点击「同步到引擎」触发 handleSyncAll 并关闭', async () => {
    const onSync = vi.fn();
    render(<Wrapper onSync={onSync} />);
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    fireEvent.click(await screen.findByText('同步到引擎'));
    expect(onSync).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText('同步到引擎')).not.toBeInTheDocument());
  });

  it('Esc 关闭菜单', async () => {
    render(<Wrapper />);
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    const menu = await screen.findByRole('menu');
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('键盘漫游：ArrowDown 聚焦首项，Enter 触发同步', async () => {
    const onSync = vi.fn();
    render(<Wrapper onSync={onSync} />);
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    const menu = await screen.findByRole('menu');
    // F7-F2 契约：打开即聚焦首项（原 ArrowDown 从 -1 落到首项的语义
    // 由打开即聚焦接管）
    await waitFor(() => expect(screen.getAllByRole('menuitem')[0]).toHaveFocus());
    fireEvent.keyDown(menu, { key: 'Enter' });
    expect(onSync).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('禁用态：无技能时「同步到引擎」禁用', async () => {
    render(
      <SkillsMoreMenu
        moreOpen={true}
        setMoreOpen={() => {}}
        moreMenuId="more-menu-test"
        skills={[]}
        filtered={[]}
        syncBusy={false}
        loading={false}
        discoverBusy={false}
        enableCommands={true}
        setEnableCommands={() => {}}
        batch={{
          batchConfirm: 'none',
          batchBusy: false,
          batchEnableCount: 0,
          batchDisableCount: 0,
          runBatchActivation: async () => {},
        }}
        handleSyncAll={async () => {}}
        refresh={async () => {}}
      />
    );
    expect(await screen.findByText('同步到引擎')).toBeDisabled();
    expect(screen.getByText('全部启用')).toBeDisabled();
  });
});
