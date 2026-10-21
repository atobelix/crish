/**
 * 目标命令只是一枚输入胶囊，展示名不带斜杠。
 * 展示名走 i18n（composer.goalChipLabel），发给模型的正文仍走命令标识，
 * 不使用这里的展示名。
 */
import { t } from '../../i18n';

export function isGoalCommand(value: string | null | undefined): boolean {
  if (!value) return false;
  const bare = value
    .trim()
    .replace(/^host-/, '')
    .replace(/^\//, '')
    .toLowerCase();
  return bare === 'goal';
}

export function goalCommandDisplayLabel(): string {
  return t('chat.goalChipLabel');
}
