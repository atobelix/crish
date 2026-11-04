/**
 * apps/crish-desktop/src/services/desktopNotificationText.ts
 *
 * 桌面通知的文案解析（自 desktopNotificationObserver 抽出）：失败正文经
 * 失败分类表出文案（原始错误串不进通知面），会话标题解析与正文裁剪。
 */
import { presentFailure } from '../api/userFacingErrors';
import { t } from '../i18n';
import { getSessionStoreState } from '../store/sessionStore';

/** 通知正文裁剪上限（超出以省略号收尾） */
const BODY_CLIP = 160;

/** 正文裁剪：超出上限以省略号收尾 */
export function clip(text: string): string {
  if (text.length <= BODY_CLIP) return text;
  return `${text.slice(0, BODY_CLIP)}…`;
}

/**
 * 失败正文（反馈路由宪法 §3）：后端原始错误串永不内联到通知面——
 * 能经分类表命中的出家族一句话说明；不能命中的回落「会话名失败/
 * 通用失败」文案。原始串只留日志与用户主动打开的详情。
 */
export function failureBodyText(
  error: string | undefined,
  sessionTitle: string | undefined
): string {
  if (error) {
    const presentation = presentFailure(error);
    if (presentation) return clip(presentation.guidance);
  }
  return sessionTitle
    ? t('settings.notification.content.namedFailed', {
        name: sessionTitle,
      })
    : t('settings.notification.content.runFailed');
}

export function resolveSessionTitle(sessionId?: string): string | undefined {
  if (!sessionId) return undefined;
  try {
    const title = getSessionStoreState().sessionsById[sessionId]?.title;
    const trimmed = typeof title === 'string' ? title.trim() : '';
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}
