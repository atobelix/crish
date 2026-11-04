/**
 * apps/crish-desktop/src/components/ui/ScrollFadeRegion/ScrollFadeRegion.tsx
 *
 * ui/ScrollFadeRegion 内部滚动区边缘渐隐的声明式包裹组件
 * （F1 · 渐隐组件化，用户裁决 (6)(7)：每个封顶容器都带渐隐、且做成
 * 可复用的选择加入组件）。
 *
 * 【组件族三形态 · 单内核】渐隐机制全域唯一实现只有一套内核：
 * 状态机 useScrollFade（同目录内核：attachScrollFade / computeScrollFadeState）
 * + 样式 styles/scroll-fade.css（mask-image 作用于宿主的内容内层）。
 * 三种接入形态只是同一内核的不同外壳，禁止任何第二套状态机/mask：
 *   - 形态 A（本组件）：宿主 + 内层的声明式包裹，新宿主默认走此形态；
 *   - 形态 B（useScrollFade hook 直用）：内层必须是语义元素本体、
 *     或宿主结构特殊（grid 槽位、宿主 ref 另有专用消费方）时保留；
 *     本组件内部即以此 hook 实现，两形态零双轨；
 *   - 形态 C（bindScrollFadesIn）：innerHTML 渲染面专用
 *     （MarkdownSurface 的代码块，无 React 宿主可包裹），在组件族
 *     文档中登记为命令式成员，CSS 专条（.md-code-pre > code）保留。
 *
 * 【新宿主纪律】渐隐的观察逻辑（scroll + ResizeObserver）只许存在于
 * useScrollFade 内核一处（G-03 口径）；新宿主禁止自带任何尺寸/滚动
 * 监听实现渐隐，一律经本组件（或形态 B/C）接入。
 *
 * 【刻意不进组件的东西】封顶高度。高度是「展开高度分档」的 token
 * 治理域（--expand-max-h-* 几档制），经宿主自己的 className/CSS
 * 承担；fade 只是边缘呈现，两者正交——组件只管渐隐，避免把 cap
 * 与 fade 耦成黑盒。
 */

import React, { forwardRef, useRef } from 'react';
import { useScrollFade } from './useScrollFade';
import { useMergedRefs } from '../utils/mergeRefs';

/** 渐隐带高档位：v1 只开放 'default'（= var(--tool-fade-size)，28px）。扩档须与高度分档方案一并定名定值，禁止裸数值。 */
export type ScrollFadeSize = 'default';

export interface ScrollFadeRegionProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * 是否启用状态机；默认 true。映射 useScrollFade 的 active——
   * 折叠态宿主传 false（如手风琴收起时不挂载状态机）。
   */
  active?: boolean;
  /** 内层附加类名（承接 ReasoningRow 的 reasoningContent 这类 module 类合并） */
  innerClassName?: string;
  /** 内层元素标签；默认 'div'，'pre' 承接 shell 命令视口的语义元素本体情形 */
  innerAs?: 'div' | 'pre';
  /** 渐隐带高档位；v1 仅 'default'（token --tool-fade-size 治理，本组件不写数值） */
  fadeSize?: ScrollFadeSize;
  /**
   * 内层元素的 animationend。动画类挂在内层时（如 AN4 输出整块淡入的
   * 收起信号，useToolOutputReveal 的 handleFadeEnd 带 target 检查），
   * 处理器必须落在动画元素本体，不得借宿主冒泡代收。
   */
  onInnerAnimationEnd?: React.AnimationEventHandler<HTMLElement>;
  children?: React.ReactNode;
}

export const ScrollFadeRegion = forwardRef<
  HTMLDivElement,
  ScrollFadeRegionProps
>(function ScrollFadeRegion(
  {
    active = true,
    className,
    innerClassName,
    innerAs = 'div',
    fadeSize = 'default',
    onInnerAnimationEnd,
    children,
    ...rest
  },
  ref
) {
  const ownHostRef = useRef<HTMLDivElement | null>(null);
  useScrollFade(ownHostRef, active);
  // ref 转发到宿主元素：宿主 ref 的既有消费方（测高 / 滚动跟随）无感迁移
  const hostRef = useMergedRefs(ownHostRef, ref);

  const innerClassNames = ['scroll-fade-inner', innerClassName ?? '']
    .join(' ')
    .trim();

  // fadeSize v1 仅 'default'：带高由 --tool-fade-size token 本身治理，
  // 组件不覆写 CSS 变量；未来档位在此经宿主 style 注入变量实现。
  void fadeSize;

  return (
    <div
      {...rest}
      ref={hostRef}
      data-slot="scroll-fade-region"
      className={className}
    >
      {innerAs === 'pre' ? (
        <pre className={innerClassNames} onAnimationEnd={onInnerAnimationEnd}>
          {children}
        </pre>
      ) : (
        <div className={innerClassNames} onAnimationEnd={onInnerAnimationEnd}>
          {children}
        </div>
      )}
    </div>
  );
});
