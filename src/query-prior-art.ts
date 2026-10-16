import { z } from "zod";
import { invariant } from "./assert";
import { readRows } from "./db";
import { select } from "./query";
import type { Query } from "./query-contract";
import { withoutWorktree } from "./worktree";

const PER_WHERE = 3;

const Counts = z.strictObject({ total: z.number(), checkouts: z.number(), indexed: z.number() });

const MATCHES = "instr(lower(path), lower(?)) > 0";

export const priorArt: Query<never> = {
  name: "prior-art",
  summary: "where a path like this one already exists across the repos on disk, newest first",
  usage: 'agent-record query prior-art "<path fragment>" [--rows <n>]',
  flags: [],
  run: (db, ctx) => {
    const fragment = ctx.arg;
    const result = select(
      db,
      `WITH matched AS (
         SELECT ${withoutWorktree("path")} AS path, ${withoutWorktree("checkout")} AS checkout
         FROM repo_file
         WHERE ${MATCHES}
       ),
       dated AS (
         SELECT m.path AS path,
                coalesce(min(c.label), replace(min(m.checkout), ? || '/', '')) AS "where",
                count(DISTINCT cf.sha) AS commits,
                cast(julianday('now') - julianday(max(rc.ts)) AS INTEGER) AS days_since,
                count(DISTINCT rc.author) AS authors
         FROM matched m
         LEFT JOIN (SELECT DISTINCT repo, label FROM repo_commit WHERE label IS NOT NULL) c
           ON c.repo = m.checkout
         LEFT JOIN commit_file cf ON cf.path = m.path
         LEFT JOIN repo_commit rc ON rc.sha = cf.sha
         GROUP BY m.path
       ),
       ranked AS (
         SELECT *, row_number() OVER (
           PARTITION BY "where" ORDER BY days_since IS NULL, days_since ASC, commits DESC
         ) AS rank_in_where
         FROM dated
       )
       SELECT replace(path, ? || '/', '') AS file, "where", commits, days_since, authors
       FROM ranked
       WHERE rank_in_where <= ${PER_WHERE}
       ORDER BY days_since IS NULL, days_since ASC, commits DESC`,
      [fragment, ctx.home, ctx.home],
    );

    const counts = readRows<[string]>(
      db,
      `WITH folded AS (
         SELECT ${withoutWorktree("path")} AS path, ${withoutWorktree("checkout")} AS checkout, ${MATCHES} AS hit
         FROM repo_file
       )
       SELECT count(DISTINCT path) FILTER (WHERE hit) AS total,
              count(DISTINCT checkout) FILTER (WHERE hit) AS checkouts,
              count(DISTINCT checkout) AS indexed
       FROM folded`,
    ).get(Counts, fragment);
    invariant(counts !== null, "a count returns one row");
    const { total, checkouts, indexed } = counts;
    return {
      denominator:
        `${total} tracked files match "${fragment}", in ${checkouts} of ${indexed} checkouts indexed` +
        (result.rows.length < total
          ? `; the ${PER_WHERE} most recently touched under each where are ranked`
          : ""),
      ...result,
      note:
        total === 0
          ? "nothing on disk matches; `agent-record sync` indexes the repos the corpus names, and only those"
          : "Recency and commit count, not quality: this cannot tell a file that was got right from one that was " +
            "abandoned, and a file copied between repos looks as settled as one that was worked out. A repo the " +
            "owner only cloned ranks beside their own, so read the where column, the repo's owner/name or else " +
            "the checkout's path, before the file. `days_since` is empty for a file no commit in the corpus has touched.",
    };
  },
};
