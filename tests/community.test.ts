// The community store, end to end: the real PHP over real HTTP, against SQLite here,
// exactly as the site runs it against MySQL - same PDO code, same SQL. Two visitors are
// two cookie jars. Skipped, loudly, where no usable PHP is on the machine.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommunityError,
  browseShared,
  me,
  requestReset,
  resetPassword,
  setEmail,
  deleteItem,
  fetchShared,
  login,
  logout,
  myItems,
  probeCommunity,
  register,
  saveItem,
  shareItem,
  whoAmI,
} from '../src/lib/community';
import { CORES } from '../src/tools/balun/catalog';
import { exportProfiles, importProfiles, makeProfile } from '../src/tools/balun/profiles';

/** A PHP that can serve the API against SQLite, with the flags that make it able to. */
function findPhp(): { exe: string; flags: string[] } | undefined {
  const candidates = [
    process.env.EMWS_TEST_PHP,
    'C:\\Program Files\\PHP\\v8.4\\php.exe',
    'C:\\Program Files\\PHP\\8.5.7\\php.exe',
    'php',
  ].filter((c): c is string => !!c);
  for (const exe of candidates) {
    for (const flags of [[], ['-d', `extension_dir=${join(exe, '..', 'ext')}`, '-d', 'extension=pdo_sqlite']]) {
      const probe = spawnSync(exe, [...flags, '-r', "exit(extension_loaded('pdo_sqlite') ? 0 : 1);"], { windowsHide: true });
      if (probe.status === 0) return { exe, flags };
    }
  }
  return undefined;
}

const php = findPhp();
if (!php) console.warn('community.test.ts: no PHP with pdo_sqlite found, so the community store is NOT being tested here.');

interface CaughtMail {
  auth: { user: string; pass: string } | undefined;
  from: string;
  to: string;
  body: string;
}

/**
 * Enough of an SMTP server to catch what the store sends: greeting, EHLO, AUTH LOGIN,
 * MAIL/RCPT/DATA/QUIT. No STARTTLS is offered, so the client speaks plain - the TLS
 * branch is exercised by any real mail server, not by this catcher.
 */
function fakeSmtp(): { server: Server; port: Promise<number>; caught: CaughtMail[] } {
  const caught: CaughtMail[] = [];
  const server = createServer((socket) => {
    let buffer = '';
    let inData = false;
    let expectAuth: 'user' | 'pass' | undefined;
    const mail: CaughtMail = { auth: undefined, from: '', to: '', body: '' };
    socket.write('220 fake-smtp\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          mail.body = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          caught.push({ ...mail });
          socket.write('250 stored\r\n');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol < 0) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        if (expectAuth === 'user') {
          mail.auth = { user: Buffer.from(line, 'base64').toString(), pass: '' };
          expectAuth = 'pass';
          socket.write('334 UGFzc3dvcmQ6\r\n');
        } else if (expectAuth === 'pass') {
          mail.auth = { user: mail.auth!.user, pass: Buffer.from(line, 'base64').toString() };
          expectAuth = undefined;
          socket.write('235 ok\r\n');
        } else if (/^EHLO/i.test(line)) socket.write('250-fake\r\n250 AUTH LOGIN\r\n');
        else if (/^AUTH LOGIN/i.test(line)) {
          expectAuth = 'user';
          socket.write('334 VXNlcm5hbWU6\r\n');
        } else if (/^MAIL FROM:<(.*)>/i.test(line)) {
          mail.from = /^MAIL FROM:<(.*)>/i.exec(line)![1]!;
          socket.write('250 ok\r\n');
        } else if (/^RCPT TO:<(.*)>/i.test(line)) {
          mail.to = /^RCPT TO:<(.*)>/i.exec(line)![1]!;
          socket.write('250 ok\r\n');
        } else if (/^DATA/i.test(line)) {
          inData = true;
          socket.write('354 go\r\n');
        } else if (/^QUIT/i.test(line)) {
          socket.write('221 bye\r\n');
          socket.end();
        } else socket.write('250 ok\r\n');
      }
    });
  });
  const port = new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
  return { server, port, caught };
}

/** Browsers keep cookies; Node's fetch does not. One jar is one visitor. */
function makeJar(): { use(): void } {
  const real = fetch;
  let cookies = new Map<string, string>();
  const jar = new Map<string, string>();
  const wrapped: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    if (jar.size > 0) headers.set('cookie', [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '));
    const response = await real(input, { ...init, headers });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const eq = pair!.indexOf('=');
      jar.set(pair!.slice(0, eq), pair!.slice(eq + 1));
    }
    return response;
  };
  return {
    use() {
      cookies = jar as never;
      void cookies;
      globalThis.fetch = wrapped;
    },
  };
}

