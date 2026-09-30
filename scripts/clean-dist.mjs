// Empties dist/ before a build, tolerating what it cannot delete.
//
// Vite's own emptyOutDir stops the whole build the moment one entry will not go, and
// that happened: a sandboxed code-review session left browser profiles in
// dist/.review-temp owned by ITS sandbox user, deletable only from an elevated shell.
// So the build empties dist itself: everything deletable goes, anything locked is named
// loudly and skipped, and the deploy scripts exclude those names from mirroring so the
// junk never reaches a server.
//
// Public domain (The Unlicense). By ZR1JT.

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const dist = new URL('../dist', import.meta.url);
if (existsSync(dist)) {
  const survivors = [];
  for (const entry of readdirSync(dist)) {
    try {
      rmSync(join(dist.pathname.replace(/^\/(?=[A-Za-z]:)/, ''), entry), { recursive: true, force: true });
    } catch {
      survivors.push(entry);
    }
  }
  if (survivors.length > 0) {
    console.warn(
      `clean-dist: could not remove ${survivors.join(', ')} from dist\\. ` +
        'Locked files (a sandboxed session may own them) need deleting from an elevated shell; ' +
        'the build carries on without them and the deploy scripts exclude them.',
    );
  }
}
