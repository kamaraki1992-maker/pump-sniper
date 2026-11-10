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

`MAX_DAILY_LOSS_SOL` is off until it is set. It sums realized net PnL for the current Europe/Berlin day, after fees and tips, separately for paper and live, in `data/daily-pnl.json`. A restart keeps that total. At or below the limit the bot opens no new watches or buys. Open positions keep their normal exits. When the book is flat it logs `daily_stop` and writes `STOP_FILE`. `run-supervised.sh` treats that file as a clean exit and does not start the bot again. Unrealized PnL is not part of the total. The counter would reset at Berlin midnight, but the STOP file stays until someone removes it and starts the process again.

A websocket error, a gRPC error, or a rejected trade handler is logged. The data socket and the Helius account socket reconnect with backoff. An unhandled rejection does not exit the process. Open positions stay in `data/positions.json` across a restart. Paper mode is unchanged by a restart.

## Risk caps

These limits are constants in `src/config.ts`. The process exits on startup if the environment asks for more room. Changing the numbers means editing that file.

| Setting | Default | Hard bound |
| --- | --- | --- |
| Buy slippage | 5% | `<= 20%`. `MAX_SLIPPAGE_PCT` still fills in when `BUY_SLIPPAGE_PCT` is unset |
| Sell slippage | 10% | `<= 20%`. Same fallback when `SELL_SLIPPAGE_PCT` is unset |
| Jito tip | 1% of the trade, clamped to 0.0005–0.0015 SOL | hard floor `0.0005`, hard ceiling `0.005`. `JITO_TIP_SOL` is the legacy fixed tip only when the new keys are unset |
| Buy size | `BUY_SIZE_SOL` 0.15 when set, else $5 to $30 | USD path is the confidence score, hard cap `$30`. A fixed SOL size is refused when it prices above $30 |
| Stop loss | -20% from the entry fill | `<= 20%`, sells 100% on the mark that crosses it |
| Trailing stop | arms at +50%, trails 20% | stop is `max(entry, peak * 0.8)` and only ratchets up. `TRAIL_TIERS` is ignored |
| Take profit | +100%, sell 50% once | the other half stays on the trail (`TP1_PCT`, `TP1_SELL_FRACTION`) |
| Creator hold at launch | no more than 5% of supply | cannot be configured above 10% (`MAX_CREATOR_HOLD_PCT`) |
| Top 10 holders | 25% | bonding curve, its token account, and the pump AMM pool are excluded (`MAX_TOP10_PCT`) |
| Helius rate | 5 requests/second | shared token bucket (`HELIUS_RPS`), short cache, retry with jitter |
| Open positions | 5 | cannot be configured above 5 |
| Max hold | 10 min | sells 100% with reason `timeout` |
| Liquidity drop | 20% | sells 100% when curve SOL reserves fall by more than this from entry |
| Volume stall | 45 s after a 90 s grace | sells 100% when no trade has arrived since `max(entry + grace, last trade)` |
| Sell pressure | 3x | sells 100% when sells are at least 3x buys in 30 s, with at least 4 sells |

At most `MAX_OPEN_POSITIONS` positions are open at once, and only one position per mint. A buy that has been sent and is not confirmed yet holds a slot. A failed buy releases it. Further launches are skipped with reason `max_open_positions` (that line is logged at most once every 5 seconds). A failed buy is a failed record, not a position. Failed sells are resent as a new Jito bundle, up to `SELL_MAX_ATTEMPTS`, with a fresh blockhash. Stop, dev-sell, and fast-drop retries do not wait. A sell that still does not land leaves the position open. Exit checks share one in-flight sell per mint, so two signals cannot double-sell.

