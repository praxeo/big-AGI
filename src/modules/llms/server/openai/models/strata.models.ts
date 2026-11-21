import * as z from 'zod/v4';

import type { OpenAIWire_API_Models_List } from '~/modules/aix/server/dispatch/wiretypes/openai.wiretypes';

import { DModelInterfaceV1, LLM_IF_OAI_Chat, LLM_IF_OAI_Fn, LLM_IF_OAI_Reasoning, LLM_IF_OAI_Vision } from '~/common/stores/llms/llms.types';

import type { ModelDescriptionSchema } from '../../llm.server.types';


/**
 * [Strata] local inference engine (github.com/Niko1221/Strata, `strata launch`, default http://127.0.0.1:8080),
 * OpenAI- and Anthropic-compatible. One model is resident at a time: Qwen3.8-Flash-Next, Qwen3.6-35B-A3B or
 * DeepSeek-V4.1-Flash - all thinking models.
 *
 * Detection: /v1/models entries carry no `owned_by`/`created`, and do carry `status.value`, `meta.n_ctx` and
 * `architecture.input_modalities` (serve/server.py). Aliases are listed again under their own id with `alias_of`;
 * the optional image model (output 'image', POST /v1/images/generations) is not a chat model.
 *
 * Request side (openai.chatCompletions.strata.ts):
 * - `reasoning_effort` none|low|medium|high, Strata's own scale ('high' is the template default, 'none' answers at once)
 * - `strata_mcp: true` runs the tools of the MCP servers in Strata's config, server-side
 */
export namespace StrataWire_API_Models_List {

  export type Model = z.infer<typeof Model_schema>;
  export const Model_schema = z.object({
    id: z.string(),
    status: z.object({ value: z.string() }).nullish(), // 'loaded' | 'unloaded' (idle-unloaded: loads on the next request)
    meta: z.object({ n_ctx: z.number().nullish() }).nullish(), // the context the model was started with
    architecture: z.object({
      input_modalities: z.array(z.string()).nullish(), // 'image' when the vision encoder is on
      output_modalities: z.array(z.string()).nullish(),
    }).nullish(),
    alias_of: z.string().nullish(),
  });

}


/** Strata's reasoning_effort scale (serve/server.py: anything else is a 400). */
const _STRATA_EFFORTS = ['none', 'low', 'medium', 'high'] as const;

const _STRATA_LABELS: Record<string, string> = {
  'qwen3.8-flash-next': 'Qwen3.8 Flash Next',
  'qwen3.6-35b-a3b': 'Qwen3.6 35B A3B',
  'deepseek-v4.1-flash': 'DeepSeek V4.1 Flash',
};


export function strataHeuristic(models: OpenAIWire_API_Models_List.Model[]): boolean {
  if (!models?.length) return false;
  return models.some(model => {
    if (model.owned_by !== undefined) return false;
    const { meta, status, architecture } = model as { meta?: { n_ctx?: unknown }, status?: { value?: unknown }, architecture?: { input_modalities?: unknown } };
    return typeof meta?.n_ctx === 'number' && typeof status?.value === 'string' && Array.isArray(architecture?.input_modalities);
  });
}


export function strataModelsToModelDescriptions(wireModels: OpenAIWire_API_Models_List.Model[]): ModelDescriptionSchema[] {
  return wireModels
    .map(wireModel => {
      const parsed = StrataWire_API_Models_List.Model_schema.safeParse(wireModel);
      return parsed.success ? parsed.data : null;
    })
    .filter(model => model !== null)
    .filter(model => model.architecture?.output_modalities?.includes('text') ?? true) // drop the image model
    .sort((a, b) => !!a.alias_of === !!b.alias_of ? 0 : a.alias_of ? 1 : -1) // the model first, then its aliases
    .map(_strataModelToModelDescription);
}


function _strataModelToModelDescription(model: StrataWire_API_Models_List.Model): ModelDescriptionSchema {

  const label = _STRATA_LABELS[model.id.toLowerCase()] ?? model.id;
  const contextWindow = model.meta?.n_ctx || null;
  const hasVision = !!model.architecture?.input_modalities?.includes('image');

  // description
  const descs: string[] = [];
  descs.push(model.status?.value === 'unloaded' ? '[unloaded - loads on the first request]' : '[loaded]');
  if (model.alias_of)
    descs.push(`alias of ${model.alias_of}`);
  if (contextWindow)
    descs.push(`${Math.round(contextWindow / 1024)}K context`);
  descs.push(hasVision ? 'text + image input' : 'text input');

  const interfaces: DModelInterfaceV1[] = [
    LLM_IF_OAI_Chat,
    LLM_IF_OAI_Fn, // Chat Completions tools, streamed (serve/server.py openai_chunks)
    ...(hasVision ? [LLM_IF_OAI_Vision] : []), // WebP and the rest are converted server-side
    LLM_IF_OAI_Reasoning, // every Strata family thinks, streamed as reasoning_content
  ];

  return {
    id: model.id,
    label,
    description: descs.join(' · '),
    contextWindow,
    interfaces,
    parameterSpecs: [
      { paramId: 'llmVndOaiEffort', enumValues: [..._STRATA_EFFORTS] },
      { paramId: 'llmVndStrataMcp' },
    ],
    ...(contextWindow ? { maxCompletionTokens: Math.round(contextWindow / 2) } : {}),
    chatPrice: { input: 'free', output: 'free' },
    hidden: !!model.alias_of, // the same model under another name
  };
}
