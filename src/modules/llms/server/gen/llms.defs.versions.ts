// GENERATED FILE - DO NOT EDIT
// Per-vendor model-defs versions, derived from the runtime semantics of the files claimed by
// ../llms.defs.manifest.ts - regenerate with: node tools/develop/gen-llms-defs/generate-llms-defs.mjs
// (next dev / next build regenerate it automatically; commit the result)

import type { ModelVendorId } from '../../vendors/vendors.registry';

export type LlmsDefsVersions = Readonly<Record<ModelVendorId | '_shared' | '_openaiCompat', string>>;

export const LLMS_DEFS_VERSIONS = {
  _openaiCompat: '282dc34c957a',
  _shared: 'f18c95aad9de',
  alibaba: '95e125532e3c',
  anthropic: '2f6879a2fb4d',
  azure: 'dae263160abf',
  bedrock: 'abc0cdba700a',
  cerebras: '0dd6affd08d7',
  cohere: '64af81071684',
  deepseek: '25b92ed945df',
  googleai: '33ef2fcc36a1',
  groq: 'a07668e00b95',
  lmstudio: '032bc7abe126',
  localai: 'eaf39260cdcf',
  metaai: 'ef1d3458d469',
  mistral: 'cfdd2a6331a8',
  modular: '0d9ce0fd515a',
  moonshot: '553952422eec',
  nvidianim: 'b364f25f83cc',
  ollama: '8a5eddd3d0b4',
  openai: '1c2fce92281f',
  openrouter: '6fa181bde788',
  perplexity: '0d040bd3949a',
  sakanaai: '17e7245339d2',
  togetherai: '71171d904adf',
  xai: '05160f824c0a',
  zai: 'e31baeea072d',
} as const satisfies LlmsDefsVersions;