A new mint is watched instead of bought. `ENTRY_WATCH_MAX_SEC=0` keeps the old instant buy. Otherwise the bot buys on the first pass between `ENTRY_WATCH_MIN_SEC` (15) and `ENTRY_WATCH_MAX_SEC` (30): at least `ENTRY_MIN_BUYS` (8) buys from `ENTRY_MIN_UNIQUE_BUYERS` (5) wallets, excluding the creator and wallets that bought in the create transaction or the create slot; net buy SOL at least `ENTRY_MIN_NET_BUY_SOL` (1) and buy share at least `ENTRY_MIN_BUY_RATIO` (0.6); buys in at least two of the three buckets that divide the watch (a 5 second window uses buckets of about 1.7 seconds; `ENTRY_BUCKET_SEC` overrides that); price above the watch start and not more than `ENTRY_MAX_RUNUP_PCT` (60) above it. When `REQUIRE_SOCIALS` is on, the create metadata URI is fetched in parallel with the creator and top-10 checks. Each attempt waits about 1.2s (`METADATA_ATTEMPT_TIMEOUT_MS`) and then rotates to the next gateway (`ipfs.io`, `dweb.link`, `pump.mypinata.cloud`, or the URI itself) after a 300–500ms backoff. `METADATA_RETRY` (default true) keeps going until the document loads or the retry deadline. That deadline is `METADATA_RETRY_DEADLINE_SEC` when set, otherwise the entry watch window, and it stops a short margin before `ENTRY_WATCH_MAX_SEC` so the entry decision is not held past the watch. A JSON body with no valid Twitter/X or Telegram link is final (`no_socials`) and is not retried. A timeout or a failed fetch at the deadline skips with `metadata_unavailable`. Only a loaded result is cached. `ALLOW_NO_SOCIALS_ENTRY` keeps a token in the watch when that socials miss is the only failure. It can still pass the early and full entry gates, and the position is tagged `noSocials`. `NO_SOCIALS_TIME_STOP_SEC` and `NO_SOCIALS_MIN_GAIN_PCT` close it if the peak gain is still short of the target. A position that reached the gain, and every position that had socials, keeps the existing exits. pump.fun does not verify those links. The bot only checks that a Twitter/X or Telegram value is present and well-formed (`REQUIRE_SOCIALS_MODE=any`, or `both`). A creator sell drops the watch. At most `ENTRY_MAX_WATCHED` (30) mints are watched. A reject is logged as `entry_low_buyers`, `entry_low_volume`, `entry_burst`, `entry_runup`, `entry_creator_sold`, `entry_timeout`, or `entry_watch_full`. Holder and creator-history checks start when the watch starts. Paper buys use the curve reserves at the decision, not the create price.

Once a position is open, a sell from the creator wallet, or a drop in the creator's token balance, sells 100% with reason `dev_sell` (`DEV_SELL_EXIT`, default true). That outranks every other exit. A print at least `STOP_FAST_DROP_PCT` (12) below the previous mark sells immediately with reason `fast_drop`. If the peak has not reached `EARLY_EXIT_MIN_GAIN_PCT` (10) within `EARLY_EXIT_WINDOW_SEC` (5) of the fill, the bot sells 100% with reason `early_no_momentum`. `EARLY_EXIT_WINDOW_SEC=0` disables that timer. Stop, trail, and the 2x partial still run inside the window. Stop, fast-drop, and dev-sell fills use `SELL_SLIPPAGE_PCT` on the triggering print. The trade row stores the trigger price, the fill price, the tip, and `bundle: "jito"`. Every sell is a Jito bundle. Emergency exits tip `JITO_TIP_MAX_SOL`. The live stop path reuses the blockhash and priority fee cached while the position was open.

`PROFIT_LOCK_TRIGGER_PCT` and `PROFIT_LOCK_FLOOR_PCT` are off until both are set. After the peak reaches the trigger, the stop floor is that floor percent above the entry fill and never moves down. The hard stop still applies before the trigger. After +50% the existing trail can sit higher, and the exit uses whichever floor is higher. A profit-lock exit is reason `profit_lock` on the same Jito sell path. The hard stop sells 100% when the mark is at or below 80% of the entry fill (`STOP_LOSS_PCT=20`). It uses that fill, not a later mark. Once the peak reaches +50% (`TRAIL_ACTIVATE_PCT`), the stop becomes `max(entry, peak * 0.8)` (`TRAIL_DISTANCE_PCT=20`). That is break-even until the 20% trail is tighter, and it only ratchets up. A mark at or below that stop sells whatever is left, with reason `trailing_stop`. At +100% (`TP1_PCT`) the bot sells half (`TP1_SELL_FRACTION=0.5`) once and leaves the rest on the trail. Each partial row stores its own realized PnL, and `realizedPnlTotalSol` is the sum so far. `TRAIL_TIERS` and `TAKE_PROFIT_PCT` are ignored, with a deprecation log when they are set. After those price exits, the bot can still exit for a liquidity drop, sell pressure, a volume stall, or the 10 minute hold. Volume stall does not start at entry. `VOLUME_STALL_GRACE_SEC` (default 90) has to elapse first, and the 45 second silence window is then measured from `max(entry + grace, last trade)`. The hold and stall timers run about once a second, so a token with no trades still exits, just not in the first two minutes. The slot frees only after the remaining tokens are sold. Paper and live use the same exit rules, and a paper fill uses the reserves that produced the trigger mark. The log prints that mark next to the fill.

