import { DModelInterfaceV1, LLM_IF_OAI_Chat, LLM_IF_OAI_Fn, LLM_IF_OAI_Vision } from '~/common/stores/llms/llms.types';

import { serverCapitalizeFirstLetter } from '~/server/wire';
import type { DebugWireLogger } from '~/server/wire';
import { fetchJsonOrTRPCThrow } from '~/server/trpc/trpc.router.fetchers';

import type { ModelDescriptionSchema } from '../../llm.server.types';

import { fromManualMapping, llmsDefineManualMappings } from '../../models.mappings';

// --- FireworksAI Model ID inference (auto-derived from _fireworksKnownModels) ---
export type LlmsFireworksAIModelId = typeof _fireworksKnownModels[number]['idPrefix'];
import type { WireFireworksAIControlPlaneModel, WireFireworksAILegacyModel } from '../wiretypes/fireworksai.wiretypes';
import { wireFireworksAIControlPlaneListSchema, wireFireworksAIControlPlaneModelSchema, wireFireworksAIListOutputSchema } from '../wiretypes/fireworksai.wiretypes';


export function fireworksAIHeuristic(hostname: string) {
  return hostname.includes('fireworks.ai/');
}


const _fireworksKnownModels = llmsDefineManualMappings([
  // NOTE: the serverless catalog is fully dynamic (see fireworksAIFetchModels), so no manual patching needed for now
]);

const _fireworksDenyListContains: string[] = [
  // nothing to deny for now
] as const;

// model 'kinds' that are not chat LLMs (embeddings, image generation, ...)
const _fireworksNonChatKinds = new Set<string>(['EMBEDDING_MODEL', 'FLUMINA_BASE_MODEL', 'FLUMINA_ADDON']);


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

    return { data: models };

  } catch (error) {
    // Fallback: control-plane catalog unavailable (e.g. restricted key) - use the legacy OpenAI-compatible listing
    console.warn('[Fireworks] serverless catalog unavailable, falling back to /v1/models:', (error as Error)?.message || error);
    wire?.logRequest('GET', oaiModelsUrl, headers);
    const wireResponse = await fetchJsonOrTRPCThrow<{ data?: unknown }>({ url: oaiModelsUrl, headers, name: 'OpenAI/Fireworks', signal });
    wire?.logResponse(wireResponse);
    const legacyModels = wireFireworksAIListOutputSchema.parse(wireResponse?.data ?? []);
    return { data: legacyModels.map(_fireworksNormalizeLegacyModel) };
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

      return fromManualMapping(_fireworksKnownModels, model.id, model.created, undefined, {
        idPrefix: model.id,
        label,
        description,
        contextWindow,
        interfaces,
        // parameterSpecs: ...
        // maxCompletionTokens: ...
        // benchmark: ...
        // chatPrice,
        hidden: false,
      });
    })

    .sort((a: ModelDescriptionSchema, b: ModelDescriptionSchema): number => {
      if (a.created !== b.created)
        return (b.created || 0) - (a.created || 0);
      return a.id.localeCompare(b.id);
    });
}
