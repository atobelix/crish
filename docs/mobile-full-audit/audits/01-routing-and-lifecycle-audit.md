# 移动端全方位体检战役 · 路由与应用生命周期专项审计报告

> **审计席位**：01 · 路由与应用生命周期审计员  
> **审计范围**：`apps/crish-mobile/app/` 路由目录、`apps/crish-mobile/src/adapters/runtime/`、相关导航 Hook 及应用生命周期机制  
> **基准规范**：Expo SDK 57 / expo-router ~57.0.29 / React Native 0.86 / 仓库纪律 `AGENTS.md`  
> **状态评级**：**重大缺陷（P1）**（存在 Metro 启动告警、账号远程模式子页面弹回死循环、缺失 404 兜底、物理返回键闪退与切后台僵尸连接）

---

## 一、审计执行摘要（Executive Summary）

本次专项审计针对 Crish 移动端（`apps/crish-mobile`）的**文件路由结构、导航栈管理、守卫机制、返回栈行为、生命周期监听（前后台切换/锁屏唤醒）**进行了系统性的静态白盒审查与逻辑推演。

### 核心结论速览：
1. **Metro 启动路由警告已彻底查明**：
   - 开发者误将 `_components` 视为私有忽略目录，但 Expo Router 并不支持除 `_layout` 之外的下划线忽略语法；
   - `app/_components/` 内所有 5 个文件均被 Expo Router 强制识别为页面路由节点；
   - `accountNavigation.ts` 与 `useOpenDrawer.ts` 仅有命名导出（named export），因缺失 `default export` 触发 Metro 路由告警；
   - `Protected.tsx`、`RequireAccount.tsx`、`useSafeBack.ts` 因巧合带有 `default export` 侥幸避开告警，但已被错误暴露为全局可导航页面，造成严重路由污染与结构隐患。
2. **账号远程模式（Account Relay Mode）存在致命的“弹回重定向”（Bounce Redirect）**：
   - `<Protected>` 守卫（`app/_components/Protected.tsx`）仅校验本地配对状态 `pairState === 'paired'`，未判断账号登录状态；
   - 当用户通过账号登录连接桌面时，访问 **运行详情（`/run/[runId]`）、终端详情（`/terminal/[runId]`）、审批决策卡（`/approval/[toolCallId]`）、审批历史（`/approval-history`）、通知中心（`/notifications`）** 5 大核心功能时，均会被 `<Protected>` 强制踢往 `/welcome`；
   - `/welcome` 检测到 `accountStatus === 'loggedIn'`，又立即无条件 `replace('/')` 弹回首页；
   - 用户点击上述任何页面均呈现闪退/弹回首页现象，核心功能在账号远程模式下**100% 瘫痪**。
3. **认证状态机判定分散漂移（缺少 SSOT）**：
   - `(main)/_layout.tsx`、`welcome.tsx`、`pair/_layout.tsx`、`RequireAccount.tsx`、`Protected.tsx` 各自写了一套判断条件，有的使用 `accountUser === null`，有的使用 `accountStatus === 'loggedIn'`，存在边界时序风险。
4. **未捕获路由（404）空缺**：
   - 全局缺失 `app/+not-found.tsx`，外部坏死深链或异常跳转会直接渲染 Expo 开发调试白屏，无任何品牌化错误兜底。
5. **Android 物理返回键（Hardware Back Button）在深链场景下穿透退 App**：
   - `useSafeBack` 仅处理了 UI 返回按钮，未接入 React Native `BackHandler`；系统通知拉起的独立任务栈在按返回键时直接退出应用。
6. **前后台唤醒存在 30~90 秒“僵尸连接”盲等待**：
   - App 进入后台未主动挂起 WebSocket，唤醒时底层 TCP 已被系统断开但 JS 状态仍为 `open`，数据写入死连接无响应，必须被动等待心跳超时或假死定时器触发（30~90s）；
   - 唤醒时若连接实例已被销毁，只恢复本地配对直连，**账号远程中继模式的恢复逻辑完全丢失**。

---

## 二、缺陷全景与严重度矩阵

