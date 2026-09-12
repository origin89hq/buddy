skills-sync:
    python3 .origin89/sync-engineering.py
check:
    pnpm check
package:
    pnpm package
dev:
    pnpm --filter origin89-buddy dev
fixture:
    pnpm --filter origin89-buddy dev:fixture
deploy-config:
    pnpm --filter origin89-buddy deploy:config
deploy: check deploy-config
    node apps/buddy/scripts/deploy.mjs
