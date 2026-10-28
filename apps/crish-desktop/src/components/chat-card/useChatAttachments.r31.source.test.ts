// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

describe('R3-1 handleFilesSelected File.path ??', () => {
  it('? File.path ?? await handlePathsSelected??? continue ????', () => {
    const src = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        'useChatAttachments.ts'
      ),
      'utf8'
    );
    expect(src).toContain('pathBatch.push(fsPath)');
    expect(src).toContain('await handlePathsSelected(pathBatch)');
    // ???????? continue ??? pathBatch
    expect(src).not.toMatch(
      /const fsPath = extractFileSystemPath\(f\);\s*\/\/[^\n]*\s*if \(fsPath\) \{\s*continue;/
    );
  });
});
