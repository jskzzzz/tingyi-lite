import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // This suite spawns real helper processes and hashes payloads that add up to roughly a
    // gigabyte of ASR runtimes, so a single test can be starved well past the 5s default when
    // the files run in parallel. Tests that are inherently expensive carry their own larger
    // budget (see the native ASR runtime cases) and still assert the same behaviour.
    testTimeout: 30_000
  }
});
