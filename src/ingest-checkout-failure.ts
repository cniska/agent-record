import { existsSync } from "node:fs";
import type { Failure } from "./ingest-contract";

export const skippingGoneCheckouts =
  (fail: Failure): Failure =>
  (checkout, error) => {
    if (existsSync(checkout)) fail(checkout, error);
  };