describe.skipIf(!php)('the community store', () => {
  let server: ChildProcess;
  let base = '';
  let dir = '';
  const smtp = fakeSmtp();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'emws-community-'));
    const port = 8300 + Math.floor(Math.random() * 500);
    base = `http://127.0.0.1:${port}/`;
    server = spawn(php!.exe, [...php!.flags, '-S', `127.0.0.1:${port}`, '-t', 'public'], {
      env: {
        ...process.env,
        EMWS_DB_DSN: `sqlite:${join(dir, 'community.db')}`,
        EMWS_MAIL_DSN: `smtp://127.0.0.1:${await smtp.port}`,
        EMWS_MAIL_USER: 'mailbox@example.net',
        EMWS_MAIL_PASS: 'mail secret',
      },
      windowsHide: true,
      stdio: 'ignore',
    });
    const deadline = Date.now() + 10_000;
    for (;;) {
      if (await probeCommunity(base)) return;
      if (Date.now() > deadline) throw new Error('The PHP server never came up.');
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 15_000);

  afterAll(() => {
    server?.kill();
    smtp.server.close();
    if (dir && existsSync(dir)) {
      // The server may still hold the database file for a moment.
      setTimeout(() => rmSync(dir, { recursive: true, force: true }), 500).unref();
    }
  });

  const alice = makeJar();
  const bob = makeJar();

  /** A core profile the way the balun tool exports one: the real payload format. */
  const profileJson = () => {
    const ft240 = CORES.find((c) => c.id === 'FT240')!;
    const sweep = Array.from({ length: 20 }, (_, i) => {
      const fMHz = 1 * 30 ** (i / 19);
      return { fMHz, r: 20 + 60 * Math.sqrt(fMHz), x: 2 * Math.PI * fMHz * 1e6 * 30e-6 };
    });
    return exportProfiles([makeProfile({ name: 'Ferrite Core A', size: ft240, family: 'NiZn', mix: '#43', setup: { turns: 8, strayPf: 0, stack: 1 }, sweep })]);
  };

  it('answers its health check, says it can send mail, and knows nobody yet', async () => {
    alice.use();
    expect(await probeCommunity(base)).toEqual({ version: 1, mail: true });
    expect(await whoAmI(base)).toBeNull();
  });

  it('registers a callsign, refuses a second registration of it, and signs in', async () => {
    alice.use();
    expect(await register('zr1jt', 'a good passphrase', '', base)).toBe('ZR1JT');
    expect(await whoAmI(base)).toBe('ZR1JT');
    bob.use();
    await expect(register('ZR1JT', 'another password', '', base)).rejects.toThrow(/already has an account/);
    await expect(register('x', 'a good passphrase', '', base)).rejects.toThrow(/does not look like a callsign/);
    await expect(register('M0ABC', 'short', '', base)).rejects.toThrow(/at least 8/);
    await expect(register('M0ABC', 'bobs passphrase', 'not-an-address', base)).rejects.toThrow(/email address/);
    expect(await register('M0ABC/P', 'bobs passphrase', '', base)).toBe('M0ABC/P');
  });

  it('keeps a private measurement private, and saving the same name saves over itself', async () => {
    alice.use();
    const saved = await saveItem({ kind: 'core-profile', name: 'Ferrite Core A', summary: 'FT240 #43, 8 turns', payload: profileJson(), public: false, cc0: false }, base);
    expect(saved.updated).toBe(false);
    const again = await saveItem({ kind: 'core-profile', name: 'Ferrite Core A', summary: 'remeasured', payload: profileJson(), public: false, cc0: false }, base);
    expect(again).toEqual({ id: saved.id, updated: true });
    expect(await myItems(base)).toHaveLength(1);

    bob.use();
    expect(await browseShared('core-profile', base)).toEqual([]);
    await expect(fetchShared(saved.id, base)).rejects.toThrow(/No such shared item/);
  });

  it('will not share anything without the CC0 dedication', async () => {
    alice.use();
    await expect(saveItem({ kind: 'core-profile', name: 'Core B', summary: '', payload: profileJson(), public: true, cc0: false }, base)).rejects.toThrow(/CC0/);
    const mine = await myItems(base);
    await expect(shareItem(mine[0]!.id, true, false, base)).rejects.toThrow(/CC0/);
  });

  it('a shared measurement reaches another visitor, and imports as a working profile', async () => {
    alice.use();
    const mine = await myItems(base);
    await shareItem(mine[0]!.id, true, true, base);

    bob.use();
    const shared = await browseShared('core-profile', base);
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({ name: 'Ferrite Core A', callsign: 'ZR1JT' });
    const item = await fetchShared(shared[0]!.id, base);
    // The payload is the balun tool's own export format, so the import path - with its
    // validation and its sweep-is-truth re-derivation - is exactly what runs on it.
    const [profile] = importProfiles(item.payload);
    expect(profile!.name).toBe('Ferrite Core A');
    expect(profile!.curve.length).toBeGreaterThan(0);
    expect(profile!.setup.turns).toBe(8);
  });

  it('unsharing takes it off the shelf without deleting it, and deleting removes it for good', async () => {
    alice.use();
    const mine = await myItems(base);
    await shareItem(mine[0]!.id, false, false, base);
    bob.use();
    expect(await browseShared('core-profile', base)).toEqual([]);
    alice.use();
    expect((await myItems(base))[0]!.public).toBe(false);
    await deleteItem(mine[0]!.id, base);
    expect(await myItems(base)).toEqual([]);
    // Deleting someone else's is a quiet no-op, not a hole in the fence.
    bob.use();
    await deleteItem(mine[0]!.id, base);
  });

  it('refuses what it should refuse', async () => {
    bob.use();
    await expect(saveItem({ kind: 'balun' as never, name: 'x', summary: '', payload: '{}', public: false, cc0: false }, base)).rejects.toThrow(/Unknown kind/);
    await expect(saveItem({ kind: 'core-profile', name: 'x', summary: '', payload: 'not json', public: false, cc0: false }, base)).rejects.toThrow(/not JSON/);
    await logout(base);
    await expect(saveItem({ kind: 'core-profile', name: 'x', summary: '', payload: '{}', public: false, cc0: false }, base)).rejects.toThrow(/Sign in first/);
    // A POST without the app's own header is refused: that is the CSRF lock.
    const raw = await fetch(`${base}community/index.php?op=logout`, { method: 'POST' });
    expect(raw.status).toBe(403);
  });

  it('resets a forgotten password by a mailed code, and only that way', async () => {
    // An account with no email gets the same calm answer, and no mail goes anywhere.
    alice.use();
    await requestReset('ZR1JT', base);
    expect(smtp.caught).toHaveLength(0);
    // Bob adds an email to his account; from then on he can reset.
    bob.use();
    await login('M0ABC/P', 'bobs passphrase', base);
    await setEmail('bob@example.org', base);
    expect((await me(base)).email).toBe('bob@example.org');
    await logout(base);

    await requestReset('M0ABC/P', base);
    expect(smtp.caught).toHaveLength(1);
    const sent = smtp.caught[0]!;
    expect(sent.to).toBe('bob@example.org');
    expect(sent.auth).toEqual({ user: 'mailbox@example.net', pass: 'mail secret' });
    expect(sent.body).toContain('M0ABC/P');
    const code = /code is:\s+([A-Z2-9]{8})/.exec(sent.body)?.[1];
    expect(code).toBeDefined();

    // Asking again straight away is refused: one code a minute.
    await expect(requestReset('M0ABC/P', base)).rejects.toThrow(/just sent/);
    // A wrong code fails without burning the right one...
    await expect(resetPassword('M0ABC/P', 'WRONGONE', 'a brand new password', base)).rejects.toThrow(/Wrong or expired/);
    // ...and the right one sets the new password and signs in.
    expect(await resetPassword('M0ABC/P', code!, 'a brand new password', base)).toBe('M0ABC/P');
    await logout(base);
    await expect(login('M0ABC/P', 'bobs passphrase', base)).rejects.toThrow(/Wrong callsign or password/);
    expect(await login('M0ABC/P', 'a brand new password', base)).toBe('M0ABC/P');
    // The code is spent: it cannot be used twice.
    await expect(resetPassword('M0ABC/P', code!, 'yet another password', base)).rejects.toThrow(/Wrong or expired/);
    await logout(base);
  });

  it('has no mail, and says so, on a site that set none up', async () => {
    const port = 8850 + Math.floor(Math.random() * 100);
    const bare = spawn(php!.exe, [...php!.flags, '-S', `127.0.0.1:${port}`, '-t', 'public'], {
      env: { ...process.env, EMWS_DB_DSN: `sqlite:${join(dir, 'no-mail.db')}` },
      windowsHide: true,
      stdio: 'ignore',
    });
    try {
      const deadline = Date.now() + 10_000;
      let probe;
      while (!(probe = await probeCommunity(`http://127.0.0.1:${port}/`)) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 150));
      }
      expect(probe).toEqual({ version: 1, mail: false });
      await expect(requestReset('ZR1JT', `http://127.0.0.1:${port}/`)).rejects.toThrow(/cannot send email/);
    } finally {
      bare.kill();
    }
  });

  it('slows a password guesser to a crawl', async () => {
    bob.use();
    for (let i = 0; i < 5; i++) {
      await expect(login('M0ABC/P', `wrong guess ${i}`, base)).rejects.toThrow(/Wrong callsign or password/);
    }
    // Even the right password is refused during the cooldown.
    await expect(login('M0ABC/P', 'a brand new password', base)).rejects.toThrow(/Too many wrong passwords/);
    try {
      await login('M0ABC/P', 'a brand new password', base);
    } catch (e) {
      expect((e as CommunityError).status).toBe(429);
    }
  });
});
