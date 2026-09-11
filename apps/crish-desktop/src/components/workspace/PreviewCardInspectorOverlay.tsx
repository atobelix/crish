import React from 'react';
import styles from './PreviewCard.module.css';
import { Button, Tooltip } from '../ui';
import {
  buildInspectorElementLabel,
  hasInspectorComputedStyles,
} from './previewCardLib';
import type {
  InspectHoverPayload,
  InspectSelectPayload,
} from './previewProtocol';
import { AppIcon } from '../ui/icons/index';

export interface PreviewCardInspectorOverlayProps {
  isInspectorActive: boolean;
  hoverElement: InspectHoverPayload | null;
  selectedElement: InspectSelectPayload | null;
  onCopySelector: () => void;
  onCopyHtml: () => void;
  onSendToAi: () => void;
  onClearSelected: () => void;
}

export const PreviewCardInspectorOverlay: React.FC<PreviewCardInspectorOverlayProps> = ({
  isInspectorActive,
  hoverElement,
  selectedElement,
  onCopySelector,
  onCopyHtml,
  onSendToAi,
  onClearSelected,
}) => {
  return (
    <>
      {hoverElement && isInspectorActive ? (
        <div
          className={styles.inspectorHover}
          data-inspector-hover=""
          style={{
            left: hoverElement.rect.x,
            top: hoverElement.rect.y,
            width: hoverElement.rect.width,
            height: hoverElement.rect.height,
          }}
          aria-hidden
        >
          <span className={styles.inspectorHoverTag}>
            <code>{hoverElement.tagName}</code>
            {hoverElement.selector ? <em>{hoverElement.selector}</em> : null}
          </span>
        </div>
      ) : null}

      {selectedElement ? (
        <div
          className={styles.inspectorBadge}
          role="status"
          aria-label="DOM 拾取结果"
        >
          <div className={styles.inspectorResultText}>
            <AppIcon name="scan-search" size={13}
              className={styles.inspectorResultIcon}
              aria-hidden />
            <span>已拾取 DOM 元素：</span>
            <code className={styles.inspectorCode}>
              {`<${buildInspectorElementLabel(
                selectedElement.tagName,
                selectedElement.id,
                selectedElement.classes
              )}>`}
            </code>
            {selectedElement.bestSelector ? (
              <span className={styles.inspectorSelector}>
                ({selectedElement.bestSelector})
              </span>
            ) : null}
            <span className={styles.inspectorDim}>
              {Math.round(selectedElement.rect.width)}×
              {Math.round(selectedElement.rect.height)}
            </span>
          </div>
          {hasInspectorComputedStyles(selectedElement) ? (
            <div className={styles.inspectorDetail}>
              <code>display: {selectedElement.computedStyles.display}</code>
              <code>position: {selectedElement.computedStyles.position}</code>
              <code>font-size: {selectedElement.computedStyles.fontSize}</code>
            </div>
          ) : null}
          <div className={styles.inspectorActions}>
            <Tooltip content="复制选择器">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={styles.inspectorActionBtn}
                onClick={onCopySelector}
                aria-label="复制选择器"
                icon={<AppIcon name="copy" size={12} />}
              />
            </Tooltip>
            <Tooltip content="复制 HTML 片段">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={styles.inspectorActionBtn}
                onClick={onCopyHtml}
                aria-label="复制 HTML 片段"
                icon={<AppIcon name="code" size={12} />}
              />
            </Tooltip>
            <Tooltip content="发送到 AI">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={styles.inspectorActionBtn}
                onClick={onSendToAi}
                aria-label="发送到 AI"
                icon={<AppIcon name="send" size={12} />}
              />
            </Tooltip>
            <Tooltip content="清除">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={styles.inspectorActionBtn}
                onClick={onClearSelected}
                aria-label="清除拾取结果"
                icon={<AppIcon name="x" size={12} />}
              />
            </Tooltip>
          </div>
        </div>
      ) : null}
    </>
  );
};
