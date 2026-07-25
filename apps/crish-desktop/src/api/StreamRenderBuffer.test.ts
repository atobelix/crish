import { describe, it } from 'vitest';
import { flushFrame, safeUnicodeCutPosition } from './StreamRenderBuffer';

describe('StreamRenderBuffer', () => {
  it.todo('should handle surrogate pair at split boundary');
  it.todo('should handle nlIndex truncation with surrogate pairs');
  it.todo('should handle deadline truncation with surrogate pairs');
});
