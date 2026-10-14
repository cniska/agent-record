import { describe, expect, test } from "bun:test";
import { type Call, openedHits } from "./query-recall-pairs.test-support";

const call = (at: string, command: string, session = "s1"): Call => ({ session, at, command });

describe("opened hits", () => {
  test("pair a thread opened at a time with the search run before it", () => {
    expect(
      openedHits([
        call("2026-10-09T14:21:19Z", 'agent-record query search "cloud network secrets" 2>&1 | head -30'),
        call("2026-10-09T14:21:29Z", "agent-record query thread 8b3b0f4c-18b5 --at 2026-10-09T12:32:35.880Z"),
      ]),
    ).toEqual([
      {
        session: "s1",
        searchedAt: "2026-10-09T14:21:19Z",
        words: "cloud network secrets",
        prefix: "8b3b0f4c-18b5",
        at: "2026-10-09T12:32:35.880Z",
      },
    ]);
  });

  test("read the older binary's name and the id@time reference, quoted or not", () => {
    const hits = openedHits([
      call("2026-10-03T13:09:26Z", "cd ~/x && dim query search 'record wins over the branch' | jq ."),
      call("2026-10-03T13:17:14Z", 'dim query thread "1b59dced@2026-09-30T14:54" | jq .'),
      call("2026-10-03T13:17:20Z", "dim query thread 1b59dced@2026-09-30T14:56:01.000Z"),
    ]);
    expect(hits.map((hit) => [hit.words, hit.prefix, hit.at])).toEqual([
      ["record wins over the branch", "1b59dced", "2026-09-30T14:54"],
      ["record wins over the branch", "1b59dced", "2026-09-30T14:56:01.000Z"],
    ]);
  });

  test("read --at among other flags", () => {
    const hits = openedHits([
      call("2026-10-13T07:25:28Z", 'agent-record query search "sync fixtures" --rows 15'),
      call(
        "2026-10-13T07:25:40Z",
        "agent-record query thread fb1b5c7c --rows 15 --at 2026-10-13T07:24:07.317Z",
      ),
    ]);
    expect(hits.map((hit) => hit.at)).toEqual(["2026-10-13T07:24:07.317Z"]);
  });

  test("never pair a thread with a search in the same command, which it could not have read", () => {
    expect(
      openedHits([
        call(
          "2026-10-13T07:25:28Z",
          'agent-record query search "sync" ; agent-record query thread fb1b5c7c --at 2026-10-13T07:24',
        ),
      ]),
    ).toEqual([]);
  });

  test("drop a thread whose search is ambiguous: several in one command, or words from a variable", () => {
    expect(
      openedHits([
        call("2026-10-03T09:59:24Z", 'for q in "a b" "c"; do dim query search "$q"; done'),
        call("2026-10-03T09:59:41Z", "dim query thread 019ce89d@2026-03-14T10:46:35.962Z"),
        call("2026-10-03T10:00:00Z", 'dim query search "one" ; dim query search "two"'),
        call("2026-10-03T10:00:10Z", "dim query thread 019ce89d@2026-03-14T10:46:35.962Z"),
      ]),
    ).toEqual([]);
  });

  test("drop a thread with no time, a time coarser than a minute, or a time from a variable", () => {
    expect(
      openedHits([
        call("2026-10-12T05:34:19Z", 'agent-record query search "lexer split"'),
        call("2026-10-12T05:34:31Z", "agent-record query thread 0d805d5c"),
        call("2026-10-12T05:34:32Z", "agent-record query thread 0d805d5c --at 2026-10-12T"),
        call("2026-10-12T05:34:33Z", 'agent-record query thread "0d805d5c@2026-10-12T$t"'),
      ]),
    ).toEqual([]);
  });

  test("never carry a search into another session", () => {
    expect(
      openedHits([
        call("2026-10-12T05:34:19Z", 'agent-record query search "lexer split"', "s1"),
        call("2026-10-12T05:34:31Z", "agent-record query thread 0d805d5c --at 2026-10-12T03:32", "s2"),
      ]),
    ).toEqual([]);
  });

  test("pair each of several threads in one command with the search before it", () => {
    const hits = openedHits([
      call("2026-10-14T10:10:30Z", 'agent-record query search "addyosmani tiers evals" | head'),
      call(
        "2026-10-14T10:10:42Z",
        "agent-record query thread 7ba1ecb7 --at 2026-10-12T06:52:18.371Z; agent-record query thread b521a187 --at 2026-10-07T08:31:59.322Z",
      ),
    ]);
    expect(hits.map((hit) => hit.prefix)).toEqual(["7ba1ecb7", "b521a187"]);
  });
});
