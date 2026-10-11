import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { claudeDir, type Env } from "./paths";

export function listInstalledSkills(env: Env = process.env): Set<string> {
  const root = join(claudeDir(env), "skills");
  if (!existsSync(root)) return new Set();
  return new Set(readdirSync(root).filter((entry) => existsSync(join(root, entry, "SKILL.md"))));
}
