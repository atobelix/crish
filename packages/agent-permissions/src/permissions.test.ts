import { describe, expect, it } from 'vitest';
import {
  classifyTerminalCommand,
  DEFAULT_HARDLINE_REGISTRY,
} from '@crish/decision-engine';

/**
 * 内联 helper：复现 agent-runtime/src/permission/command-classification.ts#getHardlineCommandBlock。
 *
 * 依据 ANTI_OVERENGINEERING_GUARDRAILS.md 禁令 12 + ROUND-03-split-phase-a.md §3.2.3：
 * - command-classification.ts（wrapper）留置 agent-runtime，纯决策逻辑（classifyCommand）
 *   归 @crish/decision-engine，agent-permissions 不重复实现分类。
 * - getHardlineCommandBlock 是 DEFAULT_HARDLINE_REGISTRY.isHardline 的薄包装，
 *   本测试在此内联复现以保持测试语义等价，不引入对 agent-runtime 的依赖（leaf 层独立性）。
 */
function getHardlineCommandBlock(
  command: string | undefined
): { risk: 'hardline'; reason: string; matched?: string } | undefined {
  if (!command) return undefined;
  const hit = DEFAULT_HARDLINE_REGISTRY.isHardline(command.trim());
  if (!hit) return undefined;
  return { risk: 'hardline', reason: hit.reason, matched: hit.pattern.source };
}

describe('command classification (legacy)', () => {
  it('classifies safe read commands as read', () => {
    expect(classifyTerminalCommand('pwd')).toMatchObject({ risk: 'read' });
    expect(classifyTerminalCommand('ls -la')).toMatchObject({ risk: 'read' });
    expect(classifyTerminalCommand('cat file.txt')).toMatchObject({
      risk: 'read',
    });
    expect(classifyTerminalCommand('git status --short')).toMatchObject({
      risk: 'read',
    });
  });

  it('classifies write commands as write', () => {
    expect(classifyTerminalCommand('echo hello')).toMatchObject({
      risk: 'write',
    });
    expect(classifyTerminalCommand('mkdir newdir')).toMatchObject({
      risk: 'write',
    });
  });

  it('detects hardline commands', () => {
    expect(getHardlineCommandBlock('shutdown /s')).toBeDefined();
    expect(
      getHardlineCommandBlock('reg delete HKLM\\Software\\X /f')
    ).toBeDefined();
    expect(getHardlineCommandBlock('ls -la')).toBeUndefined();
  });
});
