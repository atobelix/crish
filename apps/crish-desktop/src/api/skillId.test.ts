import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { skillStableId } from './skillId';

/** 权威参照：agent-runtime 的 stableId = `${prefix}_${sha256(value).hex.slice(0,12)}` */
function referenceId(name: string, filePath: string): string {
  const hex = createHash('sha256')
    .update(`${name}:${filePath}`, 'utf8')
    .digest('hex');
  return `skill_${hex.slice(0, 12)}`;
}

const CASES: Array<[string, string, string]> = [
  ['空串', '', ''],
  ['ASCII', 'my-skill', '/tmp/x/SKILL.md'],
  ['中文路径', '代码审查', 'C:\\用户\\技能\\SKILL.md'],
  ['emoji（代理对）', 'rocket 🚀', '/skills/🚀/SKILL.md'],
  ['2 字节 UTF-8', 'café', '/é/ñ'],
  // SHA-256 分块边界：消息 55/56/63/64/119/120 字节附近（含 ':' 分隔符）
  ['55 字节', 'a'.repeat(27), 'b'.repeat(27)],
  ['56 字节', 'a'.repeat(27), 'b'.repeat(28)],
  ['64 字节', 'a'.repeat(31), 'b'.repeat(32)],
  ['120 字节', 'a'.repeat(59), 'b'.repeat(60)],
  ['长文本（多块）', 'n'.repeat(500), '/p/'.repeat(400)],
];

describe('skillStableId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('文件内注释的黄金向量成立', () => {
    expect(skillStableId('my-skill', '/tmp/x/SKILL.md')).toBe(
      'skill_95cfb221d00f'
    );
  });

  it.each(CASES)('与 Node sha256 逐字节一致：%s', (_label, name, path) => {
    const id = skillStableId(name, path);
    expect(id).toMatch(/^skill_[0-9a-f]{12}$/);
    expect(id).toBe(referenceId(name, path));
  });

  it('name 与 filePath 任一不同即产生不同 id', () => {
    const base = skillStableId('a', '/x');
    expect(skillStableId('b', '/x')).not.toBe(base);
    expect(skillStableId('a', '/y')).not.toBe(base);
  });

  describe('无 TextEncoder 宿主的回退 UTF-8 编码', () => {
    it.each(CASES)('与 TextEncoder 路径结果一致：%s', (_label, name, path) => {
      const expected = skillStableId(name, path);
      vi.stubGlobal('TextEncoder', undefined);
      expect(skillStableId(name, path)).toBe(expected);
    });

    it.each([
      ['孤立高代理位于末尾', 'x\uD83D', '/p'],
      ['孤立高代理后跟普通字符', '\uD83DA', '/p'],
      ['孤立低代理', '\uDE80b', '/p'],
    ])('%s：按 U+FFFD 编码，与 TextEncoder/Node 一致', (_label, name, path) => {
      const withEncoder = skillStableId(name, path);
      expect(withEncoder).toBe(referenceId(name, path));
      vi.stubGlobal('TextEncoder', undefined);
      expect(skillStableId(name, path)).toBe(withEncoder);
    });
  });
});
