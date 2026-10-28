import { HELD_RECORD_WAIT_MS } from "../src/cli-main";
import { readingRecord } from "../src/db-read";
import { parseEnv } from "../src/env";
import { dbPath } from "../src/paths";
import {
  fixtureOf,
  fixtureRecord,
  liveCases,
  RECALL_FIXTURE,
  writeFixture,
} from "../src/query-recall-fixture.test-support";
import { type Recall, rankedCases, recallAt5, recallOf } from "../src/query-recall.test-support";

const rate = (recall: Recall): string => `${recall.found}/${recall.cases}`;

const { cases, live, fixture } = readingRecord(
  dbPath(parseEnv(process.env)),
  { heldRecordWaitMs: HELD_RECORD_WAIT_MS },
  (db) => {
    const found = liveCases(db);
    const ranked = rankedCases(db, found);
    return { cases: found, live: recallOf(found, ranked), fixture: fixtureOf(db, found, ranked) };
  },
);
writeFixture(fixture);
const pinned = fixtureRecord(fixture);
const offline = recallAt5(pinned, fixture.cases);
pinned.close();
const wordsOf = new Map(cases.map((recallCase) => [recallCase.id, recallCase.words]));
console.log(
  JSON.stringify({
    cases: cases.length,
    fixture: RECALL_FIXTURE,
    live: rate(live),
    offline: rate(offline),
    missedLive: live.missed.map((miss) => ({ ...miss, words: wordsOf.get(miss.id) ?? null })),
    missedOffline: offline.missed.map((miss) => ({ ...miss, words: wordsOf.get(miss.id) ?? null })),
  }),
);
