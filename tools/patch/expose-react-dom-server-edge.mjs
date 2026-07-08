/**
 * [Cloudflare/OpenNext] Expose react-dom's `./server.edge` subpath export.
 *
 * react-dom 18 ships `server.browser.js` (web-streams SSR, workerd-compatible) but its package.json
 * `exports` map does NOT list `./server.edge`. Next.js 15's pages-router SSR runtime does
 * `require('react-dom/server.edge')`, so on Cloudflare Workers the OpenNext bundler can't resolve the
 * subpath and stubs it as a missing optional dependency - which makes every server-rendered page return
 * 500 (see https://github.com/opennextjs/opennextjs-cloudflare/issues/855). React 19 adds this export
 * natively; on React 18 we add it here (idempotent, and a no-op once the export already exists).
 *
 * Runs from `postinstall`. Harmless on non-Cloudflare targets: it only adds a resolvable subpath that
 * maps to react-dom's existing browser SSR build.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

try {
  const pkgPath = require.resolve('react-dom/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

  if (pkg?.exports && typeof pkg.exports === 'object' && !pkg.exports['./server.edge']) {
    // point ./server.edge at the browser SSR build (renderToReadableStream + the legacy sync APIs, all workerd-safe)
    pkg.exports['./server.edge'] = pkg.exports['./server.browser'] ?? './server.browser.js';
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log(' 🧠 big-AGI: patched react-dom to expose ./server.edge (Cloudflare/OpenNext pages-router SSR)');
  }
} catch (error) {
  // Non-fatal: only the Cloudflare Workers SSR path needs this; other targets are unaffected.
  console.warn(' 🧠 big-AGI: react-dom ./server.edge patch skipped:', error?.message || error);
}
