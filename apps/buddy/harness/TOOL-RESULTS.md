# Direct equipment tool smoke checks

Local run on 2026-09-08 against 25,125 active catalogue records. Model: `openai/gpt-5.6-luna`, reasoning `none`, no retries, 15-second total model/tool deadline. The model uses automatic exact prefetch plus direct AI SDK tools over D1.

| Case | Model calls | Completed reply | Estimated USD with reported cache hits | Estimated USD without a cache discount |
|---|---:|---:|---:|---:|
| Rolls S-550 C20/C100 exact lookup | 1 | 2.267 s | $0.000298 | $0.000829 |
| Rolls partial `S55` label, search then exact specifications | 3 | 3.994 s | $0.000554 | $0.002085 |
| SmartShunt 300 A port, readings and driver status | 3 | 5.005 s | $0.001070 | $0.002622 |

These are three smoke cases, not a general benchmark, p95 measurement or complete-setup cost. The timings include local Worker/provider round trips and all model steps, but exclude browser work. Individual database tool calls in this run took 3–7 ms. Model calls account for most of the reply time. Costs use provider-reported usage and the [Luna token rates](https://developers.openai.com/api/docs/models/gpt-5.6-luna) checked on the run date; they exclude photos, hosting, storage, taxes and failed development attempts. Cached rates should not be assumed for a fresh installation.

All three returned source links and left equipment, installation facts and solar arrays empty for catalogue research. Rolls ratings retained their discharge-rate distinction. SmartShunt telemetry remained a potential integration with its driver unimplemented and SOC an estimate. A separate 390 px mobile browser check completed a partial-label reply in 5.247 s, preserved its source after reload, added no inventory facts and reported no page errors or overflow. Its disposable browser session was deleted afterward.

Development checks caught two prompt issues (capability research classified as live monitoring, and promising a lookup instead of executing it) and an app/catalogue category mismatch (`monitor` versus `battery-monitor`, also `panel` versus `solar-panel`). These were corrected before the final run. The category mapping has a deterministic regression test; the conversation cases remain in the live harness because mock responses cannot establish model behavior.

Validation: 58 automated tests across the Buddy backend and shared installation package; backend TypeScript check; Worker dry-run bundle; three live evaluator cases; mobile browser/source-persistence check. No remote Worker was deployed.

Reproduce: start `pnpm buddy:eval:dev` with the local catalogue seeded and key configured, then run `node harness/verify-tools.mjs` from `apps/buddy`. Reports in ignored `test-results/tools-<timestamp>/verification.json` include response text, sources, every model step's token usage, tool timings and hashes of the runtime source files. The final smoke report for this run is `tools-2026-09-08T19-29-25.206Z`; the browser report is `tools-browser/verification.json`.
