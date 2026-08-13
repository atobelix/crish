# H4-B · intent 幂等诚实句（选项 B）

| 元数据   | 值                                             |
| -------- | ---------------------------------------------- |
| **包**   | LR-H4-B（`00` §4 行 5；`01` LR-04 **选项 B**） |
| **日期** | 2026-08-13                                     |
| **本波** | 只写诚实句。**不做** H4-A intent 落盘          |

## 写死

- intent 幂等 **仅进程内**（`StoreNoteBackend.intents: Mutex<HashMap<…>>`）。
- 杀进程 / 重开 `workspace.db` **可双插**。HashMap **不**随库复活。
- **A-SURF-06 挡关**：不得用进程内 `send_intent_idempotent_*` / `x01_*` 关。
- 产品 / 工具 **禁止**宣称跨会话「不双插 / 不丢 intent」。

## ≠

- **≠** 假装已落盘
- **≠** 关 EL
- **≠** 改表 A 关闭列

入库验收句见 `plans/acceptance/pseudo-assert-register.md` §5。

_2026-08-13 · LR-H4-B · 选项 B 挡关；intent **未**落盘。_
