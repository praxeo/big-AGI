import type { AixAPI_Model } from '../../../api/aix.wiretypes';
import type { OpenAIWire_API_Chat_Completions } from '../../wiretypes/openai.wiretypes';


// [praxeo fork] Strata (local server) Chat Completions payload extensions.
// Called by aixToOpenAIChatCompletions with one line, so upstream changes there rarely conflict.
// Only Strata-listed models carry these params, so no other host sees them.
// Reasoning needs nothing here: the shared path already sends `reasoning_effort`, which Strata honors as is.

export function strataApplyChatCompletionsPayload(model: AixAPI_Model, payload: OpenAIWire_API_Chat_Completions.Request): void {

  // Server-side MCP tools: Strata offers the tools of the MCP servers in its config, runs the calls itself and streams
  // each step back (parsed by openai.parser.strata.ts). Only on streamed requests that declare no tools of their own:
  // Strata 400s a forced tool_choice next to MCP tools, and the function-calling utility calls (follow-ups, diagrams)
  // must not run local tools.
  if (model.vndStrataMcp === 'auto' && payload.stream && !payload.tools?.length)
    payload.strata_mcp = true;
}