| 缺陷编号 | 缺陷名称 | 严重级别 | 影响范围 | 代码锚点 |
| :--- | :--- | :--- | :--- | :--- |
| **DEF-RT-01** | `_components` 误作为路由扫描引发 Metro 告警与页面污染 | **High (P1)** | 构建告警、路由树污染、非页面代码暴露 | `apps/crish-mobile/app/_components/*` |
| **DEF-RT-02** | `<Protected>` 守卫导致账号模式下 5 大核心功能弹回瘫痪 | **Critical (P0)** | 运行详情、终端、审批、通知等二级页 | `apps/crish-mobile/app/_components/Protected.tsx:8` |
| **DEF-RT-03** | 认证状态判定逻辑多处漂移，缺失单一真理源（SSOT） | **Medium (P2)** | 登录守卫、密码重置流程、登出时序 | `app/(main)/_layout.tsx:19`, `app/welcome.tsx:10` |
| **DEF-RT-04** | 缺失全局未捕获路由（`+not-found.tsx`） | **Medium (P2)** | 错误深链、已下线路由容错 | `apps/crish-mobile/app/`（缺失） |
| **DEF-RT-05** | 深链冷启动缺失 Android 物理返回键拦截导致直接退出 App | **Medium (P2)** | 推送点击拉起、冷启动返回体验 | `apps/crish-mobile/app/_components/useSafeBack.ts` |
| **DEF-RT-06** | `PairLayout` 无条件阻断已登录账号用户进行局域网扫码配对 | **Medium (P2)** | 账号登录后扫码添加新桌面端 | `apps/crish-mobile/app/pair/_layout.tsx:11` |
| **DEF-RT-07** | 遗留旧版配对欢迎页（`pair/welcome.tsx`）形成僵尸路由 | **Low (P3)** | 路由冗余、UI 体验分裂 | `apps/crish-mobile/app/pair/welcome.tsx` |
| **DEF-LC-01** | 前台唤醒僵尸 Socket 盲等待 30~90s 通信假死 | **High (P1)** | 锁屏/后台唤醒、网络消息收发恢复 | `src/adapters/runtime/appRuntime.ts:49` |
| **DEF-LC-02** | 前台唤醒丢失账号远程中继（Relay）连接自动恢复 | **High (P1)** | 账号远程模式下的前台状态恢复 | `src/adapters/runtime/appRuntime.ts:51` |
| **DEF-LC-03** | 进入后台缺乏主动挂起，设备发现与退避定时器后台空转 | **Medium (P2)** | 耗电、后台重试耗尽退避配额进入 `dead` | `src/adapters/runtime/accountRuntime.ts:86` |
| **DEF-LC-04** | 根悬浮审批卡片在锁屏/后台持续触发 1 秒高频定时器 | **Low (P3)** | 后台电量消耗、唤醒堆积渲染 | `src/adapters/hooks/useCountdownTick.ts:14` |

---

## 三、具体缺陷剖析与根因定位

### DEF-RT-01：`_components` 误作为路由扫描引发 Metro 告警与页面污染

#### 1. 现场证据与代码位置
- Metro 启动日志：
  ```text
  WARN Route "./_components/accountNavigation.ts" is missing the required default export.
  WARN Route "./_components/useOpenDrawer.ts" is missing the required default export.
  ```
- 异常文件位置：
  - `apps/crish-mobile/app/_components/accountNavigation.ts`（纯工具函数集，第 7、11、21 行仅导出函数，无 default export）
  - `apps/crish-mobile/app/_components/useOpenDrawer.ts`（自定义 Hook，第 6 行具名导出，无 default export）
  - `apps/crish-mobile/app/_components/Protected.tsx`（第 14 行 `export default Protected`）
  - `apps/crish-mobile/app/_components/RequireAccount.tsx`（第 14 行 `export default RequireAccount`）
  - `apps/crish-mobile/app/_components/useSafeBack.ts`（第 22 行 `export default useSafeBack`）

#### 2. 根因分析（Expo Router 机制）
- **下划线目录的认知偏差**：在 Next.js App Router 中，`_folder` 表示私有文件夹，框架会自动忽略其下的路由生成。**但 Expo Router 并不遵循这一约定**！在 Expo Router 中，以下划线开头的保留字**仅限 `_layout.tsx` / `_layout.js`**，其余任何以下划线开头的目录（如 `_components/`）都会被 Metro 的路由扫描插件作为普通的 URL 路径段解析。
- **路由暴露与警告分化**：
  - Expo Router 扫描到 `app/_components/accountNavigation.ts`，将其映射为路由 `/_components/accountNavigation`。因为 Expo Router 页面必须 default export 一个 React 组件，而该文件只有工具函数，Metro 遂抛出 `Route ... is missing the required default export` 警告；
  - `useOpenDrawer.ts` 同理，只有 Hook 具名导出，被警告；
  - 更加危险的是：`Protected.tsx`、`RequireAccount.tsx`、`useSafeBack.ts` 由于偶然写了 `export default`，**直接被注册为了合法的应用路由**！在 Web 端或通过 URL Scheme 输入 `crish://_components/Protected`，可以直接将一个路由守卫以完整页面的形式挂载，造成了严重的架构漏洞。

