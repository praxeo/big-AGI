import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

import { appRouterEdge } from '~/server/trpc/trpc.router-edge';
import { createTRPCFetchContext } from '~/server/trpc/trpc.server';

const handlerEdgeRoutes = (req: Request) => fetchRequestHandler({
  endpoint: '/api/edge',
  router: appRouterEdge,
  req,
  createContext: createTRPCFetchContext,
  onError:
    process.env.NODE_ENV === 'development'
      ? ({ path, error }) => console.error(`\n❌ tRPC-edge failed on ${path ?? 'unk-path'}: ${error.message}`)
      : undefined,
});

// NOTE: we don't set maxDuration explicitly here - however we set it in the Vercel project settings, raising to the limit of 300s
// export const maxDuration = 60;

// NOTE: this router historically ran on the Edge runtime. The Cloudflare (OpenNext) adapter runs the whole
// app on the Node.js-compatible Workers runtime and does not support `export const runtime = 'edge'`, so the
// declaration is intentionally omitted. tRPC's fetch handler and async-generator streaming work unchanged on
// the Workers runtime. (On Vercel, without this declaration the route runs as a Node function rather than Edge.)
export { handlerEdgeRoutes as GET, handlerEdgeRoutes as POST };