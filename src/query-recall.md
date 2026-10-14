# Search recall

`query-recall.test.ts` measures search. Each case is a `query search` an agent ran and the message it then opened with `query thread`; the test checks that the message ranks within the first five hits, and fails when that rate drops below its pinned `BASELINE`.

The cases sit in `query-recall.fixture.json` with every word replaced by a code, so the test needs no live record.

`bun run search-recall` takes the cases again from the live record, rewrites the fixture, and prints the rate over the live record and over the fixture, with each miss's words. Re-pin `BASELINE` from what it prints.
