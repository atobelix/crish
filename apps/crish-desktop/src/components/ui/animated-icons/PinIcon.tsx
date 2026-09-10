import type { Variants } from 'motion/react';
import {
  LazyMotion,
  domMin,
  m,
  useAnimation,
  useReducedMotion,
} from 'motion/react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type HTMLAttributes,
} from 'react';

export interface PinIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

export interface PinIconProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  | 'color'
  | 'onDrag'
  | 'onDragStart'
  | 'onDragEnd'
  | 'onAnimationStart'
  | 'onAnimationEnd'
  | 'onAnimationIteration'
> {
  size?: number;
  duration?: number;
  isAnimated?: boolean;
  color?: string;
  isHovered?: boolean;
}

export const PinIcon = forwardRef<PinIconHandle, PinIconProps>(
  (
    {
      onMouseEnter,
      onMouseLeave,
      className,
      size = 24,
      duration = 1,
      isAnimated = true,
      color,
      isHovered,
      style,
      ...props
    },
    ref
  ) => {
    const controls = useAnimation();
    const reduced = useReducedMotion();
    const isControlled = useRef(false);

    useImperativeHandle(ref, () => {
      isControlled.current = true;
      return {
        startAnimation: () =>
          reduced ? controls.start('normal') : controls.start('animate'),
        stopAnimation: () => controls.start('normal'),
      };
    });

    useEffect(() => {
      if (isHovered === true) {
        if (!reduced && isAnimated) controls.start('animate');
      } else if (isHovered === false) {
        controls.start('normal');
      }
    }, [isHovered, controls, reduced, isAnimated]);

    const handleEnter = useCallback(
      (e?: React.MouseEvent<HTMLDivElement>) => {
        if (!isAnimated || reduced) return;
        if (!isControlled.current) controls.start('animate');
        else onMouseEnter?.(e as React.MouseEvent<HTMLDivElement>);
      },
      [controls, reduced, isAnimated, onMouseEnter]
    );

    const handleLeave = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (!isControlled.current) {
          controls.start('normal');
        } else {
          onMouseLeave?.(e);
        }
      },
      [controls, onMouseLeave]
    );

    const bodyVariants: Variants = {
      normal: { pathLength: 1, opacity: 1 },
      animate: (i: number) => ({
        pathLength: [0, 1],
        opacity: [0, 1],
        transition: {
          duration: 0.5 * duration,
          delay: i * 0.08 * duration,
          ease: [0.16, 1, 0.3, 1],
        },
      }),
    };

    const dropVariants: Variants = {
      normal: { y: 0 },
      animate: {
        y: [-6, 0],
        transition: { duration: 0.55 * duration, ease: [0.34, 1.5, 0.55, 1] },
      },
    };

    return (
      <LazyMotion features={domMin} strict>
        <m.div
          className={className}
          onMouseEnter={handleEnter}
          onMouseLeave={handleLeave}
          {...props}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            lineHeight: 1,
            color,
            ...style,
          }}
        >
          <m.svg
            xmlns="http://www.w3.org/2000/svg"
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            animate={controls}
            initial="normal"
          >
            <m.g variants={dropVariants}>
              <m.path
                d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"
                custom={0}
                variants={bodyVariants}
              />
              <m.path d="M12 17v5" custom={1} variants={bodyVariants} />
            </m.g>
          </m.svg>
        </m.div>
      </LazyMotion>
    );
  }
);

PinIcon.displayName = 'PinIcon';
