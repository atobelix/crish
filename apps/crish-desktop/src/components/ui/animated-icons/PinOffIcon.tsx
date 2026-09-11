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
import { ICON_STROKE } from '../icons/iconTokens';

export interface PinOffIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

export interface PinOffIconProps extends Omit<
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

export const PinOffIcon = forwardRef<PinOffIconHandle, PinOffIconProps>(
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

    const slashVariants: Variants = {
      normal: { pathLength: 1, opacity: 1 },
      animate: {
        pathLength: [0, 1],
        opacity: [0, 1],
        transition: {
          duration: 0.35 * duration,
          delay: 0.55 * duration,
          ease: [0.16, 1, 0.3, 1],
        },
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
            strokeWidth={ICON_STROKE.ui}
            strokeLinecap="round"
            strokeLinejoin="round"
            animate={controls}
            initial="normal"
          >
            <m.path
              d="M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89"
              custom={0}
              variants={bodyVariants}
            />
            <m.path
              d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11"
              custom={0}
              variants={bodyVariants}
            />
            <m.path d="M12 17v5" custom={1} variants={bodyVariants} />
            <m.path d="m2 2 20 20" variants={slashVariants} />
          </m.svg>
        </m.div>
      </LazyMotion>
    );
  }
);

PinOffIcon.displayName = 'PinOffIcon';
