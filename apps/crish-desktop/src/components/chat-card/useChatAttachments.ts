import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatAttachment } from '../../hooks/useChatStream';
import { sessionRuntimeRegistry } from '../../api/SessionRuntimeRegistry';
import type { Attachment } from '../../api/SessionRuntimeRegistry';
import { toast } from '../../services/toast/ToastContext';
import { openFileDialog } from '../../api/openFileDialog';

function isImageFile(f: File): boolean {
  return (
    f.type.startsWith('image/') ||
    /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name)
  );
}

const DRAFT_SESSION_KEY = '__composer_draft_session__';

export interface UseChatAttachmentsOptions {
  activeSessionId: string | null;
}

export interface UseChatAttachmentsResult {
  attachments: ChatAttachment[];
  setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  handleFilesSelected: (files: File[]) => Promise<void>;
  handlePathsSelected: (paths: string[]) => Promise<void>;
  handlePickFiles: () => Promise<void>;
  handlePasteImage: (e: React.ClipboardEvent) => Promise<void>;
}

export function useChatAttachments({
  activeSessionId,
}: UseChatAttachmentsOptions): UseChatAttachmentsResult {
  const currentKey = activeSessionId || DRAFT_SESSION_KEY;
  const [attachments, setAttachments] = useState<ChatAttachment[]>(() => {
    return (sessionRuntimeRegistry.get(currentKey).attachments ??
      []) as ChatAttachment[];
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const prevSessionIdRef = useRef(activeSessionId);

  useEffect(() => {
    const prevKey = prevSessionIdRef.current || DRAFT_SESSION_KEY;
    const effectiveCurrentKey = activeSessionId || DRAFT_SESSION_KEY;
    if (prevKey !== effectiveCurrentKey) {
      sessionRuntimeRegistry.save(prevKey, {
        attachments: attachments as Attachment[],
      });
    }
    prevSessionIdRef.current = activeSessionId || '';
    const restored = sessionRuntimeRegistry.get(effectiveCurrentKey);
    setAttachments((restored.attachments ?? []) as ChatAttachment[]);
  }, [activeSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const key = activeSessionId || DRAFT_SESSION_KEY;
    sessionRuntimeRegistry.save(key, {
      attachments: attachments as Attachment[],
    });
  }, [activeSessionId, attachments]);

  // 监听外部注入附件事件（如文件选区批注作为附件挂载）
  useEffect(() => {
    const handleAttachmentsChanged = (e: Event) => {
      const customEvent = e as CustomEvent<{ sessionId?: string }>;
      const targetSid = customEvent.detail?.sessionId;
      const effectiveCurrentKey = activeSessionId || DRAFT_SESSION_KEY;
      if (!targetSid || targetSid === effectiveCurrentKey) {
        const latest = (sessionRuntimeRegistry.get(effectiveCurrentKey).attachments ??
          []) as ChatAttachment[];
        setAttachments([...latest]);
      }
    };
    window.addEventListener('crish-attachments-changed', handleAttachmentsChanged);
    return () => {
      window.removeEventListener(
        'crish-attachments-changed',
        handleAttachmentsChanged
      );
    };
  }, [activeSessionId]);

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
        const filePath =
          (f as unknown as { path?: string }).path ||
          (f as unknown as { webkitRelativePath?: string }).webkitRelativePath ||
          f.name;
        if (isImageFile(f)) {
          try {
            if (!blobToImageAttachment) {
              ({ blobToImageAttachment } = await import(
                '../../api/imageProcessing'
              ));
            }
            const imgAtt = await blobToImageAttachment(f, f.name);
            imgAtt.path = filePath;
            next.push(imgAtt);
          } catch {
            next.push({
              name: f.name,
              path: filePath,
              ...(f.type ? { mime: f.type } : {}),
            });
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
            next.push({ name: f.name, path: filePath, text, mime: f.type || undefined });
          } catch {
            next.push({ name: f.name, path: filePath, mime: f.type || undefined });
          }
        } else {
          next.push({ name: f.name, path: filePath, mime: f.type || undefined });
        }
      }
      addAttachments(next);
    },
    [addAttachments]
  );

  const handlePathsSelected = useCallback(
    async (paths: string[]) => {
      if (!paths.length) return;
      const next: ChatAttachment[] = [];

      for (const p of paths) {
        const trimmed = (p || '').trim();
        if (!trimmed) continue;
        const name = trimmed.replace(/^.*[\\/]/, '') || trimmed;
        const lower = name.toLowerCase();
        const isImg = /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(lower);

        if (isImg) {
          try {
            const { readLocalImageAsDataUrl, getMimeFromPath } = await import(
              '../../api/localFileReader'
            );
            const dataUrl = await readLocalImageAsDataUrl(trimmed);
            const mime = getMimeFromPath(trimmed);
            if (dataUrl) {
              next.push({ name, path: trimmed, dataUrl, mime });
              continue;
            }
          } catch {
            /* swallow-ok */
          }
          next.push({ name, path: trimmed, mime: 'image/png' });
          continue;
        }

        const isCodeOrText =
          /\.(txt|md|markdown|json|ts|tsx|js|jsx|css|html|py|rs|go|java|c|cpp|h|ya?ml|toml|xml|csv|log|sh|ps1)$/i.test(
            lower
          );
        if (isCodeOrText) {
          try {
            const { readLocalTextBestEffort } = await import(
              '../../api/localFileReader'
            );
            const text = await readLocalTextBestEffort(trimmed);
            next.push({
              name,
              path: trimmed,
              text: text ?? undefined,
              mime: 'text/plain',
            });
            continue;
          } catch {
            /* swallow-ok */
          }
        }

        let mime = 'application/octet-stream';
        if (/\.pptx?$/i.test(lower)) mime = 'application/vnd.ms-powerpoint';
        else if (/\.docx?$/i.test(lower)) mime = 'application/msword';
        else if (/\.xlsx?$/i.test(lower)) mime = 'application/vnd.ms-excel';
        else if (/\.pdf$/i.test(lower)) mime = 'application/pdf';

        next.push({ name, path: trimmed, mime });
      }

      if (next.length > 0) {
        addAttachments(next);
      }
    },
    [addAttachments]
  );

  const handlePickFiles = useCallback(async () => {
    try {
      const paths = await openFileDialog({
        title: '添加文件',
        multiple: true,
      });
      if (paths && paths.length > 0) {
        await handlePathsSelected(paths);
        return;
      }
      if (paths === null) {
        return;
      }
    } catch {
      /* native dialog unavailable -> fallback to DOM input */
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  }, [handlePathsSelected]);

  return {
    attachments,
    setAttachments,
    fileInputRef,
    handleFilesSelected,
    handlePathsSelected,
    handlePickFiles,
    handlePasteImage,
  };
}
