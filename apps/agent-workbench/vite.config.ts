import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@crish/agent-runtime": resolve(__dirname, "../../packages/agent-runtime/src/index.ts")
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
