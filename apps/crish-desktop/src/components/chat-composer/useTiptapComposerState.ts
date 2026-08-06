/**
 * apps/crish-desktop/src/components/chat-composer/useTiptapComposerState.ts
 * Phase T3 Custom State Hook for Tiptap Chat Composer (CRM-02, CRM-04, CRM-05).
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type {
  UseTiptapComposerStateOptions,
  UseTiptapComposerStateReturn,
  ChatAttachment,
  PermissionMode,
} from './composerTypes';
import { useSessionStore } from '../../store/sessionStore';

interface InternalAttachment extends ChatAttachment {
  file?: File;
}

interface DraftPayload {
  prompt: string;
  attachments: ChatAttachment[];
}

/**
 * Safely revokes blob object URLs for a set of attachments to prevent memory leaks (CRM-05).
 */
function revokeAttachmentUrls(atts: ChatAttachment[]): void {
  for (const att of atts) {
    if (att.objectUrl && att.objectUrl.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(att.objectUrl);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Serializes prompt and attachments into a draft string for sessionStore (CRM-02).
 */
function serializeDraftPayload(prompt: string, attachments: ChatAttachment[]): string {
  const cleanAtts = attachments.map(({ id, name, mime, size, objectUrl, dataUrl }) => ({
    id,
    name,
    mime,
    size,
    objectUrl,
    dataUrl,
  }));

  if (!prompt && cleanAtts.length === 0) return '';
  if (cleanAtts.length === 0) return prompt;
  return JSON.stringify({ prompt, attachments: cleanAtts });
}

/**
 * Parses draft string into prompt and attachments array (CRM-02).
 */
function parseDraftPayload(raw: string | undefined): DraftPayload {
  if (!raw) return { prompt: '', attachments: [] };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.prompt === 'string') {
      return {
        prompt: parsed.prompt,
        attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [],
      };
    }
  } catch {
    // raw string is plain prompt text
  }
  return { prompt: raw, attachments: [] };
}

/**
 * Helper to convert File to Base64 dataURL (CRM-05).
 */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(file);
  });
}

