// base64 / 采样编解码单测（原生桥数据格式契约）。
import {
  base64ToBytes,
  base64ToFloat32,
  base64ToInt16,
  bytesToBase64,
  float32ToBase64,
  int16ToFloat32,
} from './base64';

describe('base64 codecs', () => {
  it('round-trips arbitrary bytes including padding cases', () => {
    for (const bytes of [
      new Uint8Array([]),
      new Uint8Array([0]),
      new Uint8Array([255, 1]),
      new Uint8Array([1, 2, 3]),
      new Uint8Array([10, 20, 30, 40, 50]),
    ]) {
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    }
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe('aGk=');
    expect(base64ToBytes('aGk=')).toEqual(new Uint8Array([104, 105]));
  });

  it('round-trips Float32 samples bit-exactly', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25]);
    const restored = base64ToFloat32(float32ToBase64(samples));
    expect(restored).toEqual(samples);
  });

  it('decodes Int16 PCM and converts to Float32[-1,1]', () => {
    // 两个 Int16 小端样本：16384 → 0.5，-32768 → -1
    const b64 = bytesToBase64(new Uint8Array([0, 64, 0, 128]));
    const pcm = base64ToInt16(b64);
    expect(Array.from(pcm)).toEqual([16384, -32768]);
    const floats = int16ToFloat32(pcm);
    expect(floats[0]).toBeCloseTo(0.5);
    expect(floats[1]).toBeCloseTo(-1);
  });
});
