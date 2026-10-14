import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { Env } from "./env";

const TEMP_ROOTS = [
  "/tmp",
  "/private/tmp",
  "/var/tmp",
  "/private/var/tmp",
  "/var/folders",
  "/private/var/folders",
];

function namedAndResolved(path: string): string[] {
  try {
    return [path, realpathSync(path)];
  } catch {
    return [path];
  }
}

export function isScratchRepo(path: string, { tmpDir }: Pick<Env, "tmpDir">): boolean {
  const target = resolve(path);
  return [...TEMP_ROOTS, ...namedAndResolved(resolve(tmpDir))].some(
    (root) => target === root || target.startsWith(`${root}/`),
  );
}
