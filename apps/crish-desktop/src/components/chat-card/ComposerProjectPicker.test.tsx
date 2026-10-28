// @vitest-environment jsdom
/**
 * 新对话空界面：只渲染项目选择 + 多行输入框；项目选择在 composer 卡片外、位于其前。
 * 交互：点击打开、选中后焦点到输入框、Esc 关闭并把焦点还给选择器。
 */
import React, { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatEmptyState } from './ChatEmptyState';
import { ComposerProjectPicker } from './ComposerProjectPicker';
import { ChatLandingBrand } from './ChatLandingBrand';
import { ChatComposer } from '../chat-composer/ChatComposer';
import * as projectStore from '../../api/projectStore';
import { layerStackService } from '@/components/ui';

vi.mock('../../app/compositionRoot', () => ({
  getCompositionRoot: () => ({
    session: {
      getActiveSessionId: () => null,
      getState: () => ({
        activeSessionId: null,
        setComposerDraft: () => undefined,
      }),
    },
  }),
}));

vi.mock('../../api/storeAccess', () => ({
  openSettings: vi.fn(),
  getSessionStoreState: () => ({ activeSessionId: null }),
  setDraftFolder: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  layerStackService.dispose();
});

function stubProjects(): void {
  const proj = {
    id: 'proj-1',
    name: 'conex',
    path: 'C:/Software/conex',
    addedAt: 1,
    lastOpenedAt: 2,
  };
  vi.spyOn(projectStore, 'getActiveProject').mockReturnValue(proj);
  vi.spyOn(projectStore, 'getActiveProjectId').mockReturnValue('proj-1');
  vi.spyOn(projectStore, 'listProjects').mockReturnValue([proj]);
  vi.spyOn(projectStore, 'getWorkspacePath').mockReturnValue(proj.path);
  vi.spyOn(projectStore, 'setNoProject').mockImplementation(() => undefined);
}

/** 与 ChatCard 空界面同构：主列空态锚点 + composerDock（卡片外项目选择 + 多行 composer） */
function LandingHarness({
  onProjectChanged = vi.fn(),
}: {
  onProjectChanged?: () => void;
}) {
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<never[]>([]);
  const [composing, setComposing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  return (
    <div data-main-surface="chat" data-empty-kind="session-empty">
      <div data-testid="empty-col">
        <ChatEmptyState kind="session-empty" />
      </div>
      <div data-composer-wrapper="">
        <div data-composer-lead="">
          <ChatLandingBrand />
          <ComposerProjectPicker
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            onProjectChanged={onProjectChanged}
          />
        </div>
        <ChatComposer
          chatInput={input}
          setChatInput={setInput}
          isComposing={composing}
          setIsComposing={setComposing}
          filteredCommands={[]}
          loadSkillSlash={vi.fn()}
          onPasteImage={vi.fn()}
          onSend={vi.fn()}
          onStop={vi.fn()}
          canSend={Boolean(input.trim())}
          isProcessing={false}
          attachments={attachments}
          setAttachments={setAttachments}
          fileInputRef={fileInputRef}
          onFilesSelected={vi.fn()}
          showPlusMenu={false}
          setShowPlusMenu={() => {}}
          permissionMode="ask"
          onPermissionChange={vi.fn()}
          emptyKind="session-empty"
          layoutVariant="multiline"
        />
      </div>
    </div>
  );
}

function getPicker(): HTMLButtonElement {
  return screen.getByRole('button', {
    name: /当前项目：conex/,
  }) as HTMLButtonElement;
}

function getComposerInput(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-composer-card] [contenteditable="true"], [data-composer-card] textarea'
  );
}

describe('新对话空界面（项目选择 + 多行输入框）', () => {
  it('只渲染项目选择与多行输入框，且项目选择在输入框外面、位于其前', () => {
    stubProjects();
    render(<LandingHarness />);

    // 主列空态无任何可见内容（标题 / 建议卡片 / 最近会话均已移除）
    const emptyCol = screen.getByTestId('empty-col');
    expect(emptyCol.textContent).toBe('');
    expect(emptyCol.querySelector('button, h3, [role="list"]')).toBeNull();

    const card = document.querySelector('[data-composer-card]') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.getAttribute('data-multiline')).toBe('1');
    expect(card.getAttribute('data-empty-kind')).toBe('session-empty');

    const picker = getPicker();
    // 在输入框（composer 卡片）外面
    expect(card.contains(picker)).toBe(false);
    // 位于卡片之前，且与卡片同属一个 composer 包装
    expect(
      picker.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    const lead = picker.closest('[data-composer-lead]');
    expect(lead).not.toBeNull();
    // 紧邻其后的兄弟节点即 composer（卡片在其内部）
    expect(lead?.nextElementSibling?.contains(card)).toBe(true);
    expect(picker.closest('[data-composer-wrapper]')).toBe(
      card.closest('[data-composer-wrapper]')
    );

    // 品牌（Crish）在项目选择之上
    const brand = document.querySelector('[data-landing-brand]') as HTMLElement;
    expect(brand?.textContent).toContain('Crish');
    expect(
      brand.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    // 发送按钮常驻：空输入时 disabled 但仍在卡片内
    const send = card.querySelector('[data-send-active]') as HTMLButtonElement;
    expect(send).not.toBeNull();
    expect(send.disabled).toBe(true);

    // 页面上项目相关按钮只有这一个
    expect(screen.getAllByRole('button', { name: /项目/ })).toHaveLength(1);
  });

  it('点击打开项目菜单（以选择器为锚点）', async () => {
    stubProjects();
    render(<LandingHarness />);
    const picker = getPicker();
    expect(picker.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(picker);
    expect(
      await screen.findByRole('menu', { name: '选择项目' })
    ).toBeInTheDocument();
    expect(picker.getAttribute('aria-expanded')).toBe('true');
  });

  it('选中项目后关闭菜单，焦点移到输入框', async () => {
    stubProjects();
    const onProjectChanged = vi.fn();
    render(<LandingHarness onProjectChanged={onProjectChanged} />);
    fireEvent.click(getPicker());
    await screen.findByRole('menu', { name: '选择项目' });
    fireEvent.click(await screen.findByText('通用项目'));

    await waitFor(() => expect(onProjectChanged).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole('menu', { name: '选择项目' })).toBeNull()
    );
    await waitFor(() => {
      const input = getComposerInput();
      expect(input).not.toBeNull();
      expect(document.activeElement).toBe(input);
    });
  });

  it('Esc 关闭菜单，焦点还给选择器', async () => {
    stubProjects();
    render(<LandingHarness />);
    const picker = getPicker();
    fireEvent.click(picker);
    const menu = await screen.findByRole('menu', { name: '选择项目' });
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('menu', { name: '选择项目' })).toBeNull()
    );
    await waitFor(() => expect(document.activeElement).toBe(picker));
    expect(picker.getAttribute('aria-expanded')).toBe('false');
  });
});
