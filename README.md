# Origin89 Buddy

Equipment setup and assistance for Origin89: the Cloudflare service, shared TypeScript contracts, reviewed knowledge adapters and evaluation harness. The public web experience lives in [website](https://github.com/origin89hq/website); shared interface components live in [ui](https://github.com/origin89hq/ui).

```sh
pnpm install --frozen-lockfile
just check
just fixture
```

Use the pinned Node and pnpm versions and `just`. `apps/buddy` owns the service, D1 migrations, Durable Objects, inference and equipment tools. `packages/buddy` is the consumer contract. Website, Swift and Android clients can have their own interfaces; this service does not own physical equipment control.

`just package` builds the local fixture Worker and packs `@origin89/buddy` into `dist/`. Release tarballs let website tests run without a backend source checkout or inference credentials. The TypeScript package is not a Swift or Kotlin client SDK. Controller evidence is a checksummed source snapshot with its original path and commit under `apps/buddy/knowledge/evidence`; missing or changed evidence fails catalogue verification.

Deployment and reviewed catalogue publication are separate operations. See [DEPLOYMENT.md](apps/buddy/DEPLOYMENT.md) for direct Wrangler commands, private archives and optional manual workflows. No production secrets, photos, sessions or full manufacturer archives are included.

See [LICENSING.md](LICENSING.md) for the current source and third-party terms.

## npm releases

`@origin89/buddy` is published by `.github/workflows/publish-buddy.yml` using npm trusted publishing with provenance. Configure the npm package's GitHub trusted publisher for organization `origin89hq`, repository `buddy`, workflow `publish-buddy.yml`, and no environment. Allow direct publishing. No npm token belongs in repository secrets.

The initial `0.0.0` bootstrap creates the npm package so its trusted publisher can be configured. Release versions stay in `packages/buddy/package.json`. After merging a checked version change, push `buddy-v<version>` at that main-branch commit. The workflow checks the tag, builds and validates the package, and publishes its tarball. Existing `v0.1.0` GitHub release assets remain available.
