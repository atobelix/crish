// @vitest-environment jsdom
import React, { StrictMode } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useInvalidateActualOnChange } from './useInvalidateActualOnChange';

function Probe({
  owner,
  text,
  status,
}: {
  owner: { invalidateActual: (id: string) => void };
  text: string;
  status: string;
}) {
  useInvalidateActualOnChange(owner, 'm1', status !== 'processing', [text, status]);
  return null;
}

describe('useInvalidateActualOnChange', () => {
  it('skips the first mount and invalidates only when the signature changes', () => {
    const owner = { invalidateActual: vi.fn() };
    const { rerender } = render(<Probe owner={owner} text="a" status="completed" />);
    expect(owner.invalidateActual).not.toHaveBeenCalled();

    rerender(<Probe owner={owner} text="a" status="completed" />);
    expect(owner.invalidateActual).not.toHaveBeenCalled();

    rerender(<Probe owner={owner} text="b" status="completed" />);
    expect(owner.invalidateActual).toHaveBeenCalledTimes(1);
    expect(owner.invalidateActual).toHaveBeenCalledWith('m1');
  });

  it('does not invalidate while the row is processing', () => {
    const owner = { invalidateActual: vi.fn() };
    const { rerender } = render(<Probe owner={owner} text="a" status="completed" />);
    rerender(<Probe owner={owner} text="b" status="processing" />);
    expect(owner.invalidateActual).not.toHaveBeenCalled();
    rerender(<Probe owner={owner} text="b" status="completed" />);
    expect(owner.invalidateActual).toHaveBeenCalledTimes(1);
  });

  it('does not invalidate on a StrictMode remount', () => {
    const owner = { invalidateActual: vi.fn() };
    render(
      <StrictMode>
        <Probe owner={owner} text="a" status="completed" />
      </StrictMode>,
    );
    expect(owner.invalidateActual).not.toHaveBeenCalled();
  });
});
