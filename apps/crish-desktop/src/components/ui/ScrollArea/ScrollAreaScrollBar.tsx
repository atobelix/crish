import React from 'react';
import styles from './ScrollArea.module.css';
import {
  StepperArrowUpIcon,
  StepperArrowDownIcon,
  StepperArrowLeftIcon,
  StepperArrowRightIcon,
} from './ScrollAreaHelpers';

export interface ScrollAreaScrollBarProps {
  orientation: 'vertical' | 'horizontal';
  visible: boolean;
  isDragging: boolean;
  trackMargin: number;
  insetStart: number;
  insetEnd: number;
  shouldRenderButtons: boolean;
  isAtStart: boolean;
  isAtEnd: boolean;
  thumbSizePx: number;
  thumbOffsetPx: number;
  thumbRef: React.RefObject<HTMLDivElement | null>;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  onButtonPointerDown: (
    dir: 'up' | 'down' | 'left' | 'right'
  ) => (e: React.PointerEvent<HTMLButtonElement>) => void;
  onButtonPointerUpOrLeave: (e: React.SyntheticEvent) => void;
}

export const ScrollAreaScrollBar: React.FC<ScrollAreaScrollBarProps> = ({
  orientation,
  visible,
  isDragging,
  trackMargin,
  insetStart,
  insetEnd,
  shouldRenderButtons,
  isAtStart,
  isAtEnd,
  thumbSizePx,
  thumbOffsetPx,
  thumbRef,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onButtonPointerDown,
  onButtonPointerUpOrLeave,
}) => {
  if (orientation === 'vertical') {
    return (
      <div
        className={`${styles.stepperTrackColumn} ${visible ? styles.visible : ''}`}
        style={{
          top: `${insetStart}px`,
          bottom: `${insetEnd}px`,
          right: `${trackMargin}px`,
        }}
        aria-hidden="true"
      >
        {shouldRenderButtons && (
          <>
            <button
              type="button"
              tabIndex={-1}
              className={`${styles.stepperButton} ${styles.upButton} ${isAtStart ? styles.disabled : ''}`}
              onPointerDown={onButtonPointerDown('up')}
              onPointerUp={onButtonPointerUpOrLeave}
              onPointerLeave={onButtonPointerUpOrLeave}
              onPointerCancel={onButtonPointerUpOrLeave}
              onBlur={onButtonPointerUpOrLeave}
              aria-label="Scroll Up"
            >
              <StepperArrowUpIcon className={styles.arrowIcon} />
            </button>
            <div className={styles.safeGap} />
          </>
        )}

        <div className={styles.isolatedTrack}>
          <div
            ref={thumbRef}
            className={`${styles.thumbIndicator} ${isDragging ? styles.dragging : ''}`}
            style={{
              height: `${thumbSizePx}px`,
              transform: `translate3d(0, ${thumbOffsetPx}px, 0)`,
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
        </div>

        {shouldRenderButtons && (
          <>
            <div className={styles.safeGap} />
            <button
              type="button"
              tabIndex={-1}
              className={`${styles.stepperButton} ${styles.downButton} ${isAtEnd ? styles.disabled : ''}`}
              onPointerDown={onButtonPointerDown('down')}
              onPointerUp={onButtonPointerUpOrLeave}
              onPointerLeave={onButtonPointerUpOrLeave}
              onPointerCancel={onButtonPointerUpOrLeave}
              onBlur={onButtonPointerUpOrLeave}
              aria-label="Scroll Down"
            >
              <StepperArrowDownIcon className={styles.arrowIcon} />
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <div
      className={`${styles.stepperTrackRow} ${visible ? styles.visible : ''}`}
      style={{
        bottom: `${trackMargin}px`,
        left: `${insetStart}px`,
        right: `${insetEnd}px`,
      }}
      aria-hidden="true"
    >
      {shouldRenderButtons && (
        <>
          <button
            type="button"
            tabIndex={-1}
            className={`${styles.stepperButton} ${styles.leftButton} ${isAtStart ? styles.disabled : ''}`}
            onPointerDown={onButtonPointerDown('left')}
            onPointerUp={onButtonPointerUpOrLeave}
            onPointerLeave={onButtonPointerUpOrLeave}
            onPointerCancel={onButtonPointerUpOrLeave}
            onBlur={onButtonPointerUpOrLeave}
            aria-label="Scroll Left"
          >
            <StepperArrowLeftIcon className={styles.arrowIcon} />
          </button>
          <div className={styles.safeGapHorizontal} />
        </>
      )}

      <div className={styles.isolatedTrackHorizontal}>
        <div
          ref={thumbRef}
          className={`${styles.thumbIndicatorHorizontal} ${isDragging ? styles.dragging : ''}`}
          style={{
            width: `${thumbSizePx}px`,
            transform: `translate3d(${thumbOffsetPx}px, 0, 0)`,
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      </div>

      {shouldRenderButtons && (
        <>
          <div className={styles.safeGapHorizontal} />
          <button
            type="button"
            tabIndex={-1}
            className={`${styles.stepperButton} ${styles.rightButton} ${isAtEnd ? styles.disabled : ''}`}
            onPointerDown={onButtonPointerDown('right')}
            onPointerUp={onButtonPointerUpOrLeave}
            onPointerLeave={onButtonPointerUpOrLeave}
            onPointerCancel={onButtonPointerUpOrLeave}
            onBlur={onButtonPointerUpOrLeave}
            aria-label="Scroll Right"
          >
            <StepperArrowRightIcon className={styles.arrowIcon} />
          </button>
        </>
      )}
    </div>
  );
};

ScrollAreaScrollBar.displayName = 'ScrollAreaScrollBar';
