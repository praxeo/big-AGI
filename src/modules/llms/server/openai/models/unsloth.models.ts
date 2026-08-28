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
 * Reasoning controls are NOT a function of the model name: Unsloth classifies the loaded model's chat template
 * at load time (`detect_reasoning_flags`) into one of three styles, and only honors the matching request field
 * (`_request_reasoning_kwargs` -> llama-server chat_template_kwargs):
 * - 'reasoning_effort' (gpt-oss/Harmony): a low|medium|high ladder, thinking cannot be disabled
 * - 'enable_thinking_effort' (GLM-5.x): an on/off gate plus a level; a named level implies thinking on
 * - 'enable_thinking' (Qwen3 family): a BOOLEAN only - `reasoning_effort` is dropped on the floor here
 * We therefore read the server's own flags from /v1/status for the loaded model and expose exactly the
 * control it honors; unloaded catalog entries fall back to conservative name heuristics.
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

/** GET /v1/status - the loaded model's runtime capabilities, as detected from its chat template. */
export namespace UnslothWire_API_Status {

  export type Response = z.infer<typeof Response_schema>;
  export const Response_schema = z.object({
    model_identifier: z.string().nullish(),
    supports_reasoning: z.boolean().nullish(),
    reasoning_style: z.enum(['enable_thinking', 'reasoning_effort', 'enable_thinking_effort']).nullish(),
    reasoning_effort_levels: z.array(z.string()).nullish(),
    reasoning_always_on: z.boolean().nullish(),
    supports_tools: z.boolean().nullish(),
    has_video_input: z.boolean().nullish(),
  });

}

export const UNSLOTH_API_PATHS = {
  status: '/v1/status',
} as const;


const _OWNED_BY_UNSLOTH = 'unsloth-studio';

/** Effort levels we can represent, in ascending order (Unsloth's own scale, minus its 'none' sentinel). */
const _EFFORT_SCALE = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;


export function unslothHeuristic(models: OpenAIWire_API_Models_List.Model[]): boolean {
  if (!models?.length) return false;
  return models.some(model => model.owned_by === _OWNED_BY_UNSLOTH);
}


export function unslothParseStatus(wireStatus: unknown): UnslothWire_API_Status.Response | null {
  const parsed = UnslothWire_API_Status.Response_schema.safeParse(wireStatus);
  return parsed.success ? parsed.data : null;
}

/** Key under which the models-list dispatch stashes the supplementary /v1/status payload. */
export const UNSLOTH_STATUS_KEY = '_unslothStatus' as const;

/** Reads back the stashed status, if the dispatch attached one (absent when the probe failed). */
export function unslothStatusFrom(response: unknown): UnslothWire_API_Status.Response | null {
  if (!response || typeof response !== 'object' || !(UNSLOTH_STATUS_KEY in response)) return null;
  return unslothParseStatus(response[UNSLOTH_STATUS_KEY]);
}


export function unslothModelsToModelDescriptions(wireModels: OpenAIWire_API_Models_List.Model[], status?: UnslothWire_API_Status.Response | null): ModelDescriptionSchema[] {
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
    // /v1/status describes the RESIDENT model only, so it informs the loaded entry and nothing else
    .map(model => _unslothModelToModelDescription(model, model.loaded ? status : null));
}


