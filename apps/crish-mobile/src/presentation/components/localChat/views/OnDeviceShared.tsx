// 本机模型页面共享件（L2）：分组卡形态、IA 状态词与删除确认文案的
// 单一出口——首页/已安装/模型库/详情/下载任务/存储六面共用，避免
// 各页各写一套状态词而漂移（IA §3.4 的状态词表为唯一口径）。
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import type { OnDeviceModelState } from '@/adapters/onDevice/onDeviceModelManager';
import { AppText } from '@/presentation/ui';

/** 分组卡（设置子页同形态：sectionLabel + surfaceGrouped 圆角卡） */
export function OnDeviceGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space.xs + 2 }}>
      <AppText
        variant="sectionLabel"
        color="textTertiary"
        style={{
          paddingHorizontal: theme.space.xs + 2,
          fontWeight: '500',
          letterSpacing: -(theme.type.sectionLabel.letterSpacing ?? 0),
        }}
      >
        {label}
      </AppText>
      <View
        style={{
          borderRadius: theme.radius.card,
          backgroundColor: theme.colors.surfaceGrouped,
          overflow: 'hidden',
        }}
      >
        {children}
      </View>
    </View>
  );
}

/**
 * IA §3.4 状态词（已安装/详情/下载任务共用）：只用已校验、待校验、
 * 未完成、下载中、校验中、失败、已暂停（无暂停实现，永不产出）、
 * 当前已加载。「未下载」只属于磁盘零字节的 missing——占用大于 0
 * 的行在状态机层就不可能是 missing，词与事实天然对齐。
 */
export function onDeviceIaStatusText(
  state: OnDeviceModelState | null,
  loaded: boolean
): string {
  if (state === null) return '读取中';
  switch (state.kind) {
    case 'ready':
      return loaded ? '当前已加载' : '已校验';
    case 'unverified':
      return '待校验';
    case 'partial':
      return '未完成';
    case 'downloading':
      return '下载中';
    case 'verifying':
      return '校验中';
    case 'error':
      return '失败';
    case 'cancelling':
      return '取消中';
    case 'cancelled':
      return '已取消';
    case 'missing':
      return '未下载';
  }
}

/**
 * 删除确认文案按状态分（IA §3.4）：未完成说明进度不能恢复；已加载
 * 说明先释放；是默认时说明默认变未设置、不会自动改投别处。占用
 * 一律用 usageBytes 的文案（真实占用），不用目录 size。
 */
export function onDeviceDeleteConfirmText(input: {
  name: string;
  state: OnDeviceModelState | null;
  usageText: string;
  loaded: boolean;
  isDefault: boolean;
}): string {
  const { name, state, usageText, loaded, isDefault } = input;
  if (state?.kind === 'partial') {
    return `删除 ${name} 的未完成文件（${usageText}）？进度不能恢复。`;
  }
  if (loaded) {
    return `${name} 当前已加载，删除前会先释放。确定删除并释放 ${usageText} 空间？`;
  }
  if (isDefault) {
    return `删除 ${name} 后，默认模型变为未设置，不会自动改用云端或其他模型。确定删除并释放 ${usageText} 空间？`;
  }
  return `确定删除 ${name} 并释放 ${usageText} 空间？`;
}
