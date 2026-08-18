import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatAttachment } from '../../hooks/useChatStream';
import { sessionRuntimeRegistry } from '../../api/SessionRuntimeRegistry';
import type { Attachment } from '../../api/SessionRuntimeRegistry';
import { toast } from '../../services/toast/ToastContext';

function isImageFile(f: File): boolean {
  return (
    f.type.startsWith('image/') ||
    /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name)
  );
}

export interface UseChatAttachmentsOptions {
  activeSessionId: string | null;
}

export interface UseChatAttachmentsResult {
  attachments: ChatAttachment[];
  setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  handleFilesSelected: (files: File[]) => Promise<void>;
  handlePasteImage: (e: React.ClipboardEvent) => Promise<void>;
}

export function useChatAttachments({
  activeSessionId,
}: UseChatAttachmentsOptions): UseChatAttachmentsResult {
  const [attachments, setAttachments] = useState<ChatAttachment[]>(() => {
    if (activeSessionId) {
      return (sessionRuntimeRegistry.get(activeSessionId).attachments ??
        []) as ChatAttachment[];
    }
    return [];
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const prevSessionIdRef = useRef(activeSessionId);

  useEffect(() => {
    const prevId = prevSessionIdRef.current;
    if (prevId && prevId !== activeSessionId) {
      sessionRuntimeRegistry.save(prevId, {
        attachments: attachments as Attachment[],
      });
    }
    prevSessionIdRef.current = activeSessionId || '';
    if (activeSessionId) {
      const restored = sessionRuntimeRegistry.get(activeSessionId);
      setAttachments((restored.attachments ?? []) as ChatAttachment[]);
    } else {
      setAttachments([]);
    }
  }, [activeSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const addAttachments = useCallback((items: ChatAttachment[]) => {
    if (!items.length) return;
    setAttachments((prev) => {
      const names = new Set(prev.map((p) => p.name));
      const next = items.filter((n) => !names.has(n.name));
      const uniqued = items
        .filter((n) => names.has(n.name))
        .map((n, i) => {
          if (!n.dataUrl) return null;
          const base = n.name.replace(/(\.[^.]+)?$/, '');
          const ext = (n.name.match(/(\.[^.]+)$/) || [])[1] || '';
          return { ...n, name: `${base}-${Date.now()}-${i}${ext}` };
        })
        .filter(Boolean) as ChatAttachment[];
      return [...prev, ...next, ...uniqued];
    });
  }, []);

  const handlePasteImage = useCallback(
    async (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items?.length) return;
      const imageFiles: File[] = [];
      for (const item of Array.from(items)) {
        if (!item.type.startsWith('image/')) continue;
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
      if (!imageFiles.length) return;
      e.preventDefault();
      try {
        const { blobToImageAttachment } = await import(
          '../../api/imageProcessing'
        );
        const next: ChatAttachment[] = [];
        for (const f of imageFiles) {
          next.push(await blobToImageAttachment(f, f.name || undefined));
        }
        addAttachments(next);
      } catch {
        toast.show('图片粘贴失败');
      }
    },
    [addAttachments]
  );

  const handleFilesSelected = useCallback(
    async (files: File[]) => {
      const next: ChatAttachment[] = [];
      let blobToImageAttachment:
        | ((blob: Blob, preferredName?: string) => Promise<ChatAttachment>)
        | null = null;
      for (const f of files) {
        if (isImageFile(f)) {
          try {
            if (!blobToImageAttachment) {
              ({ blobToImageAttachment } = await import(
                '../../api/imageProcessing'
              ));
            }
            next.push(await blobToImageAttachment(f, f.name));
          } catch {
            next.push({ name: f.name, ...(f.type ? { mime: f.type } : {}) });
          }
          continue;
        }
        const isText =
          f.type.startsWith('text/') ||
          /\.(txt|md|json|ts|tsx|js|jsx|css|html|py|rs|go|java|c|cpp|h|yml|yaml|toml|xml|csv|log|sh|ps1)$/i.test(
            f.name
          );
        if (isText && f.size < 512_000) {
          try {
            const text = await f.text();
            next.push({ name: f.name, text });
          } catch {
            next.push({ name: f.name });
          }
        } else {
          next.push({ name: f.name });
        }
      }
      addAttachments(next);
    },
    [addAttachments]
  );

  return {
    attachments,
    setAttachments,
    fileInputRef,
    handleFilesSelected,
    handlePasteImage,
  };
}
