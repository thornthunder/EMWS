// Field Guides: how to actually use each tool, written for the people using EMWS.
//
// A guide belongs to a tool and must be kept in step with it: when a tool's behaviour
// changes, its guide changes in the same commit (see CLAUDE.md).

import type { ComponentType } from 'react';
import { AntennaModelerGuide } from './AntennaModelerGuide';
import { BalunGuide } from './BalunGuide';
import { CoilsGuide } from './CoilsGuide';
import { FieldSandboxGuide } from './FieldSandboxGuide';
import { SmithChartGuide } from './SmithChartGuide';
import { ToolboxGuide } from './ToolboxGuide';

export interface Guide {
  /** Used in the URL: #/guides/<id> */
  id: string;
  title: string;
  summary: string;
  /** The tool it explains. */
  toolHref: string;
  toolName: string;
  Content: ComponentType;
}

export const GUIDES: Guide[] = [
  {
    id: 'antenna-modeler',
    title: 'Modelling antennas',
    summary:
      'Draw a wire antenna, feed it, and read what NEC-2 makes of it: impedance, SWR, gain and radiation patterns. Includes a worked 20 m dipole.',
    toolHref: '#/antenna',
    toolName: 'Antenna Modeler',
    Content: AntennaModelerGuide,
  },
  {
    id: 'smith-chart',
    title: 'Matching with a Smith chart',
    summary:
      'Read a Smith chart, build a matching network component by component, and let the tool work out the L network for you. Includes matching a short vertical.',
    toolHref: '#/smith',
    toolName: 'Smith chart and matching',
    Content: SmithChartGuide,
  },
  {
    id: 'baluns',
    title: 'Winding baluns and ununs',
    summary:
      'Choose a ferrite core, wind it turn by turn, and see the match, the loss and the heat: 49:1 ununs, current baluns and 1:4 Guanellas. Includes measuring your own core with a NanoVNA.',
    toolHref: '#/balun',
    toolName: 'Baluns and ununs',
    Content: BalunGuide,
  },
  {
    id: 'coils-traps-filters',
    title: 'Coils, traps and filters',
    summary:
      'Wind a coil to a value, design a trap for a multiband wire, and design a low-pass or high-pass filter, with the honest Q of real parts. Includes a 40 m trap and a 30 MHz transmitter low-pass.',
    toolHref: '#/lc',
    toolName: 'Coils, traps and filters',
    Content: CoilsGuide,
  },
  {
    id: 'rf-toolbox',
    title: 'The RF toolbox',
    summary:
      'Wavelengths and wire lengths, coax loss with the SWR on it, Pi, T and L attenuators as you can build them, dBm to volts and S-units, and SWR in all its costumes - each with its working shown.',
    toolHref: '#/toolbox',
    toolName: 'RF toolbox',
    Content: ToolboxGuide,
  },
  {
    id: 'field-sandbox',
    title: 'Watching the fields',
    summary:
      'A two-dimensional world where you draw conductors, dielectrics and sources and watch Maxwell\'s equations play out: two slits, a parabola, a corner reflector, a slab, a pair of plates. What it shows, and what it honestly cannot.',
    toolHref: '#/fdtd',
    toolName: 'Field sandbox',
    Content: FieldSandboxGuide,
  },
];

export function guideById(id: string): Guide | undefined {
  return GUIDES.find((g) => g.id === id);
}

export function guideForTool(toolHref: string): Guide | undefined {
  return GUIDES.find((g) => g.toolHref === toolHref);
}
