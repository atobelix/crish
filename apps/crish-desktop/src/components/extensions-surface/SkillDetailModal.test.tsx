// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from '@testing-library/react';
import {
  SkillDetailModal,
  parseSkillMarkdown,
  type SkillDetailTarget,
} from './SkillDetailModal';
import { SkillDetailWorkbench } from './SkillDetailWorkbench';
import { ExternalImportWorkbench } from './ExternalImportWorkbench';
import { ToastProvider } from '../../services/toast/ToastContext';
import { useSessionStore } from '../../store/sessionStore';
import * as surfaceRouter from '../../store/surfaceRouter';
import * as skillsApi from '../../api/skillsApi';
import * as detectMcpApi from './detectExternalMcpServers';
import * as detectSkillsApi from './detectExternalSkills';

vi.mock('../../store/surfaceRouter', () => ({
  navigateToChatSession: vi.fn(),
  navigateToSurface: vi.fn(),
}));

vi.mock('../../api/markdownRenderAsync', () => ({
  useAsyncMarkdownHtml: (content: string) => ({
    html: content ? `<div class="rendered-markdown">${content}</div>` : '',
    loading: false,
    failed: false,
  }),
}));

describe('SkillDetailModal & Skill Document Rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  describe('parseSkillMarkdown unit parser', () => {
    it('strips YAML frontmatter and extracts metadata pairs', () => {
      const raw = `---
name: code-reviewer
description: "Review code diffs carefully"
version: '1.2.0'
activation: recommended
---

# Code Reviewer
Welcome to the code reviewer skill.

## Guidelines
- Check invariants
- Verify edge cases
`;
      const { frontmatter, markdownBody } = parseSkillMarkdown(raw);
      expect(frontmatter.name).toBe('code-reviewer');
      expect(frontmatter.description).toBe('Review code diffs carefully');
      expect(frontmatter.version).toBe('1.2.0');
      expect(frontmatter.activation).toBe('recommended');
      expect(markdownBody).toContain('# Code Reviewer');
      expect(markdownBody).not.toContain('---');
    });

    it('returns original text if frontmatter block is absent', () => {
      const raw = '# Pure Markdown\nJust markdown text without frontmatter.';
      const { frontmatter, markdownBody } = parseSkillMarkdown(raw);
      expect(Object.keys(frontmatter)).toHaveLength(0);
      expect(markdownBody).toBe(raw);
    });

    it('handles empty or non-string gracefully', () => {
      expect(parseSkillMarkdown('')).toEqual({
        frontmatter: {},
        markdownBody: '',
      });
      expect(parseSkillMarkdown(null as unknown as string)).toEqual({
        frontmatter: {},
        markdownBody: '',
      });
    });
  });

  describe('SkillDetailModal Pop Panel UI & Interactions', () => {
    const mockSkill: SkillDetailTarget = {
      id: 'skill-resume-master',
      name: 'resume-master',
      description: '简历针对性定制与排版技能',
      source: '官方',
      version: '2.0.0',
      isOfficial: true,
      isInstalled: false,
      content: `---
name: resume-master
author: Crish Team
version: 2.0.0
---

# Resume Master

根据职位描述（JD）快速针对性排版制作高品质简历。

### 指令语法
\`\`\`bash
/skill:resume-master
\`\`\`
`,
    };

    it('renders modal with frontmatter metadata badges and rich Markdown document', () => {
      render(
        <ToastProvider>
          <SkillDetailModal open={true} onClose={vi.fn()} skill={mockSkill} />
        </ToastProvider>
      );

      // 验证标题与元数据
      expect(
        screen.getAllByText('resume-master').length
      ).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('官方')).toBeInTheDocument();
      expect(screen.getByText('v2.0.0')).toBeInTheDocument();
      expect(screen.getByText(/author:/)).toBeInTheDocument();
      expect(screen.getByText('Crish Team')).toBeInTheDocument();

      // 验证富文本渲染容器与内容（正文中剔除了 YAML frontmatter 源码）
      const markdownView = screen.getByTestId('skill-markdown-view');
      expect(markdownView).toBeInTheDocument();
      expect(markdownView).toHaveTextContent('Resume Master');
      expect(markdownView).toHaveTextContent(
        '根据职位描述（JD）快速针对性排版制作高品质简历'
      );
      expect(markdownView).not.toHaveTextContent('author: Crish Team');
    });

    it('generates fallback Markdown overview when raw content is missing', () => {
      const minimalSkill: SkillDetailTarget = {
        id: 'minimal-skill',
        name: 'code-audit',
        description: '进行严格的代码安全审计',
        isInstalled: true,
      };

      render(
        <ToastProvider>
          <SkillDetailModal
            open={true}
            onClose={vi.fn()}
            skill={minimalSkill}
          />
        </ToastProvider>
      );

      const markdownView = screen.getByTestId('skill-markdown-view');
      expect(markdownView).toHaveTextContent('code-audit');
      expect(markdownView).toHaveTextContent('进行严格的代码安全审计');
      expect(markdownView).toHaveTextContent('/skill:code-audit');
    });

    it('asynchronously fetches SKILL.md when content is absent but filePath exists', async () => {
      const spyReadText = vi.spyOn(skillsApi, 'readTextAny')
        .mockResolvedValue(`---
name: async-skill
---
# Asynchronously Loaded Skill
Content loaded from disk successfully.`);

      const asyncSkill: SkillDetailTarget = {
        id: 'async-skill',
        name: 'async-skill',
        filePath: '/mock/path/SKILL.md',
      };

      render(
        <ToastProvider>
          <SkillDetailModal open={true} onClose={vi.fn()} skill={asyncSkill} />
        </ToastProvider>
      );

      await waitFor(() => {
        expect(spyReadText).toHaveBeenCalledWith('/mock/path/SKILL.md');
        expect(
          screen.getByText(/Asynchronously Loaded Skill/)
        ).toBeInTheDocument();
      });
    });

    it('triggers onImport when clicking 导入并启用此技能 on an uninstalled skill', async () => {
      const onImport = vi.fn();
      render(
        <ToastProvider>
          <SkillDetailModal
            open={true}
            onClose={vi.fn()}
            skill={{ ...mockSkill, isInstalled: false }}
            onImport={onImport}
          />
        </ToastProvider>
      );

      const importBtn = screen.getByRole('button', {
        name: /导入并启用此技能/,
      });
      expect(importBtn).toBeInTheDocument();
      fireEvent.click(importBtn);

      expect(onImport).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'resume-master' })
      );
    });

    it('triggers onToggleEnabled when switching status on an installed skill', async () => {
      const onToggle = vi.fn();
      render(
        <ToastProvider>
          <SkillDetailModal
            open={true}
            onClose={vi.fn()}
            skill={{ ...mockSkill, isInstalled: true, isEnabled: true }}
            onToggleEnabled={onToggle}
          />
        </ToastProvider>
      );

      const toggleSwitch = screen.getByRole('switch', {
        name: /启用 resume-master/,
      });
      expect(toggleSwitch).toBeInTheDocument();
      expect(toggleSwitch).toHaveAttribute('aria-checked', 'true');

      fireEvent.click(toggleSwitch);
      expect(onToggle).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'resume-master' }),
        false
      );
    });

    it('copies command /skill:<name> to clipboard when clicking copy button', async () => {
      render(
        <ToastProvider>
          <SkillDetailModal open={true} onClose={vi.fn()} skill={mockSkill} />
        </ToastProvider>
      );

      const copyBtn = screen.getByRole('button', {
        name: /复制 \/skill:resume-master/,
      });
      fireEvent.click(copyBtn);

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        '/skill:resume-master'
      );
    });

    it('creates a new session with /skill:<name> draft and navigates when clicking 使用此技能新建对话', async () => {
      const onClose = vi.fn();
      render(
        <ToastProvider>
          <SkillDetailModal open={true} onClose={onClose} skill={mockSkill} />
        </ToastProvider>
      );

      const newChatBtn = screen.getByRole('button', {
        name: /使用此技能新建对话/,
      });
      fireEvent.click(newChatBtn);

      const sessions = useSessionStore.getState().sessions;
      const created = Object.values(sessions).find(
        (s) => s.title === 'resume-master 对话'
      );
      expect(created).toBeDefined();

      const draft = useSessionStore.getState().composerDrafts[created!.id];
      expect(draft).toBe('/skill:resume-master ');
      expect(surfaceRouter.navigateToChatSession).toHaveBeenCalledWith(
        created!.id
      );
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('SkillDetailWorkbench Rich Markdown & Modal Integration', () => {
    it('renders rich MarkdownDocumentView rather than raw pre source code, and opens Pop modal', async () => {
      const testSkill = {
        id: 'code-review-desktop',
        name: 'code-review',
        description: '代码审查',
        activation: 'enabled' as const,
        scope: 'project' as const,
        system: false,
        content: `---
name: code-review
activation: enabled
---

# Code Review Instructions

严禁敷衍，深入审查边界条件。
`,
      };

      render(
        <ToastProvider>
          <SkillDetailWorkbench skill={testSkill} />
        </ToastProvider>
      );

      // 验证没有 <pre className="codeBlock"> 源码文本，而是 Markdown 文档视图
      expect(screen.getByText(/Code Review Instructions/)).toBeInTheDocument();
      expect(
        screen.getByText(/严禁敷衍，深入审查边界条件/)
      ).toBeInTheDocument();
      // 验证 frontmatter 被抽取显示为 pill
      expect(screen.getAllByText('code-review').length).toBeGreaterThanOrEqual(
        1
      );

      // 点击“弹窗详情”按钮弹出 SkillDetailModal
      const openModalBtn = screen.getByRole('button', { name: /弹窗详情/ });
      fireEvent.click(openModalBtn);

      // 验证弹出 Pop 详情面板
      expect(
        screen.getByRole('dialog', { name: 'code-review 技能文档' })
      ).toBeInTheDocument();
    });
  });

  describe('ExternalImportWorkbench Skill Card Pop Modal Integration', () => {
    it('pops up SkillDetailModal when clicking a detected external skill card', async () => {
      vi.spyOn(detectMcpApi, 'detectExternalMcpServers').mockResolvedValue([]);
      vi.spyOn(detectSkillsApi, 'detectExternalSkills').mockResolvedValue([
        {
          id: 'ext-skill-1',
          source: 'Cursor',
          name: 'cursor-rules-sync',
          description: '同步 Cursor 项目规则配置',
          filePath: '/home/.cursor/skills/cursor-rules-sync/SKILL.md',
          skillDir: '',
          content:
            '# Cursor Rules Sync\n\nAutomatically synchronizes prompt rules.',
        },
      ]);
      vi.spyOn(skillsApi, 'discoverSkills').mockResolvedValue({
        skills: [],
        errors: [],
      } as any);

      render(
        <ToastProvider>
          <ExternalImportWorkbench categoryFilter="skill" />
        </ToastProvider>
      );

      // 等待外部探测技能渲染
      const cardName = await screen.findByText('cursor-rules-sync');
      expect(cardName).toBeInTheDocument();

      // 点击该卡片
      const card = screen.getByRole('button', { name: /cursor-rules-sync/i });
      fireEvent.click(card);

      // 验证弹出 SkillDetailModal
      expect(
        await screen.findByRole('dialog', {
          name: 'cursor-rules-sync 技能文档',
        })
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Automatically synchronizes prompt rules/)
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /导入并启用此技能/ })
      ).toBeInTheDocument();
    });
  });
});
