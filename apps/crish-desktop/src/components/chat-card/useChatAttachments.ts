import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatAttachment } from '../../hooks/useChatStream';
import { sessionRuntimeRegistry } from '../../api/SessionRuntimeRegistry';
import type { Attachment } from '../../api/SessionRuntimeRegistry';
import { toast } from '../../services/toast/ToastContext';
import { openFileDialog } from '../../api/openFileDialog';
import {
  createAttachmentIntakeDedupe,
  extractFileSystemPath,
  mergeAttachmentsIdempotent,
  normalizeIntakePathKey,
} from '../../api/attachmentIntake';
import { onUiEvent } from '../../api/uiEvents';
import {
  activeModelAcceptsImage,
  COMPOSER_NON_IMAGE_FILE_ACCEPT,
  isImageChatAttachment,
  isImageIntakeFile,
  notifyImageIntakeBlocked,
  shouldStripImagesForActiveModel,
} from '../../api/modelVisionSupport';

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
  /** §3.1 拖放唯一入口：有 File.path 收敛为 paths；否则 blob */
  handleDroppedFiles: (files: File[]) => Promise<void>;
  handlePickFiles: () => Promise<void>;
  handlePasteImage: (e: React.ClipboardEvent) => Promise<void>;
  handlePasteFiles: (files: File[]) => Promise<void>;
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
  const intakeDedupeRef = useRef(createAttachmentIntakeDedupe());

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
    let next = (restored.attachments ?? []) as ChatAttachment[];
    if (shouldStripImagesForActiveModel()) {
      next = next.filter((a) => !isImageChatAttachment(a));
    }
    setAttachments(next);
  }, [activeSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const key = activeSessionId || DRAFT_SESSION_KEY;
    sessionRuntimeRegistry.save(key, {
      attachments: attachments as Attachment[],
    });
  }, [activeSessionId, attachments]);

  useEffect(() => {
    const strip = () => {
      if (!shouldStripImagesForActiveModel()) return;
      setAttachments((prev) => {
        const next = prev.filter((a) => !isImageChatAttachment(a));
        if (next.length === prev.length) return prev;
        notifyImageIntakeBlocked();
        return next;
      });
    };
    const offModel = onUiEvent('model-changed', strip);
    const offCatalog = onUiEvent('models-catalog-changed', strip);
    strip();
    return () => {
      offModel();
      offCatalog();
    };
  }, []);

  // 监听外部注入附件事件（如文件选区批注作为附件挂载）
  useEffect(() => {
    const handleAttachmentsChanged = (e: Event) => {
      const customEvent = e as CustomEvent<{ sessionId?: string }>;
      const targetSid = customEvent.detail?.sessionId;
      const effectiveCurrentKey = activeSessionId || DRAFT_SESSION_KEY;
      if (!targetSid || targetSid === effectiveCurrentKey) {
        const latest = (sessionRuntimeRegistry.get(effectiveCurrentKey)
          .attachments ?? []) as ChatAttachment[];
        setAttachments([...latest]);
      }
    };
    window.addEventListener(
      'crish-attachments-changed',
      handleAttachmentsChanged
    );
    return () => {
      window.removeEventListener(
        'crish-attachments-changed',
        handleAttachmentsChanged
      );
    };
  }, [activeSessionId]);

  const addAttachments = useCallback((items: ChatAttachment[]) => {
    if (!items.length) return;
    setAttachments((prev) => mergeAttachmentsIdempotent(prev, items));
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
      if (!activeModelAcceptsImage()) {
        notifyImageIntakeBlocked();
        return;
      }
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

  const handlePathsSelected = useCallback(
    async (paths: string[]) => {
      if (!paths.length) return;
      const keys = paths.map(normalizeIntakePathKey).filter(Boolean);
      const freshKeys = new Set(intakeDedupeRef.current.claim(keys));
      const filtered = paths.filter((p) =>
        freshKeys.has(normalizeIntakePathKey(p))
      );
      if (!filtered.length) return;

      const acceptsImage = activeModelAcceptsImage();
      const next: ChatAttachment[] = [];
      let rejectedImage = false;

      for (const p of filtered) {
        const trimmed = (p || '').trim();
        if (!trimmed) continue;
        const safePath = trimmed;
        const name = safePath.replace(/^.*[\\/]/, '') || safePath;
        const lower = name.toLowerCase();
        const isImg = isImageChatAttachment({ name, path: safePath });

        if (isImg) {
          let mime = 'image/png';
          try {
            const { getMimeFromPath } = await import(
              '../../api/localFileReader'
            );
            const detected = getMimeFromPath(safePath);
            if (detected && detected.startsWith('image/')) {
              mime = detected;
            }
          } catch {
            // fallback mime
          }

          if (!acceptsImage) {
            rejectedImage = true;
            next.push({
              name,
              path: safePath,
              mime,
              isImage: true,
            });
            continue;
          }

          try {
            const { readLocalImageAsDataUrl } = await import(
              '../../api/localFileReader'
            );
            const dataUrl = await readLocalImageAsDataUrl(safePath);
            if (!dataUrl) {
              next.push({
                name,
                path: safePath,
                mime,
                isImage: true,
              });
              continue;
            }
            const { generateSquareThumbnail } = await import(
              '../../api/imageProcessing'
            );
            const thumbnailUrl = await generateSquareThumbnail(dataUrl);
            next.push({
              name,
              path: safePath,
              dataUrl,
              thumbnailUrl,
              mime,
              isImage: true,
              status: 'ready',
              progress: 100,
            });
          } catch {
            next.push({
              name,
              path: safePath,
              mime,
              isImage: true,
            });
          }
          continue;
        }

        const isCodeOrText =
          /\.(txt|md|markdown|json|ts|tsx|js|jsx|css|html|py|rs|go|java|c|cpp|h|ya?ml|toml|xml|csv|log|sh|ps1)$/i.test(
            lower
          );
        if (isCodeOrText) {
          let text: string | undefined;
          try {
            const { readLocalTextBestEffort } = await import(
              '../../api/localFileReader'
            );
            const read = await readLocalTextBestEffort(safePath);
            text = read ?? undefined;
          } catch {
            try {
              const { readTextFileAtPath } = await import(
                '../../api/browserImportApi'
              );
              const read = await readTextFileAtPath(safePath);
              if (read) {
                text = read.slice(0, 512_000);
              }
            } catch {
              // Best-effort read; continue with undefined text
            }
          }
          next.push({
            name,
            path: safePath,
            ...(text !== undefined ? { text } : {}),
            mime: 'text/plain',
          });
          continue;
        }

        let mime = 'application/octet-stream';
        try {
          const { getMimeFromPath } = await import('../../api/localFileReader');
          mime = getMimeFromPath(safePath);
        } catch {
          // ignore
        }
        if (mime === 'application/octet-stream') {
          if (/\.pptx?$/i.test(lower)) mime = 'application/vnd.ms-powerpoint';
          else if (/\.docx?$/i.test(lower)) mime = 'application/msword';
          else if (/\.xlsx?$/i.test(lower)) mime = 'application/vnd.ms-excel';
          else if (/\.pdf$/i.test(lower)) mime = 'application/pdf';
        }

        next.push({ name, path: safePath, mime });
      }

      if (rejectedImage) {
        notifyImageIntakeBlocked();
        try {
          window.dispatchEvent(
            new CustomEvent('crish-model-vision-unsupported', {
              detail: { message: '当前模型不支持视觉输入' },
            })
          );
        } catch {
          // non-window env
        }
      }
      if (next.length > 0) {
        addAttachments(next);
      }
    },
    [addAttachments]
  );

  const handleFilesSelected = useCallback(
    async (files: File[]) => {
      const acceptsImage = activeModelAcceptsImage();
      const pathBatch: string[] = [];
      const next: ChatAttachment[] = [];
      let rejectedImage = false;
      let blobToImageAttachment:
        | ((blob: Blob, preferredName?: string) => Promise<ChatAttachment>)
        | null = null;
      for (const f of files) {
        const fsPath = extractFileSystemPath(f);
        // R3-1 / §3.1：有本机绝对路径必须转发 handlePathsSelected，禁止 continue 静默丢弃
        if (fsPath) {
          pathBatch.push(fsPath);
          continue;
        }
        const filePath = f.name;
        if (isImageIntakeFile(f)) {
          if (!acceptsImage) {
            rejectedImage = true;
            continue;
          }
          try {
            if (!blobToImageAttachment) {
              ({ blobToImageAttachment } = await import(
                '../../api/imageProcessing'
              ));
            }
            const imgAtt = await blobToImageAttachment(f, f.name);
            next.push(imgAtt);
          } catch {
            next.push({
              name: f.name,
              ...(f.type ? { mime: f.type } : {}),
            });
          }
          continue;
        }
        const isText =
          f.type.startsWith('text/') ||
          /\.(txt|md|markdown|json|ts|tsx|js|jsx|css|html|py|rs|go|java|c|cpp|h|ya?ml|toml|xml|csv|log|sh|ps1)$/i.test(
            f.name
          );
        if (isText) {
          try {
            const text = await f.text();
            next.push({
              name: f.name,
              path: filePath,
              text: text.slice(0, 512_000),
              mime: f.type || 'text/plain',
            });
          } catch {
            next.push({
              name: f.name,
              path: filePath,
              mime: f.type || 'text/plain',
            });
          }
          continue;
        }

        let mime = f.type || 'application/octet-stream';
        const lower = f.name.toLowerCase();
        if (/\.pptx?$/i.test(lower)) mime = 'application/vnd.ms-powerpoint';
        else if (/\.docx?$/i.test(lower)) mime = 'application/msword';
        else if (/\.xlsx?$/i.test(lower)) mime = 'application/vnd.ms-excel';
        else if (/\.pdf$/i.test(lower)) mime = 'application/pdf';

        next.push({
          name: f.name,
          path: filePath,
          mime,
        });
      }
      if (pathBatch.length) {
        await handlePathsSelected(pathBatch);
      }
      if (rejectedImage) notifyImageIntakeBlocked();
      addAttachments(next);
    },
    [addAttachments, handlePathsSelected]
  );

  /** §3.1 拖放唯一入口：Tauri File.path → paths 管；纯 blob → files 管；短窗与 tauri 事件幂等 */
  const handleDroppedFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      const withPath: string[] = [];
      const blobOnly: File[] = [];
      for (const f of files) {
        const p = extractFileSystemPath(f);
        if (p) withPath.push(p);
        else blobOnly.push(f);
      }
      if (withPath.length) {
        await handlePathsSelected(withPath);
      }
      if (blobOnly.length) {
        await handleFilesSelected(blobOnly);
      }
    },
    [handlePathsSelected, handleFilesSelected]
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
      const el = fileInputRef.current;
      if (activeModelAcceptsImage()) el.removeAttribute('accept');
      else el.accept = COMPOSER_NON_IMAGE_FILE_ACCEPT;
      el.value = '';
      el.click();
    }
  }, [handlePathsSelected]);

  const handlePasteFiles = useCallback(
    async (files: File[]) => {
      if (!files?.length) return;
      await handleDroppedFiles(files);
    },
    [handleDroppedFiles]
  );

  return {
    attachments,
    setAttachments,
    fileInputRef,
    handleFilesSelected,
    handlePathsSelected,
    handleDroppedFiles,
    handlePickFiles,
    handlePasteImage,
    handlePasteFiles,
  };
}