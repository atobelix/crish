/**
 * HTTP 413 / payload-too-large recovery: oldest-first image scrub on conversation messages.
 * Operates on metadata.contentParts — never softDeny path.
 */
import type { AgentMessage, JsonObject, JsonValue } from '@crish/shared-types';

export const IMAGE_OMITTED_PLACEHOLDER =
  '[Image content omitted for request-size recovery]';

export const MAX_PAYLOAD_IMAGE_RECOVERY = 2;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function isImagePart(part: unknown): boolean {
  const p = asRecord(part);
  if (!p) return false;
  if (p.type === 'image_url') return true;
  if (typeof p.url === 'string' && p.url.startsWith('data:image')) return true;
  return false;
}

function isImageBlock(block: any): boolean {
  return block?.type === 'image' && typeof block?.data === 'string';
}

export function countContentPartImages(message: AgentMessage): number {
  const meta = message.metadata ?? {};
  const parts = meta.contentParts;
  if (!Array.isArray(parts)) {
    if (meta.hasImages === true) return 1;
    return 0;
  }
  let n = 0;
  for (const part of parts) {
    if (isImagePart(part)) n += 1;
  }
  if (message.blocks?.length) {
    n += message.blocks.filter(isImageBlock).length;
  }
  if (n === 0 && meta.hasImages === true) return 1;
  return n;
}

/**
 * Strip oldest image_url parts across messages (left-to-right).
 * Returns new message array (new object refs) and stripped count.
 */
export function scrubImagesOldestFirst(
  messages: AgentMessage[],
  options: { maxStrip?: number } = {},
): { messages: AgentMessage[]; stripped: number } {
  const maxStrip = Math.max(1, options.maxStrip ?? 8);
  let remaining = maxStrip;
  let stripped = 0;
  const out: AgentMessage[] = [];

  for (const msg of messages) {
    if (remaining <= 0 || countContentPartImages(msg) === 0) {
      out.push(msg);
      continue;
    }
    const meta = { ...(msg.metadata ?? {}) } as JsonObject;
    const parts = Array.isArray(meta.contentParts)
      ? [...(meta.contentParts as unknown[])]
      : null;

    if (parts) {
      const nextParts: unknown[] = [];
      let localStrip = 0;
      for (const part of parts) {
        if (remaining > 0 && isImagePart(part)) {
          remaining -= 1;
          stripped += 1;
          localStrip += 1;
          nextParts.push({ type: 'text', text: IMAGE_OMITTED_PLACEHOLDER });
          continue;
        }
        nextParts.push(part);
      }
      // Strip blocks too
      let blocksChanged = false;
      const nextBlocks = msg.blocks?.length
        ? msg.blocks.map((b: any) => {
            if (remaining > 0 && isImageBlock(b)) {
              remaining -= 1;
              stripped += 1;
              blocksChanged = true;
              return { type: 'text' as const, text: IMAGE_OMITTED_PLACEHOLDER };
            }
            return b;
          })
        : msg.blocks;
      if (localStrip > 0 || blocksChanged) {
        meta.contentParts = nextParts as JsonValue;
        const stillImages = nextParts.some(isImagePart) || nextBlocks.some(isImageBlock);
        if (!stillImages) {
          delete meta.hasImages;
        }
        meta.imagesScrubbed = true;
        out.push({
          ...msg,
          metadata: meta,
          ...(blocksChanged ? { blocks: nextBlocks } : {}),
        });
        continue;
      }
    } else if (meta.hasImages === true && remaining > 0) {
      remaining -= 1;
      stripped += 1;
      delete meta.hasImages;
      meta.imagesScrubbed = true;
      // Append placeholder text block if no text
      const hasText = msg.blocks.some((b) => b.type === 'text');
      out.push({
        ...msg,
        metadata: meta,
        blocks: hasText
          ? msg.blocks
          : [
              ...msg.blocks,
              {
                type: 'text' as const,
                text: IMAGE_OMITTED_PLACEHOLDER,
              },
            ],
      });
      continue;
    }

    out.push(msg);
  }

  return { messages: out, stripped };
}

export function looksLikePayloadTooLargeMessage(message: string): boolean {
  const m = message.toLowerCase();
  if (/request_too_large|request too large|payload too large|entity too large|request exceeds the maximum size|exceeds the maximum size/.test(m)) {
    return true;
  }
  // Standalone 413, not model numbers like 4130
  if (/(?:^|[^0-9])413(?:[^0-9]|$)/.test(m)) return true;
  return false;
}
