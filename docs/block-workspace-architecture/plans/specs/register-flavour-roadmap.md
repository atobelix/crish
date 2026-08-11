# M4 · registerFlavour 主路径路线图

EL-07：TS 扩展一等 → **自定义块类型为主路线图项**（非永久备选）。

| 阶段 | 内容                                                            |
| ---- | --------------------------------------------------------------- |
| F0   | 接口草稿：`registerFlavour({ id, schema, blockView?, slash? })` |
| F1   | RS schema 扩展注册表 + 未知 flavour 占位块（已有 Unknown）      |
| F2   | View 轨渲染自定义块；写仍走 Op                                  |
| F3   | 打包分发 / TrustGate                                            |

W0 产出：本文件 + `plans/interfaces` 可增 `FlavourRegistration` TS 类型草稿。  
实现不得把第三方块永久锁死在「只能装饰内置 flavour」。
