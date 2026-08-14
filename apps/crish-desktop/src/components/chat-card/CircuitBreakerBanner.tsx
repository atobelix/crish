import React from 'react';
import styles from './ChatStatusRibbons.module.css';
import type { CircuitBanner } from '../../api/continuity/continuityUiStore';
import { Button } from '../ui';

export interface CircuitBreakerBannerProps {
  banner: CircuitBanner;
  onDismiss: () => void;
}

export const CircuitBreakerBanner: React.FC<CircuitBreakerBannerProps> = ({
  banner,
  onDismiss,
}) => {
  if (banner.dismissed) return null;
  return (
    <div
      className={styles.circuitBreakerBanner}
      data-testid="circuit-breaker-banner"
      role="alert"
    >
      <span>{banner.message}</span>
      <Button size="sm" variant="ghost" onClick={onDismiss}>
        关闭
      </Button>
    </div>
  );
};
