#!/usr/bin/env node

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const TARGET = join("worker", "package.json");

let root = process.cwd();
while (!existsSync(join(root, TARGET))) {
  const parent = resolve(root, "..");
  if (parent === root) {
    console.error(`Unable to locate ${TARGET} from ${process.cwd()}`);
    process.exit(1);
  }
  root = parent;
}

const workerDir = join(root, "worker");
console.log(`[build] Installing worker dependencies in ${workerDir}`);

execSync("npm install --no-progress --no-audit --prefer-offline", {
  cwd: workerDir,
  stdio: "inherit",
});

