# Buddy setup POC

For GitHub checks, Cloudflare deployment, source archives and D1 catalogue publication, see [Deployment](DEPLOYMENT.md).

Buddy builds a saved equipment inventory from successive photos and conversation. The React website at `/buddy/` shares that record with equipment cards and a map. The map shows an inventory, not verified electrical wiring.

Photo → observed equipment → one missing detail → another photo. Repeated views reuse equipment IDs. Unreadable models, electrical ratings and wiring stay unknown. Users can correct a card, defer a question, download the JSON record, or delete this preview session and its photos.

## Model routing and context

- **New photos:** `BUDDY_MODEL`, initially `openai/gpt-5.6-sol`. One Responses API call extracts structured observations; no reasoning step, no automatic retries, 20-second deadline. GPT Terra and Workers AI adapters remain selectable and benchmarkable.
- **Text conversation:** `BUDDY_CHAT_MODEL`, initially `openai/gpt-5.6-luna`. An indexed D1 lookup supplies bounded exact-model specifications before the model answers setup questions and extracts explicit new facts. Known specifications retain a one-call path. Missing knowledge can use four direct AI SDK tools, with at most two tool rounds plus a final answer (three model calls total). It also receives the saved equipment, facts, outstanding question, and six recent text messages. It does not resend old photographs or the full conversation. The entire model/tool loop has a 15-second deadline and no automatic retries.
- **Follow-up after a photo / skip / absence confirmation:** ordinary code chooses the next missing detail. No additional LLM call.
- **Scope:** this website preview helps identify and understand an installation, including catalogue research, equipment comparisons and monitoring capabilities before a purchase. Questions about available ports/readings and driver status are in scope. Requests to actually read a live site or operate hardware, and unrelated topics, get a gentle referral to `/app/`, explicitly an app preview. The broader in-app Buddy is future work.

The browser normalizes images to JPEG at up to 2048px, removes metadata through canvas re-encoding, and sends new images only. OpenAI image inputs use `detail: high` to preserve readable labels. Ask for a close-up when a label is unclear; don't fabricate a model number. See the [OpenAI vision guide](https://developers.openai.com/api/docs/guides/images-vision?api-mode=responses).

OpenAI is an external proprietary model service. Origin89's source and model adapters can remain open and replaceable; this POC must not be described as running an open-source AI model. The Workers AI alternatives currently score worse on this small dataset.

## Local development

### Equipment catalogue

The [equipment knowledge guide](knowledge/README.md) describes the reproducible SAM CEC import, revision activation, conflict handling, source citations and the proposed AI Search document layer. The local database contains 25,327 active records: 23,851 SAM panel/inverter entries, 506 manufacturer battery/controller/inverter/generator/monitor entries, 969 CEC battery entries and the historical Rolls S-550. Integration profiles distinguish available readings, implemented decoders and pending hardware verification. These are specification records, not a count of compatible controllers. The importer uses no inference or search API calls. AI Search/Vectorize remain future work; manufacturer batch enrichment and deterministic solar-array checks are implemented.

From `apps/buddy`, run `node scripts/sam-import-local.mjs` to fetch pinned sources and seed local D1. Use `--offline` once the checked source files are cached. Run `node harness/verify-knowledge.mjs` against the live preview to check a real catalogue-backed reply; this makes one paid model call in an isolated test session and clears that session afterward.

From the repository root:

```sh
pnpm install

pnpm buddy:dev
```

Keep `OPENAI_API_KEY=...` in **`apps/buddy/.env`**, which is gitignored and read only by Wrangler. Never use a `VITE_` prefix. Open `http://localhost:8790/buddy/`. The Vite development server also proxies `/api/buddy/*` to port 8790. Change model IDs in `wrangler.jsonc`, or override them with Wrangler's `--var` option.

The OpenAI key is not an account or model-access guarantee. Provider failures appear as failures with retry controls; they never fall back silently to example detections. `store: false` disables Responses storage, but does not constitute a zero-retention agreement.

### Explicit fixture mode

```sh
pnpm --filter origin89-buddy dev:fixture
node apps/buddy/harness/verify-api.mjs
```

Fixture mode uses three hand-authored extraction rounds with local R2/SQLite and **no inference**. It is clearly labelled. Storybook's `Buddy / Photo inventory POC` uses the same explicit sample flow and includes a phone view. Stop the live server before running fixtures on the same port.

### Existing ngrok review

