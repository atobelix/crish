// 改名输入弹窗（G3 新增的最小输入型弹窗：Dialog 壳 + Input 单文本框 +
// 取消/确定；App 此前无输入型弹窗——M4 已登记此缺口）。
// 视觉走 M4 已对齐的 Dialog 数值（遮罩/卡片/动作行均由 Dialog 壳提供，
// 本组件只填内容槽）。标题规范化在宿主侧（与桌面改名同口径：清洗/折叠/
// 截断），本弹窗只做空值门禁（纯空白不可提交），不预演清洗结果。
import { useEffect, useState } from 'react';
import { Dialog, Input } from '@/presentation/ui';

export interface RenameSessionDialogProps {
  visible: boolean;
  /** 打开时的当前标题（每次打开重置输入） */
  initialTitle: string;
  /** 宿主返回的错误文案（如清洗后为空/会话不存在时在弹窗内呈现，不丢输入） */
  error?: string | null;
  submitting?: boolean;
  onCancel: () => void;
  onSubmit: (title: string) => void;
  testID?: string;
}

export function RenameSessionDialog({
  visible,
  initialTitle,
  error = null,
  submitting = false,
  onCancel,
  onSubmit,
  testID = 'rename-session-dialog',
}: RenameSessionDialogProps) {
  const [text, setText] = useState(initialTitle);
  useEffect(() => {
    if (visible) setText(initialTitle);
  }, [visible, initialTitle]);

  const canSubmit = text.trim().length > 0 && !submitting;
  const submit = () => {
    if (canSubmit) onSubmit(text);
  };

  return (
    <Dialog
      visible={visible}
      title="重命名会话"
      onDismiss={onCancel}
      testID={testID}
      actions={[
        {
          label: '取消',
          variant: 'ghost',
          onPress: onCancel,
          testID: `${testID}-cancel`,
        },
        {
          label: submitting ? '保存中…' : '保存',
          variant: 'primary',
          onPress: submit,
          testID: `${testID}-submit`,
        },
      ]}
    >
      <Input
        testID={`${testID}-input`}
        value={text}
        onChangeText={setText}
        placeholder="会话标题"
        autoFocus
        editable={!submitting}
        error={error ?? undefined}
        returnKeyType="done"
        onSubmitEditing={submit}
      />
    </Dialog>
  );
}

export default RenameSessionDialog;
