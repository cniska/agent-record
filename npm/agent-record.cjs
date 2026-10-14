#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { join } = require("node:path");

const manifest = require("../package.json");
const supported = Object.keys(manifest.optionalDependencies);
const platformPackage = `@cniska/agent-record-${process.platform}-${process.arch}`;

function refuse(code, message, resolve) {
  const error = { kind: "refusal", code, message, meta: {}, resolve };
  process.stderr.write(`${JSON.stringify({ command: "agent-record", ok: false, error })}\n`);
  process.exit(1);
}

if (!supported.includes(platformPackage)) {
  refuse(
    "no_build_for_platform",
    `agent-record ships no build for ${process.platform}-${process.arch}, only ${supported.join(" and ")}`,
    "build agent-record from source with Bun, as its README says",
  );
}

let baseline;
try {
  baseline = require.resolve(`${platformPackage}/agent-record`);
} catch {
  refuse(
    "platform_package_missing",
    `${platformPackage} is not installed beside @cniska/agent-record`,
    "reinstall @cniska/agent-record with optional dependencies enabled",
  );
}

const child = spawn(join(__dirname, "..", "launcher.sh"), process.argv.slice(2), {
  stdio: "inherit",
  env: {
    ...process.env,
    AGENT_RECORD_BASELINE_BIN: baseline,
    AGENT_RECORD_BASELINE_VERSION: manifest.version,
    AGENT_RECORD_LAUNCHER: process.argv[1],
  },
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  refuse(
    "launcher_failed",
    `the launcher could not start: ${error.message}`,
    "reinstall @cniska/agent-record",
  );
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
