# quip

Quip is a standalone autonomous X agent built with eve and Convex. Plan 001 creates only its
durable memory scaffold and safety configuration. It has no X client or posting tool yet.

## Setup

1. Use Node 24 (`nvm use` reads `.nvmrc`).
2. Install dependencies with `corepack pnpm@10.26.0 install`.
3. Copy `.env.example` to `.env.local` and configure the named variables when a Convex deployment
   exists. `APP_SHARED_SECRET` belongs in the Convex deployment environment, not a checked-in file.

## Safety switches

`DRY_RUN` defaults to `true` and only the exact value `false` disables it. `POSTING_ENABLED`
defaults to `false` and only the exact value `true` enables it. Empty, whitespace, zero, negative,
and non-numeric settings fall back to safe values and log a warning.

## Verification

```sh
corepack pnpm@10.26.0 run typecheck
node --test --experimental-strip-types "agent/**/*.test.ts"
corepack pnpm@10.26.0 run build
npx tsc -p convex/tsconfig.json --noEmit
```

Do not run `convex deploy` or `npx convex dev` until a Convex deployment is explicitly created.