function _unslothModelToModelDescription(model: UnslothWire_API_Models_List.Model, status: UnslothWire_API_Status.Response | null | undefined): ModelDescriptionSchema {

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

  const { interfaces: reasoningInterfaces, parameterSpecs: reasoningSpecs, descriptor } = _unslothReasoningControls(model, status);
  if (descriptor)
    descs.push(descriptor);

  const interfaces: DModelInterfaceV1[] = [
    LLM_IF_OAI_Chat,
    ...((status?.supports_tools ?? true) ? [LLM_IF_OAI_Fn] : []), // llama-server function calling; a no-tools template degrades gracefully
    LLM_IF_OAI_Vision, // optimistic: vision needs the mmproj loaded, which neither endpoint exposes
    LLM_IF_HOTFIX_NoWebP, // llama.cpp does not decode WebP
    ...reasoningInterfaces,
  ];

  // Server-side web search rides Unsloth's tool loop, so it needs a tool-capable model. Offered on the resident
  // model when the server says it supports tools, and optimistically on catalog entries (no template to inspect).
  // Inert unless the server's tool policy allows it (`unsloth studio` defaults to off, `--disable-tools` forces off).
  const toolCapable = status ? (status.supports_tools ?? false) : true;

  const parameterSpecs: NonNullable<ModelDescriptionSchema['parameterSpecs']> = [
    ...reasoningSpecs,
    ...(toolCapable ? [{ paramId: 'llmVndUnslothWebSearch' } as const] : []),
    { paramId: 'llmForceNoStream' }, // SSE does not survive some tunnels (e.g. Cloudflare quick tunnels)
  ];

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


/**
 * The reasoning control this model actually honors.
 * Server-reported (exact) for the resident model; conservative name heuristics for catalog entries.
 */
function _unslothReasoningControls(model: UnslothWire_API_Models_List.Model, status: UnslothWire_API_Status.Response | null | undefined): {
  interfaces: DModelInterfaceV1[],
  parameterSpecs: NonNullable<ModelDescriptionSchema['parameterSpecs']>,
  descriptor: string | null,
} {
  const _none = { interfaces: [], parameterSpecs: [], descriptor: null };

  // -- server-reported (the resident model) --
  if (status?.reasoning_style) {

    if (!status.supports_reasoning)
      return _none;

    // hardcoded <think> markup: thinking is on and cannot be switched off - a control here would be a placebo
    if (status.reasoning_always_on)
      return { interfaces: [LLM_IF_OAI_Reasoning], parameterSpecs: [], descriptor: '[reasoning: always on]' };

    // levels the template actually branches on, narrowed to what we can represent
    const levels = (status.reasoning_effort_levels || []).filter((level): level is typeof _EFFORT_SCALE[number] => (_EFFORT_SCALE as readonly string[]).includes(level));

    switch (status.reasoning_style) {
      case 'reasoning_effort':
        // gpt-oss/Harmony: a ladder with no off switch (Unsloth coerces 'minimal' to 'low')
        return {
          interfaces: [LLM_IF_OAI_Reasoning],
          parameterSpecs: [{ paramId: 'llmVndOaiEffort', enumValues: levels.length ? levels : ['low', 'medium', 'high'] }],
          descriptor: '[reasoning: effort]',
        };

      case 'enable_thinking_effort':
        // GLM-5.x style: 'none' disables, a named level enables at that level (Unsloth derives the gate from it)
        return {
          interfaces: [LLM_IF_OAI_Reasoning],
          parameterSpecs: [{ paramId: 'llmVndMiscEffort', enumValues: ['none', ...(levels.length ? levels : ['high'])] }],
          descriptor: '[reasoning: on/off + effort]',
        };

      case 'enable_thinking':
        // Qwen3 family: a BOOLEAN gate. `reasoning_effort` is ignored by these templates, so this is the
        // only control that moves them - sent as chat_template_kwargs.enable_thinking by the OpenAI adapter.
        return {
          interfaces: [LLM_IF_OAI_Reasoning],
          parameterSpecs: [{ paramId: 'llmVndUnslothThinking', enumValues: ['none', 'high'] }],
          descriptor: '[reasoning: on/off]',
        };
    }
  }

  // -- name heuristics (unloaded catalog entries: no template to inspect) --
  const idLc = model.id.toLowerCase();
  if (idLc.includes('gpt-oss'))
    return { interfaces: [LLM_IF_OAI_Reasoning], parameterSpecs: [{ paramId: 'llmVndOaiEffort', enumValues: ['low', 'medium', 'high'] }], descriptor: null };
  if (/glm[-_.]?5/.test(idLc))
    return { interfaces: [LLM_IF_OAI_Reasoning], parameterSpecs: [{ paramId: 'llmVndMiscEffort', enumValues: ['none', 'high', 'max'] }], descriptor: null };
  if (/qwen[-_.]?3|qwq|deepseek-r1|deepseek-v[34]|magistral|exaone-deep|smallthinker|nemotron|reason|think/.test(idLc))
    return { interfaces: [LLM_IF_OAI_Reasoning], parameterSpecs: [{ paramId: 'llmVndUnslothThinking', enumValues: ['none', 'high'] }], descriptor: null };
  return _none;
}
