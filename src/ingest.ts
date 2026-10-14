import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { unreachable } from "./assert";
import { writeTransaction } from "./db";
import { gitRuns } from "./git-operations";
import type { SessionId, ToolCallId } from "./ingest-ids";
import { type ReadResult, readNewLines } from "./ingest-read-new";
import { advance, type Position } from "./ingest-read-plan";
import type { ChunkParser, ParsedChunk, SessionFacts, ToolCallRow } from "./ingest-session-records";
import type { SkillLoadRow } from "./ingest-skill-load";
import type { Kind, Tool } from "./ingest-tools";
import type { Timestamp } from "./timestamp";
import { projectOf, worktreeOf } from "./worktree";

export type FileSpec = SourceFile & { readonly tool: Tool };

export type SourceFile = {
  readonly path: string;
  readonly kind: Kind;
  readonly sessionId: SessionId;
  readonly parentId: SessionId | null;
  readonly agentType: string | null;
  readonly parse: ChunkParser;
};

type FileResult = ReadResult & { readonly reset: boolean };

type Cursor = Position & { readonly path: string };

const FROM_ANOTHER_FILE = "message.src_file IS NOT excluded.src_file";

const MERGED_TEXT = `CASE
  WHEN ${FROM_ANOTHER_FILE} THEN excluded.text
  WHEN excluded.text IS NULL THEN message.text
  WHEN message.text IS NULL THEN excluded.text
  ELSE message.text || char(10) || excluded.text END`;

const CURSOR_COLUMNS = "path, bytes_ingested AS bytes, lines_ingested AS lines, cursor_state AS state";

type FoldedSession = {
  cwd: string | null;
  gitBranch: string | null;
  cliVersion: string | null;
  entrypoint: string | null;
  tsFirst: Timestamp | null;
  tsLast: Timestamp | null;
  title: string | null;
};

function foldSession(facts: readonly SessionFacts[]): FoldedSession {
  const out: FoldedSession = {
    cwd: null,
    gitBranch: null,
    cliVersion: null,
    entrypoint: null,
    tsFirst: null,
    tsLast: null,
    title: null,
  };
  for (const f of facts) {
    if (f.ts) {
      if (!out.tsFirst || f.ts < out.tsFirst) out.tsFirst = f.ts;
      if (!out.tsLast || f.ts > out.tsLast) out.tsLast = f.ts;
    }
    out.cwd ??= f.cwd;
    out.entrypoint ??= f.entrypoint;
    if (f.gitBranch) out.gitBranch = f.gitBranch;
    if (f.cliVersion) out.cliVersion = f.cliVersion;
    if (f.title) out.title = f.title;
  }
  return out;
}

function bitOf(value: boolean | null): number | null {
  if (value === null) return null;
  return value ? 1 : 0;
}

