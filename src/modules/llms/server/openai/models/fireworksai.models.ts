import { DModelInterfaceV1, LLM_IF_OAI_Chat, LLM_IF_OAI_Fn, LLM_IF_OAI_Reasoning, LLM_IF_OAI_Vision } from '~/common/stores/llms/llms.types';

import { serverCapitalizeFirstLetter } from '~/server/wire';
import type { DebugWireLogger } from '~/server/wire';
import { fetchJsonOrTRPCThrow } from '~/server/trpc/trpc.router.fetchers';

import type { ModelDescriptionSchema } from '../../llm.server.types';

import { formatPubDate, fromManualMapping, llmsDefineManualMappings } from '../../models.mappings';

// --- FireworksAI Model ID inference (auto-derived from _fireworksKnownModels) ---
export type LlmsFireworksAIModelId = typeof _fireworksKnownModels[number]['idPrefix'];
import type { WireFireworksAIControlPlaneModel, WireFireworksAILegacyModel } from '../wiretypes/fireworksai.wiretypes';
import { wireFireworksAIControlPlaneListSchema, wireFireworksAIControlPlaneModelSchema, wireFireworksAIListOutputSchema } from '../wiretypes/fireworksai.wiretypes';


export function fireworksAIHeuristic(hostname: string) {
  return hostname.includes('fireworks.ai/');
}


const _fireworksKnownModels = llmsDefineManualMappings([
  // NOTE: the serverless models catalog is fully dynamic (see fireworksAIFetchModels), so no manual patching is
  // needed for regular models. The entries below are for 'Fast' serving-path routers, which live under
  // accounts/fireworks/routers/... and are NOT returned by the control-plane models catalog - they're injected
  // into the fetched list (see _fireworksExtraRouters) and described from here. https://docs.fireworks.ai/serverless/serving-paths#fast

  {
    // GLM 5.2 Fast: same model and quality as GLM 5.2, served on the high-speed 'Fast' path (100+ tokens/sec) at a
    // premium price. Not a distinct model - just a faster serving alias of accounts/fireworks/models/glm-5p2.
    idPrefix: 'accounts/fireworks/routers/glm-5p2-fast',
    label: 'Fireworks · GLM 5.2 Fast',
    pubDate: '20260615', // GLM 5.2 serverless release
    description: 'GLM 5.2 on the Fast serving path (100+ tokens/sec, premium price). Same model and quality as GLM 5.2, tuned for low-latency interactive use. Function calling and reasoning; text-only.',
    contextWindow: 1_048_576, // 1M, same as base glm-5p2
    maxCompletionTokens: 131072, // 128K max output
    interfaces: [LLM_IF_OAI_Chat, LLM_IF_OAI_Fn, LLM_IF_OAI_Reasoning],
    parameterSpecs: [
      // GLM 5.2 is a Max-tier model: none/low/medium/high plus 'xhigh' -> its top 'Max' thinking tier
      // (mirrors _fireworksEffortMax / _fireworksReasoningEffortValues, inlined as that const is defined below)
      { paramId: 'llmVndOaiEffort', enumValues: ['none', 'low', 'medium', 'high', 'xhigh'] },
    ],
    // 'Fast' serverless pricing ($/Mtok): input 2.10 / cached input 0.21 / output 6.60 - https://docs.fireworks.ai/serverless/pricing
    chatPrice: { input: 2.10, output: 6.60, cache: { cType: 'oai-ac', read: 0.21 } },
  },
]);

const _fireworksDenyListContains: string[] = [
  // nothing to deny for now
] as const;

// model 'kinds' that are not chat LLMs (embeddings, image generation, ...)
const _fireworksNonChatKinds = new Set<string>(['EMBEDDING_MODEL', 'FLUMINA_BASE_MODEL', 'FLUMINA_ADDON']);

