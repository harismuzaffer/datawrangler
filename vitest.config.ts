import { defineConfig } from "vitest/config";

// Kept apart from vite.config.ts so unit tests run in plain Node without the Worker and React plugins.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"]
  }
});
