import { describe, expect, it } from 'vitest';
import {
  IMAGE_OMITTED_PLACEHOLDER,
  MAX_PAYLOAD_IMAGE_RECOVERY,
  countContentPartImages,
  looksLikePayloadTooLargeMessage,
  scrubImagesOldestFirst,
} from './payload-image-recovery';
import { ErrorClassifier } from './error-classifier';
import {
  classifyHttpProviderError,
} from './provider-openai-compatible';
import { estimateMessageTokens, IMAGE_TOKEN_COST } from './context-compression';
import type { AgentMessage } from '@crish/shared-types';

function userWithImages(n: number, id: string, huge = false): AgentMessage {
  const pad = huge ? 'A'.repeat(200_000) : 'A'.repeat(40);
  const parts = Array.from({ length: n }, (_, i) => ({
    type: 'image_url' as const,
    image_url: { url: `data:image/png;base64,${pad}${i}` },
  }));
  return {
    id,
    role: 'user',
    createdAt: new Date().toISOString(),
    blocks: [{ type: 'text', text: 'see' }],
    metadata: { contentParts: parts, hasImages: true },
  };
}

function userHasImagesFlagOnly(id: string): AgentMessage {
  return {
    id,
    role: 'user',
    createdAt: new Date().toISOString(),
    blocks: [{ type: 'text', text: 'flag' }],
    metadata: { hasImages: true },
  };
}

describe('payload-image-recovery', () => {
  it('exports recovery constants', () => {
    expect(MAX_PAYLOAD_IMAGE_RECOVERY).toBe(2);
    expect(IMAGE_OMITTED_PLACEHOLDER).toContain('omitted');
  });

  it('counts contentParts images and data:image urls', () => {
    expect(countContentPartImages(userWithImages(2, 'u1'))).toBe(2);
    const mixed: AgentMessage = {
      id: 'm',
      role: 'user',
      createdAt: new Date().toISOString(),
      blocks: [{ type: 'text', text: 'x' }],
      metadata: {
        contentParts: [
          { type: 'text', text: 'x' },
          { type: 'image_url', image_url: { url: 'http://x/a.png' } },
          { url: 'data:image/jpeg;base64,abc' },
        ],
      },
    };
    expect(countContentPartImages(mixed)).toBe(2);
  });

  it('scrubs oldest images first across messages', () => {
    const msgs = [userWithImages(1, 'a'), userWithImages(2, 'b')];
    const { messages, stripped } = scrubImagesOldestFirst(msgs, { maxStrip: 2 });
    expect(stripped).toBe(2);
    expect(countContentPartImages(messages[0]!)).toBe(0);
    expect(countContentPartImages(messages[1]!)).toBe(1);
    // New object refs (WeakMap-safe: estimate cache cannot stick to mutated same ref)
    expect(messages[0]).not.toBe(msgs[0]);
    expect(messages[1]).not.toBe(msgs[1]);
    // Unchanged tail identity when not stripped further than needed? b was partially scrubbed → new ref
    expect(messages[0]?.metadata).not.toBe(msgs[0]?.metadata);
  });

  it('replaces image parts with placeholder text and clears hasImages when empty', () => {
    const msgs = [userWithImages(1, 'only')];
    const { messages, stripped } = scrubImagesOldestFirst(msgs, { maxStrip: 1 });
    expect(stripped).toBe(1);
    const parts = messages[0]!.metadata!.contentParts as Array<Record<string, unknown>>;
    expect(parts.some((p) => p.type === 'text' && p.text === IMAGE_OMITTED_PLACEHOLDER)).toBe(true);
    expect(parts.some((p) => p.type === 'image_url')).toBe(false);
    expect(messages[0]!.metadata!.hasImages).toBeUndefined();
    expect(messages[0]!.metadata!.imagesScrubbed).toBe(true);
  });

  it('does not mutate original message objects or contentParts arrays', () => {
    const original = userWithImages(2, 'orig');
    const partsBefore = [...(original.metadata!.contentParts as unknown[])];
    const { messages } = scrubImagesOldestFirst([original], { maxStrip: 1 });
    expect(original.metadata!.contentParts).toEqual(partsBefore);
    expect(original.metadata!.hasImages).toBe(true);
    expect(messages[0]).not.toBe(original);
    expect(countContentPartImages(original)).toBe(2);
    expect(countContentPartImages(messages[0]!)).toBe(1);
  });

  it('handles hasImages flag-only messages without contentParts', () => {
    const msgs = [userHasImagesFlagOnly('flag')];
    const { messages, stripped } = scrubImagesOldestFirst(msgs, { maxStrip: 1 });
    expect(stripped).toBe(1);
    expect(messages[0]!.metadata!.hasImages).toBeUndefined();
    expect(messages[0]!.metadata!.imagesScrubbed).toBe(true);
    expect(messages[0]).not.toBe(msgs[0]);
  });

  it('respects maxStrip and leaves later images intact', () => {
    const msgs = [userWithImages(3, 'a'), userWithImages(3, 'b')];
    const { messages, stripped } = scrubImagesOldestFirst(msgs, { maxStrip: 1 });
    expect(stripped).toBe(1);
    expect(countContentPartImages(messages[0]!)).toBe(2);
    expect(countContentPartImages(messages[1]!)).toBe(3);
    // message b untouched → same ref allowed
    expect(messages[1]).toBe(msgs[1]);
  });

  it('returns stripped=0 and same refs when no images', () => {
    const plain: AgentMessage = {
      id: 'p',
      role: 'user',
      createdAt: new Date().toISOString(),
      blocks: [{ type: 'text', text: 'hi' }],
    };
    const { messages, stripped } = scrubImagesOldestFirst([plain]);
    expect(stripped).toBe(0);
    expect(messages[0]).toBe(plain);
  });

  it('produces new message objects so WeakMap token cache cannot leak image cost after scrub', () => {
    const huge = userWithImages(1, 'cache', true);
    const before = estimateMessageTokens(huge);
    expect(before).toBeGreaterThanOrEqual(IMAGE_TOKEN_COST);

    const { messages } = scrubImagesOldestFirst([huge], { maxStrip: 1 });
    const after = estimateMessageTokens(messages[0]!);
    // Scrubbed message is a new object; estimate must drop fixed image cost
    expect(after).toBeLessThan(IMAGE_TOKEN_COST);
    // Original object cache still valid for original
    expect(estimateMessageTokens(huge)).toBe(before);
  });
});