// [Fireworks] per-model `reasoning_effort` value sets. The catalog API exposes no reasoning metadata, and the
// accepted/meaningful value set differs per model (source: Fireworks API reference - Create Chat/Text Completion
// per-model block + the reasoning guide; verified 2026-07). Models map to one of three UI tiers:
//  - Basic (low/medium/high): reasoning always on, 'none' is rejected with an error - gpt-oss (Harmony), minimax-m2.
//  - Max   (none/low/medium/high/xhigh): a real top thinking tier above 'high', reached via 'xhigh' - DeepSeek V4,
//    GLM 5.2. Fireworks folds 'xhigh' into its 'max' tier; we surface 'xhigh' (not 'max') because the shared
//    llmVndOaiEffort registry has no 'max' value (adding one would ripple into OpenRouter), and xhigh->max on the wire.
//  - Std   (none/low/medium/high): reasoning can be disabled via 'none'; the default for every other model. Some of
//    these (GLM 4.5/4.6/4.7/5.1, DeepSeek V3.1/V3.2) are actually binary on/off upstream, so low/medium/high collapse
//    to "on" - harmless, just not independently meaningful (that finer distinction is out of scope for this tier map).
// 'minimal' is rejected by every model, and 'xhigh'/'max' are not real values outside the Max-tier models above, so
// they are omitted elsewhere. NOTE: substring-matched (not catalog-driven), so new model families may need adding here.
type _FireworksEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';
const _fireworksEffortBasic: readonly _FireworksEffort[] = ['low', 'medium', 'high']; // reasoning always on
const _fireworksEffortStd: readonly _FireworksEffort[] = ['none', 'low', 'medium', 'high']; // can disable thinking via 'none'
const _fireworksEffortMax: readonly _FireworksEffort[] = ['none', 'low', 'medium', 'high', 'xhigh']; // 'xhigh' reaches the model's top 'max' tier
// model ids (substring match) selecting a non-default tier; everything else uses the Std set
const _fireworksBasicEffortContains: string[] = ['gpt-oss', 'minimax-m2'];
const _fireworksMaxEffortContains: string[] = ['deepseek-v4', 'glm-5p2'];

function _fireworksReasoningEffortValues(modelId: string): readonly _FireworksEffort[] {
  if (_fireworksBasicEffortContains.some(contains => modelId.includes(contains)))
    return _fireworksEffortBasic;
  if (_fireworksMaxEffortContains.some(contains => modelId.includes(contains)))
    return _fireworksEffortMax;
  return _fireworksEffortStd;
}


// --- Serverless catalog fetch (control-plane List Models API) ---

const FIREWORKS_CATALOG_ACCOUNT = 'fireworks'; // public serverless catalog owner (accounts/fireworks/models/...)
const FIREWORKS_LIST_PAGE_SIZE = 200;          // API max page size
const FIREWORKS_LIST_MAX_PAGES = 20;           // safety cap (200 * 20 = 4000 models)


/**
 * Common shape for a Fireworks model, normalized from either the control-plane serverless catalog
 * or the legacy OpenAI-compatible /v1/models listing. Carries `id` so the generic dispatch dedup/sort works.
 */
export interface FireworksNormalizedModel {
  id: string;                  // "accounts/fireworks/models/glm-5p2"
  created?: number;            // epoch seconds
  supportsChat: boolean;
  supportsImageInput?: boolean;
  supportsTools?: boolean;
  ownedBy: string;
  kind?: string;
  contextLength?: number;
  parameterCount?: number;     // raw number of params (control-plane only)
  moe?: boolean;               // Mixture of Experts (control-plane only)
  deprecated?: boolean;
}


function _fireworksNormalizeControlPlaneModel(m: WireFireworksAIControlPlaneModel): FireworksNormalizedModel {
  return {
    id: m.name,
    created: m.createTime ? (Math.floor(Date.parse(m.createTime) / 1000) || undefined) : undefined,
    // chat-capable = Chat Completions enabled (non-null conversationConfig) AND not an embedding/image kind
    // (NOTE: Fireworks sets conversationConfig even on EMBEDDING_MODEL kinds, so the kind guard is required)
    supportsChat: !!m.conversationConfig && !_fireworksNonChatKinds.has(m.kind || ''),
    supportsImageInput: m.supportsImageInput ?? undefined,
    supportsTools: m.supportsTools ?? undefined,
    ownedBy: 'fireworks',
    kind: m.kind ?? undefined,
    contextLength: m.contextLength ?? undefined,
    parameterCount: m.baseModelDetails?.parameterCount ? (Number(m.baseModelDetails.parameterCount) || undefined) : undefined,
    moe: m.baseModelDetails?.moe ?? undefined,
    deprecated: !!m.deprecationDate,
  };
}

function _fireworksNormalizeLegacyModel(m: WireFireworksAILegacyModel): FireworksNormalizedModel {
  return {
    id: m.id,
    created: m.created,
    supportsChat: m.supports_chat !== false,
    supportsImageInput: m.supports_image_input,
    supportsTools: m.supports_tools,
    ownedBy: typeof m.owned_by === 'string' ? m.owned_by : 'fireworks',
    kind: m.kind,
    contextLength: m.context_length,
  };
}


