import * as React from 'react';

import { DModelParameterId, DModelParameterRegistry, DModelParameterSpec, DModelParameterValues } from '~/common/stores/llms/llms.parameters';
import { FormSelectControl } from '~/common/components/forms/FormSelectControl';


// [praxeo fork] Unsloth local-server controls (Thinking, Web Search), mounted by LLMParametersEditor with one line,
// so upstream changes to the editor rarely conflict.

// 'Default'/'Off' sentinel - the same one the editors use
const _UNSPECIFIED = '_UNSPECIFIED' as const;

const _unslothWebSearchOptions = [
  { value: 'auto', label: 'On', description: 'Model may search the web to ground answers' } as const,
  { value: _UNSPECIFIED, label: 'Off', description: 'No server-side tools (default)' } as const,
] as const;

const _unslothThinkingOptions = [
  { value: 'max', label: 'Max', description: 'Hardest thinking' } as const,
  { value: 'high', label: 'High', description: 'Deep reasoning' } as const,
  { value: 'medium', label: 'Medium', description: 'Balanced' } as const,
  { value: 'low', label: 'Low', description: 'Light thinking' } as const,
  { value: 'none', label: 'Off', description: 'Answer directly' } as const,
  { value: _UNSPECIFIED, label: 'Default', description: 'Model default' } as const,
] as const;


/** Narrows the Thinking table to the model's allowed values; on a pure toggle (no low/max) 'high' reads 'On'. */
function _filterThinkingOptions(spec: DModelParameterSpec<'llmVndUnslothThinking'> | undefined) {
  if (!spec) return null;
  const allowedSet = new Set<string>(spec.enumValues ?? DModelParameterRegistry.llmVndUnslothThinking.values);
  const filtered = _unslothThinkingOptions.filter(o => o.value === _UNSPECIFIED || allowedSet.has(o.value));
  if (!allowedSet.has('low') && !allowedSet.has('max'))
    return filtered.map(o => o.value === 'high' ? { ...o, label: 'On' } : o);
  return filtered;
}


export function UnslothParametersConfig(props: {
  modelParamSpec: Partial<{ [K in DModelParameterId]: DModelParameterSpec<K> }>;
  parameters: DModelParameterValues;
  onChangeParameter: (parameterValue: DModelParameterValues) => void;
  onRemoveParameter: (parameterId: DModelParameterId) => void;
}) {

  const { modelParamSpec, onChangeParameter, onRemoveParameter } = props;
  const { llmVndUnslothThinking, llmVndUnslothWebSearch } = props.parameters;

  const thinkingSpec = modelParamSpec['llmVndUnslothThinking'];
  const thinkingOptions = React.useMemo(() => _filterThinkingOptions(thinkingSpec), [thinkingSpec]);

  const showThinking = !!thinkingSpec && !thinkingSpec.hidden && !!thinkingOptions;
  const showWebSearch = 'llmVndUnslothWebSearch' in modelParamSpec && !modelParamSpec['llmVndUnslothWebSearch']?.hidden;

  return <>

    {/* Unsloth Thinking (boolean template gate) */}
    {showThinking && (
      <FormSelectControl
        title='Thinking'
        tooltip='Enable or disable thinking mode on the local model'
        value={llmVndUnslothThinking ?? _UNSPECIFIED}
        onChange={(value) => {
          if (value === _UNSPECIFIED || !value) onRemoveParameter('llmVndUnslothThinking');
          else onChangeParameter({ llmVndUnslothThinking: value });
        }}
        options={thinkingOptions}
      />
    )}

    {/* Unsloth server-side Web Search */}
    {showWebSearch && (
      <FormSelectControl
        title='Web Search'
        tooltip='Let the local model search the web to ground its answers (runs on the Unsloth server, which must allow tools)'
        value={llmVndUnslothWebSearch ?? _UNSPECIFIED}
        onChange={(value) => {
          if (value === _UNSPECIFIED || !value) onRemoveParameter('llmVndUnslothWebSearch');
          else onChangeParameter({ llmVndUnslothWebSearch: value });
        }}
        options={_unslothWebSearchOptions}
      />
    )}

  </>;
}
