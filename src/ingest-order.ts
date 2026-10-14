import type { SourceFile } from "./ingest";
import type { SessionId } from "./ingest-ids";

export function parentsFirst(files: readonly SourceFile[]): readonly SourceFile[] {
  const listed = new Map<SessionId, SourceFile>();
  for (const file of files) if (!listed.has(file.sessionId)) listed.set(file.sessionId, file);
  const ordered = new Set<SourceFile>();
  const place = (file: SourceFile, waiting: ReadonlySet<SourceFile>): void => {
    if (ordered.has(file) || waiting.has(file)) return;
    const parent = file.parentId === null ? undefined : listed.get(file.parentId);
    if (parent !== undefined) place(parent, new Set([...waiting, file]));
    ordered.add(file);
  };
  for (const file of files) place(file, new Set());
  return [...ordered];
}
