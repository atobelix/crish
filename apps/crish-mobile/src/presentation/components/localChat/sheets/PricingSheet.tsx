// 双行定价与币种配置底抽屉（PricingSheet）
// 权威依据：
// - docs/mobile-provider-architecture/analysis/01-prototype-ui-ux-spec.md §7.6
// - docs/mobile-provider-architecture/analysis/05-rn-components-and-gestures.md §5.6
// 支持结算币种（¥ CNY / $ USD）分段切换、输入价格 (Prompt) 与输出价格 (Completion) 双行独立卡片配置
// （单位 / 1M Tokens），采用原生小数键盘与触感反馈。
// 口径（P4）：未设置的单价以空串呈现，保存时不写字段——严禁用 1.00 / 2.00
// 之类的假默认在打开时存回去；输入非法时停在编辑页，不写半份、不关闭。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import type { LocalPricingSpec } from '@/adapters/localChat/providerPresets';
import { useTheme } from '@/adapters/platform/theme';
import { haptics } from '@/adapters/platform/haptics';
import { AppText, Button, Sheet } from '@/presentation/ui';
import { SegmentedBar, type SegmentedOption } from '../ui/SegmentedBar';

export type CurrencyType = 'CNY' | 'USD';

export const CURRENCY_OPTIONS: readonly SegmentedOption<CurrencyType>[] = [
  { key: 'CNY', label: '¥ CNY 人民币' },
  { key: 'USD', label: '$ USD 美元' },
] as const;

export interface PricingSheetProps {
  visible: boolean;
  onClose: () => void;
  pricing?: LocalPricingSpec;
  /** 两项单价都未设置且原本无定价时回传 undefined（保持未设置） */
  onApply: (pricing: LocalPricingSpec | undefined) => void;
  testID?: string;
}

/** 已设单价的初始文本；未设置为空串（不以 1.00/2.00 冒充已保存值） */
function priceToText(value: number | undefined): string {
  return value !== undefined ? String(value) : '';
}

export function PricingSheet({
  visible,
  onClose,
  pricing,
  onApply,
  testID = 'pricing-sheet',
}: PricingSheetProps) {
  const theme = useTheme();

  const [currency, setCurrency] = useState<CurrencyType>(
    pricing?.currency ?? 'CNY'
  );
  const [inputPrice, setInputPrice] = useState<string>(() =>
    priceToText(pricing?.input)
  );
  const [outputPrice, setOutputPrice] = useState<string>(() =>
    priceToText(pricing?.output)
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setCurrency(pricing?.currency ?? 'CNY');
      setInputPrice(priceToText(pricing?.input));
      setOutputPrice(priceToText(pricing?.output));
      setError(null);
    }
  }, [visible, pricing]);

  const handleCurrencyChange = useCallback((newCurrency: CurrencyType) => {
    setCurrency(newCurrency);
    haptics.selection();
  }, []);

  const handleApply = useCallback(() => {
    const parsePrice = (text: string): number | undefined | null => {
      const trimmed = text.trim();
      if (trimmed === '') return undefined; // 未设置：不写字段
      const parsed = parseFloat(trimmed);
      if (isNaN(parsed) || parsed < 0) return null; // 非法
      return parsed;
    };
    const nextInput = parsePrice(inputPrice);
    const nextOutput = parsePrice(outputPrice);
    if (nextInput === null || nextOutput === null) {
      // 校验失败：停在编辑页，不写半份、不关闭
      setError('单价需为不小于 0 的数字，留空表示未设置');
      return;
    }
    if (!pricing && nextInput === undefined && nextOutput === undefined) {
      // 原本就未设置且两项仍为空：保持未设置，不虚构定价对象
      onApply(undefined);
      onClose();
      haptics.selection();
      return;
    }
    const next: LocalPricingSpec = { ...(pricing ?? { currency }) };
    next.currency = currency;
    if (nextInput === undefined) delete next.input;
    else next.input = nextInput;
    if (nextOutput === undefined) delete next.output;
    else next.output = nextOutput;
    onApply(next);
    onClose();
    haptics.selection();
  }, [currency, inputPrice, outputPrice, pricing, onApply, onClose]);

  const currencySymbol = currency === 'CNY' ? '¥' : '$';

  const footerButton = useMemo(
    () => (
      <Button
        label="确定保存"
        variant="primary"
        onPress={handleApply}
        testID={`${testID}-apply-button`}
      />
    ),
    [handleApply, testID]
  );

  return (
    <Sheet
      keyboard="input"
      visible={visible}
      onClose={onClose}
      title="模型单价与计费"
      size="large"
      footer={footerButton}
      testID={testID}
    >
      <View style={styles.container}>
        <AppText
          variant="footnote"
          color="textTertiary"
          style={[styles.subtitle, { marginBottom: theme.space.lg }]}
        >
          设置每 100 万 (1M) Tokens 的输入与输出消耗价格
        </AppText>

        {/* 顶部币种切换栏 */}
        <View style={[styles.section, { marginBottom: theme.space.lg }]}>
          <AppText
            variant="sectionLabel"
            color="textSecondary"
            style={[styles.sectionTitle, { marginBottom: theme.space.xs }]}
          >
            结算币种
          </AppText>
          <SegmentedBar<CurrencyType>
            options={CURRENCY_OPTIONS}
            selectedKey={currency}
            onSelect={handleCurrencyChange}
            testID={`${testID}-currency-bar`}
          />
        </View>

        {/* 双行价格卡片堆栈 */}
        <View style={[styles.cardsStack, { gap: theme.space.md }]}>
          <PriceCard
            title="输入价格 (Prompt)"
            description="发送给模型的提示词与上下文"
            currencySymbol={currencySymbol}
            value={inputPrice}
            onChangeText={(text) => {
              setInputPrice(text);
              setError(null);
            }}
            placeholder="未设置"
            testID={`${testID}-input-price`}
          />
          <PriceCard
            title="输出价格 (Completion)"
            description="模型回答生成的 Token 消耗"
            currencySymbol={currencySymbol}
            value={outputPrice}
            onChangeText={(text) => {
              setOutputPrice(text);
              setError(null);
            }}
            placeholder="未设置"
            testID={`${testID}-output-price`}
          />
        </View>

        {error ? (
          <AppText
            variant="footnote"
            color="danger"
            testID={`${testID}-error`}
            style={{ marginTop: theme.space.md }}
          >
            {error}
          </AppText>
        ) : null}
      </View>
    </Sheet>
  );
}

