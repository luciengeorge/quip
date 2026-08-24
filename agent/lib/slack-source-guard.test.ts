import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const projectRoot = new URL("../..", import.meta.url).pathname;
const forbiddenNames = [
  ["SLACK", "BOT", "TOKEN"].join("_"),
  ["SLACK", "X", "CHANNEL", "ID"].join("_"),
];

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (
      entry.name.endsWith(".ts") ||
      entry.name.endsWith(".md") ||
      entry.name.endsWith(".json") ||
      entry.name === ".env.example"
    ) {
      files.push(path);
    }
  }
  return files;
}

test("source files contain no legacy Slack credential or channel variables", async () => {
  const violations: string[] = [];
  for (const file of await sourceFiles(projectRoot)) {
    const contents = await readFile(file, "utf8");
    for (const forbiddenName of forbiddenNames) {
      if (contents.includes(forbiddenName)) violations.push(`${file}: ${forbiddenName}`);
    }
  }

  assert.deepEqual(violations, []);
});
