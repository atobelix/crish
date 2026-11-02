// 本地对话界面：手机直连供应商的纯对话（与远程会话分开，不进远程列表）。
// 未配置时入口照常可用（空态引导去配置），不因远程未连接而置灰——
// 本地链路不依赖 RelaySocket / 宿主状态。
import { useEffect, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  View,
  type TextStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import type { LocalChatVm } from '@/adapters/viewmodels/useLocalChatVm';
import type { LocalChatMessage } from '@/domain/types/localChat';
import {
  AppHeader,
  AppText,
  Button,
  Composer,
  EmptyState,
  Screen,
} from '@/presentation/ui';
import { StreamingText } from '@/presentation/components/blocks/StreamingText';

export interface LocalChatViewProps {
  vm: LocalChatVm;
  onBack: () => void;
  onOpenProviders: () => void;
}

export default function LocalChatView({
  vm,
  onBack,
  onOpenProviders,
}: LocalChatViewProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [input, setInput] = useState('');
  const listRef = useRef<FlatList<LocalChatMessage>>(null);
  const lastMessage = vm.messages[vm.messages.length - 1];

  useEffect(() => {
    if (vm.messages.length > 0) {
      listRef.current?.scrollToEnd({ animated: true });
    }
  }, [vm.messages.length, lastMessage?.content]);

  const submit = () => {
    const text = input.trim();
    if (text === '' || vm.streaming) return;
    setInput('');
    vm.send(text);
  };

  return (
    <Screen style={{ backgroundColor: theme.colors.canvas }}>
      <AppHeader
        title="本地对话"
        onBack={onBack}
        floating
        actions={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="本地供应商设置"
            onPress={onOpenProviders}
            testID="local-chat-providers"
            style={styles.headerAction}
          >
            <AppText variant="footnote" color="textSecondary">
              {vm.activeLabel ?? '未配置'}
            </AppText>
          </Pressable>
        }
      />

      {vm.messages.length === 0 ? (
        <View
          style={[
            styles.emptyWrap,
            { paddingTop: insets.top + theme.size.touchLarge + theme.space.lg },
          ]}
        >
          {vm.configured ? (
            <>
              <EmptyState title="本地助手已就绪" compact />
              <AppText
                variant="footnote"
                color="textTertiary"
                style={styles.centerText}
              >
                {`当前使用 ${vm.activeLabel ?? ''}，直接在手机上对话，不经过电脑。`}
              </AppText>
            </>
          ) : (
            <>
              <EmptyState title="尚未配置本地供应商" compact />
              <AppText
                variant="footnote"
                color="textTertiary"
                style={styles.centerText}
              >
                添加你的 AI 供应商（OpenAI
                兼容接口）后，即使电脑离线，也能在手机上直接对话。
              </AppText>
              <Button
                label="去配置供应商"
                onPress={onOpenProviders}
                testID="local-chat-configure"
              />
            </>
          )}
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={[...vm.messages]}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{
            paddingHorizontal: theme.space.lg,
            paddingTop: insets.top + theme.size.touchLarge + theme.space.md,
            paddingBottom: theme.space.md,
            gap: theme.space.md,
          }}
          renderItem={({ item }) => <MessageRow message={item} />}
        />
      )}

      {vm.error ? (
        <View
          testID="local-chat-error"
          style={[
            styles.errorBar,
            {
              backgroundColor: theme.colors.dangerSoft,
              marginHorizontal: theme.space.lg,
              borderRadius: theme.radius.menu,
              paddingHorizontal: theme.space.md,
              paddingVertical: theme.space.sm,
            },
          ]}
        >
          <AppText variant="footnote" color="danger" style={styles.flex}>
            {vm.error.message}
            {vm.error.detail ? `\n${vm.error.detail}` : ''}
          </AppText>
          <AppText
            variant="footnote"
            color="textSecondary"
            onPress={vm.dismissError}
          >
            关闭
          </AppText>
        </View>
      ) : null}

      <View
        style={{
          paddingHorizontal: theme.space.sm,
          paddingBottom: Math.max(insets.bottom, theme.space.sm),
          gap: theme.space.sm,
        }}
      >
        {vm.streaming ? (
          <Pressable
            testID="local-chat-stop"
            accessibilityRole="button"
            accessibilityLabel="停止生成"
            onPress={vm.stop}
            style={[
              styles.stopPill,
              {
                backgroundColor: theme.colors.surfaceGrouped,
                borderRadius: theme.radius.pill,
                paddingHorizontal: theme.space.lg,
                paddingVertical: theme.space.sm,
              },
            ]}
          >
            <AppText variant="footnote" color="textPrimary">
              停止生成
            </AppText>
          </Pressable>
        ) : null}
        {vm.messages.length > 0 && !vm.streaming ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="清空对话"
            onPress={vm.clearThread}
            style={styles.stopPill}
          >
            <AppText variant="caption" color="textTertiary">
              清空对话
            </AppText>
          </Pressable>
        ) : null}
        <Composer
          testID="local-chat-composer"
          value={input}
          onChangeText={setInput}
          onSubmit={submit}
          canSubmit={input.trim() !== '' && !vm.streaming}
          editable={!vm.streaming}
          placeholder={
            vm.configured ? '发消息给本地助手…' : '先配置供应商后即可发送'
          }
        />
      </View>
    </Screen>
  );
}

function MessageRow({ message }: { message: LocalChatMessage }) {
  const theme = useTheme();
  if (message.role === 'user') {
    return (
      <View style={styles.userRow}>
        <View
          style={[
            styles.userBubble,
            {
              backgroundColor: theme.colors.brandSoft,
              borderRadius: theme.radius.card,
              paddingHorizontal: theme.space.md + 2,
              paddingVertical: theme.space.sm + 2,
            },
          ]}
        >
          <AppText variant="body">{message.content}</AppText>
        </View>
      </View>
    );
  }
  const textStyle: TextStyle = {
    fontSize: theme.type.body.fontSize,
    lineHeight: theme.type.body.lineHeight,
    color: theme.colors.textPrimary,
  };
  return (
    <View style={styles.assistantRow}>
      {message.content === '' && message.streaming ? (
        <AppText variant="body" color="textTertiary">
          思考中…
        </AppText>
      ) : (
        <StreamingText
          text={message.content}
          streaming={message.streaming === true}
          identity={message.id}
          style={textStyle}
        />
      )}
      {message.stopped ? (
        <AppText variant="caption" color="textTertiary">
          已停止生成
        </AppText>
      ) : null}
      {message.toolCallCount !== undefined && message.toolCallCount > 0 ? (
        <AppText variant="caption" color="textTertiary">
          模型尝试调用 {message.toolCallCount}{' '}
          个工具，本地对话不执行工具，已忽略。
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  headerAction: { paddingHorizontal: 4, paddingVertical: 4 },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    paddingHorizontal: 24,
  },
  centerText: { textAlign: 'center' },
  errorBar: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  stopPill: { alignSelf: 'center' },
  userRow: { flexDirection: 'row', justifyContent: 'flex-end' },
  userBubble: { maxWidth: '82%' },
  assistantRow: { gap: 4, paddingRight: 24 },
  flex: { flex: 1 },
});
