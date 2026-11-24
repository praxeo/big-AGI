import * as React from 'react';

import type { DModelParameterId, DModelParameterSpec, DModelParameterValues } from '~/common/stores/llms/llms.parameters';
import { FormSelectControl } from '~/common/components/forms/FormSelectControl';


// [praxeo fork] Strata local-server controls (MCP Tools), mounted by LLMParametersEditor with one line,
// so upstream changes to the editor rarely conflict. Reasoning uses the shared Reasoning Effort control.

// 'Default'/'Off' sentinel - the same one the editors use
const _UNSPECIFIED = '_UNSPECIFIED' as const;

const _strataMcpOptions = [
  { value: 'auto', label: 'On', description: 'Model may call the MCP tools configured in Strata' } as const,
  { value: _UNSPECIFIED, label: 'Off', description: 'No server-side tools (default)' } as const,
] as const;


export function StrataParametersConfig(props: {
  modelParamSpec: Partial<{ [K in DModelParameterId]: DModelParameterSpec<K> }>;
  parameters: DModelParameterValues;
  onChangeParameter: (parameterValue: DModelParameterValues) => void;
  onRemoveParameter: (parameterId: DModelParameterId) => void;
}) {

  const { modelParamSpec, onChangeParameter, onRemoveParameter } = props;
  const { llmVndStrataMcp } = props.parameters;

  const showMcp = 'llmVndStrataMcp' in modelParamSpec && !modelParamSpec['llmVndStrataMcp']?.hidden;
  if (!showMcp) return null;

  return (
    <FormSelectControl
      title='MCP Tools'
      tooltip={'Let the model call the tools of the MCP servers configured in Strata ("mcp_servers" in strata-<model>.json). They run on the Strata machine with its user\'s rights.'}
      value={llmVndStrataMcp ?? _UNSPECIFIED}
      onChange={(value) => {
        if (value === _UNSPECIFIED || !value) onRemoveParameter('llmVndStrataMcp');
        else onChangeParameter({ llmVndStrataMcp: value });
      }}
      options={_strataMcpOptions}
    />
  );
}
