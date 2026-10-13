// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  detectExternalSkills,
  DEFAULT_PRESET_EXTERNAL_SKILLS,
  parseSkillMarkdown,
} from './detectExternalSkills';
import * as tauriInvoke from '../../api/tauriInvoke';

describe('detectExternalSkills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns default preset skills when fallback is enabled and no files found', async () => {
    vi.spyOn(tauriInvoke, 'invokeResult').mockResolvedValue({
      status: 'missing',
    } as any);
    const result = await detectExternalSkills();
    expect(result.length).toBeGreaterThan(0);
    expect(result).toEqual(DEFAULT_PRESET_EXTERNAL_SKILLS);
  });

  it('parses real SKILL.md files from external candidate directories', async () => {
    vi.spyOn(tauriInvoke, 'invokeResult').mockImplementation(
      async (cmd: string, args: any) => {
        if (
          cmd === 'workbench_list_directory' &&
          args?.path?.includes('.gemini/antigravity/skills')
        ) {
          return {
            status: 'ok',
            data: {
              items: [{ name: 'my-custom-skill', is_dir: true }],
            },
          } as any;
        }
        if (
          cmd === 'workbench_read_file_content' &&
          args?.path?.includes('my-custom-skill/SKILL.md')
        ) {
          return {
            status: 'ok',
            data: {
              content:
                '---\nname: my-custom-skill\ndescription: 自定义测试技能\n---\n\n# 技能正文',
            },
          } as any;
        }
        return { status: 'missing' } as any;
      }
    );

    const result = await detectExternalSkills({ fallback: false });
    expect(result.length).toBe(1);
    expect(result[0].name).toBe('my-custom-skill');
    expect(result[0].description).toBe('自定义测试技能');
    expect(result[0].source).toBe('Antigravity');
  });

  it('parses frontmatter and titles correctly with parseSkillMarkdown', () => {
    const res1 = parseSkillMarkdown(
      '---\nname: test-skill\ndescription: 描述信息\n---\n正文'
    );
    expect(res1.name).toBe('test-skill');
    expect(res1.description).toBe('描述信息');

    const res2 = parseSkillMarkdown('# 纯标题技能\n第一行说明文字');
    expect(res2.name).toBe('纯标题技能');
    expect(res2.description).toBe('第一行说明文字');
  });
});
