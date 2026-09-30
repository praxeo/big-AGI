// GENERATED FILE - DO NOT EDIT
// Per-vendor model-defs versions, derived from the runtime semantics of the files claimed by
// ../llms.defs.manifest.ts - regenerate with: node tools/develop/gen-llms-defs/generate-llms-defs.mjs
// (next dev / next build regenerate it automatically; commit the result)

import type { ModelVendorId } from '../../vendors/vendors.registry';

export type LlmsDefsVersions = Readonly<Record<ModelVendorId | '_shared' | '_openaiCompat', string>>;

export const LLMS_DEFS_VERSIONS = {
  _openaiCompat: '7bc9b02a595c',
  _shared: '93065b457633',
  alibaba: '5ef172c02762',
  anthropic: 'ff76b96d54f3',
  azure: '8c4e685df4ea',
  bedrock: 'a89cf30f10ae',
  cerebras: '3805daeb5cc3',
  cohere: '72f36f5486dd',
  deepseek: '633cb1f6608b',
  googleai: '35fadfd5819c',
  groq: '4742fdb04e59',
  lmstudio: '73f22dd0693d',
  localai: 'dd548267809c',
  metaai: 'f31e79cd0e0a',
  mistral: '7fdf5f9e0cd6',
  modular: 'ee573d53042c',
  moonshot: 'bada2f57b619',
  nvidianim: 'd4b4a1f609e4',
  ollama: 'a055d3fa46a3',
  openai: 'cf3d7350942c',
  openrouter: '07e9b880805c',
  perplexity: '9b3b224ee1c1',
  sakanaai: '72556379b67c',
  togetherai: '3c1fe9dd7cdd',
  xai: '87737125e0cf',
  zai: '0c8a96b565a6',
} as const satisfies LlmsDefsVersions;
