import * as React from 'react';

import { Box } from '@mui/joy';


// [praxeo fork] Code blocks render as plain text while they stream: no Prism highlighting, no language
// inference, no HTML/SVG/PlantUML rendering until the block is complete (avoids crashes on heavy streams).
// Hooked into RenderCode.tsx with single lines, so upstream changes to that file rarely conflict.

const _plainPreSx = {
  m: 0,
  overflowX: 'auto',
  whiteSpace: 'pre',
  fontFamily: 'monospace',
} as const;


/** Swapped in for Prism's highlighter while streaming: the syntax highlighter renders nothing. */
export function streamingNoHighlight(): string {
  return '';
}

/** Swapped in for Prism's language inference while streaming. */
export function streamingNoLanguage(): string | null {
  return null;
}


export function RenderCodeStreamingPlain(props: { code: string }) {
  return (
    <Box component='pre' sx={_plainPreSx}>
      <Box component='code'>
        {props.code}
      </Box>
    </Box>
  );
}
