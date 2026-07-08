---
unlisted: true
---

# Deploying big-AGI to Cloudflare Workers

This guide deploys big-AGI to **Cloudflare Workers** using the
[OpenNext Cloudflare adapter](https://opennext.js.org/cloudflare) (`@opennextjs/cloudflare`).

> Why Workers (and not the old Pages guide)?
>
> The previous guide used `@cloudflare/next-on-pages` on Cloudflare **Pages**, which only supports the
> **Edge** runtime and required *deleting* the Node.js cloud router (browse, import/export, sharing).
> The OpenNext adapter runs the whole app on the **Node.js-compatible Workers runtime**, so those routes
> stay in place. This is the current, actively-maintained path recommended by both Cloudflare and OpenNext.

## What works out of the box

- The full web app and UI
- All LLM providers and AIX streaming (`/api/edge/*` - now runs on the Workers runtime)
- Speech-to-text routes (`/api/stt/*`)
- The cloud tRPC router endpoint (`/api/cloud/*`) is deployed and reachable

## Features that need extra Cloudflare wiring

These are **optional** and only matter if you use them (each is documented in
[Optional features](#optional-features) below):

- **Web browsing** (`src/modules/browse`) uses `puppeteer-core` to connect to a remote browser. Point it at
  a remote websocket endpoint (`PUPPETEER_WSS_ENDPOINT`) or wire up Cloudflare **Browser Rendering**.
- **Sharing / ChatGPT-share import** (`src/modules/trade`) uses Prisma over Postgres. On Workers this needs a
  Prisma **driver adapter** plus **Hyperdrive** (or another Workers-compatible database). Leave it unconfigured
  and only these specific endpoints are unavailable - everything else runs.
- **`next/image` optimization** is limited on Workers; configure
  [Cloudflare Images](https://opennext.js.org/cloudflare/howtos/image) if you rely on it.

---

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) on the **Workers Paid** plan.

  > The built Worker is ~3.4 MB gzipped, which is over the **free plan's 3 MB compressed limit**. The Paid
  > plan raises this to 10 MB and is also required for Browser Rendering and higher CPU limits. Check the
  > current size anytime with `npm run cf:build && npx wrangler deploy --dry-run` (look at the `gzip:` value).

- Node.js 22+ and this repo checked out locally.
- The Cloudflare CLI is already a dev dependency (`wrangler`); no global install needed.

## Files in this repo

| File | Purpose |
| --- | --- |
| `wrangler.jsonc` | Worker name, `nodejs_compat` flags, static-assets binding, optional bindings |
| `open-next.config.ts` | OpenNext adapter config (caching overrides, etc.) |
| `.dev.vars.example` | Template for local secrets used by `npm run cf:preview` |
| `next.config.ts` | Calls `initOpenNextCloudflareForDev()` (only when `OPEN_NEXT_DEV=1`) |

npm scripts (in `package.json`):

- `npm run cf:build` - build the Worker bundle (`.open-next/`)
- `npm run cf:preview` - build and run it locally on the Workers runtime (workerd)
- `npm run cf:deploy` - build and deploy to Cloudflare
- `npm run cf:typegen` - regenerate `cloudflare-env.d.ts` types from `wrangler.jsonc` bindings

---

## Option A: Deploy from your machine

1. Authenticate wrangler with your Cloudflare account:

   ```bash
   npx wrangler login
   ```

2. (Optional) Preview locally on the real Workers runtime first:

   ```bash
   cp .dev.vars.example .dev.vars   # then fill in the provider keys you use
   npm run cf:preview
   ```

3. Deploy:

   ```bash
   npm run cf:deploy
   ```

   The first deploy provisions a `*.workers.dev` URL. Configure a custom domain later from the
   Workers project's **Settings > Domains & Routes**.

## Option B: Continuous deployment via GitHub Actions

A ready-made workflow is included at [`.github/workflows/deploy-cloudflare.yml`](../.github/workflows/deploy-cloudflare.yml).
It builds and deploys on every push to the **dedicated Cloudflare branch**
(`claude/cloudflare-deployment-migration-kg8rmh`) and on manual dispatch. To enable it, add two
**repository** secrets (Settings > Secrets and variables > Actions):

- `CLOUDFLARE_API_TOKEN` - a token created from the **Edit Cloudflare Workers** template
- `CLOUDFLARE_ACCOUNT_ID` - your account id (dashboard sidebar, or `npx wrangler whoami`)

Provider API keys stay as Worker secrets (below), not repo secrets. Until both secrets exist, the workflow
builds and **skips** the deploy (staying green); once they're set, pushes auto-deploy. This runs
**alongside** Vercel - see [Running alongside Vercel](#running-alongside-vercel).

## Option C: Cloudflare Workers Builds (dashboard)

Prefer Cloudflare's own Git integration? Connect the repo via **Workers & Pages > Create > Workers >
Import a repository**, and set:

- **Build command:** `npm run cf:build`
- **Deploy command:** `npx opennextjs-cloudflare deploy`

Cloudflare reads `wrangler.jsonc` for the runtime config. Set your secrets in the project settings
(see below) rather than committing them.

## Running alongside Vercel

This Cloudflare deployment is designed to run **in parallel** with an existing Vercel production deploy,
without disturbing it:

- **All the app changes required for Cloudflare** (the Next 15.5 bump, removing `runtime = 'edge'`,
  `serverExternalPackages`, `wrangler.jsonc`, this workflow) live **only on the dedicated Cloudflare branch**
  (`claude/cloudflare-deployment-migration-kg8rmh`). Keep them there.
- **Do not merge that branch into `v2-dev`.** `v2-dev` continues to deploy to Vercel exactly as before.
  Merging would push the framework bump and the edge-runtime change into your Vercel production build.
- To refresh the Cloudflare deploy with the latest production code, **merge or rebase `v2-dev` into the
  Cloudflare branch** (one direction only), then push - the workflow redeploys just the Cloudflare Worker.
- The two targets never collide: different infrastructure, different domains. Vercel builds previews of the
  branch too (harmless throwaway URLs); those are not your production.

---

## Setting API keys and environment variables

big-AGI reads all server config from `process.env` (validated in `src/server/env.server.ts`). On Cloudflare:

- **Secrets (API keys):** set them as encrypted Worker secrets, not in `wrangler.jsonc`:

  ```bash
  npx wrangler secret put OPENAI_API_KEY
  npx wrangler secret put ANTHROPIC_API_KEY
  # ...one per provider you use
  ```

  Or add them in the dashboard under **Settings > Variables and Secrets**.

- **Local preview:** put the same values in `.dev.vars` (gitignored). See `.dev.vars.example`.

- **`NEXT_PUBLIC_*` build-time vars** (e.g. `NEXT_PUBLIC_GA4_MEASUREMENT_ID`) must be present at **build**
  time, so set them in your build environment / Workers Builds settings, not as runtime secrets.

The full list of variables is in [environment-variables.md](environment-variables.md).

> `wrangler.jsonc` sets `compatibility_date` to a value `>= 2025-04-01`, which is what makes wrangler
> vars and secrets show up on `process.env`. Keep it at or above that date.

---

## Optional features

### Web browsing (Browser Rendering)

`src/modules/browse` connects to a remote browser over a websocket. Two choices:

- **Remote endpoint:** set `PUPPETEER_WSS_ENDPOINT` (e.g. a hosted browserless instance) as a Worker secret.
- **Cloudflare Browser Rendering:** uncomment the `browser` binding in `wrangler.jsonc` (requires the Paid
  plan) and adapt the browse router to use `@cloudflare/puppeteer` with that binding.

### Sharing / ChatGPT-share import (Prisma + Postgres)

The default Prisma engine does not run on Workers. To enable `src/modules/trade` persistence:

1. Add a Prisma **driver adapter** (e.g. `@prisma/adapter-pg` / Neon) and enable `driverAdapters` in the
   Prisma schema `previewFeatures`.
2. Provision **Hyperdrive** for your Postgres and add the `hyperdrive` binding in `wrangler.jsonc`.
3. Point `src/server/prisma/prismaDb.ts` at the adapter.

Until then, only the sharing/import endpoints are unavailable; the rest of the app is unaffected.

### ISR / SSG caching

big-AGI is dynamic (its API routes are `force-dynamic`), so no incremental cache is configured by default.
If you add ISR/SSG pages, enable an R2-backed cache in `open-next.config.ts` and add the matching
`r2_buckets` binding in `wrangler.jsonc` (see the comments in both files).

---

## Notes and limitations

- **No Edge runtime.** OpenNext runs everything on the Node.js-compatible Workers runtime; `export const
  runtime = 'edge'` is not supported and has been removed from `app/api/edge/[trpc]/route.ts`.
- **Node Middleware** (Next.js `middleware` on the Node runtime, 15.2+) is not yet supported by the adapter.
- Build output (`.open-next/`) and `cloudflare-env.d.ts` are gitignored.

## Troubleshooting

- Adapter/runtime issues: [OpenNext Cloudflare troubleshooting](https://opennext.js.org/cloudflare/troubleshooting).
- Confirm `nodejs_compat` is present in `compatibility_flags` if you see Node built-in errors at runtime.
- Deploys that build fine but 500 at runtime are usually missing secrets - check the Worker's logs
  (observability is enabled in `wrangler.jsonc`).
