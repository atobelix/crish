# 模型供应商设置表单与单轨持久化源码级深度审计报告

> **战役工作区**：`docs/workbench-interaction-repair/`  
> **审计对象**：`commit f6ae63f5f` 及相关模型持久化核心文件  
> **审查基准**：[`01-provider-config-persistence-plan.md`](../01-provider-config-persistence-plan.md)  
> **涉及核心文件**：  
> - `apps/crish-desktop/src/components/settings-models/ProviderProfileForm.tsx`  
> - `apps/crish-desktop/src/components/settings-models/catalogWriteGate.ts`  
> - `apps/crish-desktop/src/api/modelsCatalogStore.ts`  
> - `apps/crish-desktop/src/api/modelsCatalogStore.test.ts`  
> - `apps/crish-desktop/src/components/settings-models/ProviderProfileForm.test.tsx`  
> - `crates/agent-provider/src/models/config_validation.rs`  

---

## 一、审计背景与审查目标

在桌面端工作台交互修复战役中，针对“模型服务商配置输入不生效、清除 Base URL 报错、回车无响应、发生冲突后 Store 永久瘫痪死锁”等顽疾，团队在 `commit f6ae63f5f` 及关联提交中实施了单轨持久化改造与 CAS 冲突自愈逻辑。

本次审计由表单与持久化专家角色（Form & Persistence Reviewer）执行，旨在对该改动进行严格、深入、客观的源码级立体审查，验证其是否满足单真理源（SSOT）、并发安全、数据清洗一致性、CAS 自愈韧性与代码门禁规范，杜绝表面修复与隐藏回退。

---

## 二、核心审查维度代码实证分析

### 1. 单轨写盘原则（SSOT）：双轨切断完整性与残留分析

