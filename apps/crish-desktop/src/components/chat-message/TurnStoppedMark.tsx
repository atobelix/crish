/**
 * apps/crish-desktop/src/components/chat-message/TurnStoppedMark.tsx
 *
 * 批 B ㉖「已停止」安静行：用户主动停止且无正文的轮次的唯一呈现
 * （居中灰字 polite 档；停止非失败，不用 interruptedMark 的错误形态、
 * 无按钮无详情）。文案走 i18n 字典（chat.message.turnStopped）。
 * 呈现门控在 MessageContent 分支 α（stoppedByUser 且零可渲染内容）。
 */

import React from 'react';
import { useI18n } from '../../i18n/useI18n';
import styles from './MessageContent.module.css';

export const TurnStoppedMark: React.FC = () => {
  const { t } = useI18n();
  return (
    <div className={styles.stoppedMark} data-testid="turn-stopped-mark">
      {t('chat.message.turnStopped')}
    </div>
  );
};
