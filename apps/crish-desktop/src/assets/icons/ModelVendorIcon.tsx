import React from 'react';
import { Tooltip } from '../../components/ui';
import { resolveModelVendor } from './modelVendorCatalog';
import { MODEL_VENDOR_ICONS } from './modelVendorIcons';
import { ModelVendorFallback } from './ModelVendorFallback';
import { useI18n } from '../../i18n';

export interface ModelVendorIconProps {
  /** 模型标识、厂商 ID 或带组织前缀的模型路径（如 'deepseek-ai/DeepSeek-V3', 'claude-3-5-sonnet', 'openai'） */
  modelOrVendor?: string | null;
  /** 显示尺寸（宽高像素），默认为 20 */
  size?: number;
  /** 圆角半径（像素），未传时按 25% 比例自适应（如 20px 对应 5px） */
  radius?: number;
  /** 悬停提示文字，未传时自动使用厂商标准名称或模型名 */
  title?: string;
  /** 附加 className */
  className?: string;
  /** 附加内联样式 */
  style?: React.CSSProperties;
}

/**
 * ModelVendorIcon — 统一 AI 模型厂商方形原彩图标组件
 *
 * 设计原则：
 * 1. 方形原彩：已收录厂商呈现【官方主色底板 + 黄金比例居中官方矢量】；
 * 2. 桌面软件兜底：未收录或私有模型自动降级为【桌面自身官方原彩 App 图标】；
 * 3. 极简轻量：纯静态矢量，零网络请求，零额外依赖，尺寸无损缩放。
 */
export const ModelVendorIcon: React.FC<ModelVendorIconProps> = ({
  modelOrVendor,
  size = 20,
  radius,
  title,
  className = '',
  style = {},
}) => {
  const { t } = useI18n();
  const vendorMeta = resolveModelVendor(modelOrVendor);
  const iconEntry = vendorMeta ? MODEL_VENDOR_ICONS[vendorMeta.id] : undefined;

  // 圆角自适应（默认 25% 视觉比例）
  const computedRadius =
    radius !== undefined ? radius : Math.max(3, Math.round(size * 0.25));
  const vendorName = vendorMeta?.nameKey
    ? t(vendorMeta.nameKey, vendorMeta.name)
    : vendorMeta?.name;
  const finalTitle =
    title || vendorName || modelOrVendor || '本地 / 自定义模型';

  // 1. 若未能识别厂商，或无对应矢量数据，自动平稳降级为桌面软件官方 App 图标
  if (!vendorMeta || !iconEntry) {
    return (
      <ModelVendorFallback
        size={size}
        radius={computedRadius}
        title={finalTitle}
        className={className}
        style={style}
      />
    );
  }

  // 2. 渲染官方方形原彩图标
  // 内部标志通常采用约 60%~65% 黄金比例居中内缩
  const innerSize = Math.max(10, Math.round(size * 0.62));

  const element = (
    <div
      className={`model-vendor-icon ${className}`.trim()}
      style={{
        width: size,
        height: size,
        borderRadius: computedRadius,
        backgroundColor: iconEntry.bg,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        overflow: 'hidden',
        userSelect: 'none',
        boxSizing: 'border-box',
        boxShadow: '0 1px 2px rgba(0, 0, 0, 0.2)',
        ...style,
      }}
      role="img"
      aria-label={finalTitle}
    >
      <svg
        width={innerSize}
        height={innerSize}
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
        style={{ display: 'block' }}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: iconEntry.innerHtml }}
      />
    </div>
  );

  if (!finalTitle) {
    return element;
  }

  return <Tooltip content={finalTitle}>{element}</Tooltip>;
};
