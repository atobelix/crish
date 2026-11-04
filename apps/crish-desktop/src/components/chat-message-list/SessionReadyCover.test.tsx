/**
 * @vitest-environment jsdom
 * 批 B ⑳ 就绪遮罩：退出条件（测高遍数走完 + 锚点落定）与呈现态区分。
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { SessionReadyCover, isSessionCoverReady } from './SessionReadyCover';

describe('SessionReadyCover（批 B ⑳）', () => {
  it('退出条件：测高遍数走完且锚点落定才就绪', () => {
    expect(
      isSessionCoverReady({ measurePassesRemaining: 0, restorePending: false })
    ).toBe(true);
    expect(
      isSessionCoverReady({ measurePassesRemaining: 2, restorePending: false })
    ).toBe(false);
    expect(
      isSessionCoverReady({ measurePassesRemaining: 0, restorePending: true })
    ).toBe(false);
    expect(
      isSessionCoverReady({ measurePassesRemaining: 1, restorePending: true })
    ).toBe(false);
  });

  it('呈现：覆盖态与淡出态以 data-fading 区分', () => {
    const { container, rerender } = render(
      <SessionReadyCover fading={false} />
    );
    const el = container.querySelector('[data-testid="session-ready-cover"]');
    expect(el).not.toBeNull();
    expect(el?.getAttribute('data-fading')).toBe('false');
    rerender(<SessionReadyCover fading={true} />);
    expect(el?.getAttribute('data-fading')).toBe('true');
  });
});
