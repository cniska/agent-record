export type Call = { readonly session: string; readonly at: string; readonly command: string };

type OpenedHit = {
  readonly session: string;
  readonly searchedAt: string;
  readonly words: string;
  readonly prefix: string;
  readonly at: string;
};

type Search = Omit<OpenedHit, "prefix" | "at">;

const BINARY = String.raw`(?:agent-record|dim)\s+query`;
const ANY_SEARCH = /\bquery\s+search\b/g;
const LITERAL_SEARCH = new RegExp(String.raw`${BINARY}\s+search\s+(?:"([^"$]*)"|'([^']*)')`, "g");
const THREAD = new RegExp(String.raw`${BINARY}\s+thread\s+([^|;&]*)`, "g");
const TIME = String.raw`\d{4}-\d\d-\d\dT\d\d:\d\d[\d:.]*Z?`;
const REFERENCE = new RegExp(String.raw`^["']?([0-9a-f][0-9a-f-]{5,})(?:@(${TIME}))?["']?(?=\s|$)`);
const AT_FLAG = new RegExp(String.raw`--at\s+["']?(${TIME})["']?(?=\s|$)`);

function searchOf(call: Call): Search | null {
  const literal = [...call.command.matchAll(LITERAL_SEARCH)];
  const [only] = literal;
  if (only === undefined || literal.length !== 1 || call.command.match(ANY_SEARCH)?.length !== 1) return null;
  return { session: call.session, searchedAt: call.at, words: only[1] ?? only[2] ?? "" };
}

function referencesOf(command: string): readonly { readonly prefix: string; readonly at: string }[] {
  return [...command.matchAll(THREAD)].flatMap(([, args = ""]) => {
    const trimmed = args.trim();
    const reference = REFERENCE.exec(trimmed);
    if (reference?.[1] === undefined) return [];
    const at = reference[2] ?? AT_FLAG.exec(trimmed)?.[1];
    return at === undefined ? [] : [{ prefix: reference[1], at }];
  });
}

function inSession(search: Search | null, call: Call): Search | null {
  return search?.session === call.session ? search : null;
}

export function openedHits(calls: readonly Call[]): readonly OpenedHit[] {
  const hits: OpenedHit[] = [];
  let last: Search | null = null;
  for (const call of calls) {
    const before = inSession(last, call);
    if (before !== null)
      hits.push(...referencesOf(call.command).map((reference) => ({ ...before, ...reference })));
    last = call.command.match(ANY_SEARCH) === null ? before : searchOf(call);
  }
  return hits;
}
