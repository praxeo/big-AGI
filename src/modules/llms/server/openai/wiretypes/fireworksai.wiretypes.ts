import * as z from 'zod/v4';


// [Fireworks AI] OpenAI-compatible Models List API (`/inference/v1/models`) - Response
// NOTE: this endpoint only returns a subset of models (mostly the account's deployed/known models),
// so serverless-only models never appear. Kept as a fallback - see the control-plane schema below.

export const wireFireworksAIListOutputSchema = z.array(z.object({

  id: z.string(),
  object: z.literal('model'),
  owned_by: z.union([
    z.literal('fireworks'),
    z.literal('yi-01-ai'),
    z.string(),
  ]),
  created: z.number(),
  kind: z.union([
    z.literal('HF_BASE_MODEL'),
    z.literal('HF_PEFT_ADDON'),
    z.literal('FLUMINA_BASE_MODEL'),
    z.string(),
  ]).optional(),
  // these seem to be there all the time, but just in case make them optional
  supports_chat: z.boolean().optional(),
  supports_image_input: z.boolean().optional(),
  supports_tools: z.boolean().optional(),
  // Not all models have this, so make it optional
  context_length: z.number().optional(),
}));

export type WireFireworksAILegacyModel = z.infer<typeof wireFireworksAIListOutputSchema>[number];


// [Fireworks AI] Control-plane List Models API - Response
// GET /v1/accounts/{account}/models?filter=supports_serverless=true
// Unlike the OpenAI-compatible /v1/models endpoint, this returns the FULL serverless catalog (the
// same source Fireworks' own `fireconnect model list` uses). Docs: https://docs.fireworks.ai/api-reference/list-models
// We only declare the fields we consume; unknown fields are stripped by zod.

// NOTE: object-typed optional fields come back as `null` (not absent) for many models - e.g.
// `conversationConfig: null` (non-chat models) and `deprecationDate: null` (non-deprecated models, i.e.
// almost all of them). Hence `.nullish()` (null | undefined) throughout, otherwise `.parse()` throws on the
// real response and the catalog silently degrades to the legacy fallback.
export const wireFireworksAIControlPlaneModelSchema = z.object({
  name: z.string(),                          // e.g. "accounts/fireworks/models/glm-5p2"
  displayName: z.string().nullish(),
  description: z.string().nullish(),
  createTime: z.string().nullish(),          // ISO date-time
  updateTime: z.string().nullish(),
  kind: z.string().nullish(),                // HF_BASE_MODEL, EMBEDDING_MODEL, FLUMINA_BASE_MODEL, ...
  contextLength: z.number().nullish(),
  supportsImageInput: z.boolean().nullish(),
  supportsTools: z.boolean().nullish(),
  supportsServerless: z.boolean().nullish(),
  // presence (non-null) => the Chat Completions API is enabled for this model (contents unused; keep lenient)
  conversationConfig: z.object({ style: z.string().nullish() }).nullish(),
  baseModelDetails: z.object({
    parameterCount: z.string().nullish(),    // int64-as-string; serverless price-per-token driver
    moe: z.boolean().nullish(),
  }).nullish(),
  // non-null => the serverless deployment of the model is scheduled for take-down
  deprecationDate: z.object({
    year: z.number().nullish(),
    month: z.number().nullish(),
    day: z.number().nullish(),
  }).nullish(),
});

export type WireFireworksAIControlPlaneModel = z.infer<typeof wireFireworksAIControlPlaneModelSchema>;

// Parse the envelope leniently and validate each model individually (see fireworksAIFetchModels), so a
// single unexpected entry can never collapse the whole catalog into the legacy fallback.
export const wireFireworksAIControlPlaneListSchema = z.object({
  models: z.array(z.unknown()),
  nextPageToken: z.string().nullish(),
  totalSize: z.number().nullish(),
});
