import { useState, useCallback, useRef, useEffect } from 'react';

interface UsePanelToggleOptions {
  closeOnClickOutside?: boolean;
  closeOnEscape?: boolean;
  closeOnSelect?: boolean;
  restoreFocusOnClose?: boolean;
  focusFirstOnOpen?: boolean;
  onClose?: () => void;
  onOpen?: () => void;
}

interface UsePanelToggleReturn {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
  triggerRef: React.RefObject<HTMLElement>;
  panelRef: React.RefObject<HTMLElement>;
  subMenuRef: React.RefObject<HTMLElement>;
  animationState: 'entering' | 'open' | 'exiting' | 'closed';
  handleSelect: () => void;
  handleKeyDown: (e: React.KeyboardEvent) => void;
}

const EXIT_DURATION = 100;

export function usePanelToggle(options: UsePanelToggleOptions = {}): UsePanelToggleReturn {
  const {
    closeOnClickOutside = true,
    closeOnEscape = true,
    closeOnSelect = true,
    restoreFocusOnClose = true,
    focusFirstOnOpen = true,
    onClose,
    onOpen,
  } = options;

  const [open, _setOpen] = useState(false);
  const [animationState, setAnimationState] = useState<'entering' | 'open' | 'exiting' | 'closed'>('closed');

  const toggleLockRef = useRef(false);
  const triggerRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const subMenuRef = useRef<HTMLElement>(null);
  const animateTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const setOpen = useCallback((v: boolean) => {
    if (toggleLockRef.current) return;
    toggleLockRef.current = true;

    if (v) {
      _setOpen(true);
      setAnimationState('entering');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setAnimationState('open');
        });
      });
      onOpen?.();
    } else {
      setAnimationState('exiting');
      animateTimeoutRef.current = setTimeout(() => {
        _setOpen(false);
        setAnimationState('closed');
      }, EXIT_DURATION);
      onClose?.();
    }

    setTimeout(() => { toggleLockRef.current = false; }, 50);
  }, [onOpen, onClose]);

  const toggle = useCallback(() => {
    setOpen(!open);
  }, [open, setOpen]);

  useEffect(() => {
    if (!closeOnClickOutside || !open) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        panelRef.current?.contains(target) ||
        subMenuRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [closeOnClickOutside, open, setOpen]);

  useEffect(() => {
    if (!closeOnEscape || !open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [closeOnEscape, open, setOpen]);

  useEffect(() => {
    if (!restoreFocusOnClose || open) return;
    requestAnimationFrame(() => {
      triggerRef.current?.focus();
    });
  }, [open, restoreFocusOnClose]);

  useEffect(() => {
    if (!focusFirstOnOpen || !open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = panel.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    focusable?.focus();
  }, [open, focusFirstOnOpen]);

  useEffect(() => {
    return () => {
      if (animateTimeoutRef.current) {
        clearTimeout(animateTimeoutRef.current);
      }
    };
  }, []);

  const handleSelect = useCallback(() => {
    if (closeOnSelect) {
      setOpen(false);
    }
  }, [closeOnSelect, setOpen]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
    }
  }, [setOpen]);

  return {
    open,
    setOpen,
    toggle,
    triggerRef,
    panelRef,
    subMenuRef,
    animationState,
    handleSelect,
    handleKeyDown,
  };
}
