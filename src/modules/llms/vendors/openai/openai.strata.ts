import type { AixAPI_Model } from '~/modules/aix/server/api/aix.wiretypes';
import type { DModelParameterValues } from '~/common/stores/llms/llms.parameters';


// [praxeo fork] Strata (local server) per-model options -> AIX model fields.
// Spread by aixCreateModelFromLLMOptions with one line, so upstream changes there rarely conflict.

/**
 * Reasoning rides the unified reasoningEffort field (llmVndOaiEffort), so only the MCP switch lives here.
 * @param llmOptions the model options with the overrides already applied
 */
export function strataToAixModel(llmOptions: Pick<DModelParameterValues, 'llmVndStrataMcp'>): Pick<AixAPI_Model, 'vndStrataMcp'> {
  return llmOptions.llmVndStrataMcp === 'auto' ? { vndStrataMcp: 'auto' } : {};
}
