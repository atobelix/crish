import React, {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ResizeObserverManager } from '../../../utils/ResizeObserverManager';
import styles from './Tabs.module.css';
import type {
  TabsContentProps,
  TabsContextValue,
  TabsListProps,
  TabsProps,
  TabsTriggerProps,
} from './types';

const TabsContext = createContext<TabsContextValue | null>(null);

export function useTabsContext(): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (!ctx) {
    throw new Error(
      'Tabs sub-components must be rendered within a <Tabs> parent.'
    );
  }
  return ctx;
}

export const Tabs = forwardRef<HTMLDivElement, TabsProps>(function Tabs(
  {
    value: externalValue,
    defaultValue,
    onValueChange,
    variant = 'pill',
    size = 'sm',
    orientation = 'horizontal',
    block = false,
    className,
    style,
    children,
    ...rest
  },
  ref
) {
  const [internalValue, setInternalValue] = useState<string>(
    defaultValue ?? ''
  );
  const isControlled = externalValue !== undefined;
  const currentValue = isControlled ? (externalValue ?? '') : internalValue;

  const triggerMapRef = useRef<Map<string, HTMLElement>>(new Map());

  const registerTrigger = useCallback((val: string, el: HTMLElement | null) => {
    if (el) {
      triggerMapRef.current.set(val, el);
    } else {
      triggerMapRef.current.delete(val);
    }
  }, []);

  const unregisterTrigger = useCallback((val: string) => {
    triggerMapRef.current.delete(val);
  }, []);

  const handleValueChange = useCallback(
    (nextVal: string) => {
      if (!isControlled) {
        setInternalValue(nextVal);
      }
      if (nextVal !== currentValue) {
        onValueChange?.(nextVal);
      }
    },
    [isControlled, currentValue, onValueChange]
  );

  const ctxValue = useMemo<TabsContextValue>(
    () => ({
      value: currentValue,
      onValueChange: handleValueChange,
      variant,
      size,
      orientation,
      block,
      registerTrigger,
      unregisterTrigger,
    }),
    [
      currentValue,
      handleValueChange,
      variant,
      size,
      orientation,
      block,
      registerTrigger,
      unregisterTrigger,
    ]
  );

  const sizeClassName =
    size === 'xs'
      ? styles.sizeXs
      : size === 'sm'
        ? styles.sizeSm
        : size === 'md'
          ? styles.sizeMd
          : styles.sizeLg;

  const rootClasses = [styles.root, sizeClassName, className]
    .filter(Boolean)
    .join(' ');

  return (
    <TabsContext.Provider value={ctxValue}>
      <div
        ref={ref}
        className={rootClasses}
        data-orientation={orientation}
        data-variant={variant}
        data-block={block ? 'true' : undefined}
        style={style}
        {...rest}
      >
        {children}
      </div>
    </TabsContext.Provider>
  );
});
Tabs.displayName = 'Tabs';

