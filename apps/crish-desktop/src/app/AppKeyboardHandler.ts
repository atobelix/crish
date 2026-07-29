import { useKeyboardEditing } from '../hooks/keyboard/editing-keys';
import { useKeyboardNavigation } from '../hooks/keyboard/navigation-keys';
import type { UseAppKeyboardOpts } from '../hooks/keyboard/keyboard-types';

export type { UseAppKeyboardOpts };

export function useAppKeyboard(opts: UseAppKeyboardOpts): void {
  useKeyboardNavigation(opts);
  useKeyboardEditing(opts);
}

