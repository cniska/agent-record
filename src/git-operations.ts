type ShellToken = { readonly kind: "word"; readonly text: string } | { readonly kind: "separator" };

const SEPARATORS = ["&&", "||", ";", "|", "\n"] as const;

const BLANK = /[ \t\r]/;

const DOUBLE_QUOTE_ESCAPES = new Set(['"', "\\", "$", "`"]);

const HEREDOC = "<<";

const HERESTRING = "<<<";

const LEADING_TABS = /^\t+/;

const CONTINUATION = "\\\n";

const COMMENT = "#";

function lexShell(command: string): ShellToken[] {
  let i = 0;
  const tokens: ShellToken[] = [];
  const heredocs: { delimiter: string; stripTabs: boolean }[] = [];

  function separator(): string | undefined {
    return SEPARATORS.find((sep) => command.startsWith(sep, i));
  }

  function singleQuoted(): string {
    const close = command.indexOf("'", i + 1);
    const end = close === -1 ? command.length : close;
    const text = command.slice(i + 1, end);
    i = end + 1;
    return text;
  }

  function doubleQuoted(): string {
    let text = "";
    i += 1;
    while (i < command.length && command.charAt(i) !== '"') {
      if (command.startsWith(CONTINUATION, i)) {
        i += CONTINUATION.length;
        continue;
      }
      if (command.charAt(i) === "\\" && DOUBLE_QUOTE_ESCAPES.has(command.charAt(i + 1))) i += 1;
      text += command.charAt(i);
      i += 1;
    }
    i += 1;
    return text;
  }

  function escaped(): string {
    if (command.startsWith(CONTINUATION, i)) {
      i += CONTINUATION.length;
      return "";
    }
    i += 2;
    return command.charAt(i - 1);
  }

  function comment(): void {
    const newline = command.indexOf("\n", i);
    i = newline === -1 ? command.length : newline;
  }

  function atWordEnd(): boolean {
    return (
      i >= command.length ||
      BLANK.test(command.charAt(i)) ||
      separator() !== undefined ||
      command.startsWith(HEREDOC, i)
    );
  }

  function word(): string {
    let text = "";
    while (!atWordEnd()) {
      const ch = command.charAt(i);
      if (ch === "'") text += singleQuoted();
      else if (ch === '"') text += doubleQuoted();
      else if (ch === "\\") text += escaped();
      else {
        text += ch;
        i += 1;
      }
    }
    return text;
  }

  function heredoc(): void {
    i += HEREDOC.length;
    const stripTabs = command.charAt(i) === "-";
    if (stripTabs) i += 1;
    while (BLANK.test(command.charAt(i))) i += 1;
    heredocs.push({ delimiter: word(), stripTabs });
  }

  function heredocBodies(): void {
    for (const { delimiter, stripTabs } of heredocs.splice(0)) {
      while (i < command.length) {
        const newline = command.indexOf("\n", i);
        const end = newline === -1 ? command.length : newline;
        const line = command.slice(i, end);
        i = end + 1;
        if ((stripTabs ? line.replace(LEADING_TABS, "") : line) === delimiter) break;
      }
    }
  }

  while (i < command.length) {
    const sep = separator();
    if (sep !== undefined) {
      tokens.push({ kind: "separator" });
      i += sep.length;
      if (sep === "\n") heredocBodies();
    } else if (command.startsWith(HERESTRING, i)) i += HERESTRING.length;
    else if (command.startsWith(HEREDOC, i)) heredoc();
    else if (command.startsWith(CONTINUATION, i)) i += CONTINUATION.length;
    else if (command.charAt(i) === COMMENT) comment();
    else if (BLANK.test(command.charAt(i))) i += 1;
    else tokens.push({ kind: "word", text: word() });
  }
  return tokens;
}

function commandsOf(tokens: readonly ShellToken[]): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  for (const token of tokens) {
    if (token.kind === "word") {
      words.push(token.text);
      continue;
    }
    commands.push(words);
    words = [];
  }
  commands.push(words);
  return commands;
}

const PREFIX = /^[A-Z_][A-Z0-9_]*=|^(?:sudo|time|command|nice)$/;

const GIT = /(?:^|\/)git$/;

const VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

const SUBCOMMAND = /^[a-z][a-z0-9-]*$/;

function subcommandOf(words: readonly string[]): string | null {
  const start = words.findIndex((word) => !PREFIX.test(word));
  if (start === -1 || !GIT.test(words[start] ?? "")) return null;
  for (let at = start + 1; at < words.length; at += 1) {
    const word = words[at] ?? "";
    if (VALUED.has(word)) at += 1;
    else if (!word.startsWith("-")) return SUBCOMMAND.test(word) ? word : null;
  }
  return null;
}

export function gitSubcommands(command: string): string[] {
  return commandsOf(lexShell(command))
    .map(subcommandOf)
    .filter((sub) => sub !== null);
}
