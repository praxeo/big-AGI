import * as z from 'zod/v4';

import type { OpenAIWire_API_Models_List } from '~/modules/aix/server/dispatch/wiretypes/openai.wiretypes';

import { DModelInterfaceV1, LLM_IF_HOTFIX_NoWebP, LLM_IF_OAI_Chat, LLM_IF_OAI_Fn, LLM_IF_OAI_Reasoning, LLM_IF_OAI_Vision } from '~/common/stores/llms/llms.types';

import type { ModelDescriptionSchema } from '../../llm.server.types';


/**
 * [Unsloth] local OpenAI-compatible server (`unsloth studio` / `unsloth run`, default port 8888), llama.cpp-powered.
 *
 * Detection: every /v1/models entry carries `owned_by: 'unsloth-studio'` (server: studio/backend/routes/inference.py).
 * The listing has the loaded model(s) plus downloaded-but-unloaded GGUFs (`loaded` flag); with Unsloth's
 * 'Model auto-switch' setting on (Settings > API), requesting an unloaded id hot-swaps it in.
 *
 * Per-request reasoning controls on /v1/chat/completions (source-verified in the backend's
 * `_request_reasoning_kwargs`, mapped to llama-server chat_template_kwargs by template style):
 * - gpt-oss ('reasoning_effort' style): honors low|medium|high, 'minimal' coerces to low, cannot disable
 * - GLM 5.x-style hybrids ('enable_thinking_effort'): 'none' disables thinking, a named level enables it at that level
 * - Qwen3-style toggles ('enable_thinking') ignore `reasoning_effort` on this endpoint, so they get no dial
 */
export namespace UnslothWire_API_Models_List {

  export type Model = z.infer<typeof Model_schema>;
  export const Model_schema = z.object({
    id: z.string(),
    // created: server 'now' at listing time, not a release date - ignored
    owned_by: z.string().optional(),
    // Unsloth extensions
    display_name: z.string().nullish(),
    quant: z.string().nullish(), // e.g. 'UD-Q4_K_XL' - clients append ':<quant>' to the id to pin one
    loaded: z.boolean().nullish(),
    context_length: z.number().nullish(), // context the model is currently loaded at
    max_context_length: z.number().nullish(),
    native_context_length: z.number().nullish(), // trained context
  });

}


const _OWNED_BY_UNSLOTH = 'unsloth-studio';


export function unslothHeuristic(models: OpenAIWire_API_Models_List.Model[]): boolean {
  if (!models?.length) return false;
  return models.some(model => model.owned_by === _OWNED_BY_UNSLOTH);
}


export function unslothModelsToModelDescriptions(wireModels: OpenAIWire_API_Models_List.Model[]): ModelDescriptionSchema[] {
  return wireModels
    .map(wireModel => {
      const parsed = UnslothWire_API_Models_List.Model_schema.safeParse(wireModel);
      return parsed.success ? parsed.data : null;
    })
    .filter(model => model !== null)
    .sort((a, b) => {
      if (!!a.loaded !== !!b.loaded) return a.loaded ? -1 : 1; // loaded first
      return a.id.localeCompare(b.id);
    })
    .map(_unslothModelToModelDescription);
}


function _unslothModelToModelDescription(model: UnslothWire_API_Models_List.Model): ModelDescriptionSchema {
  const idLc = model.id.toLowerCase();

  // label: display_name, else the id without the owner prefix and -GGUF suffix
  const label = model.display_name || model.id.replace(/^[^/]+\//, '').replace(/-gguf$/i, '');

  // description
  const descs: string[] = [];
  descs.push(model.loaded ? '[loaded]' : '[on disk - loads on request with Unsloth\'s Model auto-switch on (Settings > API)]');
  if (model.quant)
    descs.push(model.quant);
  if (model.native_context_length)
    descs.push(`${Math.round(model.native_context_length / 1024)}K native context`);

  // loaded entries report their active/max context; catalog entries have none
  const contextWindow = model.max_context_length || model.context_length || model.native_context_length || null;

  // family heuristics - the listing exposes no capability flags
  const isGptOss = idLc.includes('gpt-oss');
  const isGlm5 = /glm[-_.]?5/.test(idLc);
  const looksReasoning = isGptOss || isGlm5 || /qwen3|qwq|deepseek-r1|deepseek-v3\.[12]|deepseek-v4|magistral|exaone-deep|smallthinker|reason|think/.test(idLc);

  const interfaces: DModelInterfaceV1[] = [
    LLM_IF_OAI_Chat,
    LLM_IF_OAI_Fn, // llama-server function calling; a no-tools template degrades gracefully
    LLM_IF_OAI_Vision, // optimistic: vision needs the mmproj loaded, which the listing does not expose
    LLM_IF_HOTFIX_NoWebP, // llama.cpp does not decode WebP
    ...(looksReasoning ? [LLM_IF_OAI_Reasoning] : []),
  ];

  // effort dial only where /v1/chat/completions honors `reasoning_effort` (see header note)
  const parameterSpecs: NonNullable<ModelDescriptionSchema['parameterSpecs']> = [];
  if (isGptOss)
    parameterSpecs.push({ paramId: 'llmVndOaiEffort', enumValues: ['low', 'medium', 'high'] });
  else if (isGlm5)
    parameterSpecs.push({ paramId: 'llmVndMiscEffort', enumValues: ['none', 'high', 'max'] });
  parameterSpecs.push({ paramId: 'llmForceNoStream' }); // SSE does not survive some tunnels (e.g. Cloudflare quick tunnels)

  return {
    id: model.id,
    label,
    description: descs.join(' · '),
    contextWindow,
    interfaces,
    parameterSpecs,
    ...(contextWindow ? { maxCompletionTokens: Math.round(contextWindow / 2) } : {}),
    chatPrice: { input: 'free', output: 'free' },
  };
}
