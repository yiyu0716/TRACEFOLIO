// Modified for TRACEFOLIO (2026): deterministic encryption key for tests only.
import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: { LUJIE_SETTINGS_SECRET: "tracefolio-unit-test-key-00000000000000000000" },
    exclude: [...configDefaults.exclude, "tmp/**", "outputs/**", ".desktop/**", ".next/**", "src-tauri/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
