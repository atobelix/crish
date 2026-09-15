/**
 * checkModelVisionSupport 只是 isModelVisionSupported 别名；发送第二道闸仍 abort。
 * @vitest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mockTauriCommand } from '../../test-setup';
import {
  ensureModelsCatalogLoaded,
  resetModelsCatalogMirror,
} from '../../api/modelsCatalogStore';
import type { ProviderSpec } from '../../api/modelsCatalogTypes';

const toastShowMock = vi.hoisted(() => vi.fn());

vi.mock('../../services/toast/ToastContext', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../services/toast/ToastContext')>();
  return {
    ...actual,
    toast: { ...actual.toast, show: (...args: unknown[]) => toastShowMock(...args) },
  };
});

vi.mock('../../api/providerProfiles', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/providerProfiles')>();
  return {
    ...actual,
    getActiveModelId: () => 'gpt-4o',
    getActiveProfileId: () => 'openai',
  };
});

vi.mock('../../api/workspaceFsApi', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/workspaceFsApi')>();
  return {
    ...actual,
    formatAnnotationsForModel: () => '',
    takePendingFileAnnotations: () => [],
  };
});

vi.mock('../../store/sessionStore', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../store/sessionStore')>();
  return {
    ...actual,
    getSessionById: () => ({ goalMode: null }),
  };
});

import {
  assembleChatPayload,
  checkModelVisionSupport,
} from './slashSendPreflight';

const SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'slashSendPreflight.ts'
);
const CATALOG_PATH = 'C:\\Users\\tester\\.conex\\models.yaml';

const TEXT_ONLY: Record<string, ProviderSpec> = {
  openai: {
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai/chat',
    models: [
      {
        id: 'gpt-4o',
        modalities: { input: ['text'], output: ['text'] },
      },
    ],
  },
};

const WITH_IMAGE: Record<string, ProviderSpec> = {
  openai: {
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai/chat',
    models: [
      {
        id: 'gpt-4o',
        modalities: { input: ['text', 'image'], output: ['text'] },
      },
    ],
  },
};

async function loadProviders(
  providers: Record<string, ProviderSpec>
): Promise<void> {
  mockTauriCommand('workbench_read_models_yaml', () => ({
    path: CATALOG_PATH,
    content: '',
    template: '',
    revision: 'revision-0',
    credentialStates: {},
    parseError: null,
    tree: { version: 2, activeModel: null, providers },
  }));
  mockTauriCommand('workbench_save_models_yaml', () => ({
    path: CATALOG_PATH,
  }));
  const res = await ensureModelsCatalogLoaded(true);
  expect(res.ok).toBe(true);
}

describe('slashSendPreflight 视觉单轨', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetModelsCatalogMirror();
  });

  it('生产路径不再三连 fail-open（无 getModelMeta / 无 store 全局兜底 / 无正则）', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    expect(src).not.toMatch(/getModelMeta/);
    expect(src).not.toMatch(/modelsCatalogStore/);
    expect(src).not.toMatch(/VISION_MODEL_PATTERNS/);
    expect(src).not.toMatch(/globalModelIndex/);
    expect(src).toContain('isModelVisionSupported(modelId, profileId)');
  });

  it('providerId 缺失 → false；yaml 无 image 的 gpt-4o → false', async () => {
    await loadProviders(TEXT_ONLY);
    expect(checkModelVisionSupport('gpt-4o')).toBe(false);
    expect(checkModelVisionSupport('gpt-4o', 'openai')).toBe(false);
  });

  it('yaml input 含 image → true', async () => {
    await loadProviders(WITH_IMAGE);
    expect(checkModelVisionSupport('gpt-4o', 'openai')).toBe(true);
  });

  it('已挂图片且当前模型无视觉：assembleChatPayload 仍硬抛（第二道闸）', async () => {
    await loadProviders(TEXT_ONLY);
    expect(() =>
      assembleChatPayload({
        sessionId: 'sess-1',
        rawInput: '看图',
        slash: { kind: 'none', raw: '看图' },
        modelText: '看图',
        displayText: '看图',
        attachments: [
          {
            name: 'shot.png',
            mime: 'image/png',
            dataUrl: 'data:image/png;base64,xx',
          },
        ],
      })
    ).toThrow(/不支持图片输入/);
    expect(toastShowMock).toHaveBeenCalled();
  });
});
