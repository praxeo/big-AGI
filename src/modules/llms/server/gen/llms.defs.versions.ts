// GENERATED FILE - DO NOT EDIT
// Per-vendor model-defs versions, derived from the runtime semantics of the files claimed by
// ../llms.defs.manifest.ts - regenerate with: node tools/develop/gen-llms-defs/generate-llms-defs.mjs
// (next dev / next build regenerate it automatically; commit the result)

import type { ModelVendorId } from '../../vendors/vendors.registry';

export type LlmsDefsVersions = Readonly<Record<ModelVendorId | '_shared' | '_openaiCompat', string>>;

export const LLMS_DEFS_VERSIONS = {
  _openaiCompat: '52bef27b1fa4',
  _shared: 'bddb72fd292b',
  alibaba: '592f03a98ea2',
  anthropic: '7bc551639029',
  azure: 'e1ea2d025ec2',
  bedrock: '5f8266a930dd',
  cerebras: 'a5aae8fdf6be',
  cohere: '12f9a0b189c8',
  deepseek: 'b26a9cf6b9b2',
  googleai: '23448cb28caa',
  groq: '533c479af951',
  lmstudio: '8e84b895fc31',
  localai: '176668f2783d',
  mistral: '3771125ca290',
  modular: 'a56aa61f8198',
  moonshot: '9f8b1d66c12f',
  nvidianim: '6ae250793858',
  ollama: '05dffb52b16c',
  openai: 'f0e17d1ca622',
  openrouter: '80472b11eb5a',
  perplexity: 'e4eb27289b70',
  sakanaai: '18bfa1282cd7',
  togetherai: '67aba5c2c2e4',
  xai: '1dd07df434b7',
  zai: '2bb45b6b2868',
} as const satisfies LlmsDefsVersions;
