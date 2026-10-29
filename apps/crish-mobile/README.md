# crish-mobile（Crish 移动端伴侣）

Crish 的移动端应用：在手机上查看桌面 Agent 的会话与运行、处理审批、浏览工作区文件、发起任务。
技术栈：Expo SDK 57 / React Native 0.86 / React 19 / expo-router / TypeScript strict。

## 运行

```bash
# 仓库根目录
npm install
npm run dev:workbench        # 启动桌面应用（移动端连接的目标）

# 移动端
npm --workspace @crish/crish-mobile run start   # Metro / Web 预览（Expo Go 不含证书信任配置）
npm --workspace @crish/crish-mobile run android # 原生调试构建（应用 CA 信任配置）
npm --workspace @crish/crish-mobile run ios     # macOS 上原生调试构建
```

> Web 目标仅用于布局预览：`npm --workspace @crish/crish-mobile run web`。Web 端不启用本地 SQLite 与系统通知。
> 真机连接自签 CA 的桌面服务必须使用原生调试构建（`expo run:android` / `expo run:ios`）；Expo Go 不会应用 `plugins/withUserCaTrust.js` 的 Android 用户 CA 信任配置。

## 配对

1. 桌面端「设置 → 多端互通」开启服务与局域网配对。
2. 桌面端「安全连接 → 导出证书」，把 `crish-ca.crt` 传到手机并安装、完全信任。
3. 手机与电脑连接同一 Wi-Fi。
4. 手机打开应用 → 扫描桌面二维码，或手动输入主机 / 配对码。

**证书信任**：桌面服务只提供 wss（自签 CA）。Android 在「设置 → 安全 → 安装 CA 证书」安装；iOS 安装描述文件后，还需在「设置 → 通用 → 关于 → 证书信任设置」中完全信任。未信任时表现为连接失败，不是网络故障；连接页「连接帮助」有完整步骤。当前信任模型为**系统 CA 信任 + 应用层指纹一致性校验**，传输层 SPKI pinning（原生模块）尚未实现。

## 开发门禁

```bash
npm --workspace @crish/crish-mobile run typecheck
npm --workspace @crish/crish-mobile test
npm --workspace @crish/crish-mobile run test:coverage
npm --workspace @crish/crish-mobile run doctor
```

## 结构

```
app/                       路由（配对 / 5 Tab / 会话 / 审批 / 运行 / 终端）
src/presentation/ui/       设计系统原子（Screen / AppHeader / Text / Icon / Button / Sheet / Toast …）
src/presentation/screens/  页面组合（仅依赖 VM 与 UI 原子）
src/presentation/timeline/ 事件 → 对话 / 工具 / 审批时间线投影
src/presentation/components/ 业务展示块
src/adapters/              VM、wiring、runtime、repositories
src/domain/                vanilla zustand store / reducers / 纯函数
src/network/ /pairing/ /notifications/  领域服务
```

设计规范见 `docs/mobile-app-rebuild/01-界面设计规范.md`；运行时与连接方案见 `docs/mobile-app-rebuild/02-运行时与连接方案.md`。