// [Fireworks] 'Fast' serving-path routers to inject into the fetched catalog. These are valid serverless chat
// endpoints (accounts/fireworks/routers/...) that the control-plane models catalog does NOT list, so without
// this they'd never appear in the model picker. Display metadata comes from the _fireworksKnownModels editorial
// entries (matched by id); the fields here mainly drive list ordering (created) and a sane fallback if an
// editorial entry is ever missing. https://docs.fireworks.ai/serverless/serving-paths#fast
const _fireworksExtraRouters: FireworksNormalizedModel[] = [
  {
    id: 'accounts/fireworks/routers/glm-5p2-fast',
    created: 1781481600, // 2026-06-15 (GLM 5.2 serverless release) - keeps it adjacent to base glm-5p2 in the list
    supportsChat: true,
    supportsTools: true,
    ownedBy: 'fireworks',
    kind: 'HF_BASE_MODEL',
    contextLength: 1_048_576, // 1M (fallback only; editorial contextWindow wins)
  },
];

/** Appends the extra 'Fast' routers not already present in the fetched catalog (id-deduped). */
function _fireworksWithExtraRouters(models: FireworksNormalizedModel[]): FireworksNormalizedModel[] {
  const present = new Set(models.map(m => m.id));
  const extras = _fireworksExtraRouters.filter(router => !present.has(router.id));
  return extras.length ? [...models, ...extras] : models;
}


/**
 * Fetches the Fireworks serverless model catalog.
 *
 * The OpenAI-compatible `/inference/v1/models` endpoint only returns a subset of models (mostly the
 * account's deployed/known models), so serverless-only models (e.g. glm-5p2) never appear. Instead we
 * query the control-plane List Models API with `filter=supports_serverless=true`, which returns the full
 * serverless catalog (this is what Fireworks' own `fireconnect model list` uses, and works with a normal key).
 *
 * Falls back to the legacy `/v1/models` listing if the control-plane call fails (e.g. restricted keys),
 * so behavior degrades gracefully rather than erroring.
 *
 * @param oaiModelsUrl the resolved OpenAI-compatible models URL (e.g. https://api.fireworks.ai/inference/v1/models)
 */
export async function fireworksAIFetchModels(oaiModelsUrl: string, headers: HeadersInit, signal: AbortSignal | undefined, wire: DebugWireLogger | null): Promise<{ data: FireworksNormalizedModel[] }> {

  // control-plane base, derived from the configured host origin (e.g. https://api.fireworks.ai)
  let origin: string;
  try {
    origin = new URL(oaiModelsUrl).origin;
  } catch {
    origin = 'https://api.fireworks.ai';
  }

  try {
    const models: FireworksNormalizedModel[] = [];
    let skipped = 0;
    let pageToken: string | undefined = undefined;

    for (let page = 0; page < FIREWORKS_LIST_MAX_PAGES; page++) {
      const params = new URLSearchParams({
        filter: 'supports_serverless=true',
        pageSize: String(FIREWORKS_LIST_PAGE_SIZE),
      });
      if (pageToken)
        params.set('pageToken', pageToken);
      const url = `${origin}/v1/accounts/${FIREWORKS_CATALOG_ACCOUNT}/models?${params.toString()}`;

      wire?.logRequest('GET', url, headers);
      const wireResponse = await fetchJsonOrTRPCThrow({ url, headers, name: 'OpenAI/Fireworks', signal });
      wire?.logResponse(wireResponse);

      // parse the envelope leniently, then validate each model on its own so one odd entry never collapses the catalog
      const { models: rawModels, nextPageToken } = wireFireworksAIControlPlaneListSchema.parse(wireResponse);
      for (const raw of rawModels) {
        const parsed = wireFireworksAIControlPlaneModelSchema.safeParse(raw);
        if (parsed.success)
          models.push(_fireworksNormalizeControlPlaneModel(parsed.data));
        else
          skipped++;
      }

      if (!nextPageToken)
        break;
      pageToken = nextPageToken;
    }

    if (skipped)
      console.warn(`[Fireworks] serverless catalog: skipped ${skipped} model(s) that failed validation`);

    // if the catalog came back empty (unexpected), fall through to the legacy listing rather than showing nothing
    if (!models.length)
      throw new Error('empty serverless catalog');

    return { data: _fireworksWithExtraRouters(models) };

  } catch (error) {
    // Fallback: control-plane catalog unavailable (e.g. restricted key) - use the legacy OpenAI-compatible listing
    console.warn('[Fireworks] serverless catalog unavailable, falling back to /v1/models:', (error as Error)?.message || error);
    wire?.logRequest('GET', oaiModelsUrl, headers);
    const wireResponse = await fetchJsonOrTRPCThrow<{ data?: unknown }>({ url: oaiModelsUrl, headers, name: 'OpenAI/Fireworks', signal });
    wire?.logResponse(wireResponse);
    const legacyModels = wireFireworksAIListOutputSchema.parse(wireResponse?.data ?? []);
    return { data: _fireworksWithExtraRouters(legacyModels.map(_fireworksNormalizeLegacyModel)) };
  }
}


