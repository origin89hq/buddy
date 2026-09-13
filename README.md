# Origin89 Buddy

![Origin89 Buddy answering questions from a blue chat bubble](https://raw.githubusercontent.com/origin89hq/brand/37fc8da9fabddab6627d2276aa5f80af13380fdc/situations/scenes/buddy-chat/buddy-social.jpg)

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

Run `pnpm changeset` with each change that affects `@origin89/buddy` consumers. Include the release note and bump choice in the feature PR. The release workflow collects those notes into a version PR with `packages/buddy/CHANGELOG.md`. Review and merge that PR to publish through npm OIDC and create the GitHub release notes.

See [the release guide](docs/releases.md) for package scope, validation, the initial npm release and recovery. The configured trusted-publisher filename remains `publish-buddy.yml`.
