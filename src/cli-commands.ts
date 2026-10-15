import type { Command } from "./cli-contract";

const LOADERS: Record<string, () => Promise<Command>> = {
  sync: () => import("./sync-command").then((m) => m.syncCommand),
  rebuild: () => import("./rebuild-command").then((m) => m.rebuildCommand),
  query: () => import("./query-command").then((m) => m.queryCommand),
  sql: () => import("./sql-command").then((m) => m.sqlCommand),
  agent: () => import("./agent-command").then((m) => m.agentCommand),
  doctor: () => import("./doctor-command").then((m) => m.doctorCommand),
};

export function findCommand(name: string | undefined): Promise<Command> | undefined {
  return name !== undefined && Object.hasOwn(LOADERS, name) ? LOADERS[name]?.() : undefined;
}

export function allCommands(): Promise<Command[]> {
  return Promise.all(Object.values(LOADERS).map((load) => load()));
}
