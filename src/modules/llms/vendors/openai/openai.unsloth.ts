import type { AixAPI_Model } from '~/modules/aix/server/api/aix.wiretypes';
import type { DModelParameterValues } from '~/common/stores/llms/llms.parameters';


// [praxeo fork] Unsloth (local server) per-model options -> AIX model fields.
// Spread by aixCreateModelFromLLMOptions with one line, so upstream changes there rarely conflict.

/**
 * Kept OUT of the unified reasoningEffort field: the thinking control is a boolean template gate, not an effort level.
 * @param llmOptions the model options with the overrides already applied
 */
export function unslothToAixModel(llmOptions: Pick<DModelParameterValues, 'llmVndUnslothThinking' | 'llmVndUnslothWebSearch'>): Pick<AixAPI_Model, 'vndUnslothThinking' | 'vndUnslothWebSearch'> {
  const { llmVndUnslothThinking, llmVndUnslothWebSearch } = llmOptions;
  return {
    ...(llmVndUnslothThinking ? { vndUnslothThinking: llmVndUnslothThinking } : {}),
    ...(llmVndUnslothWebSearch === 'auto' ? { vndUnslothWebSearch: llmVndUnslothWebSearch } : {}),
  };
}