Jito bundles, a 5% buy slippage cap, and a 10% sell slippage cap reduce sandwich exposure. They do not guarantee that a fill is protected from MEV, and a bundle can still expire without landing. Paper fills apply those same caps.

When `RPC_WS_URL` is set, each open position `accountSubscribe`s (commitment `confirmed`) to its pump.fun bonding-curve account. Real SOL reserves are the u64 lamports at offset 32. A drop of more than `LIQ_DROP_PCT` from the first sample sells with `liquidity_drop` immediately. The subscription is removed when the position closes. The socket reconnects with backoff and resubscribes every open curve. If the URL is unset or the socket is down, the same exit uses virtual SOL from the trade stream. Logs strip the `api-key` query parameter and never print the raw URL.

Before a buy, the bot reads the mint account and rejects a set mint authority, a set freeze authority, a program other than SPL Token or Token-2022, and a Token-2022 mint with a transfer fee or transfer hook. It also requires a bonding-curve round trip to produce tokens and a `simulateTransaction` of the buy. A sell simulation that fails only because the wallet does not hold the mint yet is not a rejection. The whole check must finish within `SAFETY_CHECK_TIMEOUT_MS` (default 250). If it does not, the token is skipped and the measured latency is logged. Five milliseconds is not achievable over public RPC.

Buy size in dollars is `min + score * (max - min)`, then clamped to $30 and divided by the SOL/USD price. Hold and a passed safety check set the base: a clean launch with no creator hold and no prints scores 0.28 and sizes at $12. Net buy flow scales that base toward 1, so strong tokens land above $20 and an all-strong token lands at $30. Without safety the score is 0. The creator's own initial buy is the hold signal, not flow. Each buy log includes the component signals, the final score, the USD notional, and the SOL size. Fees and the Jito tip are charged on top of the SOL size. The tip is `clamp(size * JITO_TIP_PCT, JITO_TIP_MIN_SOL, JITO_TIP_MAX_SOL)` on buys and on the expected sell proceeds. The priority fee is unchanged. `BUY_SIZE_SOL` (0.15 in the example env) replaces the confidence size when it is set. `BUY_SIZE_PCT_OF_BALANCE` replaces both of those: the buy is that percent of total balance, still clamped to $30, and skipped below 0.005 SOL. In paper the total is `PAPER_START_BALANCE_SOL` plus realized PnL plus the cost basis of open positions, stored in `data/paper-balance.json`. In live it is the wallet balance (cached 10 seconds) plus open cost, minus `LIVE_BALANCE_RESERVE_SOL` (0.02). A buy is skipped with `insufficient_balance` when free SOL does not cover the size plus fees and tip. `ENTRY_EARLY_SEC` and `ENTRY_EARLY_MIN_NET_BUY_SOL` must be set together, with the early time below `ENTRY_WATCH_MAX_SEC`. At that time the bot can buy if net buy SOL meets the early threshold and the other gates, including socials, are already verified. Otherwise it waits and uses `ENTRY_MIN_NET_BUY_SOL` at the end of the watch. The buy log records `entryStage` `early` or `full`. If the SOL/USD price is missing or older than 60 seconds the buy is skipped with reason `no_price`. The bot does not substitute a guessed price. Live mode still checks the wallet in SOL, including the SOL reserved to exit positions that are already open.

In live mode the bot reads the wallet balance before sending a buy. It skips the buy when the balance is below the order size, the priority fee, the base fee, the Jito tip, and the same priority fee plus base fee kept for the sell. Paper mode does not read a wallet.

