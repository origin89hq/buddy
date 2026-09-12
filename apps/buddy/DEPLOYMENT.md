# Deploy Buddy and publish equipment data

Buddy runs as the private `origin89-buddy` Cloudflare Worker. It owns D1 equipment knowledge, private R2 photos and Durable Object sessions. The public `origin89-website` Worker lives in [website](https://github.com/origin89hq/website) and calls Buddy through a service binding. Keep `workers_dev` and preview URLs disabled and do not add a route to Buddy.

Copy `.env.example` to `.env.production` in this directory and fill the account, existing database, photo bucket and Worker name. Authenticate Wrangler with `pnpm exec wrangler login`, or supply a scoped `CLOUDFLARE_API_TOKEN`. The generated `wrangler.deploy.json` is ignored. These commands do not provision infrastructure.

From the repository root, run `just check`, then `just deploy-config`. Before a first deployment, apply D1 migrations and publish all four reviewed catalogues using the procedure below. Existing production catalogues and secrets survive a code deployment. Set or rotate the runtime key separately with `pnpm --filter origin89-buddy exec wrangler secret put OPENAI_API_KEY --config wrangler.deploy.json`; never put it in Git.

Deploy checked code directly, without GitHub Actions:

```sh
just deploy
```

The deploy recipe applies migrations, confirms every required catalogue has active verified records and deploys only Buddy. Website assets and hostnames are owned by the website repository. OpenAI-backed production configurations omit the optional Workers AI binding.

## Optional catalogue workflow setup

`Buddy catalogue` is a manual workflow on `main`. Configure `CLOUDFLARE_ACCOUNT_ID`, `BUDDY_DATABASE_ID`, `BUDDY_PHOTOS_BUCKET`, `BUDDY_WORKER_NAME` and `BUDDY_CATALOGUE_BUCKET` as repository variables. The `buddy-production` environment needs `CLOUDFLARE_API_TOKEN`; `buddy-catalogue-build` needs a read-only `CATALOGUE_READ_TOKEN` for the private source archive. Restrict both environments to `main`. Repository creation does not copy these secrets or environments.

The workflow serializes catalogue publication within this repository. Coordinate direct CLI deployments and publications separately; do not run them against the same database concurrently. No deployment or paid inference runs on push.

## Archive reviewed sources

Manufacturer HTML and CEC spreadsheets can change without changing URL. A fresh download is not a reproducible archive. The packer checks and includes only files named in committed source manifests, including the SAM licence. It excludes private photos, sessions, credentials and generated extraction caches.

From a checkout containing the reviewed `apps/buddy/knowledge/sources` cache:

```sh
node apps/buddy/scripts/catalogue-source-cache.mjs pack /tmp/buddy-sources.jsonl.gz
source_key=$(node apps/buddy/scripts/catalogue-source-cache.mjs key)
pnpm --filter origin89-buddy exec wrangler r2 object put "$BUDDY_CATALOGUE_BUCKET/$source_key" \
  --remote --file /tmp/buddy-sources.jsonl.gz
```

Upload with an authorized R2 write token; CI uses a read-only token. Keep this bucket private. Each manifest version has its own object key. Restore verifies all files before replacing the complete cache directory. The previous cache stays in `sources.restore-backup` until installation succeeds. A failed installation rolls back; after a killed process, rerunning restore recovers the complete old or new cache before continuing. The cache path can briefly be absent between the two directory renames, so run only one restore at a time and finish it before running catalogue builds. Original documents are never bundled into the Worker or included in GitHub build artifacts.

All-catalogue, manufacturer and CEC builds require this archive. A SAM-only build can fetch its immutable upstream Git commit, and manual records already live in Git. A missing archive stops the build instead of substituting today's page.

## Feed and publish D1

1. Review source changes and adapters locally. Preserve exact bytes, identities, units, rating conditions and source links. Add small verified exceptions to `knowledge/reviewed.jsonl`; extend manufacturer adapters for broader coverage. Source acquisition alone does not establish controller compatibility or independent certification.
2. Commit source pins and adapter changes. Upload the corresponding archive when pins change. Changes to repository evidence used by integration profiles also require reviewing their hashes.
3. Run **Buddy catalogue** on `main` with **Publish disabled**. Select all feeds or one feed. Download the artifact: normalized JSONL, quarantine/conflict reports, licence and `bundle.json`. The summary shows record counts and a SHA-256 digest.
4. Review reports and sample records. Run again at the same commit with **Publish enabled** and paste that digest. A changed commit, report or record changes the digest and stops publication.
5. The publisher validates the entire release, regenerates SQL from the JSONL, applies migrations, loads bounded chunks and checks staged counts. After all selected feeds load, it activates each catalogue and verifies the result. Buddy's next lookup reads the new data.

The four feeds are `sam-cec`, `manufacturer-specifications`, `cec-batteries` and `reviewed-equipment`. The last includes the historical Rolls S-550, so a fresh database retains that reviewed exception. Building and publishing data uses no AI inference.

Each feed activates in one SQL statement. Upload failures leave old revisions active; retries are idempotent. A failure between multiple feeds' activation statements can leave a mix of complete revisions; retry finishes the release. Old revisions remain stored. Retention/pruning is deliberate; a reviewed old bundle can be republished via CLI to roll a catalogue back. Workflow concurrency serializes app/data operations; do not run another CLI publisher against that database concurrently.

For a local rehearsal or initial authorized publication from the retained cache:

```sh
python3 -m pip install -r apps/buddy/scripts/requirements-catalogue.txt
node apps/buddy/scripts/catalogue-release.mjs build --offline \
  --commit="$(git rev-parse HEAD)" --output=/tmp/buddy-release
node apps/buddy/scripts/catalogue-release-summary.mjs /tmp/buddy-release

# Use the digest printed above. This command is local only.
node apps/buddy/scripts/catalogue-release.mjs publish \
  --bundle=/tmp/buddy-release --expect-sha256="$BUDDY_RELEASE_DIGEST" \
  --config=apps/buddy/wrangler.jsonc --local
```

Use a new output directory per build. For remote publication, set deployment variables, run `pnpm --filter origin89-buddy deploy:config`, then explicitly use `--config=apps/buddy/wrangler.deploy.json --remote`. The account must match `CLOUDFLARE_ACCOUNT_ID`. SQL files from artifacts are never executed. Existing local import commands remain local-only.
