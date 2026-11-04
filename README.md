# pump-sniper

A Solana mainnet watcher for new [pump.fun](https://pump.fun) launches. It filters creators and opens or closes one position per mint with fixed risk rules.

The process starts in **paper** mode. Paper mode simulates fills from the live stream and does not sign or send transactions. It does not need a wallet key. **Live** mode runs only when the environment variable `MODE` is exactly `live`. Every other value, including `LIVE`, `paper`, and an empty string, stays in paper mode. The process never switches mode by itself.

This is a trading tool with explicit loss rules. It does not promise fills or profits. Jito tips and slippage settings raise the chance a live bundle is accepted. They do not make a fill certain. Bundles expire, auctions drop low tips, and the curve can move through the slippage limit.

## Setup

Node.js 20 or newer.

```bash
npm install
cp .env.example .env
npm test
npm start
```

Paper mode is the useful first run. Leave `PRIVATE_KEY` empty.

Logs are JSON lines on stdout. Skipped launches include a `reason`. Filled and failed orders are appended to `data/trades.jsonl`. Open positions and unrealized PnL are written to `data/positions.json`.

Stop with `SIGTERM`, `SIGINT`, or by creating the `STOP` file (`touch STOP`). That shuts the socket and flushes state. It does not sell. Selling open positions is `npm run panic-sell`.

## Risk caps

These limits are constants in `src/config.ts`. The process exits on startup if the environment asks for more room. Changing the numbers means editing that file.

| Setting | Default | Hard bound |
| --- | --- | --- |
| Buy size | 0.1 SOL | `<= 0.1` SOL |
| Slippage | 20% | `<= 20%` |
| Jito tip | 0.002 SOL | `0.002` to `0.005` SOL |
| Take profit | +100% | sells 100% of the position |
| Stop loss | -20% | sells 100% of the position |
| Creator hold at launch | under 10% of supply | cannot be configured above 10% |
| Open positions | 1 | cannot be configured above 1 |

One position per mint, and at most one open position at a time. A buy that has been sent and is not confirmed yet holds that slot. A failed buy releases it. Further launches are skipped with reason `max_open_positions` (that line is logged at most once every 5 seconds). A failed buy is a failed record, not a position. Failed sells are retried with backoff. A sell that still does not land leaves the position open and tries again after a short cooldown.

In live mode the bot reads the wallet balance before sending a buy. It skips the buy when the balance is below the order size, the priority fee, the base fee, the Jito tip, and the same priority fee plus base fee kept for the sell. Paper mode does not read a wallet.

## Paper and live

Paper fills use the stream price, then apply adverse slippage (`PAPER_SLIPPAGE_PCT`, default 2%, capped by the slippage limit), a 1% protocol fee, a 0.25% venue fee, the priority fee, the base signature fee, and the Jito tip. Unrealized PnL uses the same exit model, in SOL and in USD. USD uses the CoinGecko SOL price, with Jupiter as a fallback.

Live mode loads `PRIVATE_KEY` from the environment, derives the public key locally, and discards the secret from every log line. The key is not sent to PumpDev. Before a live buy it checks the wallet balance as described above. See the assumptions below for why the live path is the local-sign bundle endpoint rather than server-signed Lightning.

`npm run panic-sell` sells every open position. In paper mode the sells are simulated and logged with reason `manual`. In live mode it submits real bundles and requires `MODE=live` plus `PRIVATE_KEY`.

## Reporting

```bash
npm run report -- --day 2026-11-04
```

The day is a calendar date in `Europe/Berlin`. The command prints one JSON object:

- `tradesTaken` — filled buys
- `wins` / `losses` — filled sells with positive or negative realized PnL
- `realizedPnlSol` / `realizedPnlUsd`
- `feesSol` / `tipsSol` — charged on filled rows
- `failedBuys` / `failedSells`
- `mode` — `paper`, `live`, `mixed`, or `none`

`data/trades.jsonl` is append-only. Each row has the timestamp, mode, mint, name, size, price, fees, Jito tip, signature (`paper` or a transaction signature), Solscan URL when there is a live signature, and reason (`entry`, `tp`, `sl`, `manual`).

## Layout

| Module | Role |
| --- | --- |
| `src/stream.ts` | PumpDev WebSocket, reconnect backoff |
| `src/pricing.ts` | Message adapter. Swap the parser to change data sources |
| `src/filter.ts` | Creator hold, dev-dump, and floor-rug decisions |
| `src/history.ts` | RPC lookup behind the filter |
| `src/executor-paper.ts` | Simulated fills |
| `src/executor-live.ts` | Sign locally, simulate, Jito `sendBundle` |
| `src/risk.ts` | Take-profit and stop-loss |
| `src/positions.ts` | Open positions and unrealized PnL |
| `src/report.ts` | JSONL log and daily summary |
| `src/config.ts` | Env parsing and hard caps |
| `src/redact.ts` | Strips the private key from text |

## Assumptions

Checked against PumpDev's public docs (`https://pumpdev.io/skill/pumpdev/references/endpoints.md`, the data API, and the Jito bundle pages) and a live socket sample.

**Stream.** `wss://pumpdev.io/ws`. Send `{ "method": "subscribeNewToken" }` and `{ "method": "subscribeTokenTrade", "keys": [mint] }`. Launches are `txType: "create"`. Trades are `buy` and `sell`. Frames with a `type` field are control messages and are ignored. Reconnect starts at 1s and caps at 30s, then resubscribes.

**Prices.** SOL-quoted creates observed on the socket carry `marketCapSol` and raw reserves: `vSolInBondingCurve` in lamports (`30000000000` = 30 SOL) and `vTokensInBondingCurve` in base units (`1073000000000000` = 1,073,000,000 tokens). Price is `marketCapSol / 1_000_000_000` when that field is present, otherwise virtual SOL divided by virtual tokens. Non-SOL quote mints are skipped. Sizing is in SOL, and a USDC-quoted curve is a different market.

**Creator hold.** `initialBuy` on the create event is the creator allocation in the launch transaction, in display tokens (the docs' sample of `67062500` is about 6.7% of the 1,000,000,000 supply). The bot skips when that share is 10% or more. A buy the creator sends in a later transaction is not part of this check. Those later buys are visible to the dev-dump check on the creator's *next* launch.

**Creator history.** `frontend-api-v3.pump.fun` answers this host with a Cloudflare challenge, so v1 does not use it. History comes from `getSignaturesForAddress` and `getTransaction` on `RPC_URL` (default public mainnet RPC), last 25 signatures. A prior launch is a transaction whose logs contain `Instruction: Create` or `Instruction: CreateV2`.

- **Dev dump.** The creator's peak balance in the first 2 minutes falls below half of that peak inside 15 minutes.
- **Rug.** The bonding-curve account (PDA `["bonding-curve", mint]` on `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`) is at least 30 minutes old, virtual reserves price it at or under 32 SOL (the curve opens near 27.96 SOL and cannot trade below that floor), and the creator's balance is at or under 10% of the peak. That is the on-curve version of "went to ~0". Graduated coins that die in the AMM are outside this view.
- If the RPC call fails, the launch is skipped with `creator-history-unavailable`. HTTP 429 is retried a few times before that. `getMultipleAccounts` returns `{ value: [...] }`, and the client unwraps that.

**Live trading.** `POST /api/trade-lightning` is server-signed. The documented body is `action`, `mint`, `amount`, `denominatedInSol`, and an optional `creator`. It does not take a Jito tip, a compute-unit limit, or a local private key. Auth is a PumpDev API key for a hosted wallet. `POST /api/bundle-lightning` adds `jitoTip` and sends through Jito, and it also signs with that hosted key.

v1 keeps the burner key local, so live orders use `POST /api/bundle` (`TRADE_API_URL`). The body is one account with the Lightning trade fields (`type`, `amount`, `denominatedInSol`, `creator`) plus top-level `mint`, `slippage`, and `jitoTip`, and `publicKey` instead of `apiKey`. The response is an unsigned transaction. The bot simulates it, sets the compute-unit limit from units consumed (20% headroom, plus 10,000, clamped), sets the compute-unit price from `PRIORITY_FEE_SOL`, adds a tip transfer to a random Jito tip account, signs with `PRIVATE_KEY`, and calls Jito `sendBundle` with base64 encoding. Landing is `getSignatureStatuses` until confirmed or `CONFIRM_TIMEOUT_MS` (default 20s). A bundle id by itself is not a fill. Sells use amount `100%`.

PumpDev's own notes say contested launch bundles often need tips above this bot's 0.005 SOL cap (they measured 0.03 SOL). Live bundles at 0.002–0.005 SOL can be accepted by the block engine and still never land. That shows up as `bundle-not-landed`.

**Fees in the paper model.** 100 bps protocol and 25 bps venue match PumpDev's published local-trade commission and the long-standing pump.fun fee. Pump.fun's fee schedule changes. Override `PAPER_PROTOCOL_FEE_BPS` and `PAPER_VENUE_FEE_BPS` if you want the simulator to track a different schedule. Live fee reporting prefers the wallet's SOL delta from the confirmed transaction when that transaction is readable.

## Tests

```bash
npm test
npm run typecheck
```

The tests cover the hard caps, take-profit and stop-loss, creator filter decisions, paper PnL, and private-key redaction.
