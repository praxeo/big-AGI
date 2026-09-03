// GENERATED FILE - DO NOT EDIT
// Per-vendor model-defs versions, derived from the runtime semantics of the files claimed by
// ../llms.defs.manifest.ts - regenerate with: node tools/develop/gen-llms-defs/generate-llms-defs.mjs
// (next dev / next build regenerate it automatically; commit the result)

import type { ModelVendorId } from '../../vendors/vendors.registry';

export type LlmsDefsVersions = Readonly<Record<ModelVendorId | '_shared' | '_openaiCompat', string>>;

export const LLMS_DEFS_VERSIONS = {
  _openaiCompat: 'a975002ac6ab',
  _shared: '6efc04feeb13',
  alibaba: '685ea44ddb9b',
  anthropic: 'c8ed66a8d7e9',
  azure: 'd7d85b37d01a',
  bedrock: 'd712c0bd1ed3',
  cerebras: 'd0b5faf92e26',
  cohere: '905e9a6e5c0d',
  deepseek: '57b021015252',
  googleai: 'ebed169c6a8a',
  groq: '02d59e30d93c',
  lmstudio: '7112eeb1cc31',
  localai: 'a0c2d15cccd3',
  mistral: '9d7a5684d097',
  modular: 'ca7ac67aa4c5',
  moonshot: '751ed6a1d5a6',
  nvidianim: '7ef04f57f597',
  ollama: '4e8147301d04',
  openai: '769edaf6247d',
  openrouter: 'a3cb5a598dd5',
  perplexity: '98521c9c7909',
  sakanaai: '13aaef3aef86',
  togetherai: 'bfdcf825caf0',
  xai: '9315d05c670d',
  zai: 'b5edb20b7a22',
} as const satisfies LlmsDefsVersions;
