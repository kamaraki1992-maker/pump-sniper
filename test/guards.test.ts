import assert from "node:assert/strict";
import { test } from "node:test";
import { errorText, installProcessGuards, reportRejection } from "../src/guards.js";
import { Logger } from "../src/logger.js";

class Capture extends Logger {
  readonly entries: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  override error(message: string, fields?: Record<string, unknown>): void {
    this.entries.push({ message, fields });
  }
}

test("a rejected promise is logged and the guard can be removed", () => {
  const log = new Capture();
  assert.equal(errorText(new Error("boom-reject")), "boom-reject");
  reportRejection(log, new Error("boom-reject"));
  assert.equal(log.entries[0]?.message, "unhandled rejection");
  assert.equal(log.entries[0]?.fields?.error, "boom-reject");
  const remove = installProcessGuards(log);
  assert.equal(process.listenerCount("unhandledRejection") > 0, true);
  assert.equal(process.listenerCount("uncaughtException") > 0, true);
  remove();
});
