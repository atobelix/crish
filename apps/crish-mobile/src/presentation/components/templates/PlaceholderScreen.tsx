import { StyleSheet, Text, View } from 'react-native';

export interface PlaceholderScreenProps {
  title: string;
  description?: string;
}

// 页面占位模板（M4 §2.3 templates/）：骨架期统一占位形态，功能落地后由真实页面替换
export default function PlaceholderScreen({
  title,
  description,
}: PlaceholderScreenProps) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{title}</Text>
      {description ? (
        <Text style={styles.description}>{description}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 8,
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
  },
  description: {
    fontSize: 13,
    color: '#555555',
    textAlign: 'center',
    lineHeight: 20,
  },
});