#### 3. 依赖调用范围
全工程共有 25 处引用了 `app/_components/*`：
- `apps/crish-mobile/app/(main)/index.tsx:4`
- `apps/crish-mobile/app/account/code.tsx:8-9`
- `apps/crish-mobile/app/account/delete.tsx:5-6`
- `apps/crish-mobile/app/account/index.tsx:4-5`
- `apps/crish-mobile/app/account/login.tsx:4`
- `apps/crish-mobile/app/account/password.tsx:4-5`
- `apps/crish-mobile/app/account/profile.tsx:3-4`
- `apps/crish-mobile/app/account/sessions.tsx:3-4`
- `apps/crish-mobile/app/account/set-password.tsx:7-8`
- `apps/crish-mobile/app/approval/[toolCallId].tsx:3-4`
- `apps/crish-mobile/app/pair/manual.tsx:2`
- `apps/crish-mobile/app/pair/scan.tsx:3`
- `apps/crish-mobile/app/run/[runId].tsx:3-4`
- `apps/crish-mobile/app/terminal/[runId].tsx:3-4`
- `apps/crish-mobile/src/__tests__/useSafeBack.test.tsx:13`

#### 4. 精准修复建议
1. 遵循 Expo Router 规范准则：**`app/` 目录下除页面路由和 `_layout` 之外，严禁存放任何组件、Hook 或工具函数**。
2. 将非页面文件收敛至 `src/` 架构树下：
   - `Protected.tsx`、`RequireAccount.tsx` → 迁移至 `src/presentation/components/guard/`（或 `src/presentation/guards/`）；移除其 `export default`，改为标准具名导出；
   - `useSafeBack.ts`、`useOpenDrawer.ts`、`accountNavigation.ts` → 迁移至 `src/presentation/navigation/`；
3. 彻底删除 `apps/crish-mobile/app/_components/` 目录；
4. 批量更新上述 25 处 import 路径为 `@/presentation/navigation/...` 及 `@/presentation/components/guard/...`。

---

### DEF-RT-02：`<Protected>` 守卫导致账号模式下 5 大核心功能弹回瘫痪

#### 1. 现场证据与代码位置
- 守卫实现：`apps/crish-mobile/app/_components/Protected.tsx:6-12`
  ```tsx
  export function Protected({ children }: { children: ReactNode }) {
    const pairState = useAuthStore((s) => s.pairState);
    if (pairState !== 'paired') {
      return <Redirect href="/welcome" />;
    }
    return children;
  }
  ```
- 欢迎页守卫：`apps/crish-mobile/app/welcome.tsx:8-12`
  ```tsx
  export default function WelcomeRoute() {
    const pairState = useAuthStore((s) => s.pairState);
    const accountStatus = useAccountStore((s) => s.status);
    if (pairState === 'paired' || accountStatus === 'loggedIn') {
      return <Redirect href="/" />;
    }
    ...
  }
  ```
- 主界面守卫：`apps/crish-mobile/app/(main)/_layout.tsx:19-21`
  ```tsx
  const pairState = useAuthStore((s) => s.pairState);
  const accountUser = useAccountStore((s) => s.user);

  if (pairState !== 'paired' && accountUser === null) {
    return <Redirect href="/welcome" />;
  }
  ```

#### 2. 受影响的核心业务路由
以下 5 个关键页面均被 `<Protected>` 包裹：
1. `apps/crish-mobile/app/run/[runId].tsx:10-17`（任务运行详情页）
2. `apps/crish-mobile/app/terminal/[runId].tsx:9-13`（运行终端输出页）
3. `apps/crish-mobile/app/approval/[toolCallId].tsx:9-13`（全局审批决策卡弹窗）
4. `apps/crish-mobile/app/approval-history.tsx:7-11`（审批历史记录列表）
5. `apps/crish-mobile/app/notifications.tsx:8-14`（通知中心页）

