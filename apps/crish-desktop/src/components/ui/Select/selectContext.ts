import { createContext, useContext } from 'react';
import type { SelectContextValue } from './types';

export const SelectContext = createContext<SelectContextValue | null>(null);

export function useSelectContext(
  componentName = 'Select compound component'
): SelectContextValue {
  const ctx = useContext(SelectContext);
  if (!ctx) {
    throw new Error(
      `${componentName} must be used within a <Select> root component.`
    );
  }
  return ctx;
}
