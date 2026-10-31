// Android 用户 CA 信任配置插件（实现波总方案 D15/H2：Debug/Release 源集物理隔离）。
// Android 7+ 默认不信任用户安装的 CA；桌面端使用自签 CA，因此显式开启
// user trust anchor，让手机安装桌面证书后 wss 握手可通过系统信任链。
// 仍只信任系统 + 用户 CA，不关闭主机名校验。
//
// 明文口径（R02 DEF-03 修复）：
// - main 源集（随 Release 出包）：cleartextTrafficPermitted="false"——业务通道
//   固定 wss，代码中不存在明文端点，生产安装包全局禁止明文流量；
// - debug 源集（仅开发构建）：单独配置放行明文，供 Metro/adb reverse 调试加载。
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const MAIN_NETWORK_SECURITY_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false">
        <trust-anchors>
            <certificates src="system" />
            <certificates src="user" />
        </trust-anchors>
    </base-config>
</network-security-config>
`;

const DEBUG_NETWORK_SECURITY_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
            <certificates src="user" />
        </trust-anchors>
    </base-config>
</network-security-config>
`;

function withAndroidNetworkSecurityConfig(config) {
  config = withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0];
    if (application) {
      application.$ = application.$ ?? {};
      application.$['android:networkSecurityConfig'] =
        '@xml/network_security_config';
    }
    return config;
  });

  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const resRoot = path.join(
        config.modRequest.platformProjectRoot,
        'app',
        'src'
      );
      // main：生产基线（禁止明文）
      const mainXmlDir = path.join(resRoot, 'main', 'res', 'xml');
      await fs.promises.mkdir(mainXmlDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(mainXmlDir, 'network_security_config.xml'),
        MAIN_NETWORK_SECURITY_CONFIG,
        'utf8'
      );
      // debug：仅开发构建放行明文（Metro / adb reverse）
      const debugXmlDir = path.join(resRoot, 'debug', 'res', 'xml');
      await fs.promises.mkdir(debugXmlDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(debugXmlDir, 'network_security_config.xml'),
        DEBUG_NETWORK_SECURITY_CONFIG,
        'utf8'
      );
      return config;
    },
  ]);

  return config;
}

module.exports = withAndroidNetworkSecurityConfig;
