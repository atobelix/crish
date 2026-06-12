import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [preact()],
  resolve: {
    alias: {
      "@crish/agent-runtime": resolve(__dirname, "../../packages/agent-runtime/src/index.ts"),
      "react": "preact/compat",
      "react-dom": "preact/compat",
      "react/jsx-runtime": "preact/jsx-runtime"
    }
  },
  server: {
    port: 5194,
    strictPort: true
  },
  build: {
    target: "es2022"
  }
});
