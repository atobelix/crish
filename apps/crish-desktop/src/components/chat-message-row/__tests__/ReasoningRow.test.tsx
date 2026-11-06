// @vitest-environment jsdom
import React from 'react';
import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
} from '@testing-library/react';

vi.mock('../../../api/markdown/useMarkdownRender', () => {
  const renderMarkdown = (markdown: string) => {
    const text = markdown
      .replace(/^#{1,6}\s+/, '')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return `<p class="md-p">${text}</p>`;
  };
  const result = (markdown: string, enabled: boolean) => ({
    html: enabled && markdown ? renderMarkdown(markdown) : '',
    truncated: false,
    loading: false,
    failed: false,
  });
  return {
    useMarkdownResult: vi.fn(
      (markdown: string, _variant: string, enabled: boolean = true) =>
        result(markdown, enabled)
    ),
    useMarkdownPrewarm: vi.fn(),
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
          // 模板与现行词典一致（'已思考 {duration}'）：duration 已是由
          // formatDurationLabel 统一产出的带单位标签（如 '3.2 秒'），
          // 模板不得再拼 's'（R8 B13 单源化后的契约）
          return `已思考 ${d}`;
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

    it('终态统一返回静态思考过程，无 liveDot，去耗时秒数（M-07 & R2）', () => {
      const pres = resolveReasoningPresentation({
        isLive: false,
        isExpanded: false,
        durationMs: 3200,
        content: '首行核心主题\n第二行细节',
        t: mockT,
      });
      expect(pres.badgeText).toBe('思考过程');
      expect(pres.hasLiveDot).toBe(false);
      expect(pres.summaryText).toBe('首行核心主题');
      expect(pres.ariaLabel).toBe('思考过程');
    });

    it('终态无耗时稳定兜底思考过程', () => {
      const pres = resolveReasoningPresentation({
        isLive: false,
        isExpanded: false,
        content: '首行核心主题',
        t: mockT,
      });
      expect(pres.badgeText).toBe('思考过程');
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

    it('滚动红线（HC1 修订）：无 168px 硬编码与旧无界滚动类；正文是唯一的登记封顶滚动区', () => {
      const cssPath = path.resolve(__dirname, '../ReasoningRow.module.css');
      const cssContent = fs.readFileSync(cssPath, 'utf-8');

      // 绝对禁止 168px 局部视口硬编码与旧无界滚动类名
      expect(cssContent).not.toContain('168px');
      expect(cssContent).not.toContain('thoughtScrollBody');
      expect(cssContent).not.toContain('thinkingBodyContainer');

      // HC1（用户 2026-11-02 裁决，DIM-02 修订为白名单口径）：思考正文区改为
      // 登记在册的受限滚动区——封顶走 token，且全文仅此一处纵向滚动声明。
      // 旧「绝对不存在 overflow-y: auto」红线随契约修订废止。
      const bodyRule =
        cssContent.match(/\.reasoningBody\s*\{[^}]*\}/)?.[0] ?? '';
      expect(bodyRule).toContain('max-height: var(--reasoning-max-h');
      expect(bodyRule).toContain('overflow-y: auto');
      expect(cssContent.match(/overflow-y:\s*auto/g) ?? []).toHaveLength(1);

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

  describe('三、流式运行态与文字呼吸微交互：指示灯、@keyframes crish-text-breathe（正典登记） 与尾窗跟随', () => {
    it('流式运行态呈现状态指示灯与已解析的尾窗摘要，不暴露 Markdown 源码', () => {
      const { container } = render(
        <ReasoningRow
          content={'历史过程第一步\n## 正在流式推理 **最后一行**'}
          isLive={true}
        />
      );

      // 极简状态指示灯与 UX-01 12×12 槽包裹
      const dot = container.querySelector('[data-testid="status-dot"]');
      expect(dot).not.toBeNull();
      const slot = dot?.parentElement;
      expect(slot?.className).toContain('reasoningSlotIco');

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
      // HC1 · L-8：摘要改纯文本渲染并剥除装饰标记——不再经 markdown 引擎，
      // 旧「渲染出 <strong>」断言随定案翻转为「不产生格式标签、源码不外露」
      expect(summaryMarkup?.innerHTML).not.toContain('<strong>');
      expect(summaryMarkup?.innerHTML).not.toContain('##');
      expect(summaryMarkup?.innerHTML).not.toContain('**');
    });

    it('CSS 样式验证：文字呼吸消费正典 crish-text-breathe 与 a11y 降级规范', () => {
      const cssPath = path.resolve(__dirname, '../ReasoningRow.module.css');
      const cssContent = fs.readFileSync(cssPath, 'utf-8');

      // 文字呼吸微交互（AN3 正名）：关键帧定义已迁正典层登记为独立配方，
      // 本文件只按名消费——旧本地 @keyframes sweep-shine（名实不符）不得回潮
      expect(cssContent).not.toMatch(/@keyframes\s+sweep-shine/);
      expect(cssContent).toMatch(
        /animation:\s*crish-text-breathe\s+var\(--transition-pulse,\s*2\.6s ease-in-out\)/
      );
      const designSystemCss = fs.readFileSync(
        path.resolve(__dirname, '../../../styles/design-system.css'),
        'utf-8'
      );
      expect(designSystemCss).toMatch(/@keyframes\s+crish-text-breathe/);
      expect(designSystemCss).toMatch(
        /@keyframes\s+crish-text-breathe\s*\{\s*0%\s*\{\s*opacity:\s*0\.75/
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

  describe('四、终态闭合态：静态“思考过程”收敛（M-07 & R2）', () => {
    it('终态展示静态“思考过程 >”，去耗时秒数', () => {
      const { container } = render(
        <ReasoningRow content="" isLive={false} durationMs={3200} />
      );

      const badge = container.querySelector('[data-testid="reasoning-badge"]');
      expect(badge).not.toBeNull();
      expect(badge?.textContent?.replace(/\s+/g, ' ')).toBe('思考过程');

      // 折叠指示符（> 或 ›）
      const chevron = container.querySelector('[data-testid="chevron"]');
      expect(chevron).not.toBeNull();
      expect(chevron?.textContent?.trim()).toBe('›');

      // 验证 CSS 中 tabular-nums 的硬约束
      const cssPath = path.resolve(__dirname, '../ReasoningRow.module.css');
      const cssContent = fs.readFileSync(cssPath, 'utf-8');
      expect(cssContent).toMatch(/font-variant-numeric:\s*tabular-nums/);
    });

    it('无耗时终态展示兜底“思考过程 >”', () => {
      render(<ReasoningRow content="" isLive={false} />);
      expect(screen.getByText('思考过程')).toBeDefined();
    });

    it('多阶段思考轮次统一展示思考过程（无第 N 阶段、无耗时秒数）', () => {
      render(
        <ReasoningRow
          content="阶段推理总结"
          isLive={false}
          turnIndex={1}
          durationMs={2500}
        />
      );

      const badge323 = screen.getByTestId('reasoning-badge');
      expect(badge323.textContent?.replace(/\s+/g, ' ')).toBe('思考过程');
      // AN1 常驻后正文也在文档中：摘要断言须定位摘要元素本身（不再全页唯一）
      expect(screen.getByTestId('reasoning-summary-markup').textContent).toBe(
        '阶段推理总结'
      );
    });

    it('从流式态平滑跃迁至终态：最新行平滑切换为首行主题，文案由“思考中”变为“思考过程”', () => {
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
      const badge353 = screen.getByTestId('reasoning-badge');
      expect(badge353.textContent?.replace(/\s+/g, ' ')).toBe('思考过程');
    });

    it('负向断言：排版严格去符号化，绝不渲染任何 dotSeparator 分割点或耗时秒数', () => {
      const { container } = render(
        <ReasoningRow content="首行思考内容" isLive={false} durationMs={3200} />
      );
      expect(container.querySelector('[class*="dotSeparator"]')).toBeNull();
      expect(container.textContent).not.toContain('·');
      expect(container.textContent).not.toMatch(/\d+\.?\d*\s*秒/);
    });
  });

  describe('五、点击展开态与交互：自然流出、受控模式与独立复制', () => {
    it('非受控模式下点击切换展开状态，思考体常驻 DOM（AN1 机制）', () => {
      vi.useFakeTimers();
      try {
        const { container } = render(
          <ReasoningRow
            content="完整的深度思考推导思维链"
            isLive={false}
            durationMs={1800}
          />
        );
        const body = () =>
          container.querySelector('[data-testid="reasoning-body"]');
        const slot = () => body()?.parentElement ?? null;

        // 初始收起态：思考体已在文档中（AN1 常驻），槽位 hidden="until-found"
        expect(body()).not.toBeNull();
        expect(slot()?.getAttribute('hidden')).toBe('until-found');

        // 点击展开：摘除 hidden，正文自然呈现
        const btn = screen.getByRole('button');
        fireEvent.click(btn);
        expect(body()).not.toBeNull();
        expect(btn.getAttribute('aria-expanded')).toBe('true');
        expect(slot()?.hasAttribute('hidden')).toBe(false);

        // 负向断言（用户裁决）：彻底切除复制按钮，不得再出现复制按钮
        expect(screen.queryByTestId('copy-thinking-button')).toBeNull();
        expect(screen.queryByRole('button', { name: /复制/i })).toBeNull();

        // 再次点击收起：旧两阶段 data-collapsing 标记已退役，永不出现
        fireEvent.click(btn);
        expect(btn.getAttribute('aria-expanded')).toBe('false');
        const root = container.querySelector(
          '[data-testid="reasoning-container"]'
        );
        expect(root?.hasAttribute('data-collapsing')).toBe(false);
        expect(body()).not.toBeNull();

        // 兜底定时器到点：只补 hidden 属性，思考体不注销
        act(() => {
          vi.advanceTimersByTime(400);
        });
        expect(body()).not.toBeNull();
        expect(slot()?.getAttribute('hidden')).toBe('until-found');
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

      // 运行态默认折叠（2026-11-06 裁决第 8 条）：用户点击后展开正文
      fireEvent.click(screen.getByRole('button'));
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

  describe('八、AN1 常驻折叠机制（until-found 隐藏协调）与零测试环境绕行断言', () => {
    it('运行态默认折叠（2026-11-06 裁决第 8 条）：工作态全程折叠、内容生长与工作态结束都不改变展开状态，思考体常驻', () => {
      vi.useFakeTimers();
      try {
        const { rerender, container } = render(
          <ReasoningRow content="深度推理思维链推导步骤" isTurnWorking={true} />
        );

        const root = container.querySelector(
          '[data-testid="reasoning-container"]'
        );
        const body = () =>
          container.querySelector('[data-testid="reasoning-body"]');
        const slot = () => body()?.parentElement ?? null;
        // 工作态挂载即折叠（旧「工作态默认展开」口径已退役）
        expect(root?.getAttribute('data-expanded')).toBe('false');
        expect(root?.hasAttribute('data-collapsing')).toBe(false);
        expect(body()).not.toBeNull();

        // 运行中内容持续到达（content 生长）→ 展开状态不变
        rerender(
          <ReasoningRow
            content="深度推理思维链推导步骤\n新增的第二步推理"
            isTurnWorking={true}
          />
        );
        expect(root?.getAttribute('data-expanded')).toBe('false');
        expect(body()).not.toBeNull();

        // 模型输出完成，整轮工作态结束 → 保持折叠；思考体常驻
        rerender(
          <ReasoningRow
            content="深度推理思维链推导步骤\n新增的第二步推理"
            isTurnWorking={false}
            durationMs={3600}
          />
        );
        expect(root?.getAttribute('data-expanded')).toBe('false');
        expect(body()).not.toBeNull();

        // 兜底定时器到点：只补 hidden，DOM 不注销
        act(() => {
          vi.advanceTimersByTime(400);
        });
        expect(slot()?.getAttribute('hidden')).toBe('until-found');
        expect(body()).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('当传入 defaultExpanded={true} 时：运行态、生成完、历史重开全程默认折叠（2026-11-06 裁决：该入参不再驱动展开）', () => {
      vi.useFakeTimers();
      try {
        // 1. 思考中亦折叠（defaultExpanded 不再驱动展开判定）
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
        expect(root?.getAttribute('data-expanded')).toBe('false');

        // 2. 生成完保持折叠（思考体常驻、落定挂 hidden）
        rerender(
          <ReasoningRow
            content="正在生成思考过程"
            isTurnWorking={false}
            defaultExpanded={true}
            durationMs={2000}
          />
        );
        expect(root?.getAttribute('data-expanded')).toBe('false');
        act(() => {
          vi.advanceTimersByTime(400);
        });
        const bodyAfterClose = container.querySelector(
          '[data-testid="reasoning-body"]'
        );
        expect(bodyAfterClose).not.toBeNull();
        expect(bodyAfterClose?.parentElement?.getAttribute('hidden')).toBe(
          'until-found'
        );
        unmount();

        // 3. 关闭对话再打开（历史消息首次挂载 isTurnWorking=false, defaultExpanded=true）：
        // 默认折叠，思考体常驻且槽位自挂载起即 hidden
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
        const reopenedBody = reopened.container.querySelector(
          '[data-testid="reasoning-body"]'
        );
        expect(reopenedBody).not.toBeNull();
        expect(reopenedBody?.parentElement?.getAttribute('hidden')).toBe(
          'until-found'
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('手动折叠由 grid transitionend 主触发挂 hidden（不等兜底定时器）', () => {
      vi.useFakeTimers();
      try {
        const { container } = render(
          <ReasoningRow content="手动测试内容" isTurnWorking={false} />
        );

        const btn = screen.getByRole('button');
        // 展开
        fireEvent.click(btn);
        const body = container.querySelector('[data-testid="reasoning-body"]');
        expect(body).not.toBeNull();
        const slot = body?.parentElement as HTMLElement;
        expect(slot.hasAttribute('hidden')).toBe(false);

        // 收起：合成 transitionend（jsdom 不自动派发）→ 主触发立即挂 hidden
        fireEvent.click(btn);
        const grid = screen.getByTestId('reasoning-grid');
        fireEvent.transitionEnd(grid, {
          propertyName: 'grid-template-rows',
        });
        expect(slot.getAttribute('hidden')).toBe('until-found');
        expect(
          container.querySelector('[data-testid="reasoning-body"]')
        ).not.toBeNull();

        // 兜底定时器随后到点：不重复改动、不注销 DOM
        act(() => {
          vi.advanceTimersByTime(400);
        });
        expect(slot.getAttribute('hidden')).toBe('until-found');
        expect(
          container.querySelector('[data-testid="reasoning-body"]')
        ).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('用户手动展开后，工作态翻转与内容到达不改变展开状态（2026-11-06 裁决第 8 条：items/状态变化不背刺用户意图）', () => {
      vi.useFakeTimers();
      try {
        const { rerender, container } = render(
          <ReasoningRow content="思考过程" isTurnWorking={true} />
        );
        const root = container.querySelector(
          '[data-testid="reasoning-container"]'
        );
        const body = () =>
          container.querySelector('[data-testid="reasoning-body"]');
        const slot = () => body()?.parentElement ?? null;

        // 默认折叠；用户点击展开
        expect(root?.getAttribute('data-expanded')).toBe('false');
        fireEvent.click(screen.getByRole('button'));
        expect(root?.getAttribute('data-expanded')).toBe('true');
        expect(slot()?.hasAttribute('hidden')).toBe(false);

        // 工作态结束 + 内容定格 → 用户的展开不被自动收起
        rerender(
          <ReasoningRow
            content="思考过程"
            isTurnWorking={false}
            durationMs={1200}
          />
        );
        expect(root?.getAttribute('data-expanded')).toBe('true');
        expect(body()).not.toBeNull();

        // 工作态重新激活 → 仍保持展开；越过任何兜底定时器不得误挂 hidden
        rerender(<ReasoningRow content="思考过程" isTurnWorking={true} />);
        act(() => {
          vi.advanceTimersByTime(400);
        });
        expect(root?.getAttribute('data-expanded')).toBe('true');
        expect(body()).not.toBeNull();
        expect(slot()?.hasAttribute('hidden')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('CSS 样式验证：grid 与 chevron 共读根变量同钟；containment 以 hidden 落定为判据', () => {
      const cssPath = path.resolve(__dirname, '../ReasoningRow.module.css');
      const cssContent = fs.readFileSync(cssPath, 'utf8');

      // 验证 CSS Grid 折叠容器及过渡定义（时长读根元素同钟变量）
      expect(cssContent).toMatch(/\.reasoningExpandGrid\s*\{/);
      expect(cssContent).toMatch(/grid-template-rows:\s*0fr/);
      expect(cssContent).toMatch(
        /transition:\s*grid-template-rows\s+var\(--accordion-duration,\s*var\(--transition-accordion\)\)/
      );
      expect(cssContent).toMatch(/grid-template-rows:\s*1fr/);

      // 验证 slot 基础契约
      expect(cssContent).toMatch(/\.reasoningExpandSlot\s*\{/);
      expect(cssContent).toMatch(/min-height:\s*0/);

      // chevron 与 grid 同钟：同一根变量 --accordion-duration
      const chevronRule = cssContent.match(/\.chevron\s*\{[^}]*}/)?.[0] ?? '';
      expect(chevronRule).toContain('var(--accordion-duration');

      // 24px containment 的落定判据 = 槽位 hidden 在位（data-collapsing 已退役）
      expect(cssContent).toMatch(
        /:not\(\[data-expanded='true'\]\):has\(\s*>\s*\.reasoningExpandGrid\s*>\s*\.reasoningExpandSlot\[hidden\]\s*\)/
      );
      expect(cssContent).not.toContain('data-collapsing');

      // 旧 keyframes 双轨（grid-expand / slot-fade-in）已物理删除，零残留
      expect(cssContent).not.toContain('reasoning-grid-expand');
      expect(cssContent).not.toContain('reasoning-slot-fade-in');
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
      // 运行态默认折叠（2026-11-06 裁决）：先手动展开，再手动收起触发回退
      fireEvent.click(btn);
      expect(container.getAttribute('data-expanded')).toBe('true');
      fireEvent.click(btn);

      expect(container.getAttribute('data-expanded')).toBe('false');
      expect(scrollIntoViewMock).toHaveBeenCalledWith({
        block: 'start',
        behavior: 'smooth',
      });
    });

    it('展开和折叠阶段在根元素注入自适应物理时长 --accordion-duration（AN1 同钟落位）', () => {
      const { getByTestId } = render(
        <ReasoningRow
          content="详细思考步骤"
          defaultExpanded={true}
          isTurnWorking={true}
        />
      );

      // AN1：变量挂根元素（reasoning-container），grid 与 chevron 继承共读
      const root = getByTestId('reasoning-container');
      expect(root.style.getPropertyValue('--accordion-duration')).toMatch(
        /\d+ms/
      );
      // grid 自身不再自带变量（只继承根）
      const grid = getByTestId('reasoning-grid');
      expect(grid.style.getPropertyValue('--accordion-duration')).toBe('');
    });
  });

  describe('九、AN1 机制替换验收：MutationObserver 常驻断言 / beforematch / R13 完成门', () => {
    // jsdom 约束（写入契约，勿删）：jsdom 不自动派发 transitionend，
    // beforematch 永不自发——过渡完成由合成 transitionend 事件 + fake
    // timers 兜底路径驱动；beforematch 以手动 dispatchEvent 覆盖其回调
    // 路径，真机查找命中验证另行登记（不在本套件口径内）。
    it('折叠全程（含兜底定时器触发后）思考体节点零移除，槽位落 hidden="until-found"', async () => {
      vi.useFakeTimers();
      try {
        const { container } = render(
          <ReasoningRow content="常驻验收思考内容" isTurnWorking={false} />
        );
        const btn = screen.getByRole('button');
        fireEvent.click(btn);
        const body = container.querySelector('[data-testid="reasoning-body"]');
        expect(body).not.toBeNull();
        const slot = body?.parentElement as HTMLElement;

        const removals: MutationRecord[] = [];
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            if (record.type === 'childList' && record.removedNodes.length > 0) {
              removals.push(record);
            }
          }
        });
        observer.observe(container, { childList: true, subtree: true });

        fireEvent.click(btn);
        act(() => {
          vi.advanceTimersByTime(500);
        });
        // MutationObserver 回调经 microtask 派发，先冲刷再断言
        await Promise.resolve();
        observer.disconnect();

        expect(removals).toHaveLength(0);
        expect(container.contains(body)).toBe(true);
        expect(slot.getAttribute('hidden')).toBe('until-found');

        // 再展开：hidden 摘除，仍是同一节点
        fireEvent.click(btn);
        expect(slot.hasAttribute('hidden')).toBe(false);
        expect(container.contains(body)).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('中途反转（展开→折叠、折叠→展开各一次）终局属性与目标状态一致', () => {
      vi.useFakeTimers();
      try {
        const { container } = render(
          <ReasoningRow content="反转验收内容" isTurnWorking={false} />
        );
        const btn = screen.getByRole('button');
        const slot = () =>
          container.querySelector('[data-testid="reasoning-body"]')
            ?.parentElement as HTMLElement;

        fireEvent.click(btn); // 展开
        fireEvent.click(btn); // 立即折叠（反转一：展开→折叠）
        act(() => {
          vi.advanceTimersByTime(500);
        });
        expect(slot().getAttribute('hidden')).toBe('until-found');

        fireEvent.click(btn); // 再展开（反转二：折叠→展开）
        expect(slot().hasAttribute('hidden')).toBe(false);
        act(() => {
          vi.advanceTimersByTime(500);
        });
        expect(slot().hasAttribute('hidden')).toBe(false);
        expect(
          container.querySelector('[data-testid="reasoning-body"]')
        ).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('beforematch 命中隐藏内容时自动展开（回调路径；jsdom 手动派发）', () => {
      const { container } = render(
        <ReasoningRow content="查找命中验收内容" isTurnWorking={false} />
      );
      const root = container.querySelector(
        '[data-testid="reasoning-container"]'
      );
      const slot = container.querySelector('[data-testid="reasoning-body"]')
        ?.parentElement as HTMLElement;
      expect(root?.getAttribute('data-expanded')).toBe('false');
      expect(slot.getAttribute('hidden')).toBe('until-found');

      act(() => {
        slot.dispatchEvent(new Event('beforematch'));
      });
      expect(root?.getAttribute('data-expanded')).toBe('true');
      expect(slot.hasAttribute('hidden')).toBe(false);
    });

    it('R13 完成门：live 思考的未闭合围栏不以源码中间态上屏，闭合后呈现', async () => {
      const fenceOpen = '先想一下结构\n\n```ts\nconst heldMarker = 41;';
      const { container, rerender } = render(
        <ReasoningRow content={fenceOpen} isLive={true} isTurnWorking={true} />
      );
      const bodyText = () =>
        container.querySelector('[data-testid="reasoning-body"]')
          ?.textContent ?? '';
      // 已完成前缀（散文）呈现；未闭合围栏整段扣留、零足迹
      expect(bodyText()).toContain('先想一下结构');
      expect(bodyText()).not.toContain('heldMarker');

      rerender(
        <ReasoningRow
          content={`${fenceOpen}\n\`\`\`\n\n继续想收尾。`}
          isLive={true}
          isTurnWorking={true}
        />
      );
      // 两条口径叠加，断言须异步等排空：
      // (1) R11 定速显现：新到达文本先经 revealed 排空再进入封口呈现；
      // (2) 完成门活行口径：最后一行恒为活行，围栏须被后续行确认才闭合
      // ——故闭合相位带一行后续散文（真实流的常态），而非以 ``` 结尾。
      await waitFor(
        () => {
          expect(bodyText()).toContain('heldMarker');
        },
        { timeout: 5000 }
      );

      // 终态（流结束恰停在围栏行）：全新挂载走静态权威路径，
      // 封口块直接呈现（不用 rerender 缩短文本——定速层输入只追加）
      const terminal = render(
        <ReasoningRow
          content={`${fenceOpen}\n\`\`\``}
          isLive={false}
          isTurnWorking={false}
        />
      );
      expect(
        terminal.container.querySelector('[data-testid="reasoning-body"]')
          ?.textContent ?? ''
      ).toContain('heldMarker');
    });
  });
});