#### 1.1 `saveProfileBaseUrl` 旁路写盘已物理切断
- **源码实证**：在 [`ProviderProfileForm.tsx:1-8`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ProviderProfileForm.tsx#L1-L8) 中，原有的 `saveProfileBaseUrl` 导入已被彻底移除。在 `persistProviderPatch`（L120-165）中，Base URL 与 Protocol 的保存全部收敛于 `modelsCatalogStore.updateProvider(selected.id, updatePatch)`。
- **调用栈排查**：经全局检索，`saveProfileBaseUrl` 在生产代码中已无任何主动调用点（仅保留在废弃的遗留库与旧单测中）。原先“写轨 A（`saveProfileBaseUrl` -> `configProfileApply` 写盘升版本）与写轨 B（`modelsCatalogStore.updateProvider` 携旧版本提交）”导致的致命 `REVISION_CONFLICT` 双轨竞态已被成功斩断。

#### 1.2 潜在残留：`handleSaveVendorName` 过早向 localStorage 同步
- **源码实证**：定位至 [`ProviderProfileForm.tsx:101-116`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ProviderProfileForm.tsx#L101-L116)：
  ```tsx
  if (trimmed !== vendorName) {
    void runAsLocalMutation(async () => {
      try {
        upsertProfile({ ...selected, name: trimmed }); // ⚠️ 先写 localStorage
        const res = await modelsCatalogStore.updateProvider(selected.id, {
          displayName: trimmed,
        });
        if (!res.ok) {
          notify(false, res.error || t('models.probe.vendorNameSaveFailed'));
        } else {
          _refresh();
        }
      } catch (e) { ... }
    });
  }
  ```
- **风险穿透**：
  1. **版本撕裂风险**：`upsertProfile` 在 `modelsCatalogStore.updateProvider` 之前调用。若 Rust 侧写盘发生 CAS 冲突或 IO 失败，`localStorage` 中的 `conex:provider_profiles` 已经记录了新名称，而底层 `~/.conex/models.yaml` 仍为旧名称，导致两轨状态分裂。
  2. **双轨不一致性**：`persistProviderPatch` 对 `baseUrl` 的修改完全不再同步 `upsertProfile`，而 `handleSaveVendorName` 却同步了 `upsertProfile`。虽然设置页 UI 已改读统一树（`listLiveProviders()`），但首次运行向导（`useFirstRunWizard.ts:105, 185`）与 OAuth 管理器（`oauthTokenManager.ts:53`）仍读取 `loadProfiles()`，造成多处状态镜像不一致。

---

### 2. 脏检查与并发安全：防抖、IME 组合与竞态

#### 2.1 输入法（IME）组合安全
- **源码实证**：`ProviderProfileForm` 使用的 `Input` 原子组件在 [`Input.tsx:149-159`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Input/Input.tsx#L149-L159) 内置了刚性拦截：
  ```tsx
  if (isComposingRef.current || e.nativeEvent.isComposing || e.keyCode === 229 || e.key === 'Process') return;
  if (e.key === 'Enter' && !e.shiftKey) onEnter?.(...);
  ```
- **结论**：中英文输入法在拼音打字、选词候选阶段敲击 Enter 键时，被组件内部原生锁完全丢弃，不会误触 `handleSaveBaseUrl` 或 `handleSaveVendorName`，表现稳健。

#### 2.2 静态脏检查（Unchanged Content）
- **源码实证**：
  - `handleSaveBaseUrl`（[`ProviderProfileForm.tsx:167-173`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ProviderProfileForm.tsx#L167-L173)）：
    ```tsx
    const trimmed = baseUrlDraft.trim();
    const current = storeBaseUrl || selected.baseUrl || '';
    if (trimmed !== current) {
      persistProviderPatch({ baseUrl: trimmed });
    }
    ```
  - `handleSaveVendorName`（L101）：`if (trimmed !== vendorName)`。
- **结论**：用户聚焦输入框但未做任何修改即移开焦点时，脏检查生效，不会产生无意义的写盘 IPC。

#### 2.3 动态竞态缺陷：Enter 敲击与失焦（Blur）并发写盘
- **断裂重现**：
  1. 用户在 Base URL 输入框输入新地址 `https://api.new.com/v1`，敲击 Enter。
  2. `onEnter` 触发 `handleSaveBaseUrl`。此时 `trimmed !== current` 成立，调用异步函数 `persistProviderPatch`，开始向 Rust 后端写盘。
  3. 用户敲击回车后习惯性点击页面空白处或按 Tab 键，触发 `onBlur`。
  4. 此时首个写盘请求仍在网络/磁盘 IPC 队列中排队，React 尚未收到 `acceptSnapshot` 回执，组件内的 `storeBaseUrl` 与 `selected.baseUrl` 依然是旧值！
  5. `onBlur` 触发的 `handleSaveBaseUrl` 再次比对：`trimmed` 依然不等于旧的 `current`，因此**再次发起第二轮 `persistProviderPatch`**！
  6. 两笔写盘请求相继进入 `modelsCatalogStore.enqueue` 队列，造成单次用户输入产生**连续两次落盘**与**两次 revision 递增**。
- **证据支持**：Plan 01 在 [§二.3.2](file:///c:/Software/conex/docs/workbench-interaction-repair/01-provider-config-persistence-plan.md#L215-L217) 中明确将“连击与回车失焦竞态”列为待修复问题，但当前代码中尚未装配 `isSubmittingRef` 或更新前的 `currentEffectiveRef` 锁定，此缺陷依然存在。

#### 2.4 保存失败后的死循环报错
- **断裂重现**：
  当用户输入了一个非法 URL（如 `ftp://example.com` 或公网明文 `http://api.com`）时，后端 Rust 拒绝并返回 400 校验错误。
  在 `ProviderProfileForm.tsx:157` 中仅执行了 `notify(false, res.error)`，未重置 `baseUrlDraft`。
  只要用户点击页面其他区域触发 `onBlur`，脏检查便再次发现 `trimmed !== current`，从而**无休止地重试并反复弹出失败 Toast**，除非用户手动清空或切走。

---

### 3. 数据规范化（Sanitization）：Base URL 空串与协议门禁

#### 3.1 空串清洗为 `undefined` 的单轨链路
- **源码实证**：
  - `persistProviderPatch`（[`ProviderProfileForm.tsx:126-147`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ProviderProfileForm.tsx#L126-L147)）：
    ```tsx
    if (patch.baseUrl !== undefined) {
      updatePatch.baseUrl = patch.baseUrl.trim() || undefined;
    }
    ```
  - `modelsCatalogActions.ts:110-115`（`definedClone`）：
    ```ts
    Object.entries(value).filter(([, entry]) => entry !== undefined)
    ```
  - `crates/agent-provider/src/models/config_validation.rs:30-32`：
    ```rust
    if let Some(base_url) = provider.base_url.as_deref() {
        validate_outbound_url(&provider_id, "baseUrl", base_url, &["https", "http"])?;
    }
    ```
- **结论**：空串在前端被准确清洗为 `undefined`，经 `definedClone` 序列化时 Key 被彻底移除；Rust 后端反序列化为 `None`，跳过 `validate_outbound_url` 强校验，用户清空 Base URL 回退默认地址的功能完全正常。

#### 3.2 局部类型冗余反转
- **代码行号**：[`ProviderProfileForm.tsx:136`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ProviderProfileForm.tsx#L136) 与 [`catalogWriteGate.ts:73`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/catalogWriteGate.ts#L73)
  ```tsx
  // ProviderProfileForm.tsx:136
  baseUrl: cleanBaseUrl ?? '', // ⚠️ 将 undefined 强转为空串
  
  // catalogWriteGate.ts:73
  const cleanBaseUrl = args.baseUrl?.trim() || undefined; // ⚠️ 又转回 undefined
  ```
- **评价**：属于轻微代码坏味道，虽未造成功能破坏，但破坏了类型意图的一致性。

#### 3.3 缺少协议前缀的交互容错（如本地 `ip:port`）
- **实证对比**：用户在配置本地私有模型（如 Ollama、vLLM、LM Studio）时，常常直接输入 `localhost:11434` 或 `127.0.0.1:8000`。
- **后端反应**：Rust `validate_outbound_url` 强校验 `value.split_once("://")`。如果缺少 `http://`，后端直接抛错：`"供应商 xxx 的 baseUrl 必须以 https:// / http:// 开头"`。
- **现状评价**：前端目前零预检零补全，直接报错给用户。对于桌面端软件而言，若能针对本地 loopback 主机智能补全 `http://`，能大幅提升人机工程体验。

---

### 4. CAS 版本控制与冲突重试：自愈机制与 Store 存活分析

#### 4.1 彻底消除了 `loaded: false` 假锁死
- **源码实证**：在 commit `fd68ccc8d` 中修改了 [`modelsCatalogStore.ts:220`](file:///c:/Software/conex/apps/crish-desktop/src/api/modelsCatalogStore.ts#L220)：
  ```ts
  return fail(
    result.kind === 'REVISION_CONFLICT'
      ? 'REVISION_CONFLICT'
      : 'WRITE_REJECTED',
    result.error,
    result.code === 'CONTRACT_MISMATCH' // ⚠️ 不再对 REVISION_CONFLICT 传入 unreadable=true
  );
  ```
- **结论**：彻底根除了旧版本中一遇到版本冲突就把整个 Store 置为 `loaded: false`（导致全工作台必须重启）的系统性缺陷。

#### 4.2 单次 CAS 自动拉取与重试机制已生效
- **源码实证**：定位至 [`modelsCatalogStore.ts:195-211`](file:///c:/Software/conex/apps/crish-desktop/src/api/modelsCatalogStore.ts#L195-L211)：
  ```ts
  if (
    !result.ok &&
    result.kind === 'REVISION_CONFLICT' &&
    expectedRevision === undefined
  ) {
    const fresh = await readModelsYamlIpc();
    if (fresh.ok && fresh.data) {
      try {
        acceptSnapshot(fresh.data);
        requestRevision = state.revision;
        candidate = normalizeModelsTree(action(state.tree));
        result = await writeModelsYamlIpc(candidate, requestRevision);
      } catch {
        // 重试失败走下方常规 fail 分支
      }
    }
  }
  ```
- **机制评估**：
  当 Delta 类修改（如表单修改 Base URL、修改厂商名）遭遇外部并发修改冲突时，Store 会自动拉取最新快照、在最新树上重算 patch 并重发写盘，有效实现了 CAS 自愈。

#### 4.3 致命单测断裂：`modelsCatalogStore.test.ts` 存在硬性红灯
- **实测证据**：
  在当前工作区运行 `npx vitest run apps/crish-desktop/src/api/modelsCatalogStore.test.ts`，出现硬性测试失败：
  ```
  FAIL apps/crish-desktop/src/api/modelsCatalogStore.test.ts
  外部冲突保留原镜像和诊断，并要求重新读取
  AssertionError: expected { version: 2, activeModel: null, …(1) } to be { version: 2, activeModel: null, …(1) } // Object.is equality
  ```
- **原因剖析**：
  在 `modelsCatalogStore.test.ts:415-435` 中，旧单测断言写着：
  ```ts
  expect(modelsCatalogStore.getState().tree).toBe(previous);
  expect(modelsCatalogStore.getState().loaded).toBe(false);
  ```
  该断言完全是**针对旧版本“冲突即瘫痪（loaded=false）”的旧逻辑所写的测试**！
  在引入自愈拉取机制后，发生冲突时 Store 会拉取最新快照并通过 `acceptSnapshot` 更新 `tree` 且保持 `loaded: true`。因此该旧断言必然失败！
  Plan 01 在 [§五.2](file:///c:/Software/conex/docs/workbench-interaction-repair/01-provider-config-persistence-plan.md#L868-L917) 中明确要求重写该测试并断言 `loaded: true`，但此测试未被同步更新，直接导致仓库门禁存在破损。

---

### 5. 架构收敛、代码行数与门禁断言

#### 5.1 行数门禁硬阻断（Line Budget Violation）
- **实测证据**：
  运行 `node scripts/check-line-counts.mjs apps/crish-desktop/src/api/modelsCatalogStore.ts`：
  ```
  ❌ [VIOLATION] apps/crish-desktop/src/api/modelsCatalogStore.ts
     Category: Business Logic | Effective Lines: 397 | Budget: ≤ 375
  ```
- **根因分析**：
  `modelsCatalogStore.ts` 在基线文件 `docs/multi-agent-repair/基线记录/frontend-line-counts-baseline.md:121` 中登记的限额为 **375 行**。
  在引入 CAS 重试逻辑后，有效代码行增加到了 **397 行**，超出了基线限额，违反了 AGENTS.md §11 的 CI 门禁规则。

#### 5.2 计划单测未落地
- **实证**：查看 `apps/crish-desktop/src/components/settings-models/ProviderProfileForm.test.tsx` 全文（207 行），Plan 01 §五.1 承诺的三项核心测试（Base URL Enter 保存、空串过滤为 undefined、脏检查未修改零写盘）**均未合并入测试文件**。

---

## 三、问题缺陷清单与评级

| 编号 | 缺陷描述 | 对应文件与行号 | 严重等级 |
| :--- | :--- | :--- | :--- |
| **DEF-01** | `modelsCatalogStore.test.ts` 存在硬性红灯断言，与 CAS 自愈新规范冲突且破坏测试资产 | [`modelsCatalogStore.test.ts:430-434`](file:///c:/Software/conex/apps/crish-desktop/src/api/modelsCatalogStore.test.ts#L430-L434) | **Critical 致命阻断** |
| **DEF-02** | `modelsCatalogStore.ts` 有效行数（397行）超出基线（375行），CI 行数门禁红牌阻断 | [`modelsCatalogStore.ts:1-427`](file:///c:/Software/conex/apps/crish-desktop/src/api/modelsCatalogStore.ts#L1-L427) | **Critical 致命阻断** |
| **DEF-03** | `ProviderProfileForm` 中 `onEnter` 紧跟 `onBlur` 造成并发双重写盘与重复 Revision 递增 | [`ProviderProfileForm.tsx:258-259`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ProviderProfileForm.tsx#L258-L259) | **Major 功能缺陷** |
| **DEF-04** | `handleSaveVendorName` 在写盘前过早同步 `upsertProfile`，写盘失败时产生双轨版本撕裂 | [`ProviderProfileForm.tsx:104`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ProviderProfileForm.tsx#L104) | **Major 架构缺陷** |
| **DEF-05** | Plan 01 既定单元测试资产缺失，表单持久化无自动化回归守卫 | [`ProviderProfileForm.test.tsx:1-207`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ProviderProfileForm.test.tsx#L1-L207) | **Major 资产缺失** |
| **DEF-06** | 保存失败后输入框维持错误值，失焦（Blur）陷入无限重复提交报错循环 | [`ProviderProfileForm.tsx:168-172`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ProviderProfileForm.tsx#L168-L172) | **Minor 体验隐患** |
| **DEF-07** | `cleanBaseUrl ?? ''` 存在冗余反转，代码表达不精炼 | [`ProviderProfileForm.tsx:136`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ProviderProfileForm.tsx#L136) | **Minor 代码异味** |
| **DEF-08** | 本地 URL（如 `localhost:11434`）未在前端做 `http://` 智能补全，直接报错体验不佳 | [`ProviderProfileForm.tsx:168`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ProviderProfileForm.tsx#L168) | **Suggestion 体验建议** |
| **DEF-09** | 生产代码中残留废弃的 `saveProfileBaseUrl` 导出与测试 mock，需彻底退役清退 | [`profileStoreActivation.ts:41`](file:///c:/Software/conex/apps/crish-desktop/src/api/provider-profiles/profileStoreActivation.ts#L41) | **Suggestion 架构清理** |

---

## 四、具体修复方案与落地建议

### 1. 修复 DEF-01：更新 `modelsCatalogStore.test.ts` 断言
将过时的 `toBe(previous)` 与 `expect(state.loaded).toBe(false)` 更新为对齐自愈规范的断言：
```ts
// apps/crish-desktop/src/api/modelsCatalogStore.test.ts
it('外部冲突保留原镜像和诊断，并要求重新读取', async () => {
  await modelsCatalogStore.ensureLoaded();
  mockTauriError(APPLY, {
    code: 'REVISION_CONFLICT',
    message: 'external change',
    currentRevision: 'elsewhere',
  });
  const res = await modelsCatalogStore.updateModel('Acme', 'Shared', {
    displayName: 'stale',
  });
  expect(res.ok).toBe(false);
  expect(modelsCatalogStore.getState().lastError?.kind).toBe('REVISION_CONFLICT');
  // 核心断言更正：冲突自愈后保持 loaded=true，绝不死锁
  expect(modelsCatalogStore.getState().loaded).toBe(true);
});
```

### 2. 修复 DEF-02：压缩 `modelsCatalogStore.ts` 有效代码行
将 `modelsCatalogStore.ts` 内部冗余的类型导入与简单代理收敛，或将辅助工具拆分，将有效行控制在 375 行以内，重新跑通 `check:line-counts`。

### 3. 修复 DEF-03 & DEF-06：`ProviderProfileForm` 装配防重提交锁与脏检查锁定
在表单内引入 `isSavingRef` 或记录最后已提交值的 `lastSavedUrlRef`：
```tsx
const isSavingRef = useRef(false);
const lastSavedUrlRef = useRef(storeBaseUrl);

useEffect(() => {
  lastSavedUrlRef.current = storeBaseUrl;
}, [storeBaseUrl]);

const handleSaveBaseUrl = () => {
  if (isSavingRef.current) return;
  const trimmed = baseUrlDraft.trim();
  if (trimmed === lastSavedUrlRef.current) return;

  isSavingRef.current = true;
  lastSavedUrlRef.current = trimmed; // 乐观锁定，阻止 onBlur 重复触发

  persistProviderPatch({ baseUrl: trimmed }).finally(() => {
    isSavingRef.current = false;
  });
};
```

### 4. 修复 DEF-04：调整 `handleSaveVendorName` 的调用顺序
仅在写盘成功回执后，才同步本地辅助 Profile 缓存：
```tsx
const res = await modelsCatalogStore.updateProvider(selected.id, {
  displayName: trimmed,
});
if (!res.ok) {
  notify(false, res.error || t('models.probe.vendorNameSaveFailed'));
} else {
  upsertProfile({ ...selected, name: trimmed }); // 仅在成功时同步
  _refresh();
}
```

---

## 五、审计结论与推进判定

- **总体定性**：本次模型设置持久化改造在**切断双轨写盘**与**消除 Store 永久死锁（loaded=false）**两大核心系统级毒点上成效显著，底层架构方向完全正确。
- **阻断项要求**：当前仓库存在两处阻断（**DEF-01** 单测红灯与 **DEF-02** 行数门禁超标），且存在 **DEF-03** 并发写盘与 **DEF-04** 失败版本撕裂隐患。
- **推进建议**：必须在进行下一轮任务交付前，优先将 DEF-01、DEF-02、DEF-03、DEF-04 修复收口，并补齐 Plan 01 的自动化单元测试。
