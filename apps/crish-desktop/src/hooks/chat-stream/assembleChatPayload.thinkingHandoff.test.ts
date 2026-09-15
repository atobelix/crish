/**
 * assembleChatPayload：发送选项写入 thinkingTitle / thinkingWire（yaml key / live value）。
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTauriCommand } from '../../test-setup';
import {
  ensureModelsCatalogLoaded,
  resetModelsCatalogMirror,
} from '../../api/modelsCatalogStore';
import {
  sessionRuntimeRegistry,
  setSessionThinkingTitle,
} from '../../api/SessionRuntimeRegistry';
import type { ProviderSpec } from '../../api/modelsCatalogTypes';

vi.mock('../../api/storeAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/storeAccess')>();
  return {
    ...actual,
    patchSession: vi.fn(),
    setPermissionMode: vi.fn(),
  };
});

vi.mock('../../services/toast/ToastContext', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../services/toast/ToastContext')>();
  return {
    ...actual,
    toast: { ...actual.toast, show: vi.fn() },
  };
});

vi.mock('../../api/providerProfiles', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/providerProfiles')>();
  return {
    ...actual,
    getActiveModelId: () => 'flash',
    getActiveProfileId: () => 'gemini',
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

import { assembleChatPayload } from './slashSendPreflight';

const CATALOG_PATH = 'C:\\tmp\\models.yaml';

async function loadGeminiFlash(): Promise<void> {
  resetModelsCatalogMirror();
  mockTauriCommand('workbench_read_models_yaml', () => ({
    path: CATALOG_PATH,
    content: '',
    template: '',
    revision: 'revision-0',
    credentialStates: {},
    parseError: null,
    tree: {
      version: 2,
      activeModel: null,
      providers: {
      gemini: {
        displayName: 'Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com',
        protocol: 'google/generate-content',
        models: [
          { id: 'flash', thinking: { Off: 'disabled', High: 'HIGH' } },
        ],
      } satisfies ProviderSpec,
      },
    },
  }));
  mockTauriCommand('workbench_save_models_yaml', () => ({ path: CATALOG_PATH }));
  const res = await ensureModelsCatalogLoaded(true);
  expect(res.ok).toBe(true);
}

describe('assembleChatPayload thinking handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionRuntimeRegistry.clearAll();
  });

  afterEach(() => {
    sessionRuntimeRegistry.clearAll();
    resetModelsCatalogMirror();
  });

  it('会话 High → finalStreamOptions.thinkingWire 为 HIGH，不是 high', async () => {
    await loadGeminiFlash();
    setSessionThinkingTitle('sess-1', 'High');
    const out = assembleChatPayload({
      sessionId: 'sess-1',
      rawInput: 'hello',
      slash: { kind: 'none', raw: 'hello' },
      modelText: 'hello',
      displayText: 'hello',
      attachments: [],
    });
    expect(out.finalStreamOptions?.thinkingTitle).toBe('High');
    expect(out.finalStreamOptions?.thinkingWire).toBe('HIGH');
  });

  it('缺会话 Title → 不注入思考档位（视为未选，不回落字典第一 key）', async () => {
    await loadGeminiFlash();
    const out = assembleChatPayload({
      sessionId: 'sess-1',
      rawInput: 'hello',
      slash: { kind: 'none', raw: 'hello' },
      modelText: 'hello',
      displayText: 'hello',
      attachments: [],
    });
    expect(out.finalStreamOptions?.thinkingTitle).toBeUndefined();
    expect(out.finalStreamOptions?.thinkingWire).toBeUndefined();
  });

  it('原选档位不在当前模型声明中 → 不注入（视为未选，不降级到 Off/High）', async () => {
    await loadGeminiFlash();
    setSessionThinkingTitle('sess-1', 'Medium');
    const out = assembleChatPayload({
      sessionId: 'sess-1',
      rawInput: 'hello',
      slash: { kind: 'none', raw: 'hello' },
      modelText: 'hello',
      displayText: 'hello',
      attachments: [],
    });
    expect(out.finalStreamOptions?.thinkingTitle).toBeUndefined();
    expect(out.finalStreamOptions?.thinkingWire).toBeUndefined();
  });
});
