import { describe, it, expect } from 'vitest';
import { StreamRenderBuffer } from '../../src/api/StreamRenderBuffer';

describe('StreamRenderBuffer Boundaries', () => {
  it('handles empty delta', () => {
    const buf = new StreamRenderBuffer();
    expect(() => buf.push('')).not.toThrow();
    expect(() => buf.push('', true)).not.toThrow();
  });

  it('handles 10MB of data', async () => {
    const buf = new StreamRenderBuffer({ maxBytesPerFrame: 8192 });
    const frames: any[] = [];
    buf.onFrame = (frame) => { frames.push(frame); };

    const chunk = 'x'.repeat(1024 * 1024); // 1MB
    for (let i = 0; i < 10; i++) {
      buf.push(chunk);
    }
    buf.flush(true);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[frames.length - 1].full.length).toBe(10 * 1024 * 1024);
  });

  it('handles final mark before data', () => {
    const buf = new StreamRenderBuffer();
    let finalReceived = false;
    buf.onFrame = (frame) => { if (frame.isFinal) finalReceived = true; };
    buf.push('data', true);
    buf.flush(true);
    expect(finalReceived).toBe(true);
  });

  it('handles reset mid-stream', () => {
    const buf = new StreamRenderBuffer();
    buf.push('hello ');
    buf.push('world');
    buf.reset();
    buf.push('new data');
    buf.flush(true);
    expect(buf.currentText()).toBe('new data');
  });
});
