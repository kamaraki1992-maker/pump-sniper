import "dotenv/config";
import { loadConfig } from "./config.js";
import { buildRuntime } from "./run.js";

const config = loadConfig();
if (config.mode !== "live" && config.mode !== "paper") {
  process.stderr.write("panic-sell could not read MODE\n");
  process.exit(1);
}
const runtime = await buildRuntime(config);
process.stdout.write(
  JSON.stringify({
    action: "panic-sell",
    mode: config.mode,
    openPositions: runtime.positions.list().length,
  }) + "\n",
);
await runtime.bot.panicSell();
runtime.positions.save(runtime.sol.price(), config.paper, new Date().toISOString());
process.stdout.write(JSON.stringify({ action: "panic-sell", status: "done" }) + "\n");