export function useTiptapComposerState(
  options: UseTiptapComposerStateOptions
): UseTiptapComposerStateReturn {
  const { sessionId, onSend, onStop } = options;

  const [attachments, setAttachmentsState] = useState<InternalAttachment[]>([]);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('auto');
  const [isComposing, setIsComposing] = useState<boolean>(false);
  const [sendShortcut, setSendShortcut] = useState<'enter' | 'ctrlEnter'>('enter');
  const [contentState, setContentState] = useState<string>('');

  const prevSessionIdRef = useRef<string>(sessionId);
  const promptRef = useRef<string>('');
  const attachmentsRef = useRef<InternalAttachment[]>([]);
  attachmentsRef.current = attachments;

  // Live markdown sync callback for TiptapEditorField (CRM-02)
  const onMarkdownChange = useCallback((markdown: string) => {
    promptRef.current = markdown;
  }, []);

  // Read send shortcut preference on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('crish_send_shortcut');
      if (saved === 'ctrlEnter' || saved === 'enter') {
        setSendShortcut(saved);
      }
    } catch {
      /* storage disabled */
    }
  }, []);

  // Custom setAttachments wrapper that cleans up revoked object URLs on removal (CRM-05)
  const setAttachments = useCallback(
    (action: React.SetStateAction<ChatAttachment[]>) => {
      setAttachmentsState((prev) => {
        const next = typeof action === 'function' ? action(prev) : action;
        const removed = prev.filter((p) => !next.some((n) => n.id === p.id));
        revokeAttachmentUrls(removed);
        return next as InternalAttachment[];
      });
    },
    []
  );

  // CRM-02 Bi-Directional Draft Persistence effect on sessionId change
  useEffect(() => {
    const oldSessionId = prevSessionIdRef.current;

    // Outgoing session: auto-flush active editor text and attachments to store draft map
    if (oldSessionId && oldSessionId !== sessionId) {
      const draftStr = serializeDraftPayload(promptRef.current, attachmentsRef.current);
      const setComposerDraft = useSessionStore.getState().setComposerDraft;
      if (typeof setComposerDraft === 'function') {
        setComposerDraft(oldSessionId, draftStr);
      }
    }

    // Incoming session: hydrate editor and attachments from store
    prevSessionIdRef.current = sessionId;
    const storeDrafts = useSessionStore.getState().composerDrafts;
    const rawDraft = storeDrafts?.[sessionId];
    const hydrated = parseDraftPayload(rawDraft);

    promptRef.current = hydrated.prompt;
    setContentState(hydrated.prompt);
    setAttachmentsState((prev) => {
      revokeAttachmentUrls(prev);
      return hydrated.attachments as InternalAttachment[];
    });
  }, [sessionId]);

  // CRM-05 Deferred/Immediate Base64 conversion & submit handler
  const handleSend = async (promptMarkdown?: string): Promise<void> => {
    const textToSend = promptMarkdown !== undefined && promptMarkdown !== '' ? promptMarkdown : promptRef.current;
    const currentAtts = attachmentsRef.current;

    if (!textToSend.trim() && currentAtts.length === 0) {
      return;
    }

    const readyAttachments: ChatAttachment[] = await Promise.all(
      currentAtts.map(async (att) => {
        let dataUrl = att.dataUrl;
        if (!dataUrl && att.file) {
          try {
            dataUrl = await fileToBase64(att.file);
          } catch {
            /* ignore */
          }
        }
        return {
          id: att.id,
          name: att.name,
          mime: att.mime,
          size: att.size,
          dataUrl,
          objectUrl: att.objectUrl,
        };
      })
    );

    // Call onSend callback
    if (onSend) {
      await onSend(textToSend, readyAttachments);
    }

    // Clear composer draft in session store
    const setComposerDraft = useSessionStore.getState().setComposerDraft;
    if (typeof setComposerDraft === 'function') {
      setComposerDraft(sessionId, '');
    }

    // Stage 3: Revoke object URLs and clear attachments state
    revokeAttachmentUrls(currentAtts);
    setAttachmentsState([]);
    promptRef.current = '';
    setContentState('');
  };

  const handleStopRequest = (): void => {
    if (onStop) {
      onStop();
    }
  };

  // CRM-05 Stage 1: Pasted/dropped images convert to Blob URLs and compute Base64 payload
  const handleDropFiles = async (files: FileList | File[]): Promise<void> => {
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;

    const newAttachments: InternalAttachment[] = await Promise.all(
      fileArray.map(async (file) => {
        const objectUrl = URL.createObjectURL(file);
        let dataUrl: string | undefined;
        try {
          dataUrl = await fileToBase64(file);
        } catch {
          /* ignore */
        }
        return {
          id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: file.name || 'attachment',
          mime: file.type || 'application/octet-stream',
          size: file.size,
          objectUrl,
          dataUrl,
          file,
        };
      })
    );

    setAttachmentsState((prev) => [...prev, ...newAttachments]);
  };

  const handlePasteImage = async (file: File): Promise<void> => {
    const objectUrl = URL.createObjectURL(file);
    let dataUrl: string | undefined;
    try {
      dataUrl = await fileToBase64(file);
    } catch {
      /* ignore */
    }
    const newAtt: InternalAttachment = {
      id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: file.name || 'pasted-image.png',
      mime: file.type || 'image/png',
      size: file.size,
      objectUrl,
      dataUrl,
      file,
    };
    setAttachmentsState((prev) => [...prev, newAtt]);
  };

  // Cleanup on unmount: flush draft to store and revoke blob URLs
  useEffect(() => {
    return () => {
      const activeSid = prevSessionIdRef.current;
      if (activeSid) {
        const draftStr = serializeDraftPayload(promptRef.current, attachmentsRef.current);
        const setComposerDraft = useSessionStore.getState().setComposerDraft;
        if (typeof setComposerDraft === 'function') {
          setComposerDraft(activeSid, draftStr);
        }
      }
      revokeAttachmentUrls(attachmentsRef.current);
    };
  }, []);

  return {
    attachments,
    setAttachments,
    permissionMode,
    setPermissionMode,
    isComposing,
    setIsComposing,
    handleSend,
    handleStopRequest,
    handleDropFiles,
    handlePasteImage,
    sendShortcut,
    onMarkdownChange,
    content: contentState,
  };
}
