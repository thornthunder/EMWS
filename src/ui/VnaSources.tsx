// Where a measurement can come from: a NanoVNA on a USB port, or whatever the EMWS VNA
// bridge offers from the LAN - a FieldFox, say. MeasureWithVna and MeasureTransmission
// both start here, and hand on whichever Instrument the person picked.
//
// The bridge is looked for once, when this appears; it is usually not there, and then
// nothing about it shows but a quiet line saying where it was looked for.
//
// Public domain (The Unlicense). By ZR1JT.

import { useEffect, useState } from 'react';
import { type BridgeInfo, BridgeInstrument, DEFAULT_BRIDGE_URL, type Instrument, VnaError, bridgeUrl, connect, probeBridge, serialUnavailableReason, setBridgeUrl } from '../lib/vna';

export interface VnaSourcesProps {
  /** What the measurement is for: "Measure the load" - used in the serial button's hint. */
  onConnected: (instrument: Instrument) => void;
  busy: string | undefined;
  setBusy: (what: string | undefined) => void;
  onError: (e: unknown) => void;
}

/**
 * One look per page load, shared by every measuring panel: the bridge is usually not
 * there, and each look at an empty address is a refused connection in the console.
 */
let remembered: { url: string; at: number; info: BridgeInfo | undefined } | undefined;
const REMEMBER_MS = 30_000;

async function lookForBridge(url: string, fresh = false): Promise<BridgeInfo | undefined> {
  if (!fresh && remembered && remembered.url === url && Date.now() - remembered.at < REMEMBER_MS) return remembered.info;
  const info = await probeBridge(url);
  remembered = { url, at: Date.now(), info };
  return info;
}

export function VnaSources({ onConnected, busy, setBusy, onError }: VnaSourcesProps) {
  const unavailable = serialUnavailableReason();
  const [bridge, setBridge] = useState<BridgeInfo | undefined | 'looking'>('looking');
  const [address, setAddress] = useState(bridgeUrl);
  const [editing, setEditing] = useState(false);

  const look = async (url: string, fresh = false) => {
    setBridge('looking');
    setBridge(await lookForBridge(url, fresh));
  };
  useEffect(() => {
    void look(bridgeUrl());
  }, []);

  const openSerial = async () => {
    onError(undefined);
    setBusy('Asking for the port…');
    try {
      onConnected(await connect());
    } catch (e) {
      onError(e);
    } finally {
      setBusy(undefined);
    }
  };

  const openBridge = async (url: string, id: string) => {
    onError(undefined);
    const info = (bridge !== 'looking' && bridge?.instruments.find((i) => i.id === id)) || undefined;
    if (!info) return;
    if (info.status !== 'ok') {
      onError(new VnaError(`${info.name} at ${info.address} did not answer the bridge${info.error ? `: ${info.error}` : ''}.`));
      return;
    }
    onConnected(new BridgeInstrument(url, info));
  };

  const saveAddress = () => {
    setBridgeUrl(address);
    setEditing(false);
    void look(bridgeUrl(), true);
  };

  const instruments = bridge !== 'looking' && bridge ? bridge.instruments : [];
  return (
    <div className="vna-sources">
      <div className="button-row">
        {!unavailable && (
          <button type="button" className="small" onClick={openSerial} disabled={busy !== undefined} title="A NanoVNA on a USB port: the browser asks which port.">
            {busy ?? 'Connect a NanoVNA…'}
          </button>
        )}
        {instruments.map((i) => (
          <button
            key={i.id}
            type="button"
            className="small"
            onClick={() => bridge !== 'looking' && bridge && openBridge(bridge.url, i.id)}
            disabled={busy !== undefined}
            title={i.status === 'ok' ? `${i.idn ?? i.name} at ${i.address}, through the EMWS VNA bridge.` : `Not answering at ${i.address}${i.error ? `: ${i.error}` : ''}.`}
            aria-disabled={i.status !== 'ok'}
          >
            {i.status === 'ok' ? `Connect to ${i.name} (bridge)…` : `${i.name}: not answering`}
          </button>
        ))}
        {!unavailable && instruments.length === 0 && <span className="muted">Plug it in by USB, then choose its port when the browser asks.</span>}
      </div>
      {unavailable && instruments.length === 0 && (
        <p className="muted vna-unavailable">
          <strong>Measure with a NanoVNA:</strong> {unavailable}
        </p>
      )}
      <p className="muted vna-bridge-line">
        {bridge === 'looking'
          ? 'Looking for the EMWS VNA bridge…'
          : bridge
            ? `EMWS VNA bridge found at ${bridge.url}${instruments.length === 0 ? ', with no instrument configured' : ''}.`
            : `No EMWS VNA bridge at ${address} (a bench or handheld VNA on the LAN needs one; see the guide).`}{' '}
        {editing ? (
          <span className="vna-bridge-edit">
            <input type="text" value={address} onChange={(e) => setAddress(e.target.value)} placeholder={DEFAULT_BRIDGE_URL} aria-label="VNA bridge address" spellCheck={false} />
            <button type="button" className="small" onClick={saveAddress}>
              Use it
            </button>
          </span>
        ) : (
          <button type="button" className="link" onClick={() => setEditing(true)}>
            {bridge && bridge !== 'looking' ? 'Change the address' : 'Look elsewhere'}
          </button>
        )}
      </p>
    </div>
  );
}
