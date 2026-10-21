import { describe, expect, it } from 'vitest';
import { readTextAny, writeTextAny } from './skillsApiFs';

describe('plugin fs capability probe', () => {
  it('returns a soft failure when the plugin mock has no text methods', async () => {
    await expect(readTextAny('/tmp/missing/SKILL.md')).resolves.toBeNull();
    await expect(writeTextAny('/tmp/missing/SKILL.md', '正文')).resolves.toBe(
      false
    );
  });
});
