// @vitest-environment jsdom
import React from 'react';
import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  ReasoningRow,
  TimelineThoughtSection,
  extractLatestLine,
  extractFirstLine,
} from '../ReasoningRow';

describe('DIM-03 §1.1: 24px ReasoningRow 极简思考行流式追踪与扫光微交互', () => {
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
      expect(extractLatestLine('单行无换行思考内容')).toBe('单行无换行思考内容');
      expect(extractLatestLine('前缀行\n最新思考末尾带空格   \n')).toBe('最新思考末尾带空格');
    });

    it('extractFirstLine: 提取首个有效实质性主题行并过滤前置空行', () => {
      const multiLine = '\n\n   \n第一阶段：建立核心几何与状态机模型\n第二阶段：接入扫光微交互';
      expect(extractFirstLine(multiLine)).toBe('第一阶段：建立核心几何与状态机模型');
      expect(extractFirstLine('')).toBe('');
      expect(extractFirstLine('   \n  \n')).toBe('');
    });
  });

  describe('二、几何与尺寸隔离：24px 高度硬契约与零局部视口', () => {
    it('未展开态拥有 24px 尺寸隔离契约与正确的无障碍属性', () => {
      const { container } = render(
        <ReasoningRow content="正在推理当前步骤" isLive={true} />
      );

      const root = container.querySelector('[data-testid="reasoning-container"]');
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
        <ReasoningRow
          content={'长文本推理行\n'.repeat(50)}
          isOpen={true}
        />
      );
      expect(container.querySelector('[class*="thoughtScrollBody"]')).toBeNull();
      expect(container.querySelector('[class*="thinkingBodyContainer"]')).toBeNull();
    });
  });

  describe('三、流式运行态与扫光微交互：指示灯、@keyframes sweep-shine 与尾窗跟随', () => {
    it('流式运行态呈现状态指示灯与 [data-follow-end="true"] 尾窗追踪窗', () => {
      const { container } = render(
        <ReasoningRow
          content={'历史过程第一步\n正在流式推理最后一行'}
          isLive={true}
        />
      );

      // 极简状态指示灯
      const dot = container.querySelector('[data-testid="status-dot"]');
      expect(dot).not.toBeNull();

      // 语义标签
      expect(screen.getByText('思考中')).toBeDefined();

      // 尾窗打字机跟随视窗
      const summaryContainer = container.querySelector('[data-follow-end="true"]');
      expect(summaryContainer).not.toBeNull();
      expect(screen.getByText('正在流式推理最后一行')).toBeDefined();
    });

    it('CSS 样式验证：包含 @keyframes sweep-shine 与 a11y 降级规范', () => {
      const cssPath = path.resolve(__dirname, '../ReasoningRow.module.css');
      const cssContent = fs.readFileSync(cssPath, 'utf-8');

      // 扫光微交互动画名称声明
      expect(cssContent).toMatch(/@keyframes\s+sweep-shine/);
      expect(cssContent).toMatch(/animation:\s*sweep-shine\s+2\.6s/);

      // 无障碍 a11y 降级声明
      expect(cssContent).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
      expect(cssContent).toMatch(/animation:\s*none/);

      // Conex §13 软环焦点规范
      expect(cssContent).toMatch(/:focus-visible/);
      expect(cssContent).toMatch(/color-mix\(in\s+srgb/);
    });
  });

  describe('四、终态闭合态：已思考 3.2s > 与 tabular-nums 等宽对齐', () => {
    it('终态展示“已思考 3.2s >”，耗时样式应用 tabular-nums', () => {
      const { container } = render(
        <ReasoningRow
          content=""
          isLive={false}
          durationMs={3200}
        />
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
  });

  describe('五、点击展开态与交互：自然流出、受控模式与独立复制', () => {
    it('非受控模式下点击切换展开状态并渲染 reasoningBody', () => {
      const { container } = render(
        <ReasoningRow
          content="完整的深度思考推导思维链"
          isLive={false}
          durationMs={1800}
        />
      );

      // 初始收起态
      expect(container.querySelector('[data-testid="reasoning-body"]')).toBeNull();

      // 点击展开
      const btn = screen.getByRole('button');
      fireEvent.click(btn);

      // 展开态自然呈现
      const body = container.querySelector('[data-testid="reasoning-body"]');
      expect(body).not.toBeNull();
      expect(btn.getAttribute('aria-expanded')).toBe('true');

      // 包含独立一键复制按钮
      const copyBtn = screen.getByTestId('copy-thinking-button');
      expect(copyBtn).toBeDefined();

      // 再次点击收起
      fireEvent.click(btn);
      expect(container.querySelector('[data-testid="reasoning-body"]')).toBeNull();
      expect(btn.getAttribute('aria-expanded')).toBe('false');
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
      expect(container.querySelector('[data-testid="reasoning-body"]')).not.toBeNull();
    });
  });

  describe('六、兼容导出断言', () => {
    it('TimelineThoughtSection 别名导出与 ReasoningRow 完全等同', () => {
      expect(TimelineThoughtSection).toBe(ReasoningRow);
    });
  });

  describe('七、40% 灰度次度降噪规范断言', () => {
    it('触发按钮与展开面板挂载标准 class 并契约支持次度呈现', () => {
      const { container } = render(
        <ReasoningRow
          content="测试思考内容"
          isOpen={true}
        />
      );

      const btn = screen.getByRole('button', { name: '思考过程' });
      expect(btn.className).toContain('reasoningRow');

      const body = container.querySelector('[data-testid="reasoning-body"]');
      expect(body).not.toBeNull();
      expect(body?.className).toContain('reasoningBody');
    });
  });
});
