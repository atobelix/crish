/**
 * Tiptap 粘贴图：无视觉不得 preventDefault 成附件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(__dirname, './TiptapEditorExtensions.ts');

describe('TiptapEditorExtensions 粘贴图视觉守卫', () => {
  it('handlePaste 先问 activeModelAcceptsImage，无视觉不转交附件链', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    expect(src).toContain('activeModelAcceptsImage');
    expect(src).toContain('notifyImageIntakeBlocked');
    expect(src).toMatch(
      /if \(!activeModelAcceptsImage\(\)\) \{\s*notifyImageIntakeBlocked\(\);\s*(break|return)/
    );
  });
});
