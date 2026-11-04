import "dotenv/config";
import { ConfigError } from "./config.js";
import { runSniper } from "./run.js";

function maxRuntimeMs(argv: string[]): number | undefined {
  const index = argv.indexOf("--max-runtime-ms");
  if (index === -1) return undefined;
  const value = Number(argv[index + 1]);
  if (!Number.isFinite(value) || value < 0) {
    throw new ConfigError("--max-runtime-ms must be a positive number");
  }
  return value;
}

try {
  await runSniper({ maxRuntimeMs: maxRuntimeMs(process.argv.slice(2)) });
} catch (error) {
  const message = error instanceof Error ? error.message : "startup failed";
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
