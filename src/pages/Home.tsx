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
    name: 'Baluns and ununs',
    blurb:
      'Pick a ferrite core, wind it turn by turn, and see the match, the loss and the heat before you cut wire: 49:1 ununs, current baluns and 1:4 Guanellas.',
    href: '#/balun',
  },
  {
    name: 'Coils, traps and filters',
    blurb:
      'Wind an air-cored coil and know its inductance and Q; design a trap for a multiband wire; design a low-pass or high-pass filter and see its response with the parts you will really use.',
    href: '#/lc',
  },
  {
    name: 'RF toolbox',
    blurb:
      'Wavelengths and wire lengths, coax loss with the SWR on it, Pi, T and L attenuators as you can build them, dBm to volts and S-units, SWR and return loss, link budgets, intermods, Fresnel zones and knife edges.',
    href: '#/toolbox',
  },
  {
    name: 'Field sandbox',
    blurb:
      'A two-dimensional FDTD world: draw conductors, dielectrics and sources, press play, and watch the waves go - two slits, a parabola, a corner reflector, a slab, a pair of plates.',
    href: '#/fdtd',
  },
];

export function Home() {
  return (
    <div className="prose">
      <h1>A public-domain electromagnetics workbench</h1>
      <p className="lede">
        Simulate your antenna and RF experiments before you cut wire. EMWS is free for anyone to use, copy,
        re-host and change, in the amateur radio spirit. Every calculation runs in your own browser, no
        account needed, and it keeps working offline; nothing leaves your machine unless a site offers
        community sharing and you choose to use it.
      </p>
      <p className="muted">
        On an https site you can <strong>install EMWS as an app</strong> — look for "Install" in the browser's
        menu or address bar — and it opens in its own window and works with no connection at all, on the bench
        or on a hilltop. Ctrl+P on any tool prints the results cleanly, charts and patterns included, for a
        club newsletter or the shack wall.
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