export interface PriceCardProps {
  title: string;
  description: string;
  currencySymbol: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  testID?: string;
}

/** 单个价格配置卡片：标题、副说明与带币种前缀的纯净输入盒 */
export function PriceCard({
  title,
  description,
  currencySymbol,
  value,
  onChangeText,
  placeholder = '未设置',
  testID,
}: PriceCardProps) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);

  return (
    <View
      style={[
        styles.priceCard,
        {
          borderRadius: theme.radius.card,
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.hairline,
          padding: theme.space.md + theme.space.xxs,
        },
      ]}
    >
      <View style={styles.cardHeader}>
        <AppText variant="bodyStrong" color="textPrimary">
          {title}
        </AppText>
        <AppText
          variant="footnote"
          color="textTertiary"
          style={[styles.cardDescription, { marginTop: theme.space.xxs }]}
        >
          {description}
        </AppText>
      </View>

      <View
        style={[
          styles.inputContainer,
          {
            borderRadius: theme.radius.control,
            backgroundColor: focused
              ? theme.colors.fieldFocus
              : theme.colors.fillSubtle,
            borderColor: focused ? theme.colors.brand : theme.colors.hairline,
            marginTop: theme.space.sm,
            paddingHorizontal: theme.space.md,
          },
        ]}
      >
        <AppText
          variant="bodyStrong"
          color="textPrimary"
          style={[styles.currencyPrefix, { marginRight: theme.space.xs }]}
        >
          {currencySymbol}
        </AppText>
        <TextInput
          testID={testID}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.textDisabled}
          keyboardType="decimal-pad"
          inputMode="decimal"
          underlineColorAndroid="transparent"
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={[
            styles.textInput,
            theme.type.body,
            { color: theme.colors.textPrimary },
          ]}
        />
        <AppText
          variant="footnote"
          color="textTertiary"
          style={[styles.unitSuffix, { marginLeft: theme.space.xs }]}
        >
          / 1M
        </AppText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  subtitle: {
    paddingHorizontal: 2,
  },
  section: {
    width: '100%',
  },
  sectionTitle: {
    paddingHorizontal: 2,
  },
  cardsStack: {
    width: '100%',
  },
  priceCard: {
    width: '100%',
    borderWidth: StyleSheet.hairlineWidth,
  },
  cardHeader: {
    width: '100%',
  },
  cardDescription: {},
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 44,
    borderWidth: StyleSheet.hairlineWidth,
  },
  currencyPrefix: {
    minWidth: 16,
    textAlign: 'center',
  },
  textInput: {
    flex: 1,
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  unitSuffix: {
    paddingRight: 2,
  },
});
