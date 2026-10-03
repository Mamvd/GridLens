import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

// Unit tests live in test/unit/ OUTSIDE src/ — tsc -b (tsconfig.app.json
// includes src/*) never typechecks them; vitest owns that surface.
// node environment + hand-rolled localStorage/fetch stubs in setup.ts —
// no jsdom/happy-dom dependency.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(root, "src") },
  },
  test: {
    environment: "node",
    include: ["test/unit/**/*.test.ts"],
    setupFiles: ["test/unit/setup.ts"],
  },
});
