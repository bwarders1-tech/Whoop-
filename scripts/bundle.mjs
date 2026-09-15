#!/usr/bin/env node
/**
 * Stages the extension in build/whoop/ and, when a packer is available, writes
 * build/whoop.mcpb — the file Claude Desktop installs.
 *
 *   npm run build && npm run bundle
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(root, "build");
const stageDir = path.join(buildDir, "whoop");

async function main() {
  const compiled = path.join(root, "dist", "src", "index.js");
  if (!(await exists(compiled))) {
    throw new Error('dist/src/index.js is missing — run "npm run build" first.');
  }

  await fs.rm(stageDir, { recursive: true, force: true });
  await fs.mkdir(stageDir, { recursive: true });

  await fs.cp(path.join(root, "dist", "src"), path.join(stageDir, "server"), { recursive: true });
  await fs.copyFile(path.join(root, "manifest.json"), path.join(stageDir, "manifest.json"));
  await fs.copyFile(path.join(root, "README.md"), path.join(stageDir, "README.md"));

  // The bundle has to carry its own runtime dependencies.
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  await fs.writeFile(
    path.join(stageDir, "package.json"),
    `${JSON.stringify(
      {
        name: pkg.name,
        version: pkg.version,
        description: pkg.description,
        type: "module",
        main: "server/index.js",
        license: pkg.license,
        dependencies: pkg.dependencies,
      },
      null,
      2,
    )}\n`,
  );

  const install = spawnSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts"], {
    cwd: stageDir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (install.status !== 0) {
    throw new Error("Installing the bundle's production dependencies failed.");
  }
  await fs.rm(path.join(stageDir, "package-lock.json"), { force: true });

  const archive = path.join(buildDir, "whoop.mcpb");
  await fs.rm(archive, { force: true });

  if (pack(["npx", "--yes", "@anthropic-ai/mcpb", "pack", stageDir, archive]) || pack(["zip", "-r", "-q", archive, "."], stageDir)) {
    process.stdout.write(`\nPacked ${path.relative(root, archive)}\n`);
    return;
  }

  process.stdout.write(
    `\nStaged the extension in ${path.relative(root, stageDir)}.\n` +
      `Neither "npx @anthropic-ai/mcpb pack" nor "zip" was available, so the .mcpb archive was not created.\n` +
      `Install the packer with "npm i -g @anthropic-ai/mcpb" and run "mcpb pack ${path.relative(root, stageDir)}".\n`,
  );
}

function pack(command, cwd = process.cwd()) {
  const [bin, ...args] = command;
  const result = spawnSync(bin, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  return result.status === 0;
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
