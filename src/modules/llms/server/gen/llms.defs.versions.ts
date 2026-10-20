// GENERATED FILE - DO NOT EDIT
// Per-vendor model-defs versions, derived from the runtime semantics of the files claimed by
// ../llms.defs.manifest.ts - regenerate with: node tools/develop/gen-llms-defs/generate-llms-defs.mjs
// (next dev / next build regenerate it automatically; commit the result)

import type { ModelVendorId } from '../../vendors/vendors.registry';

export type LlmsDefsVersions = Readonly<Record<ModelVendorId | '_shared' | '_openaiCompat', string>>;

export const LLMS_DEFS_VERSIONS = {
  _openaiCompat: '7ef94d5796d4',
  _shared: '2b9c222666cd',
  alibaba: '4ffb94d26f52',
  anthropic: '86d74bbd19a8',
  azure: '828ac66c2d6b',
  bedrock: '2953d547c549',
  cerebras: '4c3e22bcd6d5',
  cohere: 'd214307836e2',
  deepseek: 'e263feb83808',
  googleai: 'd2daa2770ec4',
  groq: 'cf9d075baeb8',
  lmstudio: '0b62c1c2353e',
  localai: '08164fc1bfd5',
  metaai: '27c461a470ac',
  mistral: 'aad2788ef087',
  modular: 'a3302dc51bbe',
  moonshot: '3d5627ff6d80',
  nvidianim: 'df0e08f48004',
  ollama: '8fe5980ff82d',
  openai: 'ad89a303f20d',
  openrouter: '9e1913d3b3ff',
  perplexity: '4b7f1726dc46',
  sakanaai: 'bc72372a46ec',
  togetherai: '9501855ef85d',
  xai: '00be13505056',
  zai: '5bfaac71d44b',
} as const satisfies LlmsDefsVersions;
