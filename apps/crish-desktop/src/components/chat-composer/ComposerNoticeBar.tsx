/**
 * ComposerNoticeBar: 兼容转发层（P6 · T6-2）
 *
 * 物理实现已收敛至 ComposerEmbeddedNotice（输入坞内嵌顶槽），
 * 保留本文件导出签名以确保域外历史引用零编译断链。
 */

import {
  ComposerEmbeddedNotice,
  type ComposerEmbeddedNoticeProps,
} from './ComposerEmbeddedNotice';

export type {
  ComposerNotice,
  ComposerNoticeAction,
  ComposerNoticeSeverity,
  ComposerNoticeLegacyType,
  ComposerNoticePlacement,
  ComposerNoticeSourceId,
} from './composerNoticeTypes';

export type ComposerNoticeBarProps = ComposerEmbeddedNoticeProps;

export const ComposerNoticeBar = ComposerEmbeddedNotice;

export default ComposerNoticeBar;
