/**
 * 视觉判定只信 live catalog modalities.input；禁止正则 fail-open。
 */
// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mockTauriCommand } from '../test-setup';
import {
  ensureModelsCatalogLoaded,
  resetModelsCatalogMirror,
} from './modelsCatalogStore';
import {
  activeModelAcceptsImage,
  getModelVisionWarning,
  isComplexDocChatAttachment,
  isImageChatAttachment,
  isImageIntakeFile,
  isModelVisionSupported,
  notifyVisionWarning,
  onVisionWarning,
} from './modelVisionSupport';
import { modelAcceptsInput } from './modelsCatalogLive';
import type { ProviderSpec } from './modelsCatalogTypes';

const SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'modelVisionSupport.ts'
);
const CATALOG_PATH = 'C:\\Users\\tester\\.conex\\models.yaml';

const PROVIDERS: Record<string, ProviderSpec> = {
  openai: {
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai/chat',
    models: [
      {
        id: 'gpt-4o',
        modalities: { input: ['text'], output: ['text'] },
      },
      {
        id: 'gpt-4o-fake',
        modalities: { input: ['text'], output: ['text'] },
      },
      {
        id: 'my-plain-vl',
        modalities: { input: ['text', 'image'], output: ['text'] },
      },
    ],
  },
  acme: {
    displayName: 'Acme',
    baseUrl: 'https://example.invalid/v1',
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

describe('modelVisionSupport（只信 modalities.input）', () => {
  beforeEach(() => {
    resetModelsCatalogMirror();
  });

  it('生产源码零引用视觉正则 / getModelMeta / findCatalogModel', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    expect(src).not.toMatch(/VISION_MODEL_PATTERNS/);
    expect(src).not.toMatch(/NON_VISION_MODEL_PATTERNS/);
    expect(src).not.toMatch(/getModelMeta/);
    expect(src).not.toMatch(/findCatalogModel/);
    expect(src).toContain("modelAcceptsInput(pid, mid, 'image')");
  });

  it('store 未加载或 providerId 缺失 → false（含名字像视觉的 gpt-4o）', () => {
    expect(isModelVisionSupported('gpt-4o')).toBe(false);
    expect(isModelVisionSupported('gpt-4o', '')).toBe(false);
    expect(isModelVisionSupported('gpt-4o', null)).toBe(false);
    expect(isModelVisionSupported('', 'openai')).toBe(false);
    expect(activeModelAcceptsImage()).toBe(false);
  });

  it('yaml 无 image、id 为 gpt-4o → false（正则会判 true 的反例）', async () => {
    await loadProviders(PROVIDERS);
    expect(modelAcceptsInput('openai', 'gpt-4o', 'image')).toBe(false);
    expect(isModelVisionSupported('gpt-4o', 'openai')).toBe(false);
    expect(isModelVisionSupported('gpt-4o-fake', 'openai')).toBe(false);
  });

  it('yaml input 含 image、id 为 my-plain-vl → true（正则不一定命中的正例）', async () => {
    await loadProviders(PROVIDERS);
    expect(modelAcceptsInput('openai', 'my-plain-vl', 'image')).toBe(true);
    expect(isModelVisionSupported('my-plain-vl', 'openai')).toBe(true);
  });

  it('同名模型必须带对的 providerId；capabilities.image 不当真源', async () => {
    await loadProviders(PROVIDERS);
    expect(isModelVisionSupported('gpt-4o', 'openai')).toBe(false);
    expect(isModelVisionSupported('gpt-4o', 'acme')).toBe(true);
    expect(modelAcceptsInput('openai', 'gpt-4o', 'image')).toBe(false);
  });

  it('isImageIntakeFile / isImageChatAttachment 识别图片', () => {
    const png = new File(['x'], 'shot.png', { type: 'image/png' });
    const txt = new File(['x'], 'note.txt', { type: 'text/plain' });
    expect(isImageIntakeFile(png)).toBe(true);
    expect(isImageIntakeFile(txt)).toBe(false);
    expect(isImageChatAttachment({ name: 'a.webp' })).toBe(true);
    expect(isImageChatAttachment({ name: 'a.md', mime: 'text/markdown' })).toBe(
      false
    );
    expect(
      isImageChatAttachment({ name: 'x', dataUrl: 'data:image/png;base64,xx' })
    ).toBe(true);
  });

  it('isComplexDocChatAttachment 识别复杂文档（PDF、Office等）', () => {
    expect(isComplexDocChatAttachment({ name: 'report.pdf' })).toBe(true);
    expect(isComplexDocChatAttachment({ name: 'doc.docx' })).toBe(true);
    expect(isComplexDocChatAttachment({ name: 'deck.pptx' })).toBe(true);
    expect(isComplexDocChatAttachment({ name: 'sheet.xlsx' })).toBe(true);
    expect(
      isComplexDocChatAttachment({
        name: 'unknown',
        mime: 'application/pdf',
      })
    ).toBe(true);
    expect(
      isComplexDocChatAttachment({
        name: 'code.ts',
        mime: 'text/typescript',
      })
    ).toBe(false);
  });

  it('getModelVisionWarning 在模型无视觉时给出准确提示条警告文案', async () => {
    await loadProviders(PROVIDERS);
    // openai/gpt-4o 无视觉
    const imgWarn = getModelVisionWarning(
      [{ name: 'shot.png', mime: 'image/png' }],
      'gpt-4o',
      'openai'
    );
    expect(imgWarn).toContain('不支持图片输入');

    const docWarn = getModelVisionWarning(
      [{ name: 'contract.pdf', mime: 'application/pdf' }],
      'gpt-4o',
      'openai'
    );
    expect(docWarn).toContain('不支持复杂文档解析');

    const bothWarn = getModelVisionWarning(
      [
        { name: 'shot.png', mime: 'image/png' },
        { name: 'contract.pdf', mime: 'application/pdf' },
      ],
      'gpt-4o',
      'openai'
    );
    expect(bothWarn).toContain('多模态视觉与复杂文档解析');

    // acme/gpt-4o 有视觉 → null
    const supportedWarn = getModelVisionWarning(
      [{ name: 'shot.png', mime: 'image/png' }],
      'gpt-4o',
      'acme'
    );
    expect(supportedWarn).toBeNull();
  });

  it('notifyVisionWarning 与 onVisionWarning 正确分发与取消订阅', () => {
    let captured: string | null = 'init';
    const unsub = onVisionWarning((msg) => {
      captured = msg;
    });

    notifyVisionWarning('测试警告文案');
    expect(captured).toBe('测试警告文案');

    unsub();
    notifyVisionWarning('二次警告');
    expect(captured).toBe('测试警告文案'); // 不再更新
  });
});
