import * as React from 'react';

import { SvgIcon, SvgIconProps } from '@mui/joy';

/*
 * Unsloth ships no vector logo (raster only), so this is an original minimal sloth-face glyph:
 * face disc with knocked-out eye stripes (pupils re-filled) and nose, single currentColor fill.
 */
export function UnslothIcon(props: SvgIconProps) {
  return <SvgIcon viewBox='0 0 24 24' width='24' height='24' fill='currentColor' stroke='none' {...props}>
    <path fillRule='evenodd' d='M2 12 a10 10 0 1 0 20 0 a10 10 0 1 0 -20 0 Z M7.77 8.04 L4.57 11.44 A1.55 1.55 0 0 0 6.83 13.56 L10.03 10.16 A1.55 1.55 0 0 0 7.77 8.04 Z M6.94 10.12 a1 1 0 1 0 2 0 a1 1 0 1 0 -2 0 Z M13.97 10.16 L17.17 13.56 A1.55 1.55 0 0 0 19.43 11.44 L16.23 8.04 A1.55 1.55 0 0 0 13.97 10.16 Z M15.06 10.12 a1 1 0 1 0 2 0 a1 1 0 1 0 -2 0 Z M10.4 15 a1.6 1.15 0 1 0 3.2 0 a1.6 1.15 0 1 0 -3.2 0 Z' />
  </SvgIcon>;
}
