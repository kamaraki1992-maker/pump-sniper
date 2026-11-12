/**
 * Read-only sellability check. Builds a buy-then-sell and simulates it.
 * Nothing is signed or sent.
 *
 *   npx tsx scripts/sim-honeypot.ts <mint> [pump|pump-amm] [<mint> ...]
 */
import { loadConfig } from "../src/config.js";
import { createHoneypotCheck } from "../src/momentum/honeypot.js";

const args = process.argv.slice(2);
const jobs: Array<{ mint: string; pool: "pump" | "pump-amm" }> = [];
for (let i = 0; i < args.length; i += 1) {
  const mint = args[i]!;
  const next = args[i + 1];
  const pool = next === "pump" || next === "pump-amm" ? next : mint.endsWith("pump") ? "pump" : "pump-amm";
  if (next === "pump" || next === "pump-amm") i += 1;
  jobs.push({ mint, pool });
}
if (jobs.length === 0) {
  jobs.push(
    { mint: "EdEtnuUaTgXAd1izQT4Mt2dJFikN77vdd5xmCJvcpump", pool: "pump" },
    { mint: "5qaP7oKUqKffwwo5DaEqDoTtsBLMpdbQTxEkCDaTpump", pool: "pump-amm" },
  );
}

const config = loadConfig({
  DATA_DIR: "/tmp/sim-honeypot",
  KILL_FILE: "/tmp/sim-honeypot/KILL",
  RPC_URL: process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com",
  RUG_CHECK_RPC_URL: process.env.RUG_CHECK_RPC_URL ?? process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com",
  TRADE_API_URL: process.env.TRADE_API_URL ?? "https://pumpportal.fun/api/trade-local",
});
const check = createHoneypotCheck(config);

for (const job of jobs) {
  const started = Date.now();
  const verdict = await check(job.mint, job.pool);
  console.log(JSON.stringify({
    mint: job.mint,
    pool: verdict.pool ?? job.pool,
    ok: verdict.ok,
    reason: verdict.reason,
    simErr: verdict.simErr,
    simLog: verdict.simLog,
    ms: Date.now() - started,
  }));
}
