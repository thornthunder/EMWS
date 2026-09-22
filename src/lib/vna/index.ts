// Plugging a VNA into EMWS.
//
// The browser asks which port; EMWS asks the port what it is. One carriage return tells
// them apart: a classic NanoVNA answers a CR with its "ch> " prompt, and to a V2 the same
// byte, 0x0d, is the INDICATE command, which it answers with '2'. So the same probe does
// for both, and neither USB vendor id nor luck is needed.
//
// Public domain (The Unlicense). By ZR1JT.

import { type Link, VnaError, WebSerialLink, decoder, readUntil, text } from './link';
import type { Instrument } from './instrument';
import { NanoVna } from './nanovna';
import { NanoVnaV2 } from './nanovna-v2';

export type { Instrument, SweepRequest } from './instrument';
export { VnaError } from './link';

/** Why a VNA cannot be used here, in words for the person, or undefined if it can. */
export function serialUnavailableReason(): string | undefined {
  if (typeof navigator === 'undefined') return 'Not in a browser.';
  if (!window.isSecureContext) {
    return 'The browser only lets a page talk to a USB device on a secure page. Open EMWS over https://, or from localhost.';
  }
  if (!navigator.serial) {
    return 'This browser cannot talk to serial devices. Chrome, Edge or another Chromium browser on a desktop can; Firefox, Safari and phones cannot. The .s1p file route still works everywhere.';
  }
  return undefined;
}

/** Works out what is on a link, or throws with the reason. */
export async function identify(link: Link): Promise<Instrument> {
  await link.write(text('\r'));
  const reply = await readUntil(link, (b) => decoder.decode(b).includes('ch> ') || b.includes(0x32), { totalMs: 2000, idleMs: 400 });
  const asText = decoder.decode(reply);
  let instrument: Instrument;
  if (asText.includes('ch> ')) instrument = new NanoVna(link);
  else if (reply.includes(0x32)) instrument = new NanoVnaV2(link);
  else if (reply.length === 0) throw new VnaError('Nothing answered on that port. Is the NanoVNA switched on, and is it the right port?');
  else throw new VnaError('Something answered on that port, but not like a NanoVNA.');
  await instrument.describe();
  return instrument;
}

/**
 * Asks the person for a port (the browser shows the chooser), opens it, and finds out
 * what is there. Rejects if they cancel, if the port cannot be opened, or if whatever is
 * on it is not a NanoVNA - each with a reason meant to be read.
 */
export async function connect(): Promise<Instrument> {
  const reason = serialUnavailableReason();
  if (reason) throw new VnaError(reason);
  let port: SerialPort;
  try {
    port = await navigator.serial!.requestPort();
  } catch {
    throw new VnaError('No port was chosen.');
  }
  let link: Link;
  try {
    link = await WebSerialLink.open(port);
  } catch (e) {
    throw new VnaError(
      `The port could not be opened${e instanceof Error && e.message ? ` (${e.message})` : ''}. ` +
        'If another program - the NanoVNA app, say - has it open, close that first.',
    );
  }
  try {
    return await identify(link);
  } catch (e) {
    await link.close().catch(() => {});
    throw e;
  }
}

export { NanoVna, NanoVnaV2 };
