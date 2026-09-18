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
    blurb: 'Plot an impedance, add series and shunt L, C and line sections, and watch the match move.',
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
    </div>
  );
}
