import React, { memo } from 'react';
import { Tooltip } from '../settings/SettingsUI';

interface MessageWindowControlsProps {
  hasOlder: boolean;
  olderStep: number;
  hiddenCount: number;
  offerShowAllOlder: boolean;
  onExpandOlderStep: () => void;
  onExpandOlderAll: () => void;
}

const MessageWindowControlsInner: React.FC<MessageWindowControlsProps> = ({
  hasOlder,
  olderStep,
  hiddenCount,
  offerShowAllOlder,
  onExpandOlderStep,
  onExpandOlderAll,
}) => {
  if (!hasOlder || olderStep <= 0) return null;

  const olderAria = `显示更早的 ${olderStep} 条消息，当前仍有 ${hiddenCount} 条未显示`;
  const showAllAria = `一次展开全部 ${hiddenCount} 条更早消息`;

  return (
    <div className="chat-msg-window-older" role="region" aria-label="更早消息">
      <div className="chat-msg-window-older-actions">
        <Tooltip content={olderAria}>
          <button
            type="button"
            className="chat-msg-window-older-btn"
            onClick={onExpandOlderStep}
            aria-label={olderAria}
          >
            显示更早的 {olderStep} 条
            <span className="chat-msg-window-older-meta" aria-hidden="true">
              （另有 {hiddenCount} 条未显示）
            </span>
          </button>
        </Tooltip>
        {offerShowAllOlder ? (
          <Tooltip content={showAllAria}>
            <button
              type="button"
              className="chat-msg-window-older-btn chat-msg-window-older-btn--all"
              onClick={onExpandOlderAll}
              aria-label={showAllAria}
            >
              全部展开
              <span className="chat-msg-window-older-meta" aria-hidden="true">
                （{hiddenCount} 条）
              </span>
            </button>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
};

export const MessageWindowControls = memo(MessageWindowControlsInner);
MessageWindowControls.displayName = 'MessageWindowControls';
