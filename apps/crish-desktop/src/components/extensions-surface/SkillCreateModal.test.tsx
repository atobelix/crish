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
import { SkillCreateModal } from './SkillCreateModal';
import { ToastProvider } from '../../services/toast/ToastContext';
import { useSessionStore } from '../../store/storeAccess';
import { sessionDraftManager } from '../../api/draft/sessionDraftManager';
import * as uiEvents from '../../api/uiEvents';
import * as skillsApi from '../../api/skillsApi';

describe('SkillCreateModal', () => {
  const onClose = vi.fn();
  const onSuccess = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState({ activeSessionId: 'test-session-42' });
  });

  afterEach(() => {
    cleanup();
  });

  it('triggers session draft injection and navigation on AI create mode', () => {
    const injectSeedSpy = vi.spyOn(sessionDraftManager, 'injectSeed');
    const emitEventSpy = vi.spyOn(uiEvents, 'emitUiEvent');

    render(
      <ToastProvider>
        <SkillCreateModal open={true} onClose={onClose} onSuccess={onSuccess} />
      </ToastProvider>
    );

    // 界面展示两大核心方式
    expect(screen.getByText('AI 智能对话创建')).toBeInTheDocument();
    expect(screen.getByText('导入本地已有技能目录')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '在对话中由 AI 创建' })
    ).toBeInTheDocument();

    // 点击【在对话中由 AI 创建】
    fireEvent.click(screen.getByRole('button', { name: '在对话中由 AI 创建' }));

    expect(injectSeedSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSessionId: 'test-session-42',
        mode: 'safe_seed',
        metadata: { source: 'skill_editor', title: 'AI 技能创建' },
      })
    );
    expect(onClose).toHaveBeenCalled();
    expect(emitEventSpy).toHaveBeenCalledWith('open-chat');
  });

  it('allows customizing AI prompt and injects modified prompt seed', () => {
    const injectSeedSpy = vi.spyOn(sessionDraftManager, 'injectSeed');

    render(
      <ToastProvider>
        <SkillCreateModal open={true} onClose={onClose} onSuccess={onSuccess} />
      </ToastProvider>
    );

    const textarea = screen.getByLabelText('技能需求描述');
    fireEvent.change(textarea, {
      target: { value: '创建一个自动化发布与打标签的技能' },
    });

    fireEvent.click(screen.getByRole('button', { name: '在对话中由 AI 创建' }));

    expect(injectSeedSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('创建一个自动化发布与打标签的技能'),
      })
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('imports local skill directory and invokes callbacks when directory is selected', async () => {
    const pickSkillDirSpy = vi
      .spyOn(skillsApi, 'pickSkillDirectory')
      .mockResolvedValue('C:/Software/conex/skills/my-custom-skill');
    const addExtraSkillDirSpy = vi
      .spyOn(skillsApi, 'addExtraSkillDir')
      .mockImplementation(() => {});

    render(
      <ToastProvider>
        <SkillCreateModal open={true} onClose={onClose} onSuccess={onSuccess} />
      </ToastProvider>
    );

    const importButton = screen.getByRole('button', {
      name: '浏览并导入本地技能目录',
    });
    fireEvent.click(importButton);

    await waitFor(() => {
      expect(pickSkillDirSpy).toHaveBeenCalled();
    });

    expect(addExtraSkillDirSpy).toHaveBeenCalledWith(
      'C:/Software/conex/skills/my-custom-skill'
    );
    expect(onSuccess).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('does nothing when local directory picker is cancelled', async () => {
    vi.spyOn(skillsApi, 'pickSkillDirectory').mockResolvedValue(null);
    const addExtraSkillDirSpy = vi.spyOn(skillsApi, 'addExtraSkillDir');

    render(
      <ToastProvider>
        <SkillCreateModal open={true} onClose={onClose} onSuccess={onSuccess} />
      </ToastProvider>
    );

    fireEvent.click(
      screen.getByRole('button', { name: '浏览并导入本地技能目录' })
    );

    await waitFor(() => {
      expect(skillsApi.pickSkillDirectory).toHaveBeenCalled();
    });

    expect(addExtraSkillDirSpy).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows toast when attempting AI creation without active session', () => {
    useSessionStore.setState({ activeSessionId: null });
    const injectSeedSpy = vi.spyOn(sessionDraftManager, 'injectSeed');

    render(
      <ToastProvider>
        <SkillCreateModal open={true} onClose={onClose} onSuccess={onSuccess} />
      </ToastProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: '在对话中由 AI 创建' }));

    expect(injectSeedSpy).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
