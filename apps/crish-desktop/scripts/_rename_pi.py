from pathlib import Path

# --- clientApi.ts ---
p = Path(__file__).resolve().parents[1] / "src" / "api" / "clientApi.ts"
t = p.read_text(encoding="utf-8")

repls = [
    (
        "const SETTINGS_KEY = 'conex_pi_settings'",
        "const SETTINGS_KEY = 'crish_settings'\nconst SETTINGS_KEY_LEGACY = 'conex_pi_settings'",
    ),
    (
        "const PROVIDERS_KEY = 'conex_pi_providers'",
        "const PROVIDERS_KEY = 'crish_providers'\nconst PROVIDERS_KEY_LEGACY = 'conex_pi_providers'",
    ),
    (
        "const CRON_KEY = 'conex_pi_cron'",
        "const CRON_KEY = 'crish_cron'\nconst CRON_KEY_LEGACY = 'conex_pi_cron'",
    ),
    (
        "const MCP_KEY = 'conex_pi_mcp'",
        "const MCP_KEY = 'crish_mcp'\nconst MCP_KEY_LEGACY = 'conex_pi_mcp'",
    ),
    (
        "const TRUSTED_FOLDERS_KEY = 'conex_pi_trusted_folders'",
        "const TRUSTED_FOLDERS_KEY = 'crish_trusted_folders'\nconst TRUSTED_FOLDERS_KEY_LEGACY = 'conex_pi_trusted_folders'",
    ),
    ("export const piClientApi = {", "export const clientApi = {"),
    ("piClientApi.", "clientApi."),
    ("conex_pi_project_settings_", "crish_project_settings_"),
]
for a, b in repls:
    if a not in t:
        print("MISS:", a[:70])
    else:
        t = t.replace(a, b)

helper = '''
function lsGet(key: string, legacy?: string): string | null {
  try {
    const v = localStorage.getItem(key);
    if (v != null) return v;
    if (legacy) {
      const old = localStorage.getItem(legacy);
      if (old != null) {
        localStorage.setItem(key, old);
        return old;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

'''
if "function lsGet" not in t:
    t = t.replace("function initDb", helper + "function initDb")

t = t.replace(
    "localStorage.getItem(SETTINGS_KEY)",
    "lsGet(SETTINGS_KEY, SETTINGS_KEY_LEGACY)",
)
t = t.replace(
    "localStorage.getItem(PROVIDERS_KEY)",
    "lsGet(PROVIDERS_KEY, PROVIDERS_KEY_LEGACY)",
)
t = t.replace(
    "localStorage.getItem(CRON_KEY)",
    "lsGet(CRON_KEY, CRON_KEY_LEGACY)",
)
t = t.replace(
    "localStorage.getItem(MCP_KEY)",
    "lsGet(MCP_KEY, MCP_KEY_LEGACY)",
)
t = t.replace(
    "localStorage.getItem(TRUSTED_FOLDERS_KEY)",
    "lsGet(TRUSTED_FOLDERS_KEY, TRUSTED_FOLDERS_KEY_LEGACY)",
)

if "export const piClientApi" not in t.split("export const clientApi")[-1]:
    t += "\n\n/** @deprecated use clientApi */\nexport const piClientApi = clientApi;\n"

p.write_text(t, encoding="utf-8")
print("clientApi written")

# --- RuntimePanel.tsx ---
p2 = Path(__file__).resolve().parents[1] / "src" / "components" / "RuntimePanel.tsx"
t2 = p2.read_text(encoding="utf-8")
t2 = t2.replace("../api/piClientApi", "../api/clientApi")
t2 = t2.replace("PiRuntimePanelProps", "RuntimePanelProps")
t2 = t2.replace("export const PiRuntimePanel", "export const RuntimePanel")
t2 = t2.replace("piClientApi", "clientApi")
p2.write_text(t2, encoding="utf-8")
print("RuntimePanel written")

# --- bulk import rewrites ---
root = Path(__file__).resolve().parents[1] / "src"
for f in root.rglob("*"):
    if f.suffix not in {".ts", ".tsx"}:
        continue
    if f.name in {"clientApi.ts", "piClientApi.ts", "_rename_pi.py"}:
        continue
    txt = f.read_text(encoding="utf-8")
    orig = txt
    txt = txt.replace("from '../api/piClientApi'", "from '../api/clientApi'")
    txt = txt.replace('from "../api/piClientApi"', 'from "../api/clientApi"')
    txt = txt.replace("from './api/piClientApi'", "from './api/clientApi'")
    txt = txt.replace("from './piClientApi'", "from './clientApi'")
    txt = txt.replace("piClientApi", "clientApi")
    txt = txt.replace("from './PiRuntimePanel'", "from './RuntimePanel'")
    txt = txt.replace("from '../components/PiRuntimePanel'", "from '../components/RuntimePanel'")
    txt = txt.replace("PiRuntimePanel", "RuntimePanel")
    txt = txt.replace("piSettings", "appSettings")
    txt = txt.replace("setPiSettings", "setAppSettings")
    txt = txt.replace("'pi-runtime'", "'runtime'")
    txt = txt.replace('"pi-runtime"', '"runtime"')
    txt = txt.replace("pi-runtime", "runtime")
    txt = txt.replace("Pi Telemetry", "运行状态")
    txt = txt.replace("Pi Settings", "App Settings")
    if txt != orig:
        f.write_text(txt, encoding="utf-8")
        print("updated", f.relative_to(root))

print("done")
