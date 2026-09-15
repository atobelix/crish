/**
 * S1/S2 对话流扩展 import 面：禁 registerView、禁 src/plugins、11 内置不被改写。
 * host 喂 projectMessage；包路径不出现 block-paper。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readEntryChainSource } from '../../test-utils/entryChainSources';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

const DESKTOP_SRC = join(DIR, '../..');

const BUILTIN_REGISTRAR = join(
  DESKTOP_SRC,
  'services/view-registry/registerBuiltInViews.tsx'
);

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...collectTsFiles(full));
      continue;
    }
    if (extname(name) === '.ts' || extname(name) === '.tsx') {
      out.push(full);
    }
  }
  return out;
}

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
    expect(src).toMatch(
      /registerSingle\s*\(\s*['"]workspace\.chat\.composerAbove['"]/
    );
    expect(src).toMatch(/id:\s*['"]conversation-flow['"]/);
    expect(src).toMatch(/from\s+['"]\.\/host['"]|import\s*\(\s*['"]\.\/host['"]/);
    expect(src).toMatch(
      /from\s+['"]\.\/PermissionBar['"]|import\s*\(\s*['"]\.\/PermissionBar['"]/
    );
    expect(src).not.toMatch(/@crish\/conversation-flow/);
  });

  it('SlotTypes 不反向 import chat-message-list / chat-card', () => {
    const src = readFileSync(
      join(DESKTOP_SRC, 'services/view-registry/SlotTypes.ts'),
      'utf8'
    );
    expect(src).not.toMatch(/chat-message-list/);
    expect(src).not.toMatch(/ChatMessageListProps/);
    expect(src).not.toMatch(/chat-card/);
    expect(src).not.toMatch(/ChatComposerAboveProps/);
    expect(src).not.toMatch(/PermissionBar/);
  });

  it('registerBuiltInViews 10 名单无 conversation-flow view id', () => {
    const src = readFileSync(BUILTIN_REGISTRAR, 'utf8');
    expect(src).not.toMatch(/id:\s*['"]conversation-flow['"]/);
    expect(src).toMatch(/全部 10 个/);
    const ids = [...src.matchAll(/^\s*id:\s*['"]([^'"]+)['"]/gm)].map(
      (m) => m[1]
    );
    expect(ids).toHaveLength(10);
    // 决策 1 视图路由收敛：browser 已并入 preview，不得回归
    expect(ids).not.toContain('browser');
    expect(ids).not.toContain('conversation-flow');
  });

  it('入口链把 conversation-flow 当扩展激活（而非内置视图工厂），且不 registerView', () => {
    // 装配点在 entry-core.tsx（ACT-301 单拍装配后 main.tsx 仅转发）⇒ 扫整条入口链
    const src = readEntryChainSource();
    expect(src).toMatch(/shouldActivateOfficialConversationFlow\s*\(/);
    expect(src).toMatch(/activateConversationFlow\s*\(/);
    expect(src).not.toMatch(/\bregisterView\s*\(/);

    // 内置视图工厂表必须无 conversation-flow（精确扫定义模块，不用整链正则：
    // 整链会同时命中 import 语句，断言失真）
    const factoriesSrc = readFileSync(
      join(DESKTOP_SRC, 'builtinViewFactories.tsx'),
      'utf8'
    );
    expect(factoriesSrc).not.toContain('conversation-flow');
  });

  it('host.tsx / activate.ts 不 registerView', () => {
    const hostSrc = readFileSync(join(DIR, 'host.tsx'), 'utf8');
    const activateSrc = readFileSync(join(DIR, 'activate.ts'), 'utf8');
    expect(hostSrc).not.toMatch(/\bregisterView\s*\(/);
    expect(activateSrc).not.toMatch(/\bregisterView\s*\(/);
    expect(hostSrc).not.toMatch(/\bviewRegistry\b/);
  });

  it('host 喂 projectMessage 且仍挂 ChatMessageList，根钉 data-conversation-flow', () => {
    const src = readFileSync(join(DIR, 'host.tsx'), 'utf8');
    expect(src).toMatch(/from\s+['"]@crish\/conversation-flow['"]/);
    expect(src).toMatch(/\bprojectMessage\b/);
    expect(src).toMatch(/\bprojectPlanRoot\b/);
    expect(src).toMatch(/selectPlanModeEnabled/);
    expect(src).toMatch(/\bChatMessageList\b/);
    expect(src).toMatch(/data-conversation-flow=["']on["']/);
    expect(src).toMatch(/data-flow-node-count=/);
    expect(src).not.toMatch(/@crish\/conversation-flow\//);
    expect(src).not.toMatch(/\bPurpose\b|\bPermissionBar\b/);
    expect(src).not.toMatch(/PlanGoalRibbons/);
  });

  it('host / activate / 包路径不出现 block-paper', () => {
    const importBlockPaper =
      /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*block-paper/;
    const hostSrc = readFileSync(join(DIR, 'host.tsx'), 'utf8');
    const activateSrc = readFileSync(join(DIR, 'activate.ts'), 'utf8');
    expect(hostSrc).not.toMatch(/block-paper/);
    expect(activateSrc).not.toMatch(/block-paper/);
    expect(hostSrc).not.toMatch(importBlockPaper);
    expect(activateSrc).not.toMatch(importBlockPaper);

    const pkgRoot = join(DESKTOP_SRC, '../../../packages/conversation-flow');
    if (!existsSync(pkgRoot)) return;
    const pkgJsonPath = join(pkgRoot, 'package.json');
    if (existsSync(pkgJsonPath)) {
      const pkgJson = readFileSync(pkgJsonPath, 'utf8');
      expect(pkgJson).not.toMatch(/@crish\/block-paper/);
    }
    for (const rel of collectTsFiles(pkgRoot)) {
      const src = readFileSync(rel, 'utf8');
      expect(src, rel).not.toMatch(importBlockPaper);
    }
  });
});
