// GENERATED FILE - DO NOT EDIT
// Per-vendor model-defs versions, derived from the runtime semantics of the files claimed by
// ../llms.defs.manifest.ts - regenerate with: node tools/develop/gen-llms-defs/generate-llms-defs.mjs
// (next dev / next build regenerate it automatically; commit the result)

import type { ModelVendorId } from '../../vendors/vendors.registry';

export type LlmsDefsVersions = Readonly<Record<ModelVendorId | '_shared' | '_openaiCompat', string>>;

export const LLMS_DEFS_VERSIONS = {
  _openaiCompat: '5803cf028535',
  _shared: 'b3580c191df2',
  alibaba: 'd61bc5942988',
  anthropic: 'eea80087b3f3',
  azure: '4b2029e50fd6',
  bedrock: '30fa9127b7cb',
  cerebras: '679eba1638d2',
  cohere: 'ab4ecc08d1f8',
  deepseek: 'a03d867d99c1',
  googleai: '028511674796',
  groq: 'c3baefca1186',
  lmstudio: '6d1b6a2e6866',
  localai: '96077b1ee029',
  mistral: '2ec723b0c7d6',
  modular: 'df6904553c71',
  moonshot: '014d3db36956',
  nvidianim: '008791c8d876',
  ollama: '1f853dfe63fc',
  openai: '9c2254bf8749',
  openrouter: '3f46d8d35de2',
  perplexity: '377193ac3686',
  sakanaai: 'b793b5c8fd44',
  togetherai: 'f99ddad41b2f',
  xai: '05e5f8d2bf2c',
  zai: '4374de9c35a1',
} as const satisfies LlmsDefsVersions;
