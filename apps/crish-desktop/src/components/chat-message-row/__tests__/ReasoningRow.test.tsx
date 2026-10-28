// @vitest-environment jsdom
import React from 'react';
import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('../../../api/markdownRenderAsync', () => {
  const renderMarkdown = (markdown: string) => {
    const text = markdown
      .replace(/^#{1,6}\s+/, '')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return `<p class="md-p">${text}</p>`;
  };
  return {
    useAsyncMarkdownHtml: vi.fn((markdown: string) => ({
      html: markdown ? renderMarkdown(markdown) : '',
      loading: false,
      failed: false,
    })),
    useStreamingMarkdownHtml: vi.fn((markdown: string, enabled: boolean) =>
      enabled && markdown ? renderMarkdown(markdown) : ''
    ),
  };
});

import {
  ReasoningRow,
  extractLatestLine,
  extractFirstLine,
  resolveReasoningPresentation,
} from '../ReasoningRow';

describe('DIM-03 §1.1: 24px ReasoningRow 极简思考行流式追踪与扫光微交互', () => {
  describe('零、呈现契约纯逻辑：resolveReasoningPresentation 状态覆盖', () => {
    const mockT = vi.fn(
      (
        key: string,
        fallbackOrParams?: string | Record<string, unknown>,
        params?: Record<string, unknown>
      ) => {
        if (key === 'chat.thinking.label') return '思考中';
        if (key === 'chat.thinking.completed') return '已思考';
        if (key === 'chat.thinking.durationShort') {
          const d =
            (typeof fallbackOrParams === 'object'
              ? (fallbackOrParams as Record<string, unknown>).duration
              : params?.duration) ?? '';
          return `已思考 ${d}s`;
        }
        if (key === 'chat.thinking.process') return '思考过程';
        return typeof fallbackOrParams === 'string' ? fallbackOrParams : key;
      }
    );

    it('流式态返回思考中并启用 liveDot', () => {
      const pres = resolveReasoningPresentation({
        isLive: true,
        isExpanded: false,
        content: '第一行\n最新第二行',
        t: mockT,
      });
      expect(pres.badgeText).toBe('思考中');
      expect(pres.hasLiveDot).toBe(true);
      expect(pres.summaryText).toBe('最新第二行');
      expect(pres.ariaLabel).toBe('思考中');
      expect(pres.interactive).toBe(true);
    });

    it('终态带耗时返回格式化时长，无 liveDot', () => {
      const pres = resolveReasoningPresentation({
        isLive: false,
        isExpanded: false,
        durationMs: 3200,
        content: '首行核心主题\n第二行细节',
        t: mockT,
      });
      expect(pres.badgeText).toBe('已思考 3.2s');
      expect(pres.hasLiveDot).toBe(false);
      expect(pres.summaryText).toBe('首行核心主题');
      expect(pres.ariaLabel).toBe('已思考 3.2s');
    });

    it('终态无耗时稳定兜底已思考', () => {
      const pres = resolveReasoningPresentation({
        isLive: false,
        isExpanded: false,
        content: '首行核心主题',
        t: mockT,
      });
      expect(pres.badgeText).toBe('已思考');
      expect(pres.hasLiveDot).toBe(false);
      expect(pres.summaryText).toBe('首行核心主题');
      expect(pres.ariaLabel).toBe('思考过程');
    });

    it('展开态下 summaryText 恒为空以阻断双份复读', () => {
      const pres = resolveReasoningPresentation({
        isLive: false,
        isExpanded: true,
        durationMs: 2000,
        content: '首行核心主题\n正文长篇思维链',
        t: mockT,
      });
      expect(pres.summaryText).toBe('');
    });
  });
  describe('一、纯算法层：512B 尾窗切片与 O(1) 复杂度断言', () => {
    it('extractLatestLine: 面对超长文本严格截取尾窗最新行并保持 O(1) 耗时', () => {
      const longPrefix = '历史推理链阶段思考输出与分析步骤\n'.repeat(3000); // 约 60KB
      const targetLatest = '正在分析网络拓扑并准备调用终端执行工具';
      const fullText = `${longPrefix}${targetLatest}`;

      const start = performance.now();
      const result = extractLatestLine(fullText);
      const elapsed = performance.now() - start;

      expect(result).toBe(targetLatest);
      // 常数级时间开销 (严控在 0.5ms 内)
      expect(elapsed).toBeLessThan(0.5);
    });

    it('extractLatestLine: 空白、换行与退化边界处理', () => {
      expect(extractLatestLine('')).toBe('');
      expect(extractLatestLine('   \n\n  \n')).toBe('');
      expect(extractLatestLine('单行无换行思考内容')).toBe(
        '单行无换行思考内容'
      );
      expect(extractLatestLine('前缀行\n最新思考末尾带空格   \n')).toBe(
        '最新思考末尾带空格'
      );
    });

    it('extractFirstLine: 提取首个有效实质性主题行并过滤前置空行', () => {
      const multiLine =
        '\n\n   \n第一阶段：建立核心几何与状态机模型\n第二阶段：接入扫光微交互';
      expect(extractFirstLine(multiLine)).toBe(
        '第一阶段：建立核心几何与状态机模型'
      );
      expect(extractFirstLine('')).toBe('');
      expect(extractFirstLine('   \n  \n')).toBe('');
    });
  });

  describe('二、几何与尺寸隔离：24px 高度硬契约与零局部视口', () => {
    it('未展开态拥有 24px 尺寸隔离契约与正确的无障碍属性', () => {
      const { container } = render(
        <ReasoningRow content="正在推理当前步骤" isLive={true} />
      );

      const root = container.querySelector(
        '[data-testid="reasoning-container"]'
      );
      expect(root).not.toBeNull();
      expect(root?.getAttribute('data-expanded')).toBe('false');
      expect(root?.getAttribute('data-live')).toBe('true');

      const btn = container.querySelector('button');
      expect(btn).not.toBeNull();
      expect(btn?.getAttribute('aria-expanded')).toBe('false');
      expect(btn?.getAttribute('aria-label')).toBe('思考中');
    });

    it('CSS 样式硬约束：声明 24px 固定高、contain: size layout 与防坍塌盒模型', () => {
      const cssPath = path.resolve(__dirname, '../ReasoningRow.module.css');
      const cssContent = fs.readFileSync(cssPath, 'utf-8');

      // 验证 24px 刚性契约
      expect(cssContent).toMatch(/height:\s*24px/);
      expect(cssContent).toMatch(/min-height:\s*24px/);
      expect(cssContent).toMatch(/max-height:\s*24px/);
      expect(cssContent).toMatch(/box-sizing:\s*border-box/);

      // 验证硬件级尺寸隔离
      expect(cssContent).toMatch(/contain:\s*size\s+layout/);

      // 验证防 Chromium 内核坍塌
      expect(cssContent).toMatch(/display:\s*flex/);
      expect(cssContent).toMatch(/width:\s*100%/);
    });

    it('负产出刚性红线：绝对不存在 168px 硬编码高度或 overflow-y: auto 局部滚动视口', () => {
      const cssPath = path.resolve(__dirname, '../ReasoningRow.module.css');
      const cssContent = fs.readFileSync(cssPath, 'utf-8');

      // 绝对禁止 168px 局部视口与非受控内部滚动
      expect(cssContent).not.toContain('168px');
      expect(cssContent).not.toContain('overflow-y: auto');
      expect(cssContent).not.toContain('thoughtScrollBody');
      expect(cssContent).not.toContain('thinkingBodyContainer');

      // 展开态也不存在内部滚动容器
      const { container } = render(
        <ReasoningRow content={'长文本推理行\n'.repeat(50)} isOpen={true} />
      );
      expect(
        container.querySelector('[class*="thoughtScrollBody"]')
      ).toBeNull();
      expect(
        container.querySelector('[class*="thinkingBodyContainer"]')
      ).toBeNull();
    });
  });

  describe('三、流式运行态与扫光微交互：指示灯、@keyframes sweep-shine 与尾窗跟随', () => {
    it('流式运行态呈现状态指示灯与已解析的尾窗摘要，不暴露 Markdown 源码', () => {
      const { container } = render(
        <ReasoningRow
          content={'历史过程第一步\n## 正在流式推理 **最后一行**'}
          isLive={true}
        />
      );

      // 极简状态指示灯
      const dot = container.querySelector('[data-testid="status-dot"]');
      expect(dot).not.toBeNull();

      // 语义标签与状态圆点
      expect(screen.getByText('思考中')).toBeDefined();
      expect(
        container.querySelector('button')?.getAttribute('aria-label')
      ).toBe('思考中');

      // 尾窗打字机跟随视窗
      const summaryContainer = container.querySelector(
        '[data-follow-end="true"]'
      );
      expect(summaryContainer).not.toBeNull();
      const summaryMarkup = screen.getByTestId('reasoning-summary-markup');
      expect(summaryMarkup?.textContent).toBe('正在流式推理 最后一行');
      expect(summaryMarkup?.innerHTML).toContain('<strong>最后一行</strong>');
      expect(summaryMarkup?.innerHTML).not.toContain('##');
      expect(summaryMarkup?.innerHTML).not.toContain('**');
    });

    it('CSS 样式验证：包含 @keyframes sweep-shine 与 a11y 降级规范', () => {
      const cssPath = path.resolve(__dirname, '../ReasoningRow.module.css');
      const cssContent = fs.readFileSync(cssPath, 'utf-8');

      // 扫光微交互动画名称声明
      expect(cssContent).toMatch(/@keyframes\s+sweep-shine/);
      expect(cssContent).toMatch(
        /animation:\s*sweep-shine\s+var\(--transition-pulse,\s*2\.6s ease-in-out\)/
      );

      // 无障碍 a11y 降级声明
      expect(cssContent).toMatch(
        /@media\s*\(prefers-reduced-motion:\s*reduce\)/
      );
      expect(cssContent).toMatch(/animation:\s*none/);

      // Conex §13 软环焦点规范
      expect(cssContent).toMatch(/:focus-visible/);
      expect(cssContent).toMatch(/color-mix\(in\s+srgb/);
    });
  });

  describe('四、终态闭合态：已思考 3.2s > 与 tabular-nums 等宽对齐', () => {
    it('终态展示“已思考 3.2s >”，耗时样式应用 tabular-nums', () => {
      const { container } = render(
        <ReasoningRow content="" isLive={false} durationMs={3200} />
      );

      // 终态闭合文案匹配
      expect(screen.getByText('已思考 3.2s')).toBeDefined();

      // 折叠指示符（> 或 ›）
      const chevron = container.querySelector('[data-testid="chevron"]');
      expect(chevron).not.toBeNull();
      expect(chevron?.textContent?.trim()).toBe('›');

      // 验证 CSS 中 tabular-nums 的硬约束
      const cssPath = path.resolve(__dirname, '../ReasoningRow.module.css');
      const cssContent = fs.readFileSync(cssPath, 'utf-8');
      expect(cssContent).toMatch(/font-variant-numeric:\s*tabular-nums/);
    });

    it('无耗时终态展示兜底“已思考 >”', () => {
      render(<ReasoningRow content="" isLive={false} />);
      expect(screen.getByText('已思考')).toBeDefined();
    });

    it('多阶段思考轮次统一展示思考与耗时（无第 N 阶段）', () => {
      render(
        <ReasoningRow
          content="阶段推理总结"
          isLive={false}
          turnIndex={1}
          durationMs={2500}
        />
      );

      expect(screen.getByText('已思考 2.5s')).toBeDefined();
      expect(screen.getByText('阶段推理总结')).toBeDefined();
    });

    it('从流式态平滑跃迁至终态：最新行平滑切换为首行主题', () => {
      const { rerender } = render(
        <ReasoningRow
          content={'首行设计方案\n正在执行具体分析细节...'}
          isLive={true}
        />
      );
      expect(screen.getByText('正在执行具体分析细节...')).toBeDefined();
      expect(screen.getByText('思考中')).toBeDefined();

      // 跃迁为终态
      rerender(
        <ReasoningRow
          content={'首行设计方案\n正在执行具体分析细节...'}
          isLive={false}
          durationMs={3200}
        />
      );
      expect(screen.getByText('首行设计方案')).toBeDefined();
      expect(screen.getByText('已思考 3.2s')).toBeDefined();
    });

    it('负向断言：排版严格去符号化，绝不渲染任何 dotSeparator 分割点', () => {
      const { container } = render(
        <ReasoningRow content="首行思考内容" isLive={false} durationMs={3200} />
      );
      expect(container.querySelector('[class*="dotSeparator"]')).toBeNull();
      expect(container.textContent).not.toContain('·');
    });
  });

  describe('五、点击展开态与交互：自然流出、受控模式与独立复制', () => {
    it('非受控模式下点击切换展开状态并渲染 reasoningBody', () => {
      vi.useFakeTimers();
      try {
        const { container } = render(
          <ReasoningRow
            content="完整的深度思考推导思维链"
            isLive={false}
            durationMs={1800}
          />
        );

        // 初始收起态
        expect(
          container.querySelector('[data-testid="reasoning-body"]')
        ).toBeNull();

        // 点击展开
        const btn = screen.getByRole('button');
        fireEvent.click(btn);

        // 展开态自然呈现
        const body = container.querySelector('[data-testid="reasoning-body"]');
        expect(body).not.toBeNull();
        expect(btn.getAttribute('aria-expanded')).toBe('true');

        // 负向断言（用户裁决）：彻底切除复制按钮，不得再出现复制按钮
        expect(screen.queryByTestId('copy-thinking-button')).toBeNull();
        expect(screen.queryByRole('button', { name: /复制/i })).toBeNull();

        // 再次点击收起（触发折叠动画过渡态）
        fireEvent.click(btn);
        expect(btn.getAttribute('aria-expanded')).toBe('false');
        const root = container.querySelector(
          '[data-testid="reasoning-container"]'
        );
        expect(root?.getAttribute('data-collapsing')).toBe('true');

        // 220ms 动效结束后注销 DOM
        act(() => {
          vi.advanceTimersByTime(220);
        });
        expect(
          container.querySelector('[data-testid="reasoning-body"]')
        ).toBeNull();
        expect(root?.getAttribute('data-collapsing')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('支持受控模式：外部传入 isOpen 与 onToggle', () => {
      const onToggle = vi.fn();
      const { rerender, container } = render(
        <ReasoningRow
          content="受控思考内容"
          isOpen={false}
          onToggle={onToggle}
        />
      );

      const btn = screen.getByRole('button');
      fireEvent.click(btn);
      expect(onToggle).toHaveBeenCalledTimes(1);

      // 受控更新为展开
      rerender(
        <ReasoningRow
          content="受控思考内容"
          isOpen={true}
          onToggle={onToggle}
        />
      );
      expect(
        container.querySelector('[data-testid="reasoning-body"]')
      ).not.toBeNull();
    });

    it('架构防复读断言：展开态下头部不渲染摘要文本，彻底阻断与正文的内容双重重复', () => {
      const { container } = render(
        <ReasoningRow
          content={'## 第一阶段 **推理**\n第二阶段推理'}
          isLive={true}
          isTurnWorking={true}
        />
      );

      // 工作态默认展开正文
      const reasoningBody = container.querySelector(
        '[data-testid="reasoning-body"]'
      );
      expect(reasoningBody).not.toBeNull();
      const renderedHtml = Array.from(
        reasoningBody?.querySelectorAll('.md-rendered') ?? []
      )
        .map((block) => block.innerHTML)
        .join('\n');
      expect(renderedHtml).toContain('<strong>推理</strong>');
      expect(renderedHtml).not.toContain('##');
      expect(renderedHtml).not.toContain('**');
      // 头部单行按钮内绝不包含任何尾窗跟随摘要元素
      const summaryInHeader = container.querySelector(
        'button [data-follow-end="true"]'
      );
      expect(summaryInHeader).toBeNull();
    });
  });

  describe('六、负向断言：历史兼容别名已物理切除', () => {
    it('ReasoningRow 模块不得再导出 TimelineThoughtSection（命名收敛 SSOT）', async () => {
      const mod = await import('../ReasoningRow');
      expect('TimelineThoughtSection' in mod).toBe(false);
      expect('TimelineThoughtSectionProps' in mod).toBe(false);
    });
  });

  describe('七、40% 灰度次度降噪规范断言', () => {
    it('触发按钮与展开面板挂载标准 class 并契约支持次度呈现', () => {
      const { container } = render(
        <ReasoningRow content="测试思考内容" isOpen={true} />
      );

      const btn = screen.getByRole('button', { name: '思考过程' });
      expect(btn.className).toContain('reasoningRow');

      const body = container.querySelector('[data-testid="reasoning-body"]');
      expect(body).not.toBeNull();
      expect(body?.className).toContain('reasoningBody');
    });

    it('负向断言（2026-09-11 用户裁决）：展开态思考正文严禁渲染复制按钮', () => {
      render(<ReasoningRow content="测试思考正文内容" isOpen={true} />);

      expect(screen.queryByTestId('copy-thinking-button')).toBeNull();
      expect(screen.queryByRole('button', { name: /复制/i })).toBeNull();
    });

    it('负向断言（源码级）：ReasoningRow.module.css 严禁包含 .reasoningBody:hover 加深文字颜色规则', () => {
      const cssPath = path.resolve(__dirname, '../ReasoningRow.module.css');
      const cssContent = fs.readFileSync(cssPath, 'utf8');

      expect(cssContent).not.toMatch(/\.reasoningBody:hover/);
      expect(cssContent).not.toMatch(/\.copyButton/);
    });
  });

  describe('八、两阶段平滑折叠（Two-Phase Folding）与零测试环境绕行断言', () => {
    it('当模型工作态结束（isTurnWorking 从 true 转为 false）时，触发两阶段优雅折叠', () => {
      vi.useFakeTimers();
      try {
        const { rerender, container } = render(
          <ReasoningRow content="深度推理思维链推导步骤" isTurnWorking={true} />
        );

        const root = container.querySelector(
          '[data-testid="reasoning-container"]'
        );
        expect(root?.getAttribute('data-expanded')).toBe('true');
        expect(root?.getAttribute('data-collapsing')).toBeNull();
        expect(
          container.querySelector('[data-testid="reasoning-body"]')
        ).not.toBeNull();

        // 模型输出完成，整轮工作态结束
        rerender(
          <ReasoningRow
            content="深度推理思维链推导步骤"
            isTurnWorking={false}
            durationMs={3600}
          />
        );

        // 阶段一：进入折叠过渡态（保留 DOM 供 CSS Grid 执行 160ms 平滑收缩，避免视口突变跳跃）
        expect(root?.getAttribute('data-expanded')).toBe('false');
        expect(root?.getAttribute('data-collapsing')).toBe('true');
        expect(
          container.querySelector('[data-testid="reasoning-body"]')
        ).not.toBeNull();

        // 推进 160ms 物理动画周期
        act(() => {
          vi.advanceTimersByTime(220);
        });

        // 阶段二：完全卸载态（DOM 安全注销，data-collapsing 标记移除）
        expect(root?.getAttribute('data-collapsing')).toBeNull();
        expect(
          container.querySelector('[data-testid="reasoning-body"]')
        ).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('当传入 defaultExpanded={true}（默认未开启隐藏思考块）时：思考中展开、生成完自动关闭、历史对话重开默认折叠', () => {
      vi.useFakeTimers();
      try {
        // 1. 思考中展开
        const { rerender, container, unmount } = render(
          <ReasoningRow
            content="正在生成思考过程"
            isTurnWorking={true}
            defaultExpanded={true}
          />
        );
        const root = container.querySelector(
          '[data-testid="reasoning-container"]'
        );
        expect(root?.getAttribute('data-expanded')).toBe('true');

        // 2. 生成完自动关闭（220ms 平滑收起）
        rerender(
          <ReasoningRow
            content="正在生成思考过程"
            isTurnWorking={false}
            defaultExpanded={true}
            durationMs={2000}
          />
        );
        expect(root?.getAttribute('data-expanded')).toBe('false');
        expect(root?.getAttribute('data-collapsing')).toBe('true');
        act(() => {
          vi.advanceTimersByTime(220);
        });
        expect(
          container.querySelector('[data-testid="reasoning-body"]')
        ).toBeNull();
        unmount();

        // 3. 关闭对话再打开（历史消息首次挂载 isTurnWorking=false, defaultExpanded=true）：默认折叠
        const reopened = render(
          <ReasoningRow
            content="历史对话思考内容"
            isTurnWorking={false}
            defaultExpanded={true}
            durationMs={2000}
          />
        );
        const reopenedRoot = reopened.container.querySelector(
          '[data-testid="reasoning-container"]'
        );
        expect(reopenedRoot?.getAttribute('data-expanded')).toBe('false');
        expect(
          reopened.container.querySelector('[data-testid="reasoning-body"]')
        ).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('手动点击折叠进入平滑 collapsing 动画过渡，并在窗口结束后安全卸载', () => {
      vi.useFakeTimers();
      try {
        const { container } = render(
          <ReasoningRow content="手动测试内容" isTurnWorking={false} />
        );

        const btn = screen.getByRole('button');
        // 展开
        fireEvent.click(btn);
        expect(
          container.querySelector('[data-testid="reasoning-body"]')
        ).not.toBeNull();

        // 收起：第一阶段保留 DOM，启动平滑过渡
        fireEvent.click(btn);
        const root = container.querySelector(
          '[data-testid="reasoning-container"]'
        );
        expect(root?.getAttribute('data-collapsing')).toBe('true');
        expect(
          container.querySelector('[data-testid="reasoning-body"]')
        ).not.toBeNull();

        // 第二阶段：220ms 动效窗口结束后安全注销 DOM
        act(() => {
          vi.advanceTimersByTime(220);
        });
        expect(root?.getAttribute('data-collapsing')).toBeNull();
        expect(
          container.querySelector('[data-testid="reasoning-body"]')
        ).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('折叠过渡中途若工作态重新激活，应立即取消折叠并恢复展开', () => {
      vi.useFakeTimers();
      try {
        const { rerender, container } = render(
          <ReasoningRow content="思考过程" isTurnWorking={true} />
        );

        // 触发收拢
        rerender(<ReasoningRow content="思考过程" isTurnWorking={false} />);
        const root = container.querySelector(
          '[data-testid="reasoning-container"]'
        );
        expect(root?.getAttribute('data-collapsing')).toBe('true');

        // 在 80ms 处重新激活工作态
        act(() => {
          vi.advanceTimersByTime(80);
        });
        rerender(<ReasoningRow content="思考过程" isTurnWorking={true} />);

        expect(root?.getAttribute('data-expanded')).toBe('true');
        expect(root?.getAttribute('data-collapsing')).toBeNull();
        expect(
          container.querySelector('[data-testid="reasoning-body"]')
        ).not.toBeNull();

        // 推进剩余时间，确保不会被错误注销
        act(() => {
          vi.advanceTimersByTime(200);
        });
        expect(
          container.querySelector('[data-testid="reasoning-body"]')
        ).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('CSS 样式验证：包含 var(--transition-accordion) 的 CSS Grid 平滑收缩契约', () => {
      const cssPath = path.resolve(__dirname, '../ReasoningRow.module.css');
      const cssContent = fs.readFileSync(cssPath, 'utf8');

      // 验证 CSS Grid 折叠容器及过渡定义
      expect(cssContent).toMatch(/\.reasoningExpandGrid\s*\{/);
      expect(cssContent).toMatch(/grid-template-rows:\s*0fr/);
      expect(cssContent).toMatch(
        /transition:\s*grid-template-rows\s+var\(--transition-accordion\)/
      );
      expect(cssContent).toMatch(/grid-template-rows:\s*1fr/);

      // 验证 slot 透明度与位移轻量淡出
      expect(cssContent).toMatch(/\.reasoningExpandSlot\s*\{/);
      expect(cssContent).toMatch(/min-height:\s*0/);

      // 验证未折叠态与非过渡态的 24px containment 联合选择器
      expect(cssContent).toMatch(
        /:not\(\[data-expanded='true'\]\):not\(\[data-collapsing='true'\]\)/
      );
    });

    it('刚性红线：源码级断言绝不包含任何 NODE_ENV === test 或 typeof window 绕行作弊分支', () => {
      const tsxPath = path.resolve(__dirname, '../ReasoningRow.tsx');
      const tsxContent = fs.readFileSync(tsxPath, 'utf8');

      expect(tsxContent).not.toMatch(/process\.env\.NODE_ENV/);
      expect(tsxContent).not.toMatch(/NODE_ENV\s*===/);
      expect(tsxContent).not.toMatch(/typeof\s+window\s*===/);
      expect(tsxContent).not.toMatch(/!important/);
    });

    it('收起长思维链时若滚出屏幕顶部，触发视口平滑回退保护', () => {
      const { getByTestId } = render(
        <ReasoningRow
          content="详细思考步骤\n第一步\n第二步\n第三步"
          isTurnWorking={true}
          defaultExpanded={true}
        />
      );

      const container = getByTestId('reasoning-container');
      const scrollIntoViewMock = vi.fn();
      container.scrollIntoView = scrollIntoViewMock;
      vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
        top: -300,
        bottom: 500,
        left: 0,
        right: 400,
        width: 400,
        height: 800,
        x: 0,
        y: -300,
        toJSON: () => {},
      });

      const btn = container.querySelector('button') as HTMLButtonElement;
      fireEvent.click(btn);

      expect(container.getAttribute('data-expanded')).toBe('false');
      expect(scrollIntoViewMock).toHaveBeenCalledWith({
        block: 'start',
        behavior: 'smooth',
      });
    });

    it('展开和折叠阶段注入自适应物理时长 --accordion-duration', () => {
      const { getByTestId } = render(
        <ReasoningRow
          content="详细思考步骤"
          defaultExpanded={true}
          isTurnWorking={true}
        />
      );

      const grid = getByTestId('reasoning-grid');
      expect(grid.style.getPropertyValue('--accordion-duration')).toMatch(
        /\d+ms/
      );
    });
  });
});
