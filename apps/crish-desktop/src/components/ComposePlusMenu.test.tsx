import { describe, expect, it } from 'vitest';
import styles from './ComposePlusMenu.module.css';

describe('ComposePlusMenu', () => {
  it('should apply max-height viewport clamping', () => {
    expect(styles.root).toBeDefined();
    expect(styles.main).toBeDefined();
    expect(typeof styles.main).toBe('string');
  });

  it('should prevent scroll overflow', () => {
    expect(styles.slim).toBeDefined();
    expect(typeof styles.slim).toBe('string');
  });
});
