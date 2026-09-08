/**
 * L8：无视觉模型 intake 不挂图；切到纯文本立即剥已挂图片。
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type React from 'react';
import { emitUiEvent } from '../../api/uiEvents';
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
    dataUrl: 'data:image/png;base64,xx',
    mime: 'image/png',
    status: 'ready',
    progress: 100,
  })),
  generateSquareThumbnail: vi.fn(async () => 'data:image/png;base64,th'),
}));

import { useChatAttachments } from './useChatAttachments';
import { VISION_IMAGE_BLOCKED_TOAST } from '../../api/modelVisionSupport';

function pasteEvent(file: File): React.ClipboardEvent {
  const preventDefault = vi.fn();
  return {
    preventDefault,
    clipboardData: {
      items: [{ type: file.type, getAsFile: () => file }],
    },
  } as unknown as React.ClipboardEvent;
}

describe('useChatAttachments 视觉入口', () => {
  beforeEach(() => {
    vision.accepts = false;
    vision.strip = false;
    toastShow.mockClear();
    sessionRuntimeRegistry.clearAll();
  });

  afterEach(() => {
    sessionRuntimeRegistry.clearAll();
  });

  it('无视觉：粘贴图片不 preventDefault、不入列', async () => {
    const { result } = renderHook(() =>
      useChatAttachments({ activeSessionId: 's1' })
    );
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    const ev = pasteEvent(file);
    await act(async () => {
      await result.current.handlePasteImage(ev);
    });
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(result.current.attachments).toEqual([]);
    expect(toastShow).toHaveBeenCalledWith(VISION_IMAGE_BLOCKED_TOAST);
  });

  it('无视觉：文件选择 / 拖放图片不入列，非图片仍可加', async () => {
    const { result } = renderHook(() =>
      useChatAttachments({ activeSessionId: 's1' })
    );
    const png = new File(['x'], 'a.png', { type: 'image/png' });
    const txt = new File(['hello'], 'note.txt', { type: 'text/plain' });
    await act(async () => {
      await result.current.handleFilesSelected([png, txt]);
    });
    expect(result.current.attachments.map((a) => a.name)).toEqual(['note.txt']);
    expect(toastShow).toHaveBeenCalledWith(VISION_IMAGE_BLOCKED_TOAST);

    toastShow.mockClear();
    await act(async () => {
      await result.current.handleDroppedFiles([
        new File(['y'], 'b.jpg', { type: 'image/jpeg' }),
      ]);
    });
    expect(result.current.attachments.map((a) => a.name)).toEqual(['note.txt']);
  });

  it('有视觉：粘贴图片入列', async () => {
    vision.accepts = true;
    const { result } = renderHook(() =>
      useChatAttachments({ activeSessionId: 's1' })
    );
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    const ev = pasteEvent(file);
    await act(async () => {
      await result.current.handlePasteImage(ev);
    });
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.attachments[0]?.name).toBe('shot.png');
  });

  it('已挂图后切到纯文本 / catalog 去掉 image：立即剥图片芯片', async () => {
    vision.accepts = true;
    vision.strip = false;
    const { result } = renderHook(() =>
      useChatAttachments({ activeSessionId: 's1' })
    );
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    await act(async () => {
      await result.current.handlePasteImage(pasteEvent(file));
    });
    expect(result.current.attachments).toHaveLength(1);

    vision.accepts = false;
    vision.strip = true;
    act(() => {
      emitUiEvent('models-catalog-changed', undefined);
    });
    expect(result.current.attachments).toEqual([]);
  });
});
