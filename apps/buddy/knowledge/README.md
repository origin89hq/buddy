# Equipment knowledge

For production publication and repeatable source archives, see [Deployment](../DEPLOYMENT.md). Catalogue releases are reviewed separately from website deployments; existing local import commands remain local-only.

The local POC has **25,327 active specification records**: 21,508 SAM panels, 2,343 SAM inverters, 506 manufacturer records (200 Rolls, 38 U.S. Battery, 13 Volthium, 5 Yilink and 3 Discover batteries; 55 Victron/EPEVER and 38 Morningstar charge controllers; 44 EPEVER, 62 Samlex and 3 Sol-Ark inverters; 6 OutBack and 1 Schneider inverter/chargers; 33 DuroMax/DuroStar generators; four Victron SmartShunt ratings and one Peacefair PZEM-017), plus the historical Rolls S-550 and 969 CEC battery records. These are catalogue entries, not supported-device counts. The historical S-550 remains a separate reviewed record. Raw downloads and generated SQL are excluded from Git and the Worker bundle. Runtime internet search, remote provisioning and scheduled ingestion remain unimplemented.

The manufacturer battery batch includes 112 flooded, 54 AGM, 25 gel and 68 LiFePO4 products. Voltage classes cover 2, 4, 6, 8, 12, 24, 32, 36 and 48 V. Keep voltage class separate from actual nominal voltage (for example 36 V class / 38.4 V nominal), and rated Ah at a stated discharge duration separate from maximum charge/discharge current. The 2018 S-550's 428 Ah C20 and 556 Ah C100 are not replaced with a current successor's ratings.

The acquisition strategy is **a catalogue enriched in advance, with web search as a fallback**. The SAM adapter fetches immutable, hash-pinned CSV files and validates identities, units and basic electrical consistency without calling an AI model. Catalogue-import checks do not establish independent measurement accuracy. First identify the brand and exact model and check saved specifications. Manufacturer aliases not represented in the source must be reviewed before adding them; do not guess corporate-brand equivalence. Preserve suffixes, inverter voltage variants, document revisions, units and discharge-rate conditions. Unresolved identities and conflicting documents need clarification.

Web discovery should produce candidate knowledge with citations. An AI answer alone must not mark a record `verified`. Publication needs source/identity/measurement validation; installation wiring and condition remain private user facts. The cheap conversation model should receive only the relevant bounded records. Keep search off ordinary conversation turns and never send private installation photos, addresses or the entire chat to search.

The existing equipment compatibility catalogue is research input. It is not a database of verified battery ratings or a guarantee of working device support.

## Direct tools for Buddy

`src/equipment-tools.ts` exposes four typed AI SDK tools over the existing D1 catalogue and `solarChecks` function. There is no remote MCP server or new database to provision.

| Tool | Input and behavior |
|---|---|
| `search_equipment` | Known brand, optional model prefix and equipment kind. Uses the alias primary-key range, reads at most 65 rows and validates at most 64. Returns up to five candidate identities, without ratings or automatic inventory updates. A truncated search asks for a narrower model prefix. |
| `get_equipment` | Complete brand/model including suffixes. Reuses exact active-revision lookup, reviewed aliases, bounded records and source IDs. Ambiguity or unknown variants yield no specs. |
| `get_monitoring_options` | Complete brand/model. Returns support status, ports, manufacturer capabilities versus implemented readings, external monitor suggestions and limitations. Missing integration means unknown support. |
| `check_setup` | No model-supplied electrical values. Checks a snapshot of this session's saved solar arrays against exact specifications retrieved so far. New message details are checked by the normal server path after saving. |

The automatic exact lookup remains the first step; the model should answer directly when that context is sufficient. Additional tools are bounded to six executions, 8,000 characters per result and 16,000 total returned characters per turn, with request-local result/lookup caches. At most two tool rounds precede a final structured answer. The final step disables tools, and the 15-second model deadline covers all steps. Source links are resolved only from records actually supplied by the server; candidate search alone does not authorize a specification citation. Logs contain tool names, status, cache hits and duration, not labels, photos or conversation text.

Search currently requires a known manufacturer and supports model prefixes, not semantic manual search, arbitrary substring matching or filters over electrical ratings. It never transfers a candidate's identity, ratings or accessory suggestions into the installation. The model extracts only new user evidence through the existing review/merge path. Lookup data and instructions remain separate. Tests check the SQL query plan, active revision/alias validation, caching, tool budgets, failure handling, calculation results, source allowlisting and the real AI SDK loop with a mock provider.

## Connection and monitoring metadata

Records can carry an `integration` profile with ports, protocol/settings, required interface, available device readings, the subset currently decoded, monitoring alternatives, limitations and pinned repository evidence. `passive` means there is no digital telemetry; `documented` means the connection is researched but the Origin89 driver is pending; `decoder-implemented` is partial software coverage without hardware validation. Missing metadata means unknown, not unsupported. No imported profile currently claims `hardware-verified`.

