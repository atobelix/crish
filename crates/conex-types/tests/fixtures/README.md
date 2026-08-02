# conex-types 测试 golden fixture 管理规范

> 归属：PE-11 T11.3（契约测试统一规范）/ PE-03 T03.10（事件 schema 版本化）
> 本文是事件 golden fixture 的**唯一管理规范**（T11.3 产出，fixture 变更走
> 本规范 + 33-event-schema-changelog.md 双登记）。

## 目录结构

```
tests/
├── fixtures/
│   ├── events-v1/                 # v1 基线事件样本（24 事件每类 ≥1 条）
│   │   ├── event-<type>.json      #   文件名 = 事件类型名（type_name 一致性门禁）
│   │   └── frame-with-runid-sequence.json   # 完整信封帧（runId/sequence）
│   └── README.md                  # 本文件
├── common/mod.rs                  # 统一访问辅助（fixture / v1_fixture / v1_fixture_dir）
├── events_roundtrip.rs            # 24 事件穷举 roundtrip + 03 §5.1 硬依赖字段锚定
└── events_schema_version.rs       # schema 版本化兼容（v1 旧帧解析 / schemaVersion 语义）
```

## 规则

1. **单一访问入口**：所有测试经 `tests/common/mod.rs` 的 `fixture()` /
   `v1_fixture()` / `v1_fixture_dir()` 读取样本（`mod common;` 声明后复用），
   禁止各测试文件自造路径拼接（第二套实现即违规）。
2. **清单 SoT**：事件类型清单 = `events_schema_version.rs` 的 `V1_EVENT_TYPES`
   （与 `docs/rust-rewrite/33-event-schema-changelog.md` v1 表逐条对应）；
   变体数一致性（24 == 清单 == fixtures == changelog）由测试锁定。
3. **新增事件三步门禁**（缺一即测试失败）：
   ① 登记 changelog（33 号文档：版本 | 事件 | 字段变更 | 兼容性 | 依据）；
   ② 加入 `V1_EVENT_TYPES` 清单；③ 补 `event-<type>.json` v1 样本。
4. **v1 样本形状**：无 `schemaVersion` 字段的旧帧（向后兼容解析测试依赖）；
   字段取最小集 + 硬依赖表（03-frontend-contract.md §5.1）锚定值；
   变更关键字段（如 RuntimeError `error: String` → 对象）时先建兼容解析
   测试（v1 样本不动），新形状另立样本并登记 changelog。
5. **golden 变更审查**：修改 / 新增 / 删除 fixture 属契约变更，必须同步
   changelog 登记，并显式审查（对齐 PE-03 T03.8「golden 变更必须显式更新」），
   拒绝「更新后隐式吞 diff」。

## 运行门禁

| 命令                                                         | 覆盖                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| `cargo test -p conex-types`                                  | roundtrip 穷举 + v1 旧帧解析 + schemaVersion 语义（T11.3 验收 V4） |
| `cargo test -p agent-workbench --test event_bridge_contract` | emit 载荷 16 项硬依赖 + schemaVersion 注入（壳侧锚定）             |