// --- Model descriptions ---

function _prettyModelId(id: string, isVision: boolean): string {
  // example: "accounts/fireworks/models/llama-v3p1-405b-instruct" => "Fireworks · Llama V3p1 405b Instruct"
  let prettyName = id
    .replace(/^accounts\//, '') // remove the leading "accounts/" if present
    .replace(/\/models\//, ' · ') // turn the next "/models/" into " · "
    .replaceAll(/[_-]/g, ' ') // replace underscores or dashes with spaces
    .split(' ')
    .filter(piece => piece !== 'instruct')
    .map(serverCapitalizeFirstLetter)
    .join(' ')
    .replaceAll('/', ' · ') // replace any additional slash with " · "
    .trim();
  // add "Vision" to the name if it's a vision model
  if (isVision && !id.includes('-vision'))
    prettyName += ' Vision';
  prettyName = prettyName.replace(' Vision', ' (Vision)');
  return prettyName;
}

function _fireworksModelDescription(model: FireworksNormalizedModel): string {
  const bits: string[] = [];
  // parameter count, e.g. "236B params" (raw count from the serverless catalog)
  if (model.parameterCount) {
    const billions = model.parameterCount / 1e9;
    bits.push(billions >= 1 ? `${Math.round(billions)}B params` : `${model.parameterCount} params`);
  }
  if (model.moe)
    bits.push('MoE');
  bits.push(`${model.ownedBy} \`${model.kind || 'unknown'}\` type`);
  const description = bits.join(' · ') + '.';
  return model.deprecated ? '⚠️ Deprecated. ' + description : description;
}


export function fireworksAIModelsToModelDescriptions(models: FireworksNormalizedModel[]): ModelDescriptionSchema[] {
  return models

    .filter((model) => {
      // filter-out non-chat models (embeddings, image generation, ...)
      if (model.supportsChat === false)
        return false;

      return !_fireworksDenyListContains.some(contains => model.id.includes(contains));
    })

    .map((model): ModelDescriptionSchema => {

      // heuristics
      const label = _prettyModelId(model.id, !!model.supportsImageInput);
      const description = _fireworksModelDescription(model);
      const contextWindow = model.contextLength || null;
      const interfaces: DModelInterfaceV1[] = [LLM_IF_OAI_Chat];
      if (model.supportsImageInput)
        interfaces.push(LLM_IF_OAI_Vision);
      if (model.supportsTools)
        interfaces.push(LLM_IF_OAI_Fn);

      // [Fireworks] serverless chat models are reasoning models - expose reasoning_effort with the per-model
      // value set probed from the live API (see _fireworksReasoningEffortValues). Default unset = vendor default,
      // so models are unaffected unless a level is explicitly chosen; the openai-dialect adapter sends it as
      // `reasoning_effort`, and replies carry `reasoning_content`. https://docs.fireworks.ai/guides/reasoning
      interfaces.push(LLM_IF_OAI_Reasoning);
      const parameterSpecs: ModelDescriptionSchema['parameterSpecs'] = [
        { paramId: 'llmVndOaiEffort', enumValues: [..._fireworksReasoningEffortValues(model.id)] },
      ];

      const md = fromManualMapping(_fireworksKnownModels, model.id, model.created, undefined, {
        idPrefix: model.id,
        label,
        description,
        contextWindow,
        interfaces,
        parameterSpecs,
        // maxCompletionTokens: ...
        // benchmark: ...
        // chatPrice,
        hidden: false,
      });

      // pubDate fallback: Fireworks' 'created' is verified real per-model release/index dates (unique,
      // 2024-2026 spread, not a constant), so derive a day-precision pubDate to drive the "new" badge for
      // models without an editorial pubDate. An editorial pubDate (from _fireworksKnownModels) always wins.
      if (md.pubDate === undefined && md.created)
        md.pubDate = formatPubDate(md.created);

      return md;
    })

    .sort((a: ModelDescriptionSchema, b: ModelDescriptionSchema): number => {
      if (a.created !== b.created)
        return (b.created || 0) - (a.created || 0);
      return a.id.localeCompare(b.id);
    });
}