All 153 new lead-acid records and the historical S-550 suggest external bank monitoring. SmartShunt 300/500/1000/2000 A records document VE.Direct and estimated SOC, consumed Ah, signed current and other capabilities. The Origin89 driver is pending. Select the rating using maximum bank current including surges, not battery Ah; these IP21 models require a 6.5–70 V supply. SOC requires configuration and synchronisation and does not measure battery health. The 300 A model is in the current product manual but not the pinned protocol 3.34 PID list, so identity/firmware verification remains explicit.

PZEM-017 has an existing V/A/W decoder, an external shunt and a powered RS485 interface (9600 8N2). Its current is unsigned: it is a directional DC meter, not a replacement for a bidirectional battery-bank SOC monitor. Energy exists on the device but is not mapped by the current decoder. The shunt range must match the meter configuration. No installation steps are generated.

EPEVER IPower Plus and the documented larger classic IPower variants carry candidate RS485 telemetry profiles; the smaller IP350/IP500 do not inherit an RS485 claim. XTRA4210N's researched mapping is explicitly pending driver/firmware validation. Old research references to `cabin-*` drivers do not prove support in the current `o89-core` repository. Builds check `integration-profiles.json` evidence hashes and require review if that source changes.


## Local development

From `apps/buddy`, using the existing installed Node and Wrangler:

```sh
node node_modules/wrangler/bin/wrangler.js d1 migrations apply origin89-equipment-knowledge --local
node scripts/import-knowledge.mjs knowledge/reviewed.jsonl /tmp/origin89-knowledge.sql
node node_modules/wrangler/bin/wrangler.js d1 execute origin89-equipment-knowledge --local --file /tmp/origin89-knowledge.sql

# Fetch the pinned SAM files, validate, generate JSONL + chunked SQL + a rejection report.
node scripts/sam-catalogue.mjs

# Build from the checked local source cache, apply migrations and import into local D1.
node scripts/sam-import-local.mjs --offline
```

### Manufacturer sources

```sh
# Restore the exact pinned source bytes when still available upstream.
node scripts/snapshot-manufacturers.mjs --fetch-pinned
# Requires Python with pdfplumber==0.11.9; BUDDY_PYTHON can select its executable.
python3 -m pip install -r scripts/requirements-catalogue.txt
node scripts/manufacturer-catalogue.mjs
node scripts/sam-import-local.mjs --manufacturers

# Deliberate source update: downloads current pages and writes a new manifest.
node scripts/snapshot-manufacturers.mjs --refresh
# Re-snapshot one or more adapters and keep every other pinned entry unchanged.
node scripts/snapshot-manufacturers.mjs --only=us-battery,discover
```

```sh
# Pin the EG4 media library and Xantrex docs post type as PDF document indexes.
node scripts/document-indexes.mjs            # add --offline to re-parse the pinned pages
# Pin who-talks-to-what identity pages (Victron battery compatibility, GX Modbus register list, SolarAssistant, dbus-serialbattery).
node scripts/integration-identity.mjs        # add --offline to re-parse the pinned pages
```

Each adapter lives in `scripts/adapters/<maker>.mjs` and is listed in `scripts/adapters/index.mjs`. `discover` names the pages to pin (a catalogue page, a sitemap, a category listing or a JSON feed) and `records` turns one pinned file into validated records. The discovery pages are pinned in the manifest's `discovery` list, so a listing that shrinks is a diff and not a silent loss. A 429 is retried once after twenty seconds; any other refusal is recorded in the manifest's `errors`. An adapter that reads PDFs declares `extract`: `"lines"` runs `pdf-lines.py` (words with x-ranges, grouped into lines) for datasheets laid out as label/value rows or model columns without ruled borders; the default runs `pdf-tables.py` (cell geometry of ruled tables). Both need `BUDDY_PYTHON` pointing at an environment with the pinned pdfplumber, and both cache the extraction beside the source by PDF hash and script hash.

`scripts/adapters/pdf-text.mjs` is the shared geometry: a label ends where the first model column begins, a cell belongs to every column band it overlaps, and a lone cell centred on the whole model area is a merged rating shared by every model on the sheet. That last rule is what lets one Samlex sheet publish its 12, 24 and 48 V models with the shared watts and the per-model amps kept apart.

### Document indexes and integration identity

