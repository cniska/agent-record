export type Version = { readonly major: number; readonly minor: number; readonly patch: number };

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(text: string): Version | null {
  const [, major, minor, patch] = VERSION.exec(text) ?? [];
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

export function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function isNewer(candidate: string, than: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(than);
  return a !== null && b !== null && compareVersions(a, b) > 0;
}
