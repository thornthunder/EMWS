import { GUIDES } from '../guides/registry';

interface Tool {
  name: string;
  blurb: string;
  href?: string;
}

const TOOLS: Tool[] = [
  {
    name: 'Antenna Modeler',
    blurb:
      'Wire antennas by the method of moments, on the NEC2 engine: feed impedance, SWR, gain, radiation patterns, currents and frequency sweeps.',
    href: '#/antenna',
  },
  {
    name: 'Smith chart and matching',
    blurb:
      'Plot an impedance, add L, C, coax and stubs, and watch the match move. It will also work out the matching network for you.',
    href: '#/smith',
  },
  {
    name: 'RF toolbox',
    blurb: 'Wire lengths, coax loss, LC resonance, coil inductance, L and Pi networks, SWR and return loss.',
  },
  {
    name: 'Field sandbox',
    blurb: 'A 2-D FDTD solver: draw conductors, dielectrics and sources, and watch the waves propagate.',
  },
];

export function Home() {
  return (
    <div className="prose">
      <h1>A public-domain electromagnetics workbench</h1>
      <p className="lede">
        Simulate your antenna and RF experiments before you cut wire. EMWS is free for anyone to use, copy,
        re-host and change, in the amateur radio spirit. Every calculation runs in your own browser: no
        account, no upload, and it keeps working offline.
      </p>
      <div className="cards">
        {TOOLS.map((tool) =>
          tool.href ? (
            <a key={tool.name} className="card card-live" href={tool.href}>
              <h2>{tool.name}</h2>
              <p>{tool.blurb}</p>
              <span className="card-cta">Open →</span>
            </a>
          ) : (
            <div key={tool.name} className="card">
              <h2>{tool.name}</h2>
              <p>{tool.blurb}</p>
              <span className="badge">Planned</span>
            </div>
          ),
        )}
      </div>

      <section className="home-guides">
        <h2>Field Guides</h2>
        <p>
          How to get real work out of each tool, written for radio amateurs. Start here if a tool looks like it
          wants a manual.
        </p>
        <ul>
          {GUIDES.map((guide) => (
            <li key={guide.id}>
              <a href={`#/guides/${guide.id}`}>{guide.title}</a> — {guide.summary}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
