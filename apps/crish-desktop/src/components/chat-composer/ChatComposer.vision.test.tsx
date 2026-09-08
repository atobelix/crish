/**
 * ChatComposer 隐藏 file input：无视觉时 accept 排除图片，选图丢弃。
 */
// @vitest-environment jsdom
import React, { useRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { mockTauriCommand } from '../../test-setup';
import {
  ensureModelsCatalogLoaded,
  resetModelsCatalogMirror,
} from '../../api/modelsCatalogStore';
import type { ProviderSpec } from '../../api/modelsCatalogTypes';
import type { ChatComposerProps } from './ChatComposer';

vi.mock('../../api/providerProfiles', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/providerProfiles')>();
  return {
    ...actual,
    getActiveModelId: () => 'gpt-4o',
    getActiveProfileId: () => 'openai',
  };
});

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
}));

import { ChatComposer } from './ChatComposer';
import { COMPOSER_NON_IMAGE_FILE_ACCEPT } from '../../api/modelVisionSupport';

const CATALOG_PATH = 'C:\\Users\\tester\\.conex\\models.yaml';

function providers(input: string[]): Record<string, ProviderSpec> {
  return {
    openai: {
      displayName: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai/chat',
      models: [{ id: 'gpt-4o', modalities: { input, output: ['text'] } }],
    },
  };
}

async function loadCatalog(input: string[]): Promise<void> {
  resetModelsCatalogMirror();
  mockTauriCommand('workbench_read_models_yaml', () => ({
    path: CATALOG_PATH,
    content: '',
    template: '',
    seeded: false,
    parseError: null,
    providers: providers(input),
  }));
  mockTauriCommand('workbench_save_models_yaml', () => ({ path: CATALOG_PATH }));
  const res = await ensureModelsCatalogLoaded(true);
  expect(res.ok).toBe(true);
}

function renderComposer(onFilesSelected: ChatComposerProps['onFilesSelected']) {
  function Harness() {
    const fileInputRef = useRef<HTMLInputElement>(null);
    return (
      <ChatComposer
        chatInput=""
        setChatInput={() => {}}
        isComposing={false}
        setIsComposing={() => {}}
        filteredCommands={[]}
        loadSkillSlash={() => {}}
        onPasteImage={() => {}}
        onSend={() => {}}
        onStop={() => {}}
        canSend={false}
        isProcessing={false}
        attachments={[]}
        setAttachments={() => {}}
        fileInputRef={fileInputRef}
        onFilesSelected={onFilesSelected}
        showPlusMenu={false}
        setShowPlusMenu={() => {}}
        permissionMode="ask"
        onPermissionChange={() => {}}
      />
    );
  }
  return render(<Harness />);
}

describe('ChatComposer 选图守卫', () => {
  beforeEach(() => {
    resetModelsCatalogMirror();
  });

  it('无视觉：hidden file input 取消 accept 硬过滤，允许选取文件交付 onFilesSelected', async () => {
    await loadCatalog(['text']);
    const onFilesSelected = vi.fn();
    renderComposer(onFilesSelected);
    const input = document.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.getAttribute('data-image-intake')).toBe('off');
    expect(input.getAttribute('accept')).toBeNull();

    const png = new File(['x'], 'a.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [png],
    });
    fireEvent.change(input);
    expect(onFilesSelected).toHaveBeenCalledTimes(1);
  });

  it('有视觉：不设 accept 限制，选 png 交给 onFilesSelected', async () => {
    await loadCatalog(['text', 'image']);
    const onFilesSelected = vi.fn();
    renderComposer(onFilesSelected);
    const input = document.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement;
    expect(input.getAttribute('data-image-intake')).toBe('on');
    expect(input.getAttribute('accept')).toBeNull();

    const png = new File(['x'], 'a.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [png],
    });
    fireEvent.change(input);
    expect(onFilesSelected).toHaveBeenCalledTimes(1);
    const passed = onFilesSelected.mock.calls[0][0] as File[];
    expect(passed).toHaveLength(1);
    expect(passed[0]?.name).toBe('a.png');
  });
});
