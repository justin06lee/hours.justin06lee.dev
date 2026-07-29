import { defineConfig } from "vitest/config";

export default defineConfig({
  // Native tsconfig `paths` resolution, so `@/lib/...` works in tests without
  // an extra plugin.
  resolve: { tsconfigPaths: true },
  test: { environment: "node" },
});
