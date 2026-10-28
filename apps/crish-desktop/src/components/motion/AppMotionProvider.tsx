import type { ReactNode } from 'react';
import { LazyMotion, domAnimation, MotionConfig } from 'motion/react';

export interface AppMotionProviderProps {
  children: ReactNode;
}

/**
 * 全局动效基础设施顶层宿主：
 * 1. 统一注入 domAnimation 特性包（涵盖物理弹簧、FLIP layout、AnimatePresence）；
 * 2. 启用 strict 模式，强行拦截非 m.* 标签的误用；
 * 3. 首屏静态包体积锁死在 4.6 KB，消除双轨打包分裂；
 * 4. 配置 MotionConfig reducedMotion="user" 适配系统级动效偏好。
 */
export function AppMotionProvider({ children }: AppMotionProviderProps) {
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}