#### 3. 根因分析与弹回时序推演
在 Crish 的双轨连接模型中，用户可以通过**局域网本地配对**（`pairState === 'paired'`）或**Crish 账号远程中继**（`accountStatus === 'loggedIn'` 且 `pairState === 'unpaired'`）使用移动端。
当用户处于**账号远程中继模式**下时：
1. 用户在首页或会话中运行 Agent，触发审批请求、或点击运行详情、或收到系统通知；
2. 用户点击跳转到 `/run/[runId]` 或 `/approval/[toolCallId]`；
3. `<Protected>` 执行判断：`pairState !== 'paired'`（由于用户未进行本地局域网配对，条件命中！）；
4. `<Protected>` 立即渲染 `<Redirect href="/welcome" />`，将路由强行踢回欢迎页；
5. 路由栈被推入 `/welcome`，`WelcomeRoute` 组件挂载执行判断：
   `if (pairState === 'paired' || accountStatus === 'loggedIn') return <Redirect href="/" />;`
   由于此时用户确实已经账号登录（`accountStatus === 'loggedIn'`），欢迎页立即强制重定向到首页 `/`；
6. 最终表现：用户点击任何详情、审批、通知，屏幕剧烈闪烁一次后立刻被弹回新对话首页，**根本无法打开任何二级页面**。这是当前版本最致命的交互阻塞缺陷。

#### 4. 精准修复建议
修改 `<Protected>` 守卫，使其兼顾局域网配对与账号远程登录双轨状态：
```tsx
export function Protected({ children }: { children: ReactNode }) {
  const pairState = useAuthStore((s) => s.pairState);
  const accountStatus = useAccountStore((s) => s.status);
  const accountUser = useAccountStore((s) => s.user);

  const isAuthenticated =
    pairState === 'paired' ||
    (accountStatus === 'loggedIn' && accountUser !== null);

  if (!isAuthenticated) {
    return <Redirect href="/welcome" />;
  }
  return children;
}
```

---

### DEF-RT-03：认证状态判定逻辑多处漂移，缺失单一真理源（SSOT）

#### 1. 现场证据与对比分析
系统内存在 5 处关于“当前用户是否已通过认证”的判定，各处条件出现严重漂移：
1. `apps/crish-mobile/app/(main)/_layout.tsx:19`：
   `if (pairState !== 'paired' && accountUser === null)`（依据：`user` 是否非空）
2. `apps/crish-mobile/app/welcome.tsx:10`：
   `if (pairState === 'paired' || accountStatus === 'loggedIn')`（依据：`status` 是否为 `'loggedIn'`）
3. `apps/crish-mobile/app/pair/_layout.tsx:11`：
   `if (pairState === 'paired' || accountStatus === 'loggedIn')`（依据：`status` 是否为 `'loggedIn'`）
4. `apps/crish-mobile/app/_components/Protected.tsx:8`：
   `if (pairState !== 'paired')`（依据：仅限 `pairState`）
5. `apps/crish-mobile/app/_components/RequireAccount.tsx:10`：
   `if (user === null)`（依据：仅限 `user`）

#### 2. 潜在死循环与时序风险
- 当用户在已登录状态下进行“修改密码”或“刷新令牌”时，`accountStore` 的 `status` 会短暂被置为 `'loggingIn'` 或 `'error'`，但 `user` 对象依然保存在内存中；
- 此时如果用户被导航到 `/welcome`：`welcome.tsx` 检查 `accountStatus !== 'loggedIn'`，认为未认证，继续渲染 `WelcomeScreen`；
- 但如果用户此时进入 `(main)`，`(main)/_layout.tsx` 检查 `accountUser !== null`，认为已认证，允许渲染；
- 一旦某处触发联动，极易在 `/welcome` 与 `/(main)` 之间形成死循环重定向。

#### 3. 精准修复建议
在 `src/domain/pure/authSelectors.ts` 中建立单一判定契约：
```ts
export function isAppAuthenticated(
  pairState: string,
  accountStatus: string,
  accountUser: unknown | null
): boolean {
  if (pairState === 'paired') return true;
  return accountStatus === 'loggedIn' && accountUser !== null;
}
```
让所有的路由守卫统一消费此纯函数，根除逻辑漂移。

---

### DEF-RT-04：缺失全局未捕获路由（`+not-found.tsx`）

#### 1. 现场证据
- 在 `apps/crish-mobile/app/` 下检索 `+not-found`、`_error`、`[...missing]` 均为 0 个结果；
- 根布局 `app/_layout.tsx` 的 `<Stack>` 内部亦未声明 `<Stack.Screen name="+not-found" />`。

#### 2. 根因与业务影响
- Expo Router 会自动处理未匹配 URL。当用户通过外部 URL Scheme（例如通过浏览器、其他 App 调起 `crish://invalid-path`）或因旧推送消息携带了已废弃路由（如历史残留的 `crish://files`）时，没有 fallback 页面进行拦截；
- 在开发模式下会直接呈现 Expo 开发者调试红屏/白屏；在生产 APK/IPA 构建中，由于没有未捕获页面，界面会卡死在空白状态，无法回退。

