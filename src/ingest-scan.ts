import { existsSync } from "node:fs";
import { Glob } from "bun";

export function scan(root: string, globs: readonly string[]): string[] {
  if (!existsSync(root)) return [];
  const paths = new Set<string>();
  for (const glob of globs) {
    for (const path of new Glob(glob).scanSync({ cwd: root, absolute: true })) paths.add(path);
  }
  return [...paths].toSorted((a, b) => a.localeCompare(b));
}
