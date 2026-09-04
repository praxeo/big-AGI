// GENERATED FILE - DO NOT EDIT
// Per-vendor model-defs versions, derived from the runtime semantics of the files claimed by
// ../llms.defs.manifest.ts - regenerate with: node tools/develop/gen-llms-defs/generate-llms-defs.mjs
// (next dev / next build regenerate it automatically; commit the result)

import type { ModelVendorId } from '../../vendors/vendors.registry';

export type LlmsDefsVersions = Readonly<Record<ModelVendorId | '_shared' | '_openaiCompat', string>>;

export const LLMS_DEFS_VERSIONS = {
  _openaiCompat: '9da766e80594',
  _shared: '2e907da9b3d3',
  alibaba: '6188e0f2d155',
  anthropic: '8e6813b2a0dc',
  azure: 'a0676b085873',
  bedrock: '5ddcd0a5f33a',
  cerebras: '8baf69991b5d',
  cohere: '9e418d7fa859',
  deepseek: 'd87e463144c0',
  googleai: 'a97fbbba187e',
  groq: 'd44c9cfccdd8',
  lmstudio: 'd2c30a4b9152',
  localai: 'b104a8993f9e',
  metaai: 'dd068d0f7b7a',
  mistral: 'aee6145a7790',
  modular: 'a163a79b41ad',
  moonshot: '815dfc8c4538',
  nvidianim: 'f1f8863693e1',
  ollama: 'dcbdce65e0ee',
  openai: 'b14da03f99ed',
  openrouter: '556b4cae54ce',
  perplexity: 'b9dd905d3269',
  sakanaai: '8ec91e67803f',
  togetherai: 'cce43b3f513a',
  xai: '32a4ec0f6ce8',
  zai: '82903c7aa736',
} as const satisfies LlmsDefsVersions;
