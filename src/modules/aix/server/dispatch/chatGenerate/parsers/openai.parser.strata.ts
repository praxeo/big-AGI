import * as z from 'zod/v4';

import type { IParticleTransmitter } from './IParticleTransmitter';


// [praxeo fork] Strata (local server): server-side MCP tool activity -> operation chips.
// Created and called by the OpenAI streaming parser with one line each, so upstream changes there rarely conflict.
//
// With `strata_mcp: true` Strata runs the MCP tool calls itself and reports each step on an otherwise empty chunk,
// under a `strata_mcp` field (serve/server.py run_with_mcp). The calls never appear as `tool_calls`, so the turn
// ends as a normal answer. Events:
// - start  {id, name}                                  the model began writing a call
// - call   {id, name, server, tool, arguments, round}  the call runs
// - result {id, ok, text, chars, truncated, ms, skipped} its result; `skipped`: announced, never run
// - limit  {max_rounds}                                the round limit was hit, one final reply follows without tools

const _MAX_RESULT_CHARS = 2000; // the chip tooltip shows a preview, the model got the full result

const _CallId_schema = z.union([z.string(), z.number()]).transform(String);

const StrataMcpEvent_schema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('start'), id: _CallId_schema, name: z.string() }),
  z.object({ event: z.literal('call'), id: _CallId_schema, name: z.string(), server: z.string().nullish(), tool: z.string().nullish(), arguments: z.unknown().optional() }),
  z.object({ event: z.literal('result'), id: _CallId_schema, ok: z.boolean(), text: z.string().nullish(), truncated: z.boolean().nullish(), skipped: z.boolean().nullish() }),
  z.object({ event: z.literal('limit'), max_rounds: z.number().nullish() }),
]);


/** Returns a per-stream handler; it returns true when the chunk carried tool activity (shown to the user). */
export function createStrataMcpEventsHandler() {

  const labels = new Map<string, string>(); // call id -> chip text
  let limitCount = 0;

  return function(pt: IParticleTransmitter, chunkData: unknown): boolean {
    const rawEvent = (chunkData as { strata_mcp?: unknown } | null)?.strata_mcp;
    if (!rawEvent) return false;

    const parsed = StrataMcpEvent_schema.safeParse(rawEvent);
    if (!parsed.success) {
      console.log('AIX: Strata: unknown MCP event:', rawEvent);
      return false;
    }

    const ev = parsed.data;
    switch (ev.event) {

      case 'start': {
        const label = `Calling ${ev.name}`;
        labels.set(ev.id, label);
        pt.sendOperationState('code-exec', label, { opId: `strata-mcp-${ev.id}` });
        return true;
      }

      case 'call': {
        const label = ev.server && ev.tool ? `${ev.server} · ${ev.tool}` : ev.name;
        labels.set(ev.id, label);
        const args = ev.arguments === undefined ? undefined : JSON.stringify(ev.arguments, null, 2);
        pt.sendOperationState('code-exec', label, { opId: `strata-mcp-${ev.id}`, ...(args ? { iTexts: [args] } : {}) });
        return true;
      }

      case 'result': {
        const label = labels.get(ev.id) ?? 'Tool';
        const text = ev.text ?? '';
        const preview = text.length > _MAX_RESULT_CHARS ? text.slice(0, _MAX_RESULT_CHARS) + '\n...' : text;
        if (ev.skipped)
          pt.sendOperationState('code-exec', `${label} (not run)`, { opId: `strata-mcp-${ev.id}`, state: 'done' });
        else
          pt.sendOperationState('code-exec', label, { opId: `strata-mcp-${ev.id}`, state: ev.ok ? 'done' : 'error', ...(preview ? { oTexts: [preview] } : {}) });
        return true;
      }

      case 'limit':
        pt.sendOperationState('code-exec', `Tool limit reached${ev.max_rounds ? ` (${ev.max_rounds} rounds)` : ''}`, { opId: `strata-mcp-limit-${++limitCount}`, state: 'done' });
        return true;
    }
  };
}