describe('looksLikePayloadTooLargeMessage + provider classify', () => {
  it('classifies 413 payload messages without matching model 4130', () => {
    expect(looksLikePayloadTooLargeMessage('HTTP 413 Payload Too Large')).toBe(true);
    expect(looksLikePayloadTooLargeMessage('request_too_large')).toBe(true);
    expect(looksLikePayloadTooLargeMessage('Request entity too large')).toBe(true);
    expect(looksLikePayloadTooLargeMessage('payload too large')).toBe(true);
    expect(looksLikePayloadTooLargeMessage('request exceeds the maximum size')).toBe(true);
    expect(looksLikePayloadTooLargeMessage('model version 4130 released')).toBe(false);
    expect(looksLikePayloadTooLargeMessage('error code 41301')).toBe(false);
    expect(looksLikePayloadTooLargeMessage('ok')).toBe(false);
  });

  it('ErrorClassifier.classify payload-too-large, retryable, and 4130 exclusion', () => {
    const r1 = ErrorClassifier.classify(new Error('HTTP 413 Payload Too Large'));
    expect(r1.legacyKind).toBe('payload-too-large');
    expect(r1.retryable).toBe(false);

    const r2 = ErrorClassifier.classify(new Error('request_too_large'));
    expect(r2.legacyKind).toBe('payload-too-large');
    expect(r2.retryable).toBe(false);

    expect(ErrorClassifier.classify(new Error('model version 4130 released')).legacyKind).not.toBe('payload-too-large');

    const r3 = ErrorClassifier.classify(new Error('502 bad gateway'));
    expect(r3.legacyKind).toBe('server');
    expect(r3.retryable).toBe(true);

    const r4 = ErrorClassifier.classify(new Error('entity too large'));
    expect(r4.legacyKind).toBe('payload-too-large');
    expect(r4.retryable).toBe(false);

    expect(ErrorClassifier.classify(new Error('status 413')).legacyKind).toBe('payload-too-large');
    expect(ErrorClassifier.classify(new Error('model 4130')).legacyKind).not.toBe('payload-too-large');
  });

  it('classifyHttpProviderError: status 413 is payload-too-large', () => {
    const response = new Response('too big', { status: 413, statusText: 'Payload Too Large' });
    expect(classifyHttpProviderError(response, 'whatever')).toEqual({
      kind: 'payload-too-large',
      retryable: false,
    });
  });

  it('classifyHttpProviderError: body payload beats schema(400)', () => {
    const response = new Response(JSON.stringify({ error: 'request_too_large' }), {
      status: 400,
      statusText: 'Bad Request',
    });
    expect(classifyHttpProviderError(response, 'request_too_large')).toEqual({
      kind: 'payload-too-large',
      retryable: false,
    });
  });

  it('classifyHttpProviderError: plain 400 without size text stays schema', () => {
    const response = new Response('bad schema', { status: 400 });
    expect(classifyHttpProviderError(response, 'invalid request schema')).toEqual({
      kind: 'schema',
      retryable: false,
    });
  });
});
