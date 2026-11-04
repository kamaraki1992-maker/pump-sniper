import "dotenv/config";
import { loadConfig } from "./config.js";
import { summarizeDay, TradeLog } from "./report.js";

function dayArg(argv: string[]): string {
  const index = argv.indexOf("--day");
  const value = index === -1 ? undefined : argv[index + 1];
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("usage: npm run report -- --day YYYY-MM-DD");
  }
  return value;
}

const config = loadConfig({ ...process.env, MODE: "paper", PRIVATE_KEY: undefined });
const day = dayArg(process.argv.slice(2));
const summary = summarizeDay(new TradeLog(config.tradesPath).readAll(), day);
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
