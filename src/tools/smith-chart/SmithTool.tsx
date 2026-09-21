import { useMemo, useState } from 'react';
import { SweepChart } from '../../ui/SweepChart';
import { ChainPanel, stepColour } from './ChainPanel';
import { type Element, type Network, defaultNetwork } from './model';
import { chainImpedances, elementPath, mismatchLossDb, sweepNetwork, swrBandwidth, type SweepPoint } from './network';
import { SmithChart, type ChartNode, type ChartSegment } from './SmithChart';
import { elementTitle, elementValue, formatImpedance, formatMHz, formatOhms } from './units';

const STORAGE_KEY = 'emws.smith-chart.v1';

function readNetwork(): Network {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Network;
      if (Array.isArray(saved?.elements) && saved.load && typeof saved.z0 === 'number') return saved;
    }
  } catch {
    // storage can be blocked, or hold something from an older version
  }
  return defaultNetwork();
}

function save(network: Network): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(network));
  } catch {
    // see readNetwork()
  }
}

export function SmithTool() {
  const [network, setNetworkState] = useState<Network>(readNetwork);
  const [hovered, setHovered] = useState<SweepPoint | undefined>(undefined);

  const setNetwork = (next: Network) => {
    setNetworkState(next);
    save(next);
  };

  const sweep = useMemo(() => sweepNetwork(network), [network]);
  const nodesAtDesign = useMemo(() => chainImpedances(network, network.designMHz), [network]);
  const atRadio = nodesAtDesign[nodesAtDesign.length - 1]!;
  const band = useMemo(() => swrBandwidth(sweep, 2, network.designMHz), [sweep, network.designMHz]);

  const selected = hovered ?? sweep.reduce<SweepPoint | undefined>(
    (best, p) => (!best || Math.abs(p.fMHz - network.designMHz) < Math.abs(best.fMHz - network.designMHz) ? p : best),
    undefined,
  );

  const segments: ChartSegment[] = useMemo(
    () =>
      network.elements.map((element: Element, i) => ({
        label: elementTitle(element),
        colour: stepColour(i),
        points: elementPath(nodesAtDesign[i]!, element, network.designMHz),
      })),
    [network.elements, network.designMHz, nodesAtDesign],
  );

  const chartNodes: ChartNode[] = useMemo(() => {
    const list: ChartNode[] = [{ label: 'L', z: nodesAtDesign[0]!, colour: 'var(--muted)' }];
    network.elements.forEach((_, i) => {
      list.push({ label: String(i + 1), z: nodesAtDesign[i + 1]!, colour: stepColour(i) });
    });
    return list;
  }, [nodesAtDesign, network.elements]);

  const swrPoints = sweep.map((p) => ({ frequencyMHz: p.fMHz, swr: p.swr }));
  const selectedIndex = selected ? sweep.findIndex((p) => p.fMHz === selected.fMHz) : 0;

  return (
    <div className="smith">
      <h1 className="visually-hidden">Smith chart and matching</h1>
      <aside className="panel side-panel" aria-label="Matching network">
        <div className="tabs">
          <span className="tab-title">Smith chart and matching</span>
          <a className="tab-link" href="#/guides/smith-chart" title="How to use the Smith chart">
            Field guide
          </a>
        </div>
        <div className="tab-body">
          <ChainPanel network={network} onChange={setNetwork} />
        </div>
      </aside>

      <div className="workspace">
        <div className="smith-layout">
          <figure className="plot smith-figure">
            <figcaption>
              Normalised to {network.z0} Ω · path drawn at {formatMHz(network.designMHz)}
            </figcaption>
            <SmithChart
              z0={network.z0}
              segments={segments}
              nodes={chartNodes}
              sweep={sweep}
              designMHz={network.designMHz}
              hovered={hovered}
              onHover={setHovered}
            />
            <figcaption className="plot-note">
              {selected
                ? `${hovered ? 'Pointer' : 'Design'}: ${formatMHz(selected.fMHz)} · ${formatImpedance(selected.z)} · SWR ${
                    Number.isFinite(selected.swr) ? selected.swr.toFixed(2) : '∞'
                  }:1`
                : 'Hover the sweep to read it off.'}
            </figcaption>
          </figure>

          <div className="smith-readouts">
            <dl className="summary">
              <div>
                <dt>At the radio</dt>
                <dd>{formatImpedance(atRadio)}</dd>
                <small>at {formatMHz(network.designMHz)}</small>
              </div>
              <div>
                <dt>SWR</dt>
                <dd>
                  {selected && Number.isFinite(selected.swr) ? `${selected.swr.toFixed(2)} : 1` : '∞'}
                </dd>
                <small>
                  {selected && Number.isFinite(selected.swr)
                    ? `${mismatchLossDb(selected.z, network.z0).toFixed(2)} dB of power turned back`
                    : 'nothing gets in'}
                </small>
              </div>
              <div>
                <dt>Under 2:1</dt>
                <dd>{band ? `${(band.widthMHz * 1000).toFixed(0)} kHz` : '—'}</dd>
                <small>
                  {band ? `${formatMHz(band.lowMHz)} to ${formatMHz(band.highMHz)}` : 'not within the sweep'}
                </small>
              </div>
              <div>
                <dt>At the load</dt>
                <dd>{formatImpedance(nodesAtDesign[0]!)}</dd>
                <small>what the antenna shows</small>
              </div>
            </dl>

            {network.elements.length > 0 && (
              <div className="table-wrap">
                <table className="feed-table chain-table">
                  <caption>Step by step at {formatMHz(network.designMHz)}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Step</th>
                      <th scope="col">Component</th>
                      <th scope="col">Value</th>
                      <th scope="col">Looking in</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>
                        <span className="step-swatch" style={{ background: 'var(--muted)' }} aria-hidden="true">
                          L
                        </span>
                      </td>
                      <td>The load</td>
                      <td>—</td>
                      <td>{formatImpedance(nodesAtDesign[0]!)}</td>
                    </tr>
                    {network.elements.map((element, i) => (
                      <tr key={element.id} className={element.bypassed ? 'bypassed' : undefined}>
                        <td>
                          <span className="step-swatch" style={{ background: stepColour(i) }} aria-hidden="true">
                            {i + 1}
                          </span>
                        </td>
                        <td>
                          {elementTitle(element)}
                          {element.bypassed && ' (out of circuit)'}
                        </td>
                        <td>{elementValue(element)}</td>
                        <td>{formatImpedance(nodesAtDesign[i + 1]!)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {sweep.length > 1 && (
          <SweepChart
            points={swrPoints}
            selected={Math.max(0, selectedIndex)}
            onSelect={(i) => {
              const point = sweep[i];
              if (point) setNetwork({ ...network, designMHz: point.fMHz });
            }}
            z0={network.z0}
          />
        )}

        <p className="muted">
          Resistance {formatOhms(atRadio.re)} Ω, reactance {formatOhms(atRadio.im)} Ω. Click the SWR curve to move the
          design frequency.
        </p>
      </div>
    </div>
  );
}
