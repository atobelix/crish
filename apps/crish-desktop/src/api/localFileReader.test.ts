import { describe, expect, it } from 'vitest';
import { getMimeFromPath } from './localFileReader';

describe('localFileReader helpers', () => {
  it('identifies image MIME types correctly', () => {
    expect(getMimeFromPath('test.png')).toBe('image/png');
    expect(getMimeFromPath('photo.JPG')).toBe('image/jpeg');
    expect(getMimeFromPath('img.webp')).toBe('image/webp');
    expect(getMimeFromPath('anim.gif')).toBe('image/gif');
    expect(getMimeFromPath('vector.svg')).toBe('image/svg+xml');
  });

  it('identifies office document types correctly', () => {
    expect(getMimeFromPath('deck.pptx')).toBe('application/vnd.ms-powerpoint');
    expect(getMimeFromPath('deck.ppt')).toBe('application/vnd.ms-powerpoint');
    expect(getMimeFromPath('doc.docx')).toBe('application/msword');
    expect(getMimeFromPath('sheet.xlsx')).toBe('application/vnd.ms-excel');
    expect(getMimeFromPath('paper.pdf')).toBe('application/pdf');
  });

  it('defaults to octet-stream for unknown files', () => {
    expect(getMimeFromPath('archive.bin')).toBe('application/octet-stream');
    expect(getMimeFromPath('code.rs')).toBe('application/octet-stream');
  });
});
