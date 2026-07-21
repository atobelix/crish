/**
 * Conversation Rewind desktop bridge.
 *
 * Daemon already implements preview/apply; this module is the product surface
 * so ChatHeaderMore / message menus can call real protocol messages.
 * Never invents preview facts client-side.
 */
import { getDesktopDaemonClient } from './daemonClient';

export interface ConversationRewindPreview {
  ok: boolean;
  raw: Record<string, unknown>;
  error?: string;
}

export interface ConversationRewindApplyResult {
  ok: boolean;
  raw: Record<string, unknown>;
  error?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/**
 * Preview rewind to a target leaf / message boundary.
 * Pass whatever facts the UI has; daemon validates and returns diagnostics.
 */
export async function previewConversationRewind(input: {
  sessionId: string;
  targetLeafId?: string;
  targetEventId?: string;
  targetMessageId?: string;
}): Promise<ConversationRewindPreview> {
  const client = getDesktopDaemonClient();
  try {
    const response = await client.request(
      {
        type: 'preview-conversation-rewind',
        sessionId: input.sessionId,
        ...(input.targetLeafId ? { targetLeafId: input.targetLeafId } : {}),
        ...(input.targetEventId ? { targetEventId: input.targetEventId } : {}),
        ...(input.targetMessageId
          ? { targetMessageId: input.targetMessageId }
          : {}),
      },
      'conversation-rewind-preview',
      15_000
    );
    const raw = asRecord(response) ?? {};
    return { ok: true, raw };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, raw: {}, error: message };
  }
}

/**
 * Apply a previously previewed rewind. Prefer passing the same target facts
 * the preview used; daemon may require a preview token if protocol adds one later.
 */
export async function applyConversationRewind(input: {
  sessionId: string;
  targetLeafId?: string;
  targetEventId?: string;
  targetMessageId?: string;
}): Promise<ConversationRewindApplyResult> {
  const client = getDesktopDaemonClient();
  try {
    const response = await client.request(
      {
        type: 'apply-conversation-rewind',
        sessionId: input.sessionId,
        ...(input.targetLeafId ? { targetLeafId: input.targetLeafId } : {}),
        ...(input.targetEventId ? { targetEventId: input.targetEventId } : {}),
        ...(input.targetMessageId
          ? { targetMessageId: input.targetMessageId }
          : {}),
      },
      'conversation-rewind-applied',
      30_000
    );
    const raw = asRecord(response) ?? {};
    return { ok: true, raw };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, raw: {}, error: message };
  }
}