#### 3. 精准修复建议
创建 `apps/crish-mobile/app/+not-found.tsx`：
```tsx
import { Link, Stack } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { AppHeader, AppText, BrandMark, Button } from '@/presentation/ui';
import { useTheme } from '@/adapters/platform/theme';

export default function NotFoundScreen() {
  const theme = useTheme();
  return (
    <>
      <Stack.Screen options={{ title: '页面不存在', headerShown: false }} />
      <View style={[styles.container, { backgroundColor: theme.colors.canvas }]}>
        <BrandMark size={56} />
        <AppText variant="titleLarge">页面未找到</AppText>
        <AppText variant="body" color="textSecondary">
          此链接可能已失效或已被移除
        </AppText>
        <Link href="/" asChild replace>
          <Button title="返回首页" variant="primary" />
        </Link>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 16,
  },
});
```
---

### DEF-RT-05：深链冷启动缺失 Android 物理返回键拦截导致直接退出 App

#### 1. 现场证据与代码位置
- 文件：`apps/crish-mobile/app/_components/useSafeBack.ts:12-20`
  ```ts
  export function useSafeBack(): () => void {
    return useCallback(() => {
      if (router.canGoBack()) {
        router.back();
        return;
      }
      router.replace(SAFE_BACK_FALLBACK_HREF);
    }, []);
  }
  ```
- 全工程搜索 `BackHandler` 结果为 0 处。

#### 2. 根因分析
- `useSafeBack` 设计的初衷很好：在历史栈深度不足时，点击 UI 上的左上角返回按钮会 `replace('/')` 兜底到首页，防止卡死；
- **但它仅作为一个普通回调传递给 UI 按钮（如 `AppHeader` 的 `onBack`）**；
- 在 Android 设备上，当用户锁屏收到一条高危审批推送并点击，系统通知通过深链（`crish://approval/{id}`）冷启动直接唤起 `app/approval/[toolCallId].tsx`：
  - 此时由系统构建的原生栈仅有当前页面一个任务，`router.canGoBack()` 为 `false`；
  - 如果用户没有点击屏幕左上角的 UI 返回按钮，而是按了**Android 物理返回键**或使用了**屏幕边缘侧滑返回手势**；
  - React Native 的默认行为是执行系统 Activity 退栈——由于栈底无其他 Activity，**App 直接闪退并退出到系统桌面**！
  - 用户本应在处理完审批后顺畅回到 Crish 主界面，却被迫重新启动应用。

#### 3. 精准修复建议
在 `useSafeBack` 中，或在二级页面通用的包裹层（如 `Screen` 或导航 Hook）中加入 `BackHandler` 物理按键监听：
```ts
useEffect(() => {
  if (Platform.OS !== 'android') return;
  const onHardwareBack = () => {
    if (router.canGoBack()) {
      router.back();
      return true;
    }
    router.replace('/');
    return true; // 拦截系统默认退出行为
  };
  const sub = BackHandler.addEventListener('hardwareBackPress', onHardwareBack);
  return () => sub.remove();
}, []);
```

---

### DEF-RT-06：`PairLayout` 无条件阻断已登录账号用户进行局域网扫码配对

#### 1. 现场证据与代码位置
- 文件：`apps/crish-mobile/app/pair/_layout.tsx:11-13`
  ```tsx
  export default function PairLayout() {
    const pairState = useAuthStore((s) => s.pairState);
    const accountStatus = useAccountStore((s) => s.status);

    if (pairState === 'paired' || accountStatus === 'loggedIn') {
      return <Redirect href="/" />;
    }

    return (
      <Stack screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>
        <Stack.Screen name="welcome" />
        <Stack.Screen name="manual" />
        <Stack.Screen name="scan" />
      </Stack>
    );
  }
  ```

#### 2. 根因分析
- 开发者假设配对流程与账号体系是“二选一”的排他关系，在 `PairLayout` 根部判定如果 `accountStatus === 'loggedIn'` 就无条件 `Redirect href="/"`；
- 但现实场景中，用户可能在公司先登录了 Crish 账号，回到家后想通过局域网扫码直连家里的台式机（直连低延迟且走本地局域网流量）；
- 当已登录账号的用户试图通过任何入口（如未来在设置中点击“扫码添加本地设备”）访问 `/pair/scan` 时，被 `PairLayout` 粗暴拦截并弹回首页，造成功能硬锁死。

#### 3. 精准修复建议
将 `accountStatus === 'loggedIn'` 仅用于 `/pair/welcome` 引导页的跳过，而不是把整个 `/pair` 栈（含 `scan` 与 `manual`）全盘封死。

