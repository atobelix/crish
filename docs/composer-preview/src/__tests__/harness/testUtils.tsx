import React from 'react';
import { render, RenderOptions, RenderResult, screen, fireEvent, waitFor } from '@testing-library/react';

export function renderWithProviders(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>
): RenderResult {
  return render(ui, { ...options });
}

export { render, screen, fireEvent, waitFor };