## Paper and live

Paper fills use the stream price, then apply adverse slippage (`PAPER_SLIPPAGE_PCT`, default 2%, capped at 5% on buys and 10% on sells), a 1% protocol fee, a 0.25% venue fee, the estimated priority fee (the same clamped Helius quote, or `PRIORITY_FEE_SOL` when the quote fails), the base signature fee, and the Jito tip. Unrealized PnL uses the same exit model, in SOL and in USD. USD uses the CoinGecko SOL price, with Jupiter as a fallback.

Live mode loads `PRIVATE_KEY` from the environment, derives the public key locally, and discards the secret from every log line. The key is not sent to PumpDev. Before a live buy it checks the wallet balance as described above. See the assumptions below for why the live path is the local-sign bundle endpoint rather than server-signed Lightning.

`npm run panic-sell` sells every open position. In paper mode the sells are simulated and logged with reason `manual`. In live mode it submits real bundles and requires `MODE=live` plus `PRIVATE_KEY`.

## Reporting

```bash
npm run report -- --day 2026-11-04
```

The day is a calendar date in `Europe/Berlin`. The command prints one JSON object:

- `tradesTaken` — filled buys
- `wins` / `losses` — filled sells with positive or negative realized PnL, except `timeout`
- `timeouts` — filled sells with reason `timeout`
- `exits` — filled sell counts by reason (`tp`, `sl`, `trailing_stop`, `timeout`, `liquidity_drop`, `volume_stall`, `sell_pressure`, `manual`)
- `buySize` — count, min, max, and average SOL of filled buys
- `scores` — count, min, median, max, and average confidence on filled buys
- `realizedPnlSol` / `realizedPnlUsd`
- `feesSol` / `tipsSol` — charged on filled rows
- `failedBuys` / `failedSells`
- `mode` — `paper`, `live`, `mixed`, or `none`

`data/trades.jsonl` is append-only. Each row has the timestamp, mode, mint, name, size, price, fees, Jito tip, signature (`paper` or a transaction signature), Solscan URL when there is a live signature, confidence on buys, and reason (`entry`, `tp`, `sl`, `trailing_stop`, `timeout`, `liquidity_drop`, `volume_stall`, `sell_pressure`, `manual`).

## Layout

| Module | Role |
| --- | --- |
| `src/stream.ts` | PumpPortal data WebSocket by default (`FEED=pumpportal`). `FEED=pumpdev` keeps the old socket |
| `src/yellowstone.ts` | Optional Yellowstone gRPC source for the same events |
| `src/pricing.ts` | Message adapter. Swap the parser to change data sources |
| `src/filter.ts` | Creator hold, dev-dump, and floor-rug decisions |
| `src/holders.ts` | Top-10 holder filter, excluding the curve and pump pool |
| `src/rpc-limit.ts` | Shared Helius token bucket, cache, and 429 retry |
| `src/history.ts` | RPC lookup behind the filter |
| `src/executor-paper.ts` | Simulated fills |
| `src/executor-live.ts` | Sign locally, simulate, Jito `sendBundle` |
| `src/priority-fee.ts` | Helius priority fee, recent-fee percentile, and the lamport clamp |
| `src/risk.ts` | Stop loss, trailing stop, and the 2x partial |
| `src/positions.ts` | Open positions and unrealized PnL |
| `src/report.ts` | JSONL log and daily summary |
| `src/config.ts` | Env parsing and hard caps |
| `src/redact.ts` | Strips the private key from text |

## Assumptions

Checked against PumpDev's public docs (`https://pumpdev.io/skill/pumpdev/references/endpoints.md`, the data API, and the Jito bundle pages) and a live socket sample.

