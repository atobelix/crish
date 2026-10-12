# Third-Party Software Licenses and Notices

Crish / Conex depends on open-source libraries from the Rust and JavaScript/TypeScript ecosystems.
This document lists the licenses governing these third-party dependencies.

---

## 1. Primary License Distribution

The majority of dependencies in this project are licensed under permissive open-source licenses:

- **MIT License** (e.g., `serde`, `tokio`, `react`, `zustand`, `vite`, `tauri`)
- **Apache License, Version 2.0** (e.g., `reqwest`, `tracing`, `syntect`)
- **BSD 2-Clause / 3-Clause Licenses** (e.g., `pulldown-cmark`, `d3-*`)
- **ISC License**
- **Unicode License Agreement (Unicode-DFS-2016)**

---

## 2. Weak Copyleft Dependencies (Mozilla Public License 2.0)

In accordance with Section 3.1 and 3.2 of the **Mozilla Public License, Version 2.0 (MPL-2.0)**, the following dependencies are incorporated in unmodified library form:

### Rust Crates (Cargo)

- `bitmaps` (MPL-2.0+)
- `cssparser` (MPL-2.0)
- `cssparser-macros` (MPL-2.0)
- `im` (MPL-2.0+)
- `sized-chunks` (MPL-2.0+)

### JavaScript / Node Tooling (Build & Dev Dependencies)

- `lightningcss` and platform binaries (MPL-2.0)
- `@parcel/watcher` (MPL-2.0)

_Notice: No modifications have been made to the source code of any MPL-2.0 licensed components. Source code for each respective upstream crate/package is available via its corresponding crates.io or npm registry listing._

---

## 3. Font Assets (SIL Open Font License 1.1)

The bundled web fonts are licensed under the **SIL Open Font License 1.1**:

- **Inter** — Copyright (c) 2016-2024 Rasmus Andersson
- **JetBrains Mono** — Copyright (c) 2020 JetBrains s.r.o.
- **IBM Plex** — Copyright (c) 2017-2024 IBM Corp.

Full copyright text and attribution are documented in [`NOTICE`](NOTICE).

---

## 4. Full License Texts Reference

For the complete text of each license type, please visit:

- **MIT**: https://opensource.org/licenses/MIT
- **Apache-2.0**: https://www.apache.org/licenses/LICENSE-2.0
- **BSD-3-Clause**: https://opensource.org/licenses/BSD-3-Clause
- **MPL-2.0**: https://www.mozilla.org/MPL/2.0/
- **OFL-1.1**: https://scripts.sil.org/OFL
