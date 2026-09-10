// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { PinIcon, PinOffIcon, CopyIcon, PencilIcon } from '../index';

describe('Animated Icons (animateicons)', () => {
  it('PinIcon renders without crashing', () => {
    const { container } = render(<PinIcon size={14} isHovered={false} />);
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('PinOffIcon renders without crashing', () => {
    const { container } = render(<PinOffIcon size={14} isHovered={false} />);
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('CopyIcon renders without crashing', () => {
    const { container } = render(<CopyIcon size={14} isHovered={false} />);
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('PencilIcon renders without crashing', () => {
    const { container } = render(<PencilIcon size={14} isHovered={false} />);
    expect(container.querySelector('svg')).toBeTruthy();
  });
});
