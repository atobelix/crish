// 配对随机源装配（release 独立包随机源修复，2026-11-02 实测发现）：
// DEF-3 的环境探测链在 **release 独立包（Hermes + 无 expo-crypto 原生模块）**
// 下两端全空——globalThis.crypto 不存在（RN 不内置）、globalThis.expo.modules.
// ExpoCrypto 只在 Expo Go 存在（独立包未装 expo-crypto 时探测必失败）——
// 「连接」点击触发 X25519 密钥协商即整包崩溃（模拟器 API34 release 实测
// FATAL，真机 release 同样会崩；此前配对只在 Expo Go 验证过，独有缺口）。
// 修复：安装 expo-crypto（官方原生 JSI CSPRNG，autolink 零手工接线）并在
// 配对装配点（ensurePairingWiringForApp）显式注入——不再依赖环境探测运气。
// 注入用惰性 require + try：jest / 无原生环境（expo-crypto JS 入口
// requireNativeModule 抛错）静默跳过，保留 noblePrimitives 的环境探测链兜底。
import { configureRandomSource } from './noblePrimitives';

/** 安装 App 侧随机源（幂等；失败静默保留默认链，见文件头） */
export function installAppRandomSource(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ExpoCrypto = require('expo-crypto') as {
      getRandomValues?: (array: Uint8Array) => void;
    };
    if (typeof ExpoCrypto.getRandomValues !== 'function') return;
    configureRandomSource((bytes: number): Uint8Array => {
      const out = new Uint8Array(bytes);
      ExpoCrypto.getRandomValues!(out);
      return out;
    });
  } catch {
    // jest / 无原生模块环境：不覆盖注入，环境探测链（Node crypto / 测试注入）继续生效
  }
}
