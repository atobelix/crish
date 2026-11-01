// 平台剪贴板适配（账号 UID 复制等）：
// - 仓内移动端无 expo-clipboard / @react-native-clipboard 依赖（已核查
//   package.json 与 node_modules 均无）；RN 0.86 core 仍提供 Clipboard
//   （已标记弃用、带 clipboard-moved 迁出提示，但在当前 RN 版本内可用），
//   是仓内现存的唯一原生剪贴板能力，故经本适配收口使用；
// - shared-utils 的 copyTextToClipboard 是 Web 实现（navigator/document），
//   原生侧恒失败，不在此复用；
// - 后续引入 expo-clipboard 时只换本文件实现，调用面不变。
import { Clipboard } from 'react-native';

/** 写入系统剪贴板（成功 true；空串/原生异常 false，不抛错冒泡） */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    Clipboard.setString(text);
    return true;
  } catch {
    return false;
  }
}