---

### DEF-RT-07：遗留旧版配对欢迎页（`pair/welcome.tsx`）形成僵尸路由

#### 1. 现场证据与代码位置
- 遗留路由：`apps/crish-mobile/app/pair/welcome.tsx:1-14`
  ```tsx
  export default function PairWelcomeRoute() {
    return (
      <PairWelcomeScreen
        onLogin={() => router.push('/account/login')}
        onOpenManual={() => router.push('/pair/manual')}
        onOpenScan={() => router.push('/pair/scan')}
        onEnterApp={() => router.replace('/')}
      />
    );
  }
  ```
- 真实入口：`apps/crish-mobile/app/welcome.tsx`（账号 v3 规范统一欢迎页，承接邮箱登录与扫码配对）。

#### 2. 根因分析
在早期架构中，欢迎页位于 `/pair/welcome`。在账号 v3 重构中，顶层引入了 `app/welcome.tsx` 作为主入口。但旧的 `app/pair/welcome.tsx` 未被清理，且仍作为 `app/pair/_layout.tsx` 的首个 Screen。
一旦外部路由访问 `/pair`，会直接进入这个遗留的、视觉与交互均落后的旧版页面。

#### 3. 精准修复建议
下线 `app/pair/welcome.tsx`，将 `app/pair/` 栈收敛为纯功能栈（仅包含 `scan` 和 `manual`）。

---

## 四、应用生命周期与前后台切换专项审计

### DEF-LC-01：前台唤醒僵尸 Socket 盲等待 30~90s 通信假死

#### 1. 现场证据与代码位置
- 文件：`apps/crish-mobile/src/adapters/runtime/appRuntime.ts:49-66`
  ```ts
  function handleAppState(next: AppStateStatus): void {
    if (next !== 'active') return;
    const wiring = getObservationWiring();
    if (!wiring) {
      if (authStore.getState().pairState === 'paired') {
        ensureObservationWiring();
      }
      return;
    }
    if (wiring.client.phase === 'open') {
      wiring.bridge.syncSubscriptions();
      for (const sessionId of Object.keys(eventStore.getState().windows)) {
        void wiring.bridge.hydrateSession(sessionId);
      }
    } else if (wiring.client.phase !== 'connecting') {
      wiring.reconnect();
    }
  }
  ```
- 文件：`apps/crish-mobile/src/network/ReconnectingWsClient.ts:89-95`
  ```ts
  export const HEARTBEAT_INTERVAL_MS = 30_000;
  export const HEARTBEAT_TIMEOUT_FACTOR = 3;
  export const HEARTBEAT_DEAD_MS = HEARTBEAT_INTERVAL_MS * HEARTBEAT_TIMEOUT_FACTOR; // 90s
  ```

#### 2. 根因分析（移动端网络栈特质）
- **移动端系统的 Socket 冻结机制**：在 iOS 和现代 Android（Doze Mode）中，当应用转入后台数秒后，操作系统内核会暂停进程并将网络套接字挂起。如果后台期间设备切换了 Wi-Fi/蜂窝网络、或桌面端重置了连接、或 NAT 映射超时，底层 TCP 会话在网络层已经实际断开（Dead Connection）；
- **JS 层的假死滞后性**：当用户唤醒应用进入前台（`AppState === 'active'`）时，React Native 的 WebSocket 实例内存状态仍然保持 `readyState === 1`（`open`）。此时套接字实际上是“单向死亡 / 半开”（Half-open / Zombie）；
- **盲目同步与无感知沉默**：
  - `handleAppState` 检查到 `wiring.client.phase === 'open'`，便直接调用 `syncSubscriptions()` 和 `hydrateSession()` 向该 Socket 发送订阅帧；
  - 由于 TCP 缓冲区此时已断开但尚未触发 RST/FIN，发送操作被静默丢弃，不会立即触发 `onerror` 或 `onclose`；
  - 客户端必须等待心跳定时器（每 30 秒一次）发送 `heartbeat`。若心跳也无回包，则必须累计达到 `HEARTBEAT_TIMEOUT_FACTOR = 3`（即整整 **90 秒**）之后，`isHeartbeatDead` 才会将其判定为假死并执行 `ws.close()`！
  - **严重后果**：用户从后台切回 App 后，看到界面右上角显示“已连接”，但发送消息无反应、也收不到任何新消息，处于长达 1.5 分钟的静默瘫痪期。

