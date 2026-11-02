import React from 'react';
import type { AgentIdentity } from '../../api/tool-presentation/agentIdentity';
import styles from './AgentIdentityBadge.module.css';

/**
 * 子 agent 身份标（R4a 共享地基组件）：身份色点 + 几何标号。
 *
 * 颜色一律取引数 identity 的 hueVar（var(--agent-hue-N)），亮暗双主题
 * 由变量定义承担，组件不写死任何色值。身份的「分给谁」由
 * resolveAgentIdentities（会话级撞色顺延）或 agentIdentity（单 agent）
 * 决定，本组件只负责呈现，供 R4b 在流内分派卡 / 侧栏头部 / 团队板 /
 * 顶栏下拉四面以同一组件接线，保证同 agent 四面同色同标。
 *
 * 纯装饰语义（aria-hidden）：身份信息始终有相邻的标题文本承载，
 * 身份标不单独传达信息。
 */
export function AgentIdentityBadge({
  identity,
  size = 12,
  className,
}: {
  identity: AgentIdentity;
  /** 基准字号 px（色点直径取其 0.6 倍，标号字形取其 1 倍） */
  size?: number;
  className?: string;
}) {
  const dotSize = Math.max(4, Math.round(size * 0.6));
  return (
    <span
      className={className ? `${styles.badge} ${className}` : styles.badge}
      data-agent-identity-badge=""
      data-hue-index={identity.hueIndex}
      aria-hidden="true"
      style={{ fontSize: size }}
    >
      <span
        className={styles.dot}
        style={{
          backgroundColor: identity.hueVar,
          width: dotSize,
          height: dotSize,
        }}
      />
      <span className={styles.glyph} style={{ color: identity.hueVar }}>
        {identity.glyph}
      </span>
    </span>
  );
}