**Stream.** `FEED=helius` (default) opens one `logsSubscribe` on `RPC_WS_URL` for the pump.fun program, commitment `processed`, and decodes `CreateEvent` and `TradeEvent` from `Program data:` lines. No `getTransaction` calls. Trades are kept only for watched or held mints. The socket pings, reconnects with backoff from 1s to 30s, and reconnects again if it is silent for `HELIUS_STALL_SEC` (30). Pongs do not count as traffic. A socket that never opens, or never confirms `logsSubscribe`, is dropped after about 10s. A stall calls `terminate` and schedules the reconnect itself, so a missing close event cannot leave the feed down. A refused `logsSubscribe` is logged and does not switch feeds. `FEED=pumpportal` uses one connection to `DATA_WS_URL` (`wss://pumpportal.fun/api/data`). `subscribeNewToken` goes out on open. Watched mints share `subscribeTokenTrade` batches of at most 100 keys, and `unsubscribeTokenTrade` goes out when a watch is dropped or a position closes. A creator sell is the token print whose `traderPublicKey` is the creator. Reconnect starts at 1s, caps at 30s, and resubscribes only mints still tracked. There is no per-token socket and no 5-subscription cap on this feed. New-token events are free. As of this check, `subscribeTokenTrade` is rejected unless `PUMPPORTAL_API_KEY` is set and its linked wallet holds at least 0.02 SOL. The key is sent only on that subscribe message. `FEED=pumpdev` uses `WS_URL` and the old auth path. PumpPortal reserves are already SOL and display tokens; raw PumpDev reserves are scaled to the same units. `pool` values other than `pump`, `pumpswap`, and `pump-amm` are skipped. Frames with a `type` field are control messages and are not treated as trades. After migration the same subscription keeps delivering trades, and those can carry an AMM market cap. That number is not a bonding-curve price. A mark is logged as `mark_rejected` when it disagrees with the mint's virtual reserves or jumps more than 5x upward in one update. Every accepted trade or curve update logs `mark` (at most every 5 seconds, and again when the trail stop changes) and rechecks the stop, the partial take profit, and liquidity. Paper sells simulate the token balance against the curve reserves and then apply slippage. A bonding-curve account with `complete` set, or a stream `complete` / `create_pool` event, graduates the position. After that the bot prices and paper-sells against PumpSwap pool reserves. If those reserves are missing the position is `unpriced` and is not filled at the last curve price; the next pool quote is the fill. A live sell of a graduated mint sets `pool` to `pump-amm` on the same local-sign Jito bundle. A mint is written to `data/bought-mints.json` when the buy is reserved and loaded again on startup, so it is not bought twice after a sell or a restart. The key is the mint address. The same name or symbol on another mint is a different coin.

**Prices.** SOL-quoted creates carry `marketCapSol`. PumpDev raw reserves are lamports (`30000000000` = 30 SOL) and base units (`1073000000000000` = 1,073,000,000 tokens). PumpPortal sends those same reserves already scaled (`30` and `1073000000`). Both become virtual SOL and display tokens before a price is used. Price is `marketCapSol / 1_000_000_000` when that field is present, otherwise virtual SOL divided by virtual tokens. Non-SOL quote mints are skipped. Sizing is in SOL, and a USDC-quoted curve is a different market.

