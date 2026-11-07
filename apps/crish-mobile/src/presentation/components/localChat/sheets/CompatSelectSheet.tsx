// 高级组单选底抽屉（CompatSelectSheet）：模型级 compat 三项共用。
// 每项一个选择：首行恒为「跟随供应商」（= 该字段未设置 undefined），
// 其余为该字段的枚举值。只编辑调用方给定的那一个字段。选择型
// Sheet（keyboard="none"），行样式与 ThinkingConfigSheet 同用 SheetOptionRow。
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { haptics } from '@/adapters/platform/haptics';
import { AppText, Button, Sheet, SheetOptionRow } from '@/presentation/ui';

export interface CompatOption {
  key: string;
  label: string;
}

export interface CompatSelectSheetProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  options: readonly CompatOption[];
  /** 当前值；undefined = 跟随供应商 */
  selectedKey: string | undefined;
  /** 回传 undefined 表示改为「跟随供应商」（删除模型级覆盖） */
  onApply: (key: string | undefined) => void;
  testID?: string;
}

export function CompatSelectSheet({
  visible,
  onClose,
  title,
  subtitle,
  options,
  selectedKey,
  onApply,
  testID = 'compat-select-sheet',
}: CompatSelectSheetProps) {
  const theme = useTheme();
  const [draftKey, setDraftKey] = useState<string | undefined>(selectedKey);

  useEffect(() => {
    if (visible) {
      setDraftKey(selectedKey);
    }
  }, [visible, selectedKey]);

  const handleSelect = (key: string | undefined) => {
    setDraftKey(key);
    haptics.selection();
  };

  const handleApply = () => {
    onApply(draftKey);
    onClose();
  };

  return (
    <Sheet
      keyboard="none"
      visible={visible}
      onClose={onClose}
      title={title}
      size="large"
      testID={testID}
      footer={
        <Button
          testID={`${testID}-apply`}
          label="确定保存"
          variant="primary"
          onPress={handleApply}
        />
      }
    >
      <View style={styles.container}>
        {subtitle ? (
          <AppText
            variant="footnote"
            color="textSecondary"
            style={[styles.subtitle, { marginBottom: theme.space.md }]}
          >
            {subtitle}
          </AppText>
        ) : null}
        <View style={{ gap: theme.space.sm }}>
          <SheetOptionRow
            testID={`${testID}-option-follow`}
            label="跟随供应商"
            selected={draftKey === undefined}
            onPress={() => handleSelect(undefined)}
          />
          {options.map((opt) => (
            <SheetOptionRow
              key={opt.key}
              testID={`${testID}-option-${opt.key}`}
              label={opt.label}
              selected={draftKey === opt.key}
              onPress={() => handleSelect(opt.key)}
            />
          ))}
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  container: {
    alignSelf: 'stretch',
  },
  subtitle: {
    paddingHorizontal: 2,
  },
});

export default CompatSelectSheet;
