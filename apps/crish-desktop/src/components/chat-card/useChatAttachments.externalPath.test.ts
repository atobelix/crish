/**
 * 模块 B 验收：附件入队状态机与外来路径放行单元测试
 * 确保外部路径（工作区外绝对路径、剪贴板多模态文件等）不会被静默吞掉，无异常抛出。
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { sessionRuntimeRegistry } from '../../api/SessionRuntimeRegistry';

const vision = vi.hoisted(() => ({
  accepts: false,
  strip: false,
}));

vi.mock('../../api/modelVisionSupport', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/modelVisionSupport')>();
  return {
    ...actual,
    activeModelAcceptsImage: () => vision.accepts,
    shouldStripImagesForActiveModel: () => vision.strip,
  };
});

const toastShow = vi.hoisted(() => vi.fn());
vi.mock('../../services/toast/ToastContext', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../services/toast/ToastContext')>();
  return {
    ...actual,
    toast: { ...actual.toast, show: (...args: unknown[]) => toastShow(...args) },
  };
});

vi.mock('../../api/imageProcessing', () => ({
  blobToImageAttachment: vi.fn(async (_blob: Blob, name?: string) => ({
    name: name || 'image.png',
    dataUrl: 'data:image/png;base64,mock',
    mime: 'image/png',
    status: 'ready',
    progress: 100,
  })),
  generateSquareThumbnail: vi.fn(async () => 'data:image/png;base64,thumb'),
}));

vi.mock('../../api/localFileReader', () => ({
  getMimeFromPath: vi.fn((p: string) => {
    const lower = p.toLowerCase();
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.docx')) return 'application/msword';
    if (lower.endsWith('.pptx')) return 'application/vnd.ms-powerpoint';
    if (lower.endsWith('.xlsx')) return 'application/vnd.ms-excel';
    if (lower.endsWith('.pdf')) return 'application/pdf';
    return 'application/octet-stream';
  }),
  readLocalImageAsDataUrl: vi.fn(async (p: string) => {
    if (p.includes('invalid')) throw new Error('Not found');
    return 'data:image/png;base64,mockLocalDataUrl';
  }),
  readLocalTextBestEffort: vi.fn(async (p: string) => {
    // 模拟外来路径：如果抛出（例如在实际运行中因非工作区沙箱被拦截），也不应当阻断入队
    if (p.includes('outside')) {
      throw new Error('文件不在当前工作区内');
    }
    return 'print("hello from test")';
  }),
}));

import { useChatAttachments } from './useChatAttachments';
import { VISION_IMAGE_BLOCKED_TOAST } from '../../api/modelVisionSupport';

describe('useChatAttachments 外部路径放行与状态机 (模块 B)', () => {
  beforeEach(() => {
    vision.accepts = false;
    vision.strip = false;
    toastShow.mockClear();
    sessionRuntimeRegistry.clearAll();
  });

  afterEach(() => {
    sessionRuntimeRegistry.clearAll();
  });

  it('外部代码/纯文本路径（如 C:/Users/test/Desktop/demo.py）能成功入队，无异常抛出', async () => {
    const { result } = renderHook(() =>
      useChatAttachments({ activeSessionId: 'test-external-session' })
    );

    await act(async () => {
      await result.current.handlePathsSelected([
        'C:/Users/test/Desktop/demo.py',
        'D:/projects/outside/script.rs',
      ]);
    });

    expect(result.current.attachments).toHaveLength(2);
    expect(result.current.attachments[0]).toMatchObject({
      name: 'demo.py',
      path: 'C:/Users/test/Desktop/demo.py',
      mime: 'text/plain',
    });
    expect(result.current.attachments[1]).toMatchObject({
      name: 'script.rs',
      path: 'D:/projects/outside/script.rs',
      mime: 'text/plain',
    });
  });

  it('无视觉模型时，图片绝对路径绝不静默丢弃，仍然带 isImage: true 入队并通知提示', async () => {
    vision.accepts = false;
    const { result } = renderHook(() =>
      useChatAttachments({ activeSessionId: 'test-vision-blocked-session' })
    );

    const listener = vi.fn();
    window.addEventListener('crish-model-vision-unsupported', listener);

    await act(async () => {
      await result.current.handlePathsSelected([
        'C:/Users/test/Pictures/screenshot.png',
      ]);
    });

    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.attachments[0]).toMatchObject({
      name: 'screenshot.png',
      path: 'C:/Users/test/Pictures/screenshot.png',
      mime: 'image/png',
      isImage: true,
    });
    expect(toastShow).toHaveBeenCalledWith(VISION_IMAGE_BLOCKED_TOAST);
    expect(listener).toHaveBeenCalled();
    window.removeEventListener('crish-model-vision-unsupported', listener);
  });

  it('有视觉模型时，图片绝对路径入队并生成缩略图与 dataUrl', async () => {
    vision.accepts = true;
    const { result } = renderHook(() =>
      useChatAttachments({ activeSessionId: 'test-vision-accepted-session' })
    );

    await act(async () => {
      await result.current.handlePathsSelected([
        'C:/Users/test/Pictures/screenshot.png',
      ]);
    });

    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.attachments[0]).toMatchObject({
      name: 'screenshot.png',
      path: 'C:/Users/test/Pictures/screenshot.png',
      mime: 'image/png',
      isImage: true,
      dataUrl: 'data:image/png;base64,mockLocalDataUrl',
      thumbnailUrl: 'data:image/png;base64,thumb',
      status: 'ready',
    });
  });

  it('外部文档类型（PDF / Office / 表格等）能成功入队且识别正确的 MIME', async () => {
    const { result } = renderHook(() =>
      useChatAttachments({ activeSessionId: 'test-docs-session' })
    );

    await act(async () => {
      await result.current.handlePathsSelected([
        'C:/Users/test/Documents/spec.docx',
        'C:/Users/test/Documents/slides.pptx',
        'C:/Users/test/Documents/data.xlsx',
        'C:/Users/test/Documents/manual.pdf',
      ]);
    });

    expect(result.current.attachments).toHaveLength(4);
    expect(result.current.attachments[0]).toMatchObject({
      name: 'spec.docx',
      path: 'C:/Users/test/Documents/spec.docx',
      mime: 'application/msword',
    });
    expect(result.current.attachments[1]).toMatchObject({
      name: 'slides.pptx',
      path: 'C:/Users/test/Documents/slides.pptx',
      mime: 'application/vnd.ms-powerpoint',
    });
    expect(result.current.attachments[2]).toMatchObject({
      name: 'data.xlsx',
      path: 'C:/Users/test/Documents/data.xlsx',
      mime: 'application/vnd.ms-excel',
    });
    expect(result.current.attachments[3]).toMatchObject({
      name: 'manual.pdf',
      path: 'C:/Users/test/Documents/manual.pdf',
      mime: 'application/pdf',
    });
  });

  it('handlePasteFiles 能够接收剪贴板中的多模态文件与带有本机 path 的文件', async () => {
    const { result } = renderHook(() =>
      useChatAttachments({ activeSessionId: 'test-paste-files-session' })
    );

    const fileWithPath = new File(['code'], 'script.py', { type: 'text/x-python' });
    Object.defineProperty(fileWithPath, 'path', {
      value: 'C:/Users/test/Desktop/script.py',
    });

    const fileBlobOnly = new File(['plain text'], 'note.txt', { type: 'text/plain' });

    await act(async () => {
      await result.current.handlePasteFiles([fileWithPath, fileBlobOnly]);
    });

    expect(result.current.attachments.length).toBeGreaterThanOrEqual(2);
    const names = result.current.attachments.map((a) => a.name);
    expect(names).toContain('script.py');
    expect(names).toContain('note.txt');
  });
});
