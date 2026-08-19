/**
 * S1 对话流扩展 import 面：禁 registerView、禁 src/plugins、11 内置不被改写。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

const DESKTOP_SRC = join(DIR, '../..');

const BUILTIN_REGISTRAR = join(
  DESKTOP_SRC,
  'services/view-registry/registerBuiltInViews.tsx'
);

describe('conversation-flow extension import 边界', () => {
  it('activate.ts 无 registerView / 无 plugins / 槽 id 不是 view', () => {
    const src = readFileSync(join(DIR, 'activate.ts'), 'utf8');
    expect(src).not.toMatch(/\bregisterView\s*\(/);
    expect(src).not.toMatch(/from\s+['"][^'"]*\/plugins['"]/);
    expect(src).not.toMatch(/from\s+['"]\.\.\/\.\.\/plugins/);
    expect(src).not.toMatch(/\bviewRegistry\b/);
    expect(src).not.toMatch(
      /id:\s*['"]conversation-flow['"][\s\S]{0,120}category:/
    );
    expect(src).toMatch(
      /registerSingle\s*\(\s*['"]workspace\.chat\.stream['"]/
    );
    expect(src).toMatch(/id:\s*['"]conversation-flow['"]/);
    expect(src).toMatch(/data-conversation-flow['"]:\s*['"]on['"]/);
    expect(src).toMatch(/\bChatMessageList\b/);
  });

  it('SlotTypes 不反向 import chat-message-list', () => {
    const src = readFileSync(
      join(DESKTOP_SRC, 'services/view-registry/SlotTypes.ts'),
      'utf8'
    );
    expect(src).not.toMatch(/chat-message-list/);
    expect(src).not.toMatch(/ChatMessageListProps/);
  });

  it('registerBuiltInViews 11 名单无 conversation-flow view id', () => {
    const src = readFileSync(BUILTIN_REGISTRAR, 'utf8');
    expect(src).not.toMatch(/id:\s*['"]conversation-flow['"]/);
    expect(src).toMatch(/全部 11 个/);
    const ids = [...src.matchAll(/^\s*id:\s*['"]([^'"]+)['"]/gm)].map(
      (m) => m[1]
    );
    expect(ids).toHaveLength(11);
    expect(ids).not.toContain('conversation-flow');
  });

  it('main.tsx 不把 conversation-flow 写进 builtinViewFactories', () => {
    const src = readFileSync(join(DESKTOP_SRC, 'main.tsx'), 'utf8');
    expect(src).not.toMatch(/builtinViewFactories[\s\S]*?conversation-flow/);
    expect(src).toMatch(/shouldActivateOfficialConversationFlow\s*\(/);
    expect(src).toMatch(/activateConversationFlow\s*\(/);
    expect(src).not.toMatch(/\bregisterView\s*\(/);
  });
});
