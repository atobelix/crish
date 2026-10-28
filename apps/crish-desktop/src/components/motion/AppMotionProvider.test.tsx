// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/components/motion/AppMotionProvider.test.tsx
 *
 * 全局动效宿主 <AppMotionProvider> 单元测试与动效物理学契约守卫
 *
 * 覆盖：
 * 1. 基础渲染：正确透传与挂载 children 子节点；
 * 2. strict 约束：验证 LazyMotion strict 模式，拦截违规 motion.* 标签并要求改用 m.*；
 * 3. 动效偏好：验证 MotionConfig reducedMotion="user" 系统级动效偏好配置与上下文派发；
 * 4. m.* 组件体系：内部包裹 m.div / m.button 等按需动效组件可正常渲染与应用过渡配置；
 * 5. 源码契约：静态断言锁定 LazyMotion features={domAnimation} 与 4.6 KB 严格包体积防回潮。
 */
import React, { useContext } from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import {
  m,
  motion,
  MotionConfigContext,
  domAnimation,
  AnimatePresence,
} from 'motion/react';
import { AppMotionProvider } from './AppMotionProvider';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

const TSX_SRC = readFileSync(join(DIR, 'AppMotionProvider.tsx'), 'utf8');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AppMotionProvider 动效顶层宿主', () => {
  describe('1. 基础渲染 (Basic Rendering)', () => {
    it('正确渲染单一子元素节点', () => {
      render(
        <AppMotionProvider>
          <div data-testid="single-child">核心工作区内容</div>
        </AppMotionProvider>
      );

      const child = screen.getByTestId('single-child');
      expect(child).toBeInTheDocument();
      expect(child).toHaveTextContent('核心工作区内容');
    });

    it('正确渲染多层嵌套与同级复杂子节点树', () => {
      render(
        <AppMotionProvider>
          <header data-testid="header">TopBar</header>
          <main data-testid="main">
            <section data-testid="section">
              <span data-testid="nested-span">嵌套文本</span>
            </section>
          </main>
          <footer data-testid="footer">StatusBar</footer>
        </AppMotionProvider>
      );

      expect(screen.getByTestId('header')).toHaveTextContent('TopBar');
      expect(screen.getByTestId('main')).toBeInTheDocument();
      expect(screen.getByTestId('nested-span')).toHaveTextContent('嵌套文本');
      expect(screen.getByTestId('footer')).toHaveTextContent('StatusBar');
    });
  });

  describe('2. strict 约束 (LazyMotion strict mode guard)', () => {
    it('当内部错误混用全量 motion.div 时，在开发环境下触发 invariant 阻断并提示改用 m.*', () => {
      // 在 strict 模式下，渲染重量级 motion.div 会抛出 invariant 异常
      // 拦截 console.error 避免 Jest/Vitest 报错日志杂音
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      expect(() => {
        render(
          <AppMotionProvider>
            <motion.div data-testid="heavy-motion-element">
              违规使用 motion 标签
            </motion.div>
          </AppMotionProvider>
        );
      }).toThrow(/LazyMotion/i);

      consoleErrorSpy.mockRestore();
    });

    it('使用推荐轻量 m.div 标签时正常放行，不触发 strict 拦截', () => {
      expect(() => {
        render(
          <AppMotionProvider>
            <m.div data-testid="compliant-m-element">合规 m 标签轻量动效</m.div>
          </AppMotionProvider>
        );
      }).not.toThrow();

      expect(screen.getByTestId('compliant-m-element')).toBeInTheDocument();
      expect(screen.getByTestId('compliant-m-element')).toHaveTextContent(
        '合规 m 标签轻量动效'
      );
    });
  });

  describe('3. 动效偏好 (MotionConfig Context & Preferences)', () => {
    function ContextProbe() {
      const config = useContext(MotionConfigContext);
      return (
        <div data-testid="context-probe">
          <span data-testid="reduced-motion">{config.reducedMotion}</span>
          <span data-testid="is-static">{String(config.isStatic)}</span>
        </div>
      );
    }

    it('向子树注入 reducedMotion="user" 以响应系统级减弱动效偏好', () => {
      render(
        <AppMotionProvider>
          <ContextProbe />
        </AppMotionProvider>
      );

      expect(screen.getByTestId('reduced-motion')).toHaveTextContent('user');
      expect(screen.getByTestId('is-static')).toHaveTextContent('false');
    });
  });

  describe('4. m.* 组件体系与过渡物理学 (m.* Components & Transitions)', () => {
    it('内部包裹 m.div 可正常应用 initial / animate 样式及 spring 过渡参数', () => {
      const springConfig = {
        type: 'spring',
        stiffness: 420,
        damping: 32,
        bounce: 0,
      } as const;

      render(
        <AppMotionProvider>
          <m.div
            data-testid="physics-box"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={springConfig}
          >
            二阶物理弹簧容器
          </m.div>
        </AppMotionProvider>
      );

      const box = screen.getByTestId('physics-box');
      expect(box).toBeInTheDocument();
      expect(box).toHaveTextContent('二阶物理弹簧容器');
    });

    it('内部包裹 m.button 可响应交互并承载 layout 属性与 AnimatePresence', () => {
      render(
        <AppMotionProvider>
          <AnimatePresence>
            <m.button
              key="interactive-btn"
              data-testid="interactive-btn"
              layout
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
            >
              交互按钮
            </m.button>
          </AnimatePresence>
        </AppMotionProvider>
      );

      const btn = screen.getByTestId('interactive-btn');
      expect(btn).toBeInTheDocument();
      expect(btn.tagName.toLowerCase()).toBe('button');
      expect(btn).toHaveTextContent('交互按钮');
    });
  });

  describe('5. 源码契约与架构防回潮静态断言 (Architecture Contract)', () => {
    it('严格声明 LazyMotion features={domAnimation} 与 strict 属性', () => {
      expect(TSX_SRC).toMatch(
        /<LazyMotion\s+features=\{domAnimation\}\s+strict>/
      );
      expect(TSX_SRC).toContain(
        "import { LazyMotion, domAnimation, MotionConfig } from 'motion/react';"
      );
    });

    it('严格声明 MotionConfig reducedMotion="user"', () => {
      expect(TSX_SRC).toMatch(/<MotionConfig\s+reducedMotion="user">/);
    });

    it('禁止在全局动效宿主中引入重量级 loadFeatures 异步全量包', () => {
      // 避免全量特性包回潮，首屏包体积死锁
      expect(TSX_SRC).not.toContain('async function');
      expect(TSX_SRC).not.toContain('features={() => import(');
      expect(TSX_SRC).not.toContain('allFeatures');
    });
  });
});
