# Initial Buddy evaluation — 8 September 2026

Recommendation for the POC: **GPT-5.6 Sol for photos, GPT-5.6 Luna for setup conversation.** Terra remains a cheaper candidate. Although it passed the file-based harness, a later real browser upload omitted the pump in the wider photo (`browser-2026-09-08T16-26-49.736Z`). We prefer Sol's quality reference for the POC and accept its slightly higher cost; this is not proof that Sol cannot miss equipment. Keep the providers replaceable. This is a small development regression dataset, not a general model ranking.

**Final live browser verification passed with Sol + Luna** (`browser-2026-09-08T16-30-10.872Z`): the three photo uploads and replies took **4.69s / 4.45s / 2.95s**; contextual chat and app referral took **1.96s / 1.44s**. This includes browser preprocessing/upload and the UI response. The pump, one deduplicated XTRA4210N controller, and six batteries were recorded. Card edits survived refresh, JSON export worked, 390px/320px views fit, and reset deleted the test session's photos and messages. No browser exceptions were recorded. These browser timings are separate from the provider-token cost estimates below.

## Three rounds, four private installation photos

The sequence is a solar board, an inverter plus wider view, then a battery bank. Checks cover the visible XTRA4210N model, equipment categories, deduplication, six visible batteries, unknown electrical details, and the appropriate next question. No expected answers are in the inference prompt.

**Final `detail: high` verification:** Terra passed 33/33 checks at **4.0s / 5.4s / 1.9s**, with an estimated **US$0.0232 for the three rounds**. The earlier comparison below used automatic image detail. The final run is recorded in `2026-09-08T16-19-25.537Z`.

| Model         | Quality across measured sequences                                                    | Latency observed per round                                              | Estimated USD per three-round sequence                      |
| ------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| GPT-5.6 Terra | All quality checks passed in three sequences                                         | 2.6–13.0s; first sequence had the 13.0s call, two repeats were 2.6–6.2s | $0.0160–$0.0195                                             |
| GPT-5.6 Sol   | All quality checks passed in three sequences                                         | 2.5–12.1s; two repeat calls exceeded 10s                                | $0.0305–$0.0416                                             |
| Qwen3.8 27B   | Missed equipment/labels and introduced unsupported facts; two repeat calls timed out | 3.4–20s deadline                                                        | $0.0045 for one completed sequence; failed sequence unknown |
| Moondream3.1  | Responses failed the requested structured schema; one round timed out                | Not a usable inventory result                                           | Unknown                                                     |

Earlier exploratory Gemma/Kimi runs used different settings and one Kimi round was interrupted by hot reload. They are not a comparable basis for ranking. ResNet-50 is an image classifier, so it is not an appropriate label-reading/conversation model. LLaVA has an adapter but no completed comparison in this result set.

Terra's repeat sequences each passed all **33 quality-plus-speed checks**; its first sequence passed 32/33 because of latency. Sol's repeats each passed 32/33 because of latency. Neither these samples nor their maximum latency establish a production p95.

## Natural setup conversation

Luna passed **38/38 automated checks** across six text turns: introducing equipment, explaining MPPT, adding six unknown batteries, remembering that count, declining to give watering steps without the battery type, and gently referring an unrelated request to the app preview. The saved installation remained unchanged during ordinary questions.

Observed latency: **1.9–3.5 seconds**. Token-based estimate: **$0.0021 for all six turns**. Human review of the actual replies remains necessary; these checks do not prove reliability on unseen conversations.

## Cost interpretation

For an illustrative setup with three photo rounds and ten text replies, the measured averages imply roughly **US$0.04–$0.05 with Sol**, or **US$0.02–$0.03 with Terra**, before additional photos, retries, storage, Workers, retrieval, taxes or unreported charges. These are planning estimates, not completed setup measurements.

The more conservative harness scenario of 12 photo-sized turns plus two retries, without a cache discount, was **$0.09–$0.11 for Terra** and **$0.18–$0.20 for Sol** in the repeat runs. The $0.25 target is evaluated, not enforced as a dollar ceiling by this POC.

Prices were checked against the official [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), [Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol) and [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) pages. Input/output usage comes from provider responses; cached input discounts are applied when supplied and reasoning is not double-counted. Failed calls may still be charged. Reconcile the estimate with provider billing before forecasting at scale.

Raw private reports remain gitignored under `../test-results/`: `2026-09-08T16-03-10.268Z`, `2026-09-08T16-06-00.921Z`, `2026-09-08T16-11-10.871Z`, and the final run above. The runtime pins `imageDetail: high`; the browser's 2048px image limit is unchanged. Re-run the harness whenever models, schema, prompt or preprocessing change.
