/**
 * 前端派生 Artifact：文档才出节点；代码永不进；无 docId 不发明 persist。
 */
import { describe, expect, it } from 'vitest';
import {
  deriveArtifactFromTool,
  deriveArtifacts,
  isCodeArtifactPath,
  isDocumentArtifactPath,
  usableArtifactDocId,
} from './deriveArtifacts';
import type { ProjectToolCallInput } from './types';

function tc(
  partial: Partial<ProjectToolCallInput> &
    Pick<ProjectToolCallInput, 'id' | 'name'>,
): ProjectToolCallInput {
  return { status: 'success', ...partial };
}

describe('isDocumentArtifactPath / isCodeArtifactPath', () => {
  it('md/txt 是文档，ts/rs 是代码', () => {
    expect(isDocumentArtifactPath('docs/纪要.md')).toBe(true);
    expect(isDocumentArtifactPath('notes/a.txt')).toBe(true);
    expect(isDocumentArtifactPath('src/index.ts')).toBe(false);
    expect(isDocumentArtifactPath(undefined)).toBe(false);
    expect(isCodeArtifactPath('src/main.rs')).toBe(true);
    expect(isCodeArtifactPath('apps/a.tsx')).toBe(true);
    expect(isCodeArtifactPath('docs/纪要.md')).toBe(false);
  });
});

describe('usableArtifactDocId', () => {
  it('拒空串 / silent-doc / strict- 诚实空 / 裸 note', () => {
    expect(usableArtifactDocId('')).toBeUndefined();
    expect(usableArtifactDocId('silent-doc')).toBeUndefined();
    expect(usableArtifactDocId('strict-ws1')).toBeUndefined();
    expect(usableArtifactDocId('note')).toBeUndefined();
    expect(usableArtifactDocId('notebook')).toBeUndefined();
    expect(usableArtifactDocId('note:')).toBeUndefined();
  });

  it('接受已有 id 与 note:uri', () => {
    expect(usableArtifactDocId('doc-real-1')).toBe('doc-real-1');
    expect(usableArtifactDocId('note:doc-real-1')).toBe('doc-real-1');
  });
});

describe('deriveArtifactFromTool', () => {
  it('写入 md 从 args 取正文，标前端派生', () => {
    const node = deriveArtifactFromTool(
      tc({
        id: 'w1',
        name: 'write_file',
        arguments: JSON.stringify({
          path: 'docs/纪要.md',
          contents: '# 纪要\n\n正文',
        }),
      }),
    );
    expect(node).toMatchObject({
      kind: 'artifact',
      title: '纪要.md',
      mime: 'markdown',
      content: '# 纪要\n\n正文',
      path: 'docs/纪要.md',
      derived: 'frontend',
    });
    expect(node?.docId).toBeUndefined();
  });

  it('代码路径返回 null', () => {
    expect(
      deriveArtifactFromTool(
        tc({
          id: 'w2',
          name: 'write_file',
          arguments: JSON.stringify({
            path: 'src/index.ts',
            contents: 'export const a = 1;\n',
          }),
        }),
      ),
    ).toBeNull();
    expect(
      deriveArtifactFromTool(
        tc({
          id: 'w3',
          name: 'search_replace',
          arguments: JSON.stringify({
            path: 'crates/foo/src/lib.rs',
            contents: 'fn main() {}',
          }),
        }),
      ),
    ).toBeNull();
  });

  it('引擎 artifacts 文件块命中且非代码', () => {
    const node = deriveArtifactFromTool(
      tc({
        id: 'e1',
        name: 'generate_doc',
        output: JSON.stringify({
          text: 'ok',
          artifacts: [
            {
              kind: 'file',
              title: '重构变更摘要.md',
              text: '## 摘要\n\n- a',
              metadata: { docId: 'doc-exist' },
            },
          ],
        }),
      }),
    );
    expect(node).toMatchObject({
      derived: 'engine',
      title: '重构变更摘要.md',
      content: '## 摘要\n\n- a',
      docId: 'doc-exist',
    });
  });

  it('引擎 artifacts 指向 .ts 则丢弃', () => {
    expect(
      deriveArtifactFromTool(
        tc({
          id: 'e2',
          name: 'generate_doc',
          output: JSON.stringify({
            artifacts: [
              { kind: 'file', title: 'src/a.ts', text: 'export {}' },
            ],
          }),
        }),
      ),
    ).toBeNull();
  });

  it('pending_approval 不派生', () => {
    expect(
      deriveArtifactFromTool(
        tc({
          id: 'p1',
          name: 'write_file',
          status: 'pending_approval',
          arguments: JSON.stringify({ path: 'a.md', contents: '# x' }),
        }),
      ),
    ).toBeNull();
  });

  it('无 docId 字段不发明 persist id', () => {
    const node = deriveArtifactFromTool(
      tc({
        id: 'w4',
        name: 'write_file',
        arguments: JSON.stringify({ path: 'README.md', contents: 'hi' }),
      }),
    );
    expect(node?.docId).toBeUndefined();
    expect(JSON.stringify(node)).not.toMatch(/silent-doc|applyAndCommit|persist/);
  });

  it('工作区路径 / file uri 不当成 docId', () => {
    const node = deriveArtifactFromTool(
      tc({
        id: 'e3',
        name: 'generate_doc',
        output: JSON.stringify({
          artifacts: [
            {
              kind: 'file',
              title: '纪要.md',
              uri: 'docs/纪要.md',
              text: '# x',
            },
          ],
        }),
      }),
    );
    expect(node?.path).toBe('docs/纪要.md');
    expect(node?.docId).toBeUndefined();
  });
});

describe('deriveArtifacts', () => {
  it('只收文档、跳过代码', () => {
    const nodes = deriveArtifacts([
      tc({
        id: 'd',
        name: 'write_file',
        arguments: JSON.stringify({ path: 'a.md', contents: '# a' }),
      }),
      tc({
        id: 'c',
        name: 'write_file',
        arguments: JSON.stringify({ path: 'a.ts', contents: 'export {}' }),
      }),
    ]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.path).toBe('a.md');
  });
});
