import { describe, expect, it } from 'vitest';
import { decodeTextBuffer, encodeTextBuffer } from './encoding';

describe('text encoding helpers', () => {
  it('detects and preserves utf-8 bom text', () => {
    const encoded = encodeTextBuffer('hello', 'utf-8-bom');
    const decoded = decodeTextBuffer(encoded);

    expect(decoded).toMatchObject({
      text: 'hello',
      encoding: 'utf-8-bom',
      hasBom: true,
      writable: true,
    });
    expect(encodeTextBuffer(decoded.text, 'utf-8-bom').subarray(0, 3)).toEqual(
      Buffer.from([0xef, 0xbb, 0xbf])
    );
  });

  it('detects utf-16 text', () => {
    expect(
      decodeTextBuffer(encodeTextBuffer('hello', 'utf-16le'))
    ).toMatchObject({
      text: 'hello',
      encoding: 'utf-16le',
      writable: true,
    });
    expect(
      decodeTextBuffer(encodeTextBuffer('hello', 'utf-16be'))
    ).toMatchObject({
      text: 'hello',
      encoding: 'utf-16be',
      writable: true,
    });
  });

  it('marks binary data as non-writable text', () => {
    expect(decodeTextBuffer(Buffer.from([0, 1, 2, 3]))).toMatchObject({
      encoding: 'binary',
      writable: false,
    });
  });
});