export function createIngester(db: Database, home: string) {
  const selectCursor = db.prepare<Cursor, [string]>(
    `SELECT ${CURSOR_COLUMNS} FROM source_file WHERE path = ?`,
  );
  const selectSessionFiles = db.prepare<Cursor, [string, string]>(
    `SELECT ${CURSOR_COLUMNS} FROM source_file WHERE session_id = ? AND kind = ?`,
  );
  const movePath = db.prepare<void, [string, string]>("UPDATE source_file SET path = ? WHERE path = ?");
  const insertSourceFile = db.prepare<void, [string, string, string, string]>(
    `INSERT INTO source_file (path, tool, kind, session_id)
     VALUES (?, ?, ?, ?) ON CONFLICT(path) DO NOTHING`,
  );
  const upsertSession = db.prepare(
    `INSERT INTO session (id, tool, parent_id, agent_type, cwd, worktree, project, git_branch, cli_version,
       entrypoint, ts_first, ts_last, title)
     VALUES ($id, $tool, $parent, $agentType, $cwd, $worktree, $project, $gitBranch, $cliVersion,
       $entrypoint, $tsFirst, $tsLast, $title)
     ON CONFLICT(id) DO UPDATE SET
       parent_id    = coalesce(session.parent_id, excluded.parent_id),
       agent_type   = coalesce(session.agent_type, excluded.agent_type),
       cwd          = coalesce(session.cwd, excluded.cwd),
       worktree     = coalesce(session.worktree, excluded.worktree),
       project      = coalesce(session.project, excluded.project),
       git_branch   = coalesce(excluded.git_branch, session.git_branch),
       cli_version  = coalesce(excluded.cli_version, session.cli_version),
       entrypoint   = coalesce(session.entrypoint, excluded.entrypoint),
       ts_first     = min(coalesce(session.ts_first, excluded.ts_first),
                          coalesce(excluded.ts_first, session.ts_first)),
       ts_last      = max(coalesce(session.ts_last, excluded.ts_last),
                          coalesce(excluded.ts_last, session.ts_last)),
       title        = coalesce(excluded.title, session.title)`,
  );

  const upsertMessage = db.prepare(
    `INSERT INTO message (id, session_id, ts, role, model, turn_id, prompt_source, origin_kind,
       is_meta, is_skill_body, attribution_skill, slash_command, denial_kind,
       user_feedback, text, text_chars, src_file, src_line, extra)
     VALUES ($id, $sessionId, $ts, $role, $model, $turnId, $promptSource, $originKind,
       $isMeta, $isSkillBody, $attributionSkill, $slashCommand, $denialKind,
       $userFeedback, $text, $textChars, $srcFile, $srcLine, $extra)
     ON CONFLICT(id) DO UPDATE SET
       ts                     = min(message.ts, excluded.ts),
       model                  = coalesce(excluded.model, message.model),
       turn_id                = coalesce(excluded.turn_id, message.turn_id),
       prompt_source          = coalesce(excluded.prompt_source, message.prompt_source),
       origin_kind            = coalesce(excluded.origin_kind, message.origin_kind),
       is_meta                = max(message.is_meta, excluded.is_meta),
       is_skill_body          = max(message.is_skill_body, excluded.is_skill_body),
       attribution_skill      = coalesce(excluded.attribution_skill, message.attribution_skill),
       denial_kind            = coalesce(excluded.denial_kind, message.denial_kind),
       user_feedback          = coalesce(excluded.user_feedback, message.user_feedback),
       slash_command           = coalesce(excluded.slash_command, message.slash_command),
       text                   = ${MERGED_TEXT},
       text_chars             = length(${MERGED_TEXT}),
       src_file               = excluded.src_file,
       src_line               = CASE WHEN ${FROM_ANOTHER_FILE} THEN excluded.src_line
                                  ELSE min(message.src_line, excluded.src_line) END,
       extra                  = coalesce(excluded.extra, message.extra)`,
  );

  const insertUsage = db.prepare(
    `INSERT INTO usage (response_id, session_id, message_id, ts, model, input_tokens,
       cache_read_tokens, cache_write_tokens, output_tokens, attribution_skill)
     VALUES ($responseId, $sessionId, $messageId, $ts, $model, $inputTokens,
       $cacheReadTokens, $cacheWriteTokens, $outputTokens, $attributionSkill)
     ON CONFLICT(response_id) DO UPDATE SET
       message_id            = excluded.message_id,
       ts                    = excluded.ts,
       model                 = excluded.model,
       input_tokens          = excluded.input_tokens,
       cache_read_tokens     = excluded.cache_read_tokens,
       cache_write_tokens    = excluded.cache_write_tokens,
       output_tokens         = excluded.output_tokens,
       attribution_skill     = excluded.attribution_skill
     WHERE excluded.output_tokens > usage.output_tokens`,
  );

  const upsertTurn = db.prepare(
    `INSERT INTO turn (session_id, turn_id, ts_start, ts_end, duration_ms, message_count,
       status, model, time_to_first_token_ms)
     VALUES ($sessionId, $turnId, $tsStart, $tsEnd, $durationMs, $messageCount,
       $status, $model, $timeToFirstTokenMs)
     ON CONFLICT(session_id, turn_id) DO UPDATE SET
       ts_start               = min(coalesce(turn.ts_start, excluded.ts_start),
                                    coalesce(excluded.ts_start, turn.ts_start)),
       ts_end                 = max(coalesce(turn.ts_end, excluded.ts_end),
                                    coalesce(excluded.ts_end, turn.ts_end)),
       duration_ms            = coalesce(excluded.duration_ms, turn.duration_ms),
       message_count          = coalesce(excluded.message_count, turn.message_count),
       status                 = excluded.status,
       model                  = coalesce(excluded.model, turn.model),
       time_to_first_token_ms = coalesce(excluded.time_to_first_token_ms, turn.time_to_first_token_ms)`,
  );

  const upsertCall = db.prepare(
    `INSERT INTO tool_call (id, session_id, message_id, model, attribution_skill, ts_call,
       tool_name, skill_name, file_path, command, src_file, src_line_call)
     VALUES ($id, $sessionId, $messageId, $model, $attributionSkill, $ts,
       $toolName, $skillName, $filePath, $command, $srcFile, $srcLine)
     ON CONFLICT(id) DO UPDATE SET
       message_id        = coalesce(excluded.message_id, tool_call.message_id),
       model             = coalesce(excluded.model, tool_call.model),
       attribution_skill = coalesce(excluded.attribution_skill, tool_call.attribution_skill),
       ts_call           = excluded.ts_call,
       tool_name         = coalesce(excluded.tool_name, tool_call.tool_name),
       skill_name        = coalesce(excluded.skill_name, tool_call.skill_name),
       file_path         = coalesce(excluded.file_path, tool_call.file_path),
       command           = coalesce(excluded.command, tool_call.command),
       src_file          = excluded.src_file,
       src_line_call     = excluded.src_line_call`,
  );

  const upsertDetail = db.prepare(
    `INSERT INTO tool_call (id, session_id, tool_name, file_path, command, src_file)
     VALUES ($id, $sessionId, $toolName, $filePath, $command, $srcFile)
     ON CONFLICT(id) DO UPDATE SET
       tool_name = coalesce(excluded.tool_name, tool_call.tool_name),
       file_path = coalesce(excluded.file_path, tool_call.file_path),
       command   = coalesce(excluded.command, tool_call.command),
       src_file  = excluded.src_file`,
  );

  const upsertResult = db.prepare(
    `INSERT INTO tool_call (id, session_id, ts_result, tool_name, is_error, is_interrupted, exit_code,
       duration_ms, result_bytes, src_file, src_line_result)
     VALUES ($id, $sessionId, $ts, $toolName, $isError, $isInterrupted, $exitCode,
       $durationMs, $resultBytes, $srcFile, $srcLine)
     ON CONFLICT(id) DO UPDATE SET
       ts_result       = excluded.ts_result,
       tool_name       = coalesce(excluded.tool_name, tool_call.tool_name),
       is_error        = coalesce(excluded.is_error, tool_call.is_error),
       is_interrupted  = coalesce(excluded.is_interrupted, tool_call.is_interrupted),
       exit_code       = coalesce(excluded.exit_code, tool_call.exit_code),
       duration_ms     = coalesce(excluded.duration_ms, tool_call.duration_ms),
       result_bytes    = coalesce(excluded.result_bytes, tool_call.result_bytes),
       src_file        = excluded.src_file,
       src_line_result = excluded.src_line_result`,
  );

  const clearGitCommands = db.prepare("DELETE FROM git_command WHERE tool_call_id = ?");
  const insertGitCommand = db.prepare(
    "INSERT INTO git_command (tool_call_id, position, subcommand, dir) VALUES (?, ?, ?, ?)",
  );
  const selectSessionCwd = db.prepare<{ cwd: string | null }, [string]>(
    "SELECT cwd FROM session WHERE id = ?",
  );

  const skillLoadConflict = `ON CONFLICT(session_id, anchor_id, skill_name, how) DO UPDATE SET
       body_chars  = coalesce(excluded.body_chars, skill_load.body_chars),
       body_sha256 = coalesce(excluded.body_sha256, skill_load.body_sha256),
       skill_path  = coalesce(excluded.skill_path, skill_load.skill_path),
       model       = coalesce(excluded.model, skill_load.model)`;
  const insertSkillLoad = db.prepare(
    `INSERT INTO skill_load (session_id, tool_call_id, ts, model, skill_name, how)
     VALUES ($sessionId, $toolCallId, $ts, $model, $skillName, $how)
     ${skillLoadConflict}`,
  );
  const insertTypedSkillBody = db.prepare(
    `INSERT INTO skill_load (session_id, message_id, ts, model, skill_name, how,
       body_chars, body_sha256, skill_path)
     SELECT $sessionId, id, ts, model,
       CASE WHEN slash_command = $skillName OR slash_command LIKE '%:' || $skillName
         THEN slash_command ELSE $skillName END, 'user',
       $bodyChars, $bodySha256, $skillPath
     FROM message
     WHERE id = $parentUuid
     ${skillLoadConflict}`,
  );
  const insertCalledSkillBody = db.prepare(
    `INSERT INTO skill_load (session_id, tool_call_id, ts, model, skill_name, how,
       body_chars, body_sha256, skill_path)
     SELECT $sessionId, id, ts_call, model, skill_name, 'model',
       $bodyChars, $bodySha256, $skillPath
     FROM tool_call
     WHERE id = $toolCallId AND tool_name = 'Skill' AND ts_call IS NOT NULL AND skill_name IS NOT NULL
     ${skillLoadConflict}`,
  );

  const deleteSkillLoads = db.prepare<void, [string]>("DELETE FROM skill_load WHERE session_id = ?");
  const deleteToolCalls = db.prepare<void, [string]>("DELETE FROM tool_call WHERE session_id = ?");
  const deleteTurns = db.prepare<void, [string]>("DELETE FROM turn WHERE session_id = ?");
  const deleteUsage = db.prepare<void, [string]>("DELETE FROM usage WHERE session_id = ?");
  const deleteMessages = db.prepare<void, [string]>("DELETE FROM message WHERE session_id = ?");
  const clearTranscriptFields = db.prepare<void, [string]>(
    `UPDATE session SET agent_type = NULL, cwd = NULL, worktree = NULL, project = NULL, git_branch = NULL,
       cli_version = NULL, entrypoint = NULL, ts_first = NULL, ts_last = NULL, title = NULL
     WHERE id = ?`,
  );
  const resetCursors = db.prepare<void, [string]>(
    "UPDATE source_file SET bytes_ingested = 0, lines_ingested = 0, cursor_state = NULL WHERE session_id = ?",
  );

  function clearSession(sessionId: string): void {
    deleteSkillLoads.run(sessionId);
    deleteToolCalls.run(sessionId);
    deleteTurns.run(sessionId);
    deleteUsage.run(sessionId);
    deleteMessages.run(sessionId);
    clearTranscriptFields.run(sessionId);
    resetCursors.run(sessionId);
  }

  const selectFileSession = db.prepare<{ session_id: string }, [string]>(
    "SELECT session_id FROM source_file WHERE path = ?",
  );

  function resetFileSession(path: string): void {
    const row = selectFileSession.get(path);
    if (row) writeTransaction(db, () => clearSession(row.session_id));
  }

  function writeToolCall(t: ToolCallRow, spec: FileSpec): void {
    switch (t.kind) {
      case "call":
        upsertCall.run({
          $id: t.id,
          $sessionId: spec.sessionId,
          $messageId: t.messageId,
          $model: t.model,
          $attributionSkill: t.attributionSkill,
          $ts: t.ts,
          $toolName: t.toolName,
          $skillName: t.skillName,
          $filePath: t.filePath,
          $command: t.command,
          $srcFile: spec.path,
          $srcLine: t.srcLine,
        });
        return;
      case "detail":
        upsertDetail.run({
          $id: t.id,
          $sessionId: spec.sessionId,
          $toolName: t.toolName,
          $filePath: t.filePath,
          $command: t.command,
          $srcFile: spec.path,
        });
        return;
      case "result":
        upsertResult.run({
          $id: t.id,
          $sessionId: spec.sessionId,
          $ts: t.ts,
          $toolName: t.toolName,
          $isError: bitOf(t.isError),
          $isInterrupted: bitOf(t.isInterrupted),
          $exitCode: t.exitCode,
          $durationMs: t.durationMs,
          $resultBytes: t.resultBytes,
          $srcFile: spec.path,
          $srcLine: t.srcLine,
        });
        return;
      default:
        unreachable(t);
    }
  }

  function writeSkillLoad(l: SkillLoadRow, spec: FileSpec): void {
    switch (l.kind) {
      case "called":
        insertSkillLoad.run({
          $sessionId: spec.sessionId,
          $toolCallId: l.toolCallId,
          $ts: l.ts,
          $model: l.model,
          $skillName: l.skillName,
          $how: l.how,
        });
        return;
      case "called-body":
        insertCalledSkillBody.run({
          $sessionId: spec.sessionId,
          $toolCallId: l.toolCallId,
          $bodyChars: l.bodyChars,
          $bodySha256: l.bodySha256,
          $skillPath: l.skillPath,
        });
        return;
      case "typed-body":
        insertTypedSkillBody.run({
          $sessionId: spec.sessionId,
          $parentUuid: l.parentUuid,
          $skillName: l.skillName,
          $bodyChars: l.bodyChars,
          $bodySha256: l.bodySha256,
          $skillPath: l.skillPath,
        });
        return;
      default:
        unreachable(l);
    }
  }

  function writeGitCommands(id: ToolCallId, command: string, cwd: string | null): void {
    clearGitCommands.run(id);
    for (const [position, { subcommand, dir }] of gitRuns(command, { cwd, home }).entries()) {
      insertGitCommand.run(id, position, subcommand, dir);
    }
  }

  function applyChunk(spec: FileSpec, parsed: ParsedChunk, to: Position): void {
    insertSourceFile.run(spec.path, spec.tool, spec.kind, spec.sessionId);
    const s = foldSession(parsed.session);
    upsertSession.run({
      $id: spec.sessionId,
      $tool: spec.tool,
      $parent: spec.parentId,
      $agentType: spec.agentType,
      $cwd: s.cwd,
      $worktree: worktreeOf(s.cwd),
      $project: projectOf(s.cwd),
      $gitBranch: s.gitBranch,
      $cliVersion: s.cliVersion,
      $entrypoint: s.entrypoint,
      $tsFirst: s.tsFirst,
      $tsLast: s.tsLast,
      $title: s.title,
    });

    for (const m of parsed.messages) {
      upsertMessage.run({
        $id: m.id,
        $sessionId: spec.sessionId,
        $ts: m.ts,
        $role: m.role,
        $model: m.model,
        $turnId: m.turnId,
        $promptSource: m.promptSource,
        $originKind: m.originKind,
        $isMeta: m.isMeta ? 1 : 0,
        $isSkillBody: m.isSkillBody ? 1 : 0,
        $attributionSkill: m.attributionSkill,
        $slashCommand: m.slashCommand,
        $denialKind: m.denialKind,
        $userFeedback: m.userFeedback,
        $text: m.text,
        $textChars: m.text === null ? null : m.text.length,
        $srcFile: spec.path,
        $srcLine: m.srcLine,
        $extra: m.extra,
      });
    }

    for (const u of parsed.usage) {
      insertUsage.run({
        $responseId: u.responseId,
        $sessionId: spec.sessionId,
        $messageId: u.messageId,
        $ts: u.ts,
        $model: u.model,
        $inputTokens: u.inputTokens,
        $cacheReadTokens: u.cacheReadTokens,
        $cacheWriteTokens: u.cacheWriteTokens,
        $outputTokens: u.outputTokens,
        $attributionSkill: u.attributionSkill,
      });
    }

    for (const t of parsed.turns) {
      upsertTurn.run({
        $sessionId: spec.sessionId,
        $turnId: t.turnId,
        $tsStart: t.tsStart,
        $tsEnd: t.tsEnd,
        $durationMs: t.durationMs,
        $messageCount: t.messageCount,
        $status: t.status,
        $model: t.model,
        $timeToFirstTokenMs: t.timeToFirstTokenMs,
      });
    }

    const cwd = selectSessionCwd.get(spec.sessionId)?.cwd ?? null;
    for (const t of parsed.toolCalls) {
      writeToolCall(t, spec);
      if (t.kind !== "result" && t.command) writeGitCommands(t.id, t.command, cwd);
    }

    for (const l of parsed.skillLoads) writeSkillLoad(l, spec);

    db.run(
      `UPDATE source_file SET bytes_ingested = ?, lines_ingested = ?,
         cursor_state = ?,
         ingested_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE path = ?`,
      [to.bytes, to.lines, to.state, spec.path],
    );
  }

  function commit(spec: FileSpec, reset: boolean, parsed: ParsedChunk, to: Position): void {
    writeTransaction(db, () => {
      if (reset) clearSession(spec.sessionId);
      applyChunk(spec, parsed, to);
    });
  }

  return {
    cursorOf: (path: string): Cursor | null => selectCursor.get(path),
    sessionFiles: (sessionId: SessionId, kind: Kind): readonly Cursor[] =>
      selectSessionFiles.all(sessionId, kind),
    moveCursor: (to: string, from: string) => writeTransaction(db, () => movePath.run(to, from)),
    resetSession: (sessionId: SessionId) => writeTransaction(db, () => clearSession(sessionId)),
    commit,
    resetFileSession,
  };
}

export type Ingester = ReturnType<typeof createIngester>;

function claimMovedCursor(ingester: Ingester, spec: FileSpec): Cursor | null {
  const name = basename(spec.path);
  const moved = ingester
    .sessionFiles(spec.sessionId, spec.kind)
    .find((row) => basename(row.path) === name && !existsSync(row.path));
  if (moved === undefined) return null;
  ingester.moveCursor(spec.path, moved.path);
  return moved;
}

export function ingestFile(ingester: Ingester, spec: FileSpec): FileResult {
  const { reset, from, chunk } = readNewLines(
    spec.path,
    ingester.cursorOf(spec.path) ?? claimMovedCursor(ingester, spec),
  );
  if (from === null) {
    if (reset) ingester.resetSession(spec.sessionId);
    return { read: false, reset, dropped: [] };
  }
  const parsed = spec.parse(chunk.lines, from.lines + 1, from.state);
  const to = advance(from, chunk, parsed.cursorState);
  ingester.commit(spec, reset, parsed, to);
  return { read: true, reset, dropped: parsed.dropped };
}
