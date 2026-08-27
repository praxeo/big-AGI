// GENERATED FILE - DO NOT EDIT
// Per-vendor model-defs versions, derived from the runtime semantics of the files claimed by
// ../llms.defs.manifest.ts - regenerate with: node tools/develop/gen-llms-defs/generate-llms-defs.mjs
// (next dev / next build regenerate it automatically; commit the result)

import type { ModelVendorId } from '../../vendors/vendors.registry';

export type LlmsDefsVersions = Readonly<Record<ModelVendorId | '_shared' | '_openaiCompat', string>>;

export const LLMS_DEFS_VERSIONS = {
  _openaiCompat: '6b21c8a99a74',
  _shared: '9bab7620e9b4',
  alibaba: 'd0b3f510f025',
  anthropic: 'd4e29e3d88dc',
  azure: '0f4122eadf4f',
  bedrock: '1ed62af0f8aa',
  cerebras: '86d8d790e7b0',
  cohere: 'a7d8052d3410',
  deepseek: 'de5def3e9c28',
  googleai: '7c451d6b3210',
  groq: '789c7e27e32a',
  lmstudio: '850d2384b171',
  localai: '17de7a65d8ac',
  mistral: '25dc47f3cf65',
  modular: '795d93a94af7',
  moonshot: 'b81b2714a47e',
  nvidianim: '4538011df569',
  ollama: 'f3168280c1d4',
  openai: '5f426ee3443e',
  openrouter: '900ee1877ba8',
  perplexity: '858a5fcf0236',
  sakanaai: 'ff2bdbce19e9',
  togetherai: '7850efb9676b',
  xai: 'e184f4de0dad',
  zai: '79609a335d48',
} as const satisfies LlmsDefsVersions;
