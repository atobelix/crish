import { describe, expect, it } from 'vitest';
import {
  approxDataUrlBytes,
  isImageFile,
  mimeToExt,
} from './imageProcessing';

describe('imageProcessing pure helpers', () => {
  it('approxDataUrlBytes estimates from base64 length', () => {
    // "aaaa" base64 ~ 3 bytes
    const url = `data:image/png;base64,${'a'.repeat(8)}`;
    expect(approxDataUrlBytes(url)).toBe(Math.floor((8 * 3) / 4));
  });

  it('mimeToExt maps common types', () => {
    expect(mimeToExt('image/jpeg')).toBe('jpg');
    expect(mimeToExt('image/png')).toBe('png');
    expect(mimeToExt('image/webp')).toBe('webp');
  });

  it('isImageFile checks type and extension', () => {
    const img = { type: 'image/png', name: 'a.bin' } as File;
    const byExt = { type: '', name: 'shot.JPG' } as File;
    const not = { type: 'text/plain', name: 'a.txt' } as File;
    expect(isImageFile(img)).toBe(true);
    expect(isImageFile(byExt)).toBe(true);
    expect(isImageFile(not)).toBe(false);
  });
});
