// Vitest configuration (M1-1). Node is the default environment; component
// tests opt into jsdom with a `// @vitest-environment jsdom` docblock.
// The `@/` alias mirrors tsconfig.json so tests can import app modules.
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)));

export default defineConfig({
  resolve: {
    alias: [{ find: "@", replacement: root }],
  },
  test: {
    environment: "node",
  },
});
