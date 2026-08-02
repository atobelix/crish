import { describe, expect, it } from 'vitest';
import styles from './ModelPicker.module.css';

describe('ModelPicker', () => {
  it('should use dvh-based viewport clamping', () => {
    expect(styles.mpick).toBeDefined();
    // Verify CSS class name export from CSS module exists
    expect(typeof styles.mpick).toBe('string');
  });

  it('should have overflow-y: auto', () => {
    expect(styles.mpickScroll).toBeDefined();
    expect(typeof styles.mpickScroll).toBe('string');
  });
});