#### 3. 精准修复建议
在 `handleAppState` 唤醒时引入主动探活机制：
1. 检查距上次有效接收时间 `now - lastRxMs`。若超过 15 秒，直接触发一次即时 Ping 探测；
2. 若已超过心跳周期（30 秒），直接认为连接陈旧，立即执行 `wiring.reconnect()` 强制断开重连，无需被动等待 90 秒。

---

### DEF-LC-02：前台唤醒丢失账号远程中继（Relay）连接自动恢复

#### 1. 现场证据与代码位置
- 文件：`apps/crish-mobile/src/adapters/runtime/appRuntime.ts:51-57`
  ```ts
  const wiring = getObservationWiring();
  if (!wiring) {
    if (authStore.getState().pairState === 'paired') {
      ensureObservationWiring();
    }
    return;
  }
  ```

#### 2. 根因分析
- 如果 App 在后台运行时间过长，因系统内存紧张触发了资源回收或 `disposeRemote()` 被意外调用，导致 `getObservationWiring()` 返回 `null`；
- 当用户再次进入应用触发 `handleAppState('active')` 时：
  代码只判定了 `if (authStore.getState().pairState === 'paired')`！
  **完全漏掉了账号远程中继模式**（`accountStore.getState().status === 'loggedIn'`）！
- 结果：处于账号远程模式的用户在长后台唤醒后，连接实例彻底丢失，界面停滞在未连接状态，除非用户手动杀进程重开。

#### 3. 精准修复建议
完善 `appRuntime.ts` 中的无连接恢复分支：
```ts
if (!wiring) {
  if (authStore.getState().pairState === 'paired') {
    ensureObservationWiring();
  } else if (accountStore.getState().status === 'loggedIn') {
    // 补齐账号中继恢复通道
    syncRemote(); 
  }
  return;
}
```

---

### DEF-LC-03：进入后台缺乏主动挂起，设备发现与退避定时器后台空转

#### 1. 现场证据与代码位置
- 文件：`apps/crish-mobile/src/adapters/runtime/accountRuntime.ts:86-90`
  ```ts
  discoveryTimer = setInterval(() => {
    if (accountStore.getState().status === 'loggedIn') {
      void refreshAccountDevices();
    }
  }, 15_000);
  ```
- 文件：`apps/crish-mobile/src/network/ReconnectingWsClient.ts:387-388`
  ```ts
  /** 主动断开（iOS 后台挂起等场景，M5 §4.3.2）：清 pending/心跳/重连计时器，
   * 相位回 idle；**不自动重连**（等待 connect() 再触发）。幂等（已 idle 无操作）。 */
  disconnect(): void
  ```

#### 2. 根因分析
- `accountRuntime` 完全没有订阅 `AppState`。其创建的 15 秒一次的 `discoveryTimer` 在后台期间依然在事件循环中尝试执行 HTTP 请求，浪费系统电量与无线射频；
- 另外在 `ReconnectingWsClient.ts` 中，作者原本写了详尽的注释指出在 iOS 后台挂起时应调用 `disconnect()`；
- 但在 `appRuntime.ts` 的 `handleAppState` 中：
  `if (next !== 'active') return;`
  进入后台时直接 `return`，未执行任何挂起动作。若此时在后台断网，重连退避计时器连续重试 5 次后，状态机直接堕入终态 `dead`，导致前台唤醒时无法恢复。

#### 3. 精准修复建议
1. 在 `accountRuntime.ts` 中引入 AppState 监听：进入后台时 `clearInterval(discoveryTimer)`，切回前台时立即执行一次 `refreshAccountDevices()` 并恢复 15 秒轮询；
2. 在 `appRuntime.ts` 中处理 `background` 状态，合理冻结或管理后台重连次数。

---

### DEF-LC-04：根悬浮审批卡片在锁屏/后台持续触发 1 秒高频定时器

#### 1. 现场证据与代码位置
- 文件：`apps/crish-mobile/src/adapters/hooks/useCountdownTick.ts:9-16`
  ```ts
  export function useCountdownTick(intervalMs = 1000, active = true): number {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
      if (!active) return;
      const id = setInterval(() => setNow(Date.now()), intervalMs);
      return () => clearInterval(id);
    }, [intervalMs, active]);

    return now;
  }
  ```
- 文件：`apps/crish-mobile/src/presentation/components/approval/ApprovalFloat.tsx:33`
  `ApprovalFloat` 位于根布局 `RootShell` 最外层，只要有审批待办，其 `useApprovalDetailVm` 便会一直调用 `useCountdownTick(1000, true)`。

