// GENERATED FILE - DO NOT EDIT
// Per-vendor model-defs versions, derived from the runtime semantics of the files claimed by
// ../llms.defs.manifest.ts - regenerate with: node tools/develop/gen-llms-defs/generate-llms-defs.mjs
// (next dev / next build regenerate it automatically; commit the result)

import type { ModelVendorId } from '../../vendors/vendors.registry';

export type LlmsDefsVersions = Readonly<Record<ModelVendorId | '_shared' | '_openaiCompat', string>>;

export const LLMS_DEFS_VERSIONS = {
  _openaiCompat: '0088ad97cad1',
  _shared: '93065b457633',
  alibaba: '5ef172c02762',
  anthropic: 'fb0cff9cb52a',
  azure: '136126f84d3f',
  bedrock: 'c52c87576f70',
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
  openai: 'ff667cd56bf6',
  openrouter: '10d861574b77',
  perplexity: '9b3b224ee1c1',
  sakanaai: '72556379b67c',
  togetherai: '3c1fe9dd7cdd',
  xai: '87737125e0cf',
  zai: '0c8a96b565a6',
} as const satisfies LlmsDefsVersions;