Run browser flows against a website checkout configured to bind this local service. Website-only preview and asset scripts live in [website](https://github.com/origin89hq/website). The harness dependencies are installed in this repository.

## Repeatable model evaluation

```sh
pnpm buddy:eval:dev
```

Copy `harness/photos.example.json` to a gitignored `harness/photos.local.json`, filling in paths to private source photos. Nothing copies those photos into website assets. In another terminal:

```sh
cd apps/buddy
BUDDY_EVAL_REPEATS=2 node --experimental-strip-types harness/run.mjs \
  harness/photos.local.json openai/gpt-5.6-terra openai/gpt-5.6-sol
node --experimental-strip-types harness/run.mjs harness/conversation.json
```

The separate evaluator runs only on loopback at port 8793. It uses the **same extraction, conversation and merge code** as the POC and reads the same active local D1 catalogue. `buddy:eval:dev` explicitly uses the app's `.wrangler/state` directory; it does not maintain an unseeded second catalogue. Do not edit that code or restart its Worker during a run: hot reload interrupts inference and invalidates the affected round. Ground-truth annotations are supplied to the grader only, never to the model.

From `apps/buddy`, `node harness/verify-tools.mjs` runs three paid conversation checks: exact Rolls ratings without extra tool calls, a partial model search followed by sourced specs, and SmartShunt monitoring capabilities without claiming an implemented driver. Pass a case ID (`known-rating`, `partial-label`, `monitoring-options`) to rerun only that case. The report records every model step's usage, tool timings, estimates and source hashes. It creates no browser session and writes no installation or catalogue records. Mock-provider tests exercise the same AI SDK loop without API calls.

`test-results/<timestamp>/` contains progress, raw structured observations, per-round token usage, latency, estimated USD, misses and a Markdown report. Photos and absolute source paths are excluded from reports, but observations may still be private; the entire directory is gitignored. Reproducibility metadata includes source/image hashes, preprocessing, targets and source-linked pricing. Human review is still necessary; regex/field checks do not establish general conversational quality or safe electrical advice.

Targets: completed scan under 10 seconds, conversational reply under 5 seconds, and a planning budget of US$0.25 per setup. The photo report models 12 turns plus two retries at the observed average **without a cache discount**. This is a scenario, not a measured completed installation or guarantee. Usage includes image inputs and reasoning when reported. Missing usage and failed/timed-out calls keep cost unknown; aborted calls may still be billed. R2, Workers, gateway, network, taxes and future manual/web lookups are additional. See [initial results](harness/RESULTS.md).

`pricing.mjs` contains dated USD rates with primary-source links. Refresh rates before a production decision. The runtime uses request budgets, not a hard dollar ledger: a global preview cap of 40 inference calls/day plus 30 sessions and 100 uploads/day. Each additional tool-loop model call, including the final answer, reserves another inference unit before calling the provider. A budget denial stops that step and preserves the saved installation. Usage callbacks report every completed step, including steps before a later failure; missing usage from failed/aborted calls remains unknown. There are 40 attempts per session, 24 stored photos, six photos per turn, and 40 equipment entries. Deleted sessions retain their attempt count. The separate opt-in evaluator makes paid calls outside the browser preview budget. Do not confuse these preview limits with a production billing policy.

## Persistence and boundaries

The Worker assigns a random HttpOnly, SameSite Strict cookie to an anonymous browser session. An Agents SDK `Agent` owns the record in a SQLite Durable Object; R2 owns the photos under that session's namespace. The server resolves and authorizes photo IDs. There is no exposed arbitrary agent RPC or WebSocket route. This is browser-session isolation, **not real user/account authentication**.

Pending-turn protection, revision checks, idempotent message IDs and persisted replies prevent ordinary retries from duplicating a completed turn. A refresh recovers the canonical record. AI failures do not replace saved inventory. A seven-day scheduled expiry deletes local session photos and state. Local development cleanup runs while the local Worker is running; it is not a production data-retention deployment.

AI observations cannot mark themselves user-reviewed. Reviewed identity fields survive conflicting model output. Newly readable blank fields require fresh review. User review confirms what the user entered, not manufacturer validity. An exact XTRA4210N match links the EPEVER series manual; Buddy retrieves its 40 A charging and voltage-specific nominal power ratings for advisory checks. This does not establish Origin89 driver compatibility or verify installation safety.

No live readings, device commands, automatic maintenance steps or wiring verification exist here. Controller operation stays independent of cloud chat; deterministic firmware owns actuation. Photos alone cannot establish that an electrical installation is safe.

## Validation

```sh
pnpm buddy:test
pnpm buddy:check
pnpm --filter origin89-buddy dry-run


```

`harness/verify-api.mjs` exercises the real local fixture Worker for private-photo isolation, origin/body checks, deduplication, idempotency, editing, persistence and reset. Use the live harness separately for actual model quality and costs. Production uses a private Buddy Worker called through the website service binding; see DEPLOYMENT.md for its independent deployment.

Next production work: account/site/controller authorization, actual storage provisioning and retention, a reconciled cost ledger, abuse controls, a larger labelled evaluation dataset, verified manual retrieval, and broader in-app context. Each site's context must be authorized server-side before it reaches Buddy; an account with multiple sites must not mix their equipment or readings.
