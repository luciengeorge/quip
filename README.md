# quip

Quip is a standalone autonomous X agent built with eve and Convex. It gathers public GitHub
activity, Hacker News, configured RSS feeds, explicit Slack drops, and optional trend sources.
It has no posting tool yet.

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

## Source safety

GitHub activity is accepted only after the repository API explicitly returns `private: false` and
`visibility: "public"`. Ambiguous visibility is excluded. The leak guard drops configured private
repository names, configured internal terms, and credential-shaped text before candidates enter
the pipeline. Configure the non-secret lists with `LEAK_GUARD_PRIVATE_REPOS` and
`LEAK_GUARD_INTERNAL_TERMS`.

X recent search is optional. Before every paid request, Quip reserves the maximum possible number
of returned posts in an atomic Convex mutation. The fixed code cap is 5,000 reads per calendar
month, equivalent to $25 at $0.005 per read. A source that cannot reserve reads returns a clear
degradation message while the free sources continue to gather.
