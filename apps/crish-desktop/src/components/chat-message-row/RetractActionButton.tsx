import React from 'react';
import { Undo2 } from 'lucide-react';
import { Button, Tooltip } from '../ui';
import styles from './ChatMessageRow.module.css';

/** 消息流撤回：ghost + 7px，不走 composer 页脚。流式中同样可点。 */
export function RetractActionButton({ onRetract }: { onRetract: () => void }) {
  return (
    <Tooltip content="撤回上一条（还原文件 + 截断时间线 + 回填文本）">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={`${styles.iconBtn} ${styles.retractBtn}`}
        data-testid="message-retract"
        aria-label="撤回上一条用户消息"
        onClick={onRetract}
        icon={<Undo2 size={14} aria-hidden />}
      />
    </Tooltip>
  );
}
