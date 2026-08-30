// OpenNext configuration for deploying big-AGI to Cloudflare Workers.
// Docs: https://opennext.js.org/cloudflare/config
import { defineCloudflareConfig } from '@opennextjs/cloudflare';

export default defineCloudflareConfig({

  // big-AGI is a dynamic, client-first app: its API routes are `force-dynamic` and there is
  // essentially no ISR/SSG output, so no incremental cache override is needed by default.
  //
  // If you later add ISR/SSG pages, enable an R2-backed cache and add the matching r2_buckets
  // binding (NEXT_INC_CACHE_R2_BUCKET) in wrangler.jsonc:
  //
  //   import r2IncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache';
  //   ...
  //   incrementalCache: r2IncrementalCache,

});