#### 2. 根因分析
`useCountdownTick` 仅支持 `active` 参数，但调用方未将 `AppState === 'active'` 传入。当手机锁屏或切换到其他 App 时，只要内存中有未决审批，1000ms 定时器就在 JS 线程中持续空转更新组件状态，产生无意义的电量消耗。

#### 3. 精准修复建议
在 `useCountdownTick` 内部集成 `AppState` 状态检测，当应用处于后台或非激活状态时，自动暂停 `setInterval`；重新唤醒时立即校准为最新的 `Date.now()`。

---

## 五、精准修复方案与可执行路线图

### 第一阶段：路由目录规范化收敛（彻底根除 Metro 警告与路由污染）
1. **创建非页面组件收敛目录**：
   - 建立 `apps/crish-mobile/src/presentation/components/guard/`
   - 建立 `apps/crish-mobile/src/presentation/navigation/`
2. **安全迁移文件**：
   - 将 `app/_components/Protected.tsx` 移至 `src/presentation/components/guard/Protected.tsx`；
   - 将 `app/_components/RequireAccount.tsx` 移至 `src/presentation/components/guard/RequireAccount.tsx`；
   - 将 `app/_components/useSafeBack.ts` 移至 `src/presentation/navigation/useSafeBack.ts`；
   - 将 `app/_components/useOpenDrawer.ts` 移至 `src/presentation/navigation/useOpenDrawer.ts`；
   - 将 `app/_components/accountNavigation.ts` 移至 `src/presentation/navigation/accountNavigation.ts`；
3. **消除冗余 default export**：
   - 守卫组件改为具名导出 `export function Protected`、`export function RequireAccount`，防止误导出；
4. **移除垃圾目录**：
   - 删除 `apps/crish-mobile/app/_components/` 整个物理目录；
5. **重构 25 处 Import 路径**：
   - 将全工程中的 `../_components/...` 替换为 `@/presentation/navigation/...` 与 `@/presentation/components/guard/...`。

### 第二阶段：修复 `<Protected>` 守卫与认证 SSOT（解除核心功能瘫痪）
1. **提取认证判定单一真理源**：
   - 在 `src/domain/pure/authSelectors.ts` 导出 `isAppAuthenticated`；
2. **修复 `<Protected>` 逻辑**：
   - 引入 `accountStatus` 与 `accountUser` 判定，使账号登录模式正常放行；
3. **统一各路由守卫**：
   - 重构 `app/(main)/_layout.tsx`、`app/welcome.tsx` 与 `app/pair/_layout.tsx`，统一使用 `isAppAuthenticated`。

### 第三阶段：深链、404 与 Android 物理返回键加固
1. **新增未捕获路由**：
   - 落地 `apps/crish-mobile/app/+not-found.tsx`；
   - 在 `app/_layout.tsx` 的 `<Stack>` 注册 `+not-found`；
2. **加固 `useSafeBack`**：
   - 接入 React Native `BackHandler`，在 Android 栈底单屏时拦截物理返回键并 `router.replace('/')`；
3. **清理僵尸路由**：
   - 移除 `apps/crish-mobile/app/pair/welcome.tsx`，保持 `app/welcome.tsx` 作为唯一欢迎入口。

### 第四阶段：生命周期与网络唤醒韧性重构
1. **Socket 唤醒即时探活**：
   - `handleAppState('active')` 时检测 `lastRxMs`；若超过 15 秒无收包，立即发送 Ping 探测帧；若超过 30 秒，直接触发强制重连；
2. **补齐账号中继唤醒恢复**：
   - 在 `handleAppState` 中，若 `wiring === null` 且 `accountStore.status === 'loggedIn'`，主动调用中继恢复通道；
3. **后台定时器休眠**：
   - `accountRuntime` 的 `discoveryTimer` 在后台状态暂停，切回前台时立即执行一次刷新并恢复；
   - `useCountdownTick` 在后台状态自动冻结。

---

## 六、审计结论与验收指标

- **Metro 启动指标**：执行 `npm start` 时，控制台零 `missing default export` 警告，路由树完全纯净。
- **账号远程体验指标**：在通过账号登录连接时，用户点击运行详情、终端、审批卡片、审批历史、通知中心等均能 100% 顺畅打开，不再出现闪退回首页的问题。
- **前后台切换指标**：应用锁屏或后台挂起 5 分钟后再次点亮屏幕唤醒，应用能够在 1 秒内完成探活与恢复重连，告别 30~90 秒假死盲等待。
- **Android 返回键指标**：从通知栏点击深链拉起任意独立页面，按物理返回键或手势侧滑均能平滑返回至主对话界面，绝不直接退出应用。