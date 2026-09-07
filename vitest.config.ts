import { defineConfig } from "vitest/config";
import path from "path";
import fs from "fs";

function loadDotEnv(filePath: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return env;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    env[match[1]] = value;
  }
  return env;
}

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    globals: false,
    env: loadDotEnv(path.resolve(__dirname, ".env")),
    // DB-backed integration tests go over the network to a real (pooled) Postgres
    // instance, which can be considerably slower than the 5s default.
    testTimeout: 20000,
  },
});