`knowledge/generated/document-indexes/<maker>.json` lists where a maker's PDFs are, pinned from the REST API the maker's own site exposes (EG4's media library, Xantrex's docs post type, with the product slug where the URL carries it). An index entry is a location, not a specification; nothing in it is published as a record and no listed PDF has been read. `knowledge/generated/integration-identity.json` is the same discipline for who-talks-to-what: the brands on Victron's battery-compatibility wiki, the D-Bus services and register count of Victron's GX Modbus-TCP list, the inverter and battery families SolarAssistant documents, and the BMS families dbus-serialbattery reads. A future integration profile can cite one of these pinned pages as evidence; none of them makes a record `documented`, and none is an Origin89 driver.

Ordinary manufacturer builds are offline and verify every source hash. `--fetch-pinned` leaves the manifest unchanged and fails if a supplier has changed the page; restore an archived snapshot or review a new snapshot instead. Without flags, the snapshot command resumes acquisition from its URL cache. Keep original snapshots in durable object storage before relying on reproducibility across clean machines; R2 source archival is not implemented yet.

Rolls HTML tables, Victron merged HTML tables and EPEVER PDF cell geometry are parsed by dedicated adapters, and so are ten sources added after the source survey in [DATA-SOURCES.md](DATA-SOURCES.md): U.S. Battery's per-page comparison tables (the column is chosen by the page's own heading, the voltage by the listing that linked it), Morningstar's family comparison tables, Yilink's single-model technical tables, the DuroMax/DuroStar Shopify products feed, Discover's product pages, Volthium's French fiches techniques (identity from the store feed, ratings from the sheet, and a sheet is published only when exactly one store product claims it), Samlex specification sheets (one column per 12/24/48 V model), Sol-Ark, OutBack FXR/VFXR and Schneider Conext XW Pro datasheets. No AI inference is used during this ingestion.

What is quarantined, and why, is in each generated `report.json`: seven inconsistent Rolls pages; XTRA N G3's unsupported PDF table; four ambiguous Tracer header variants and a clipped IPower header; 21 U.S. Battery pages whose own comparison table omits the model (the site's tables are per BCI family and leave out the N, 2 V and odd-size variants) and one with reserve minutes that cannot come from its C20; GenStar and SureSine, whose model row is images; the two legacy Morningstar families without a table; two DuroMax feed products with no Part # row; Yilink's family and system pages that quote a range of capacities; seven Discover URLs that resolve to a category page or carry a bare title; seven Volthium sheets no single store product claims (four with no matching product name, two naming the same rackmount product, one that two products name); 33 Samlex sheets with no MODEL NO. line (accessories, remotes, older layouts) and the charger sheets, whose rows this adapter does not read yet. Discover's family listings are a browser-side search, so only the statically linked models and the reviewed URLs in `manufacturer-feeds.json` are pinned. Do not turn the 506 records into a claim of full manufacturer coverage.

### Setup calculations and response time

Solar arrays retain panel count, watts and the assigned controller even with an unknown panel manufacturer. Pure calculations compare total watts per controller, battery-side charging ratings, manufacturer nominal power at the bank voltage, and PV Voc/Isc only when the required string layout and temperature data exist. Oversizing is an advisory, not automatic equipment failure: current limiting, permitted oversizing, cold Voc and input Isc are different checks. Unknown associations or conflicting voltages stay unresolved. Source citations and checks survive refresh; a later identity edit drops outdated calculated cards.

Known brand/model mentions emit a transient spec card over the existing chat stream before the conversational model finishes. This is a separate indexed lookup and adds no inference call. The full structured reply still arrives on completion; streaming generated prose is not yet implemented. `lookupMs` measures the local database-plus-validation path, not network time or Cloudflare production latency. The bounded model context excludes repeated internal evidence hashes while retaining capabilities and limitations.

Local browser verification on 2026-09-08: known SmartShunt specs appeared in 83 ms; database lookup plus validation took 10 ms; the full model reply took 4,590 ms. One isolated live call, not a percentile benchmark or production latency guarantee. The reply correctly stated VE.Direct and that Origin89 integration is pending. `node harness/verify-feedback.mjs` repeats this check with one paid call and also checks the shared button states. All 41 unit checks, backend/frontend TypeScript checks and website/Storybook builds passed.

The package scripts are `knowledge:build` and `knowledge:import:local`. Omitting `--offline` downloads missing pinned sources. The local import command has no remote mode. Existing manually reviewed records and private conversations are preserved.

`sam-sources.json` pins the upstream commit, file hashes, byte/row counts and licence. Updates require inspecting the new source revision and changing this manifest. An upstream file or unit/header change fails validation rather than silently changing meaning. Each output directory is identified by a hash of the source manifest and adapter code. It contains `records.jsonl`, `report.json`, `import.json`, `records-*.sql`, `activate.sql` and `LICENSE-SAM.txt`. The report identifies quarantined rows and conflicts. CSV record numbers are shown in source citations; they are not PDF pages. Original source files remain under `knowledge/sources/sam/`.

