// GENERATED FILE - DO NOT EDIT
// Per-vendor model-defs versions, derived from the runtime semantics of the files claimed by
// ../llms.defs.manifest.ts - regenerate with: node tools/develop/gen-llms-defs/generate-llms-defs.mjs
// (next dev / next build regenerate it automatically; commit the result)

import type { ModelVendorId } from '../../vendors/vendors.registry';

export type LlmsDefsVersions = Readonly<Record<ModelVendorId | '_shared' | '_openaiCompat', string>>;

export const LLMS_DEFS_VERSIONS = {
  _openaiCompat: 'cb59cbee1137',
  _shared: '93065b457633',
  alibaba: '5ef172c02762',
  anthropic: '1ec1b323a530',
  azure: '6e439752ac2c',
  bedrock: '60178a34b558',
  cerebras: '3805daeb5cc3',
  cohere: '72f36f5486dd',
  deepseek: '633cb1f6608b',
  googleai: '84c552f68ab2',
  groq: '4742fdb04e59',
  lmstudio: '73f22dd0693d',
  localai: 'dd548267809c',
  metaai: 'f31e79cd0e0a',
  mistral: '7fdf5f9e0cd6',
  modular: 'ee573d53042c',
  moonshot: 'bada2f57b619',
  nvidianim: 'd4b4a1f609e4',
  ollama: 'a055d3fa46a3',
  openai: '1a70c0ec247d',
  openrouter: 'f64ae39e4139',
  perplexity: '9b3b224ee1c1',
  sakanaai: '72556379b67c',
  togetherai: '3c1fe9dd7cdd',
  xai: '591ceab13091',
  zai: 'bb166e2a8742',
} as const satisfies LlmsDefsVersions;
