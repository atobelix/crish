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
  triggerRef: React.RefObject<HTMLElement | null>;
  panelRef: React.RefObject<HTMLElement | null>;
  subMenuRef: React.RefObject<HTMLElement | null>;
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
  const closeSeqRef = useRef(0);
  const hasOpenedRef = useRef(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const subMenuRef = useRef<HTMLElement | null>(null);
  const animateTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const animateRafRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(false);

  const setOpen = useCallback((v: boolean) => {
    if (toggleLockRef.current) return;
    toggleLockRef.current = true;

    if (animateTimeoutRef.current) {
      clearTimeout(animateTimeoutRef.current);
      animateTimeoutRef.current = undefined;
    }
    if (animateRafRef.current != null) {
      cancelAnimationFrame(animateRafRef.current);
      animateRafRef.current = undefined;
    }

    if (v) {
      hasOpenedRef.current = true;
      _setOpen(true);
      setAnimationState('entering');
      animateRafRef.current = requestAnimationFrame(() => {
        animateRafRef.current = requestAnimationFrame(() => {
          setAnimationState('open');
        });
      });
      onOpen?.();
    } else {
      const seq = ++closeSeqRef.current;
      setAnimationState('exiting');
      animateTimeoutRef.current = setTimeout(() => {
        animateTimeoutRef.current = undefined;
        if (closeSeqRef.current !== seq) return; // superseded by a new open
        _setOpen(false);
        setAnimationState('closed');
      }, EXIT_DURATION);
      onClose?.();
    }

    queueMicrotask(() => { toggleLockRef.current = false; });
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
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!hasOpenedRef.current) return; // never opened, no focus to restore
    if (!restoreFocusOnClose || open) return;
    const raf = requestAnimationFrame(() => {
      triggerRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
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
      if (animateRafRef.current != null) {
        cancelAnimationFrame(animateRafRef.current);
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
