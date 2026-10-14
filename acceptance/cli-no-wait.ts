import { runCli } from "../src/cli-main";

const NO_WAIT_MS = 0;

await runCli({ now: () => new Date(), heldRecordWaitMs: NO_WAIT_MS });
