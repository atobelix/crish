// 设置分组容器（F6 §12.1：分组标题小号灰字，与桌面 SettingsUI Section 分层对齐）
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAppTheme } from '@/adapters/settings/themeProjection';

export interface SettingsGroupProps {
  /** 分组标题（如 通用 / 通知偏好 / 文件 / 关于） */
  title: string;
  children: ReactNode;
}

/** 设置分组：标题 + 卡片容器（bgCard 底 + hairline 描边，M4 §3.2 token） */
export default function SettingsGroup({ title, children }: SettingsGroupProps) {
  const theme = useAppTheme();
  return (
    <View style={styles.group}>
      <Text style={[styles.title, { color: theme.textTertiary }]}>{title}</Text>
      <View
        style={[
          styles.card,
          { backgroundColor: theme.bgCard, borderColor: theme.hairline },
        ]}
      >
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    marginBottom: 20,
    gap: 8,
  },
  title: {
    fontSize: 12,
    fontWeight: '500',
    paddingHorizontal: 4,
  },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
});