Each catalogue revision loads beside the active one. The final SQL statement switches `knowledge_catalogues.active_revision` only when the expected number of verified records exists. Interrupted loads leave the old revision selected; stale model identities disappear when a new snapshot is activated. Rerunning the same import is idempotent. Old revisions remain stored for rollback and need deliberate retention/pruning before repeated large production refreshes. A first import interrupted before activation exposes no partial SAM catalogue.

Try `What are the voltage and current ratings of an Ablytek 6MN6A270 panel?` or `What does the catalogue list for ABB PVI-30-OUTD-S-US-A {208V}?` in Buddy. The latter needs its AC voltage variant; a bare inverter family does not identify the record. The runtime receives only bounded exact matches, and catalogue facts do not overwrite photo observations or user-confirmed installation facts.

The importer accepts reviewed JSONL and streams SQL to a temporary file, publishing the output file only after successful validation. Importing is idempotent per record ID. Each record remains staged until its aliases are written. Concurrent/failed publication of conflicting revisions blocks that alias rather than selecting an arbitrary rating. Production version activation and ingestion permissions need their own service; do not expose this importer as a public endpoint.

Queries use indexed exact brand/model aliases, at most 80 bound keys, six records and 8,000 characters of model context. A suffix or successor name is not silently mapped to an older model. Unknown/failed lookups return no specifications. No million-record or Cloudflare throughput benchmark has been run.

At larger scale, use D1 for structured specs and aliases, R2 for source documents, and document search for passages that cannot be answered from structured fields. D1 currently caps a paid database at 10 GB; plan partitioning or a different database once actual volume and workload justify it. The data collection and update process must be validated before making coverage claims.

## AI Search and Vectorize

Use D1 for exact equipment ratings. No embedding or extra model call is needed to find a known manufacturer/model. The SAM ingestion job currently supports bounded source files up to 10 MiB each; it is an offline Node build, not work performed during chat or inside a Worker request. For larger feeds, partition the source and ingestion jobs rather than raising memory limits without measurement.

For future manufacturer manuals, prefer Cloudflare AI Search's managed parsing, chunking, hybrid keyword/semantic indexing and metadata filters. AI Search uses Vectorize for vector retrieval, so a separate hand-managed Vectorize pipeline is unnecessary for this use case. Use its retrieval-only search endpoint and give selected passages to Buddy's existing conversation model. Filter by exact equipment identity and document revision, preserve citations, and keep raw source files in a dedicated knowledge store separate from private installation photos.

Document search would run only when structured fields do not answer the question. General internet discovery remains a separate budgeted fallback; AI Search searches the content supplied to it and does not automatically provide a comprehensive equipment catalogue. Neither AI Search nor Vectorize has been provisioned or connected by this implementation.

References checked 2026-09-08:

- [Rolls historical flooded catalogue, revision 06/18, page 1](https://www.rollsbattery.com/wp-content/uploads/2018/06/Renewable.pdf)
- [OpenAI Responses web search and citations](https://developers.openai.com/api/docs/guides/tools-web-search)
- [OpenAI search tool pricing](https://developers.openai.com/api/docs/pricing)
- [Cloudflare context storage](https://developers.cloudflare.com/use-cases/ai/store-and-retrieve-context/)
- [D1 indexes](https://developers.cloudflare.com/d1/best-practices/use-indexes/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [SAM component libraries](https://github.com/NatLabRockies/SAM/tree/develop/deploy/libraries)
- [How AI Search works and when to use Vectorize](https://developers.cloudflare.com/ai-search/concepts/how-ai-search-works/)
- [Bring your own generation model to AI Search](https://developers.cloudflare.com/ai-search/how-to/bring-your-own-generation-model/)


## CEC battery import

The CEC workbook supplies product identity, technology, nameplate energy, continuous discharge power and reported UL 1973 certification details. It does not supply nominal battery voltage, Ah/current ratings or connection ports. Those remain unknown. The standard name and the certifying body are separate fields; `catalogue-reported` certification is not direct directory verification or proof of Canadian approval.

```sh
# BUDDY_PYTHON must provide openpyxl==3.1.5 (see requirements-catalogue.txt).
node scripts/cec-batteries.mjs --offline
node scripts/sam-import-local.mjs --cec-batteries --offline
```

Omit `--offline` to fetch missing pinned workbook bytes. A changed upstream workbook fails its SHA-256 check; review and pin a new snapshot to update. No model or search API is used. Revision activation uses the same atomic catalogue pointer as other feeds. The 2026-09-01 export contains 980 rows; 969 pass validation, 11 with zero discharge kW are quarantined, and 19 blank discharge fields stay absent. All 12 lead-acid entries pass. The website advertises 979 rows; the discrepancy is recorded in the manifest. This is specification coverage, not a supported-device count.
