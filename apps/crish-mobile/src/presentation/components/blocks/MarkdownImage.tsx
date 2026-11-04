// markdown / 消息级图片真加载（批 E，2026-11-03；核查 ㉚ / FN-3)：
// - 真实加载渲染，maxHeight 走 theme.layout.imageMaxHeight(320)、contain；
// - 宽高比以图片自然尺寸为准：数据面（消息 image 块投影 / markdown 语法）
//   均无宽高字段，自然尺寸只能在加载完成时由 onLoad 取得——取得前用回落
//   画幅占位（回落值 4/3 = FN-3 前的恒定值，仅作无尺寸信息时的占位口径，
//   取得自然尺寸后立即替换，不再恒定 4/3)；
// - 加载失败诚实回落占位行（图片标 + alt)，不假装加载成功。
import { useEffect, useState } from 'react';
import { Image, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Icon } from '@/presentation/ui';

/** 无尺寸信息时的占位回落画幅（FN-3 登记口径，见文件头） */
const FALLBACK_ASPECT_RATIO = 4 / 3;

export interface MarkdownImageProps {
  source: string;
  alt: string;
  testID?: string;
  /** 加载失败占位行的 testID（缺省不设） */
  placeholderTestID?: string;
}

export function MarkdownImage({
  source,
  alt,
  testID,
  placeholderTestID,
}: MarkdownImageProps) {
  const theme = useTheme();
  const [aspectRatio, setAspectRatio] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  // 来源变化（列表回收复用）时复位几何与失败态
  useEffect(() => {
    setAspectRatio(null);
    setFailed(false);
  }, [source]);

  if (failed) {
    return (
      <View
        testID={placeholderTestID}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.space.sm,
          padding: theme.space.md,
          borderRadius: theme.radius.control,
          backgroundColor: theme.colors.fillSubtle,
        }}
      >
        <Icon
          name="image"
          size={theme.size.iconSmall}
          color={theme.colors.textTertiary}
        />
        <AppText variant="footnote" color="textTertiary">
          {alt !== '' ? alt : '图片'}
        </AppText>
      </View>
    );
  }

  return (
    <Image
      testID={testID}
      source={{ uri: source }}
      resizeMode="contain"
      accessibilityLabel={alt !== '' ? alt : '图片'}
      onLoad={(event) => {
        const { width, height } = event.nativeEvent.source;
        if (width > 0 && height > 0) setAspectRatio(width / height);
      }}
      onError={() => setFailed(true)}
      style={{
        width: '100%',
        aspectRatio: aspectRatio ?? FALLBACK_ASPECT_RATIO,
        maxHeight: theme.layout.imageMaxHeight,
        borderRadius: theme.radius.control,
        backgroundColor: theme.colors.fillSubtle,
      }}
    />
  );
}

export default MarkdownImage;
