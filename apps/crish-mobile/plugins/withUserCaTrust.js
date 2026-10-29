// Android 用户 CA 信任配置插件。
// Android 7+ 默认不信任用户安装的 CA；桌面端使用自签 CA，因此显式开启
// user trust anchor，让手机安装桌面证书后 wss 握手可通过系统信任链。
// 仍只信任系统 + 用户 CA，不关闭主机名校验。
// cleartextTrafficPermitted 保留 true 仅为 Expo dev server 加载；
// 业务通道固定 wss，代码中不存在明文端点。
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const NETWORK_SECURITY_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
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
      const xmlDir = path.join(
        config.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'res',
        'xml'
      );
      await fs.promises.mkdir(xmlDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(xmlDir, 'network_security_config.xml'),
        NETWORK_SECURITY_CONFIG,
        'utf8'
      );
      return config;
    },
  ]);

  return config;
}

module.exports = withAndroidNetworkSecurityConfig;