export const TabsList = forwardRef<HTMLDivElement, TabsListProps>(
  function TabsList(
    {
      'aria-label': ariaLabel,
      role = 'tablist',
      className,
      style,
      children,
      onKeyDown,
      ...rest
    },
    forwardedRef
  ) {
    const { value, variant, orientation, block, onValueChange } =
      useTabsContext();
    const listRef = useRef<HTMLDivElement | null>(null);

    const [sliderRect, setSliderRect] = useState<{
      x: number;
      y: number;
      width: number;
      height: number;
      opacity: number;
    }>({ x: 0, y: 0, width: 0, height: 0, opacity: 0 });

    const setRefs = useCallback(
      (node: HTMLDivElement | null) => {
        listRef.current = node;
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      },
      [forwardedRef]
    );

    const updateIndicator = useCallback(() => {
      const listEl = listRef.current;
      if (!listEl) return;

      const activeTrigger = listEl.querySelector<HTMLElement>(
        `[data-tabs-trigger][data-value="${CSS.escape(value)}"]`
      );

      if (activeTrigger) {
        if (variant === 'pill') {
          setSliderRect({
            x: activeTrigger.offsetLeft,
            y: activeTrigger.offsetTop,
            width: activeTrigger.offsetWidth,
            height: activeTrigger.offsetHeight,
            opacity: 1,
          });
        } else {
          // Line variant
          if (orientation === 'horizontal') {
            setSliderRect({
              x: activeTrigger.offsetLeft,
              y: listEl.clientHeight - 2,
              width: activeTrigger.offsetWidth,
              height: 2,
              opacity: 1,
            });
          } else {
            // Vertical line (centered line)
            const lineH = Math.max(16, activeTrigger.offsetHeight / 2);
            setSliderRect({
              x: 0,
              y:
                activeTrigger.offsetTop +
                (activeTrigger.offsetHeight - lineH) / 2,
              width: 2,
              height: lineH,
              opacity: 1,
            });
          }
        }
      } else {
        setSliderRect((prev) => ({ ...prev, opacity: 0 }));
      }
    }, [value, variant, orientation]);

    useLayoutEffect(() => {
      updateIndicator();
    }, [updateIndicator]);

    useEffect(() => {
      const el = listRef.current;
      if (!el) return;
      const ro = ResizeObserverManager.getInstance();
      ro.observe(el, updateIndicator);
      return () => {
        ro.unobserve(el, updateIndicator);
      };
    }, [updateIndicator]);

    // Roving TabIndex 键盘漫游
    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(e);
      if (e.defaultPrevented) return;

      const listEl = listRef.current;
      if (!listEl) return;

      const triggers = Array.from(
        listEl.querySelectorAll<HTMLButtonElement>(
          '[data-tabs-trigger]:not(:disabled)'
        )
      );
      if (triggers.length === 0) return;

      const currentIndex = triggers.findIndex(
        (el) => el.getAttribute('data-value') === value
      );

      let nextIndex = -1;
      const isHorizontal = orientation === 'horizontal';

      if (
        (isHorizontal && (e.key === 'ArrowRight' || e.key === 'ArrowDown')) ||
        (!isHorizontal && (e.key === 'ArrowDown' || e.key === 'ArrowRight'))
      ) {
        e.preventDefault();
        nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % triggers.length;
      } else if (
        (isHorizontal && (e.key === 'ArrowLeft' || e.key === 'ArrowUp')) ||
        (!isHorizontal && (e.key === 'ArrowUp' || e.key === 'ArrowLeft'))
      ) {
        e.preventDefault();
        nextIndex = currentIndex <= 0 ? triggers.length - 1 : currentIndex - 1;
      } else if (e.key === 'Home') {
        e.preventDefault();
        nextIndex = 0;
      } else if (e.key === 'End') {
        e.preventDefault();
        nextIndex = triggers.length - 1;
      }

      if (nextIndex >= 0 && nextIndex < triggers.length) {
        const nextTrigger = triggers[nextIndex];
        if (nextTrigger) {
          const nextValue = nextTrigger.getAttribute('data-value');
          if (nextValue !== null) {
            onValueChange(nextValue);
            nextTrigger.focus();
          }
        }
      }
    };

    const listClasses = [
      styles.list,
      variant === 'pill' ? styles.listPill : styles.listLine,
      className,
    ]
      .filter(Boolean)
      .join(' ');

    const indicatorClasses = [
      styles.indicator,
      variant === 'pill' ? styles.indicatorPill : styles.indicatorLine,
    ].join(' ');

    return (
      <div
        ref={setRefs}
        role={role}
        aria-label={ariaLabel}
        aria-orientation={orientation}
        data-block={block ? 'true' : undefined}
        className={listClasses}
        onKeyDown={handleKeyDown}
        style={style}
        {...rest}
      >
        {/* 物理平滑滑块 */}
        <div
          className={indicatorClasses}
          data-orientation={orientation}
          style={{
            transform: `translate3d(${sliderRect.x}px, ${sliderRect.y}px, 0)`,
            width: `${sliderRect.width}px`,
            height: `${sliderRect.height}px`,
            opacity: sliderRect.opacity,
          }}
          aria-hidden="true"
        />
        {children}
      </div>
    );
  }
);
TabsList.displayName = 'TabsList';

export const TabsTrigger = forwardRef<HTMLButtonElement, TabsTriggerProps>(
  function TabsTrigger(
    {
      value: itemValue,
      icon,
      badge,
      disabled = false,
      role = 'tab',
      className,
      style,
      'aria-label': ariaLabel,
      children,
      onClick,
      ...rest
    },
    forwardedRef
  ) {
    const { value, onValueChange, registerTrigger } = useTabsContext();
    const isSelected = value === itemValue;
    const triggerRef = useRef<HTMLButtonElement | null>(null);

    useEffect(() => {
      registerTrigger(itemValue, triggerRef.current);
      return () => registerTrigger(itemValue, null);
    }, [itemValue, registerTrigger]);

    const setRefs = useCallback(
      (node: HTMLButtonElement | null) => {
        triggerRef.current = node;
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      },
      [forwardedRef]
    );

    const triggerClasses = [styles.trigger, className]
      .filter(Boolean)
      .join(' ');
    const isRadio = role === 'radio';

    return (
      <button
        ref={setRefs}
        type="button"
        role={role}
        aria-selected={isRadio ? undefined : isSelected}
        aria-checked={isRadio ? isSelected : undefined}
        aria-label={ariaLabel}
        tabIndex={isSelected && !disabled ? 0 : -1}
        data-tabs-trigger="true"
        data-value={itemValue}
        data-active={isSelected ? 'true' : undefined}
        disabled={disabled}
        className={triggerClasses}
        style={style}
        onClick={(e) => {
          if (!disabled) {
            onValueChange(itemValue);
          }
          onClick?.(e);
        }}
        {...rest}
      >
        <span className={styles.triggerInner}>
          {icon && <span className={styles.triggerIcon}>{icon}</span>}
          <span className={styles.triggerLabel}>{children}</span>
          {badge && <span className={styles.triggerBadge}>{badge}</span>}
        </span>
      </button>
    );
  }
);
TabsTrigger.displayName = 'TabsTrigger';

export const TabsContent = forwardRef<HTMLDivElement, TabsContentProps>(
  function TabsContent(
    {
      value: panelValue,
      keepMounted = false,
      className,
      style,
      children,
      ...rest
    },
    ref
  ) {
    const { value } = useTabsContext();
    const isSelected = value === panelValue;
    const contentId = useId();

    if (!isSelected && !keepMounted) {
      return null;
    }

    const contentClasses = [styles.content, className]
      .filter(Boolean)
      .join(' ');

    return (
      <div
        ref={ref}
        role="tabpanel"
        id={contentId}
        tabIndex={0}
        hidden={!isSelected}
        className={contentClasses}
        style={style}
        {...rest}
      >
        {children}
      </div>
    );
  }
);
TabsContent.displayName = 'TabsContent';
