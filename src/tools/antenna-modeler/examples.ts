// The example models live in /examples as ordinary .nec files (CC0), so they can be
// opened in any NEC2 program. They are inlined into the app at build time.

import dipoleFreeSpace from '../../../examples/dipole-20m-free-space.nec?raw';
import dipoleOverGround from '../../../examples/dipole-20m-over-ground.nec?raw';
import dipoleSweep from '../../../examples/dipole-20m-swr-sweep.nec?raw';
import ocfDipole from '../../../examples/ocf-dipole-windom.nec?raw';
import vertical from '../../../examples/vertical-40m-perfect-ground.nec?raw';
import yagi from '../../../examples/yagi-3el-2m.nec?raw';

export interface Example {
  id: string;
  label: string;
  deck: string;
}

export const EXAMPLES: Example[] = [
  { id: 'yagi-3el-2m', label: '3-element Yagi, 2 m', deck: yagi },
  { id: 'dipole-20m-free-space', label: 'Dipole, 20 m, free space', deck: dipoleFreeSpace },
  { id: 'dipole-20m-over-ground', label: 'Dipole, 20 m, 10 m over real ground', deck: dipoleOverGround },
  { id: 'dipole-20m-swr-sweep', label: 'Dipole, 20 m, SWR sweep', deck: dipoleSweep },
  { id: 'ocf-dipole-windom', label: 'Off-centre-fed dipole (Windom), 4:1 balun', deck: ocfDipole },
  { id: 'vertical-40m-perfect-ground', label: 'Quarter-wave vertical, 40 m', deck: vertical },
];
