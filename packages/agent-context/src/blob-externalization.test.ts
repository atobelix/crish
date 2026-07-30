import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  externalizeToolOutputBlobs,
  isBlobReferenceJson,
} from './blob-externalization';
import { projectMessagesForProvider } from './context-projection';
import type {
  AgentMessage,
  JsonObject,
  JsonValue,
  ToolOutput,
} from '@crish/shared-types';

describe('blob externalization', () => {
  it('externalizes long text into an artifact blob reference', () => {
    const text = `${'a'.repeat(48)}tail`;
    const output: ToolOutput = { text };

    const result = externalizeToolOutputBlobs(output, {
      textCharThreshold: 24,
      maxPreviewChars: 12,
    });

    const expectedSha = sha256(Buffer.from(text, 'utf8'));
    expect(result.changed).toBe(true);
    expect(result.value).not.toBe(output);
    expect(result.value.text).toContain(`artifact://blob/${expectedSha}`);
    expect(result.value.text).not.toBe(text);
    expect(result.blobs).toHaveLength(1);
    expect(result.blobs[0]).toMatchObject({
      uri: `artifact://blob/${expectedSha}`,
      sha256: expectedSha,
      byteLength: Buffer.byteLength(text, 'utf8'),
      mime: 'text/plain; charset=utf-8',
      preview: 'aaaaaaaaaaaa...',
      source: 'tool-output-text',
      path: '$.text',
      text,
    });
    expect(result.value.artifacts?.[0]).toMatchObject({
      kind: 'log',
      uri: `artifact://blob/${expectedSha}`,
      metadata: {
        artifactKind: 'blob',
        sha256: expectedSha,
        byteLength: Buffer.byteLength(text, 'utf8'),
        mime: 'text/plain; charset=utf-8',
        preview: 'aaaaaaaaaaaa...',
      },
    });
  });

  it('externalizes base64 data URLs as binary blobs', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);
    const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;

    const result = externalizeToolOutputBlobs(
      { text: dataUrl },
      {
        dataUrlByteThreshold: 4,
        textCharThreshold: 1_000,
        maxPreviewChars: 32,
      }
    );

    const expectedSha = sha256(bytes);
    expect(result.changed).toBe(true);
    expect(result.value.text).toContain(`artifact://blob/${expectedSha}`);
    expect(result.value.text).not.toBe(dataUrl);
    expect(result.blobs[0]).toMatchObject({
      uri: `artifact://blob/${expectedSha}`,
      sha256: expectedSha,
      byteLength: bytes.byteLength,
      mime: 'image/png',
      source: 'tool-output-text',
      path: '$.text',
      encoding: 'binary',
    });
    expect(result.blobs[0]?.bytes).toEqual(Uint8Array.from(bytes));
    expect(result.value.artifacts?.[0]).toMatchObject({
      kind: 'image',
      uri: `artifact://blob/${expectedSha}`,
      metadata: {
        mime: 'image/png',
        contentType: 'image/png',
        mimeType: 'image/png',
      },
    });
  });

  it('leaves small content unchanged', () => {
    const output: ToolOutput = {
      text: 'short result',
      json: { value: 'small', nested: { ok: true } },
    };

    const result = externalizeToolOutputBlobs(output, {
      textCharThreshold: 100,
      jsonStringCharThreshold: 100,
      jsonFieldByteThreshold: 100,
      dataUrlByteThreshold: 100,
    });

    expect(result.changed).toBe(false);
    expect(result.value).toBe(output);
    expect(result.blobs).toEqual([]);
  });

  it('replaces large JSON fields with blob references', () => {
    const payload = 'payload:'.repeat(20);
    const output: ToolOutput = {
      json: {
        ok: true,
        payload,
        details: {
          rows: Array.from({ length: 12 }, (_, index) => `row-${index}`),
        },
        nested: {
          small: 'kept',
        },
      },
    };

    const result = externalizeToolOutputBlobs(output, {
      jsonStringCharThreshold: 32,
      jsonFieldByteThreshold: 64,
      maxPreviewChars: 16,
    });

    const expectedSha = sha256(Buffer.from(payload, 'utf8'));
    const json = result.value.json as JsonObject;
    expect(result.changed).toBe(true);
    expect(json.ok).toBe(true);
    expect(json.nested).toEqual({ small: 'kept' });
    expect(isBlobReferenceJson(json.payload as JsonValue)).toBe(true);
    expect(json.payload).toMatchObject({
      type: 'artifact-blob-reference',
      uri: `artifact://blob/${expectedSha}`,
      sha256: expectedSha,
      byteLength: Buffer.byteLength(payload, 'utf8'),
      mime: 'text/plain; charset=utf-8',
      preview: 'payload:payload:...',
    });
    const details = json.details as JsonObject;
    expect(isBlobReferenceJson(details.rows as JsonValue)).toBe(true);
    expect(details.rows).toMatchObject({
      type: 'artifact-blob-reference',
      mime: 'application/json',
    });
    expect(result.blobs).toHaveLength(2);
    expect(result.value.artifacts?.[0]?.metadata).toMatchObject({
      source: 'tool-output-json',
      path: '$.json.payload',
    });
  });

  it('does not mutate raw tool output', () => {
    const imageBytes = Buffer.from('image bytes for raw mutation test', 'utf8');
    const dataUrl = `data:image/jpeg;base64,${imageBytes.toString('base64')}`;
    const rawJson: JsonObject = {
      image: dataUrl,
      keep: 'same',
    };
    const output: ToolOutput = {
      text: 'x'.repeat(40),
      json: rawJson,
    };
    const before = JSON.stringify(output);

    const result = externalizeToolOutputBlobs(output, {
      textCharThreshold: 12,
      jsonStringCharThreshold: 12,
      dataUrlByteThreshold: 4,
    });

    expect(result.changed).toBe(true);
    expect(JSON.stringify(output)).toBe(before);
    expect(output.json).toBe(rawJson);
    expect(output.text).toBe('x'.repeat(40));
    expect((output.json as JsonObject).image).toBe(dataUrl);
    expect(result.value.json).not.toBe(rawJson);
  });

  it('can project provider context through blob summaries without mutating raw messages', () => {
    const longOutput = 'provider context '.repeat(20);
    const raw: AgentMessage[] = [
      {
        id: 'tool_1',
        role: 'tool',
        createdAt: '2026-01-01T00:00:00.000Z',
        blocks: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'shell',
            isError: false,
            output: { text: longOutput },
          },
        ],
      },
    ];

    const projected = projectMessagesForProvider(raw, {
      blobExternalization: { textCharThreshold: 32, maxPreviewChars: 16 },
    });

    const projectedBlock = projected[0]!.blocks[0]!;
    expect(JSON.stringify(raw)).toContain(longOutput);
    expect(
      projectedBlock.type === 'tool-result' ? projectedBlock.output.text : ''
    ).toContain('Externalized blob:');
    expect(
      projectedBlock.type === 'tool-result' ? projectedBlock.output.text : ''
    ).not.toBe(longOutput);
    expect(
      projectedBlock.type === 'tool-result'
        ? projectedBlock.output.artifacts?.[0]?.uri
        : undefined
    ).toMatch(/^artifact:\/\/blob\/[a-f0-9]{64}$/);
  });
});

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
