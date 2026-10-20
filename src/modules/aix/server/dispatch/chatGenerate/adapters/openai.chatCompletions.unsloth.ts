import type { AixAPI_Model } from '../../../api/aix.wiretypes';
import type { OpenAIWire_API_Chat_Completions } from '../../wiretypes/openai.wiretypes';


// [praxeo fork] Unsloth (local server) Chat Completions payload extensions.
// Called by aixToOpenAIChatCompletions with one line, so upstream changes there rarely conflict.
// Only Unsloth-listed models carry these params, so no other host sees them.

export function unslothApplyChatCompletionsPayload(model: AixAPI_Model, payload: OpenAIWire_API_Chat_Completions.Request): void {

  // 'enable_thinking'-style templates (Qwen3 family) ignore reasoning_effort entirely; their only gate is the boolean,
  // which Unsloth lifts out of chat_template_kwargs into its native control (studio/backend/routes/inference.py).
  if (model.vndUnslothThinking) {
    const unslothThinkingOn = model.vndUnslothThinking !== 'none';
    payload.chat_template_kwargs = { ...payload.chat_template_kwargs, enable_thinking: unslothThinkingOn };
    // Sent alongside the gate: 'enable_thinking_effort' templates (GLM-5.x) grade on it, plain 'enable_thinking'
    // templates (Qwen3) ignore it, so one control drives both styles (server: _request_reasoning_kwargs).
    if (unslothThinkingOn)
      payload.reasoning_effort = model.vndUnslothThinking;
  }

  // Server-side web search: Unsloth runs its own tool loop and returns the grounded answer as plain text.
  // `enabled_tools` MUST be sent - omitting it enables every local tool (python, terminal, edit_file).
  // permission_mode 'off' skips the confirmation gate (which can only prompt over its own UI) while KEEPING
  // the execution sandbox on - unlike 'full'/bypass_permissions, which we never send.
  if (model.vndUnslothWebSearch === 'auto') {
    payload.enable_tools = true;
    payload.enabled_tools = ['web_search'];
    payload.permission_mode = 'off';
  }
}
