const WORKTREE_SEGMENT = "/.claude/worktrees/";

export type Worktree = { readonly project: string; readonly name: string };

export function worktreeAt(path: string | null): Worktree | null {
  if (!path) return null;
  const at = path.indexOf(WORKTREE_SEGMENT);
  if (at === -1) return null;
  const rest = path.slice(at + WORKTREE_SEGMENT.length);
  const name = rest.split("/")[0];
  return name ? { project: path.slice(0, at), name } : null;
}

export const worktreeOf = (path: string | null): string | null => worktreeAt(path)?.name ?? null;

export function projectOf(cwd: string | null): string | null {
  if (!cwd) return null;
  return worktreeAt(cwd)?.project ?? cwd;
}

export const worktreeCheckout = (worktree: Worktree): string =>
  `${worktree.project}${WORKTREE_SEGMENT}${worktree.name}`;

export const withoutWorktree = (col: string): string => {
  const at = `instr(${col}, '${WORKTREE_SEGMENT}')`;
  const root = `substr(${col}, 1, ${at} - 1)`;
  const rest = `substr(${col}, ${at} + ${WORKTREE_SEGMENT.length})`;
  const tail = `instr(${rest}, '/')`;
  return `CASE
  WHEN ${at} = 0 THEN ${col}
  WHEN ${tail} = 0 THEN ${root}
  ELSE ${root} || substr(${rest}, ${tail})
  END`;
};
