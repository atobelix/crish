import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@crish/agent-runtime": resolve(__dirname, "../../packages/agent-runtime/src/index.ts"),
    },
  },
  build: { target: "es2022" },
});
