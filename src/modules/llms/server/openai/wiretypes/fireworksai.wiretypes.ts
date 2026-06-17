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

export const wireFireworksAIControlPlaneModelSchema = z.object({
  name: z.string(),                          // e.g. "accounts/fireworks/models/glm-5p2"
  displayName: z.string().optional(),
  description: z.string().optional(),
  createTime: z.string().optional(),         // ISO date-time
  updateTime: z.string().optional(),
  kind: z.string().optional(),               // HF_BASE_MODEL, EMBEDDING_MODEL, FLUMINA_BASE_MODEL, ...
  contextLength: z.number().optional(),
  supportsImageInput: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  supportsServerless: z.boolean().optional(),
  // presence => the Chat Completions API is enabled for this model (contents unused; keep lenient)
  conversationConfig: z.object({ style: z.string().optional() }).optional(),
  baseModelDetails: z.object({
    parameterCount: z.string().optional(),   // int64-as-string; serverless price-per-token driver
    moe: z.boolean().optional(),
  }).optional(),
  // if set, the serverless deployment of the model is scheduled for take-down
  deprecationDate: z.object({
    year: z.number().optional(),
    month: z.number().optional(),
    day: z.number().optional(),
  }).optional(),
});

export type WireFireworksAIControlPlaneModel = z.infer<typeof wireFireworksAIControlPlaneModelSchema>;

export const wireFireworksAIControlPlaneListSchema = z.object({
  models: z.array(wireFireworksAIControlPlaneModelSchema),
  nextPageToken: z.string().optional(),
  totalSize: z.number().optional(),
});
