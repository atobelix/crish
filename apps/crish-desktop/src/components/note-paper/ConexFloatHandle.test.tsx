// @vitest-environment jsdom
import React, { useRef } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConexFloatHandle } from './ConexFloatHandle';

function MockNotePaperContainer() {
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', width: 600, height: 400 }}
    >
      <div data-block-id="block-1" style={{ height: 30, margin: '10px 0' }}>
        Block 1 Content
      </div>
      <div data-block-id="block-2" style={{ height: 30, margin: '10px 0' }}>
        Block 2 Content
      </div>
      <ConexFloatHandle scrollContainerRef={containerRef} />
    </div>
  );
}

describe('ConexFloatHandle - Singleton 0-Re-render DOM direct write', () => {
  it('renders single float handle instance hidden by default', () => {
    render(<MockNotePaperContainer />);
    const handle = screen.getByTestId('conex-float-handle-singleton');
    expect(handle).toBeTruthy();
    expect(handle.style.display).toBe('none');
  });

  it('updates transform on pointermove over block with 0 React state updates', () => {
    render(<MockNotePaperContainer />);
    const handle = screen.getByTestId('conex-float-handle-singleton');
    const block1 = screen.getByText('Block 1 Content');

    // Simulate pointermove over block-1
    fireEvent.pointerMove(block1, { clientX: 100, clientY: 50 });

    // Handle should become visible and have transform direct written
    expect(handle.style.display).toBe('flex');
    expect(handle.style.transform).toContain('translate3d');
  });
});
