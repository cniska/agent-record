import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { type ErrorRecord, errorRecord, isRefusal } from "./coded-error";
import { writeTransaction } from "./db";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./db-schema";
import { createIngester, type FileSpec, type SourceFile } from "./ingest";
import { type ArchiveReport, archiveRootOf, archiveSources } from "./ingest-archive";
import { type GitReport, ingestCommits, probeCheckouts, repoRoots } from "./ingest-git";
import { listSource, SESSION_SOURCES, type SessionSource } from "./ingest-sources";
import { TOOLS, type Tool } from "./ingest-tools";
import type { Env } from "./paths";
import { indexRepoFiles, type RepoFileReport } from "./repo-files";

export type SyncReport = {
  archive: ArchiveReport;
  sources: { tool: Tool; files: number }[];
  filesRead: number;
  orphanSubagents: string[];
  failures: { path: string; error: ErrorRecord }[];
  dropped: { path: string; lines: number[] }[];
  git: GitReport;
  repoFiles: RepoFileReport;
};

export function sync(db: Database, env: Env = process.env): SyncReport {
  const ingester = createIngester(db);
  const sessionExists = db.prepare<{ one: number }, [string]>("SELECT 1 AS one FROM session WHERE id = ?");
  const setTitle = db.prepare<void, [string, string]>(
    "UPDATE session SET title = ? WHERE id = ? AND title IS NULL",
  );

  const report: SyncReport = {
    archive: { files: 0, bytes: 0 },
    sources: [],
    filesRead: 0,
    orphanSubagents: [],
    failures: [],
    dropped: [],
    git: { repos: 0, commits: 0, files: 0, unchanged: 0 },
    repoFiles: { repos: 0, files: 0, unchanged: 0 },
  };

  const fail = (path: string, error: unknown): void => {
    if (!isRefusal(error)) throw error;
    report.failures.push({ path, error: errorRecord(error) });
  };

  const run = (spec: FileSpec): boolean => {
    try {
      const result = ingester.ingestFile(spec);
      if (result.read) report.filesRead += 1;
      if (result.dropped.length > 0) report.dropped.push({ path: spec.path, lines: result.dropped });
      return result.reset;
    } catch (error) {
      fail(spec.path, error);
      return false;
    }
  };

  const titlesOf = (source: SessionSource, root: string): ReadonlyMap<string, string> | undefined => {
    if (!source.titles) return undefined;
    const path = join(root, source.titles.file);
    try {
      return source.titles.read(path);
    } catch (error) {
      fail(path, error);
      return undefined;
    }
  };

  report.archive = archiveSources(env, fail, ingester.resetFileSession);

  for (const tool of TOOLS) {
    const source = SESSION_SOURCES[tool];
    const root = archiveRootOf(tool, env);
    const files = listSource(source, root, fail);
    const titles = titlesOf(source, root);
    const ingest = (file: SourceFile): boolean => {
      const reset = run({ ...file, tool });
      const title = titles?.get(file.sessionId);
      if (title) writeTransaction(db, () => setTitle.run(title, file.sessionId));
      return reset;
    };
    const resetSessions = new Set<string>();
    const linked: SourceFile[] = [];
    for (const listed of files) {
      const orphan = listed.parentId !== null && !sessionExists.get(listed.parentId);
      if (orphan) report.orphanSubagents.push(listed.sessionId);
      const file = orphan ? { ...listed, parentId: null } : listed;
      linked.push(file);
      if (ingest(file)) resetSessions.add(file.sessionId);
    }
    for (const file of linked) {
      if (resetSessions.has(file.sessionId)) ingest(file);
    }
    report.sources.push({ tool, files: files.length });
  }

  const checkouts = probeCheckouts(repoRoots(db), fail);
  report.git = ingestCommits(db, checkouts, fail);
  report.repoFiles = indexRepoFiles(db, checkouts, fail);
  return report;
}

function tablesWhere(db: Database, condition: string): readonly string[] {
  return db
    .query<{ name: string }, []>(
      `SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND ${condition}`,
    )
    .all()
    .map((row) => row.name);
}

function dropEveryTable(db: Database): void {
  for (const name of tablesWhere(db, "sql LIKE 'CREATE VIRTUAL TABLE%'")) db.run(`DROP TABLE "${name}"`);
  for (const name of tablesWhere(db, "1")) db.run(`DROP TABLE "${name}"`);
}

export function rebuild(db: Database, env: Env = process.env): SyncReport {
  db.run("PRAGMA foreign_keys = OFF");
  try {
    writeTransaction(db, () => {
      dropEveryTable(db);
      db.run(SCHEMA_SQL);
    });
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }
  const report = sync(db, env);
  writeTransaction(db, () => db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`));
  return report;
}