**Creator hold.** `initialBuy` on the create event is the creator allocation in the launch transaction, in display tokens (the docs' sample of `67062500` is about 6.7% of the 1,000,000,000 supply). The bot skips when that share is more than 5% (`MAX_CREATOR_HOLD_PCT`, hard cap 10). `CREATOR_MAX_HOLD_PCT` is still read when the new name is unset. A buy the creator sends in a later transaction is not part of this check. Those later buys are visible to the dev-dump check on the creator's *next* launch.

**Top 10 holders.** Before every buy the bot reads the mint at commitment `processed`, then calls `getTokenLargestAccounts` and `getTokenSupply`. pump.fun create_v2 mints are Token-2022, and Helius answers `Invalid param: not a Token mint` until that mint is visible, so the check retries inside `RUG_CHECK_TIMEOUT_MS`. A JSON-RPC error is not cached. If the largest-account index still rejects a mint whose owner is SPL Token or Token-2022, the same filter is computed from that program's token accounts. It drops protocol inventory derived per mint: the bonding curve and its Token-2022 token account, the mayhem sol-vault token account (about half of a create_v2 supply; an SPL-token ATA is a different address and does not hold it), the pump global and mint-authority accounts, and the PumpSwap pool. A token account is also dropped when its owner is one of those PDAs. If the next 10 accounts own more than `MAX_TOP10_PCT` (default 25) the buy is skipped and the log includes that percentage. A check that still cannot finish skips the buy.

**Creator history.** `frontend-api-v3.pump.fun` answers this host with a Cloudflare challenge, so v1 does not use it. History comes from `getSignaturesForAddress` and `getTransaction` on `RPC_URL` (default public mainnet RPC), last 25 signatures. A prior launch is a transaction whose logs contain `Instruction: Create` or `Instruction: CreateV2`.

- **Dev dump.** The creator's peak balance in the first 2 minutes falls below half of that peak inside 15 minutes. A creator who dumps the previous coin within minutes is skipped here.
- **Rug.** The bonding-curve account (PDA `["bonding-curve", mint]` on `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`) is at least 3 minutes old, virtual reserves price it at or under 32 SOL (the curve opens near 27.96 SOL and cannot trade below that floor), and the creator's balance is at or under 10% of the peak. A coin that dies and is left at the floor within minutes is a rug. The old half-hour wait is gone. Graduated coins that die in the AMM are outside this view.
- If the RPC call fails, or the history or top-10 check does not finish inside `RUG_CHECK_TIMEOUT_MS` (default 2s), the launch is skipped. The reason is `creator-history-unavailable`, `creator-history-timeout`, `top10-unavailable`, or `top10-timeout`.

**RPC rate.** History, the holder check, the mint safety read, curve reserve reads, and the live `Connection` share one token bucket (`HELIUS_RPS`, default 5). Successful reads are cached for `RPC_CACHE_TTL_MS` (default 3s). HTTP 429 and 5xx retry with exponential backoff and jitter. Helius returns 429 often enough that the bucket stays conservative.

**Live trading.** `POST /api/trade-lightning` is server-signed. The documented body is `action`, `mint`, `amount`, `denominatedInSol`, and an optional `creator`. It does not take a Jito tip, a compute-unit limit, or a local private key. Auth is a PumpDev API key for a hosted wallet. `POST /api/bundle-lightning` adds `jitoTip` and sends through Jito, and it also signs with that hosted key.

v1 keeps the burner key local, so live orders use `POST /api/bundle` (`TRADE_API_URL`). The body is one account with the Lightning trade fields (`type`, `amount`, `denominatedInSol`, `creator`) plus top-level `mint`, `slippage`, and `jitoTip`, and `publicKey` instead of `apiKey`. The response is an unsigned transaction. The bot simulates it, sets the compute-unit limit from units consumed (20% headroom, plus 10,000, clamped), and sets the compute-unit price from Helius `getPriorityFeeEstimate` with `priorityLevel` `High`. If that method is missing, it uses `getRecentPrioritizationFees` and the 90th percentile of the accounts the transaction touches. The total is clamped to `PRIORITY_FEE_MAX_LAMPORTS` (default 500_000, about 0.0005 SOL) and cached for `PRIORITY_FEE_CACHE_MS` (default 5s). A failed lookup uses `PRIORITY_FEE_SOL`. The price is still `ComputeBudgetProgram.setComputeUnitPrice`, next to the dynamic unit limit. It adds a tip transfer to a random Jito tip account, signs with `PRIVATE_KEY`, and calls Jito `sendBundle` with base64 encoding. Landing is `getSignatureStatuses` until confirmed or `CONFIRM_TIMEOUT_MS` (default 20s). A bundle id by itself is not a fill. A full sell uses amount `100%`. The 2x partial uses `50%`.

PumpDev's own notes say contested launch bundles often need tips above this bot's 0.005 SOL cap (they measured 0.03 SOL). Live bundles at 0.002–0.005 SOL can be accepted by the block engine and still never land. That shows up as `bundle-not-landed`.

**Fees in the paper model.** 100 bps protocol and 25 bps venue match PumpDev's published local-trade commission and the long-standing pump.fun fee. Pump.fun's fee schedule changes. Override `PAPER_PROTOCOL_FEE_BPS` and `PAPER_VENUE_FEE_BPS` if you want the simulator to track a different schedule. Live fee reporting prefers the wallet's SOL delta from the confirmed transaction when that transaction is readable.

## Tests

```bash
npm test
npm run typecheck
```

The tests cover the hard caps, take-profit and stop-loss, creator filter decisions, paper PnL, and private-key redaction.
