// Field Guides: how to actually use each tool, written for the people using EMWS.
//
// A guide belongs to a tool and must be kept in step with it: when a tool's behaviour
// changes, its guide changes in the same commit (see CLAUDE.md).

import type { ComponentType } from 'react';
import { AntennaModelerGuide } from './AntennaModelerGuide';
import { SmithChartGuide } from './SmithChartGuide';

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
];

export function guideById(id: string): Guide | undefined {
  return GUIDES.find((g) => g.id === id);
}

export function guideForTool(toolHref: string): Guide | undefined {
  return GUIDES.find((g) => g.toolHref === toolHref);
}
