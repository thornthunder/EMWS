// The community store, from the app's side.
//
// A site can carry an optional store (public/community/index.php + a database) where a
// signed-in visitor keeps their measurements and, if they dedicate them CC0, shares them
// with everyone. This file is the only place the app talks to it. Two promises the rest
// of the app leans on:
//
//   - STANDALONE FIRST. probeCommunity() asks the site once; on a static host, a
//     download, file://, or a site that never set the database up, it answers
//     undefined and every tool shows nothing. No account, no cookie, no request beyond
//     that single probe.
//   - Nothing leaves the machine except what the person typed or pressed Share on.
//
// Public domain (The Unlicense). By ZR1JT.

/** Relative on purpose: the store lives on whatever site is serving the app. */
export const COMMUNITY_PATH = 'community/index.php';

/** Must match KINDS in public/community/index.php. */
export type CommunityKind = 'core-profile' | 'balun-design' | 'antenna-model';

export interface CommunityItem {
  id: number;
  kind: CommunityKind;
  name: string;
  summary: string;
  public: boolean;
  updatedAt: number;
}

export interface SharedItem {
  id: number;
  name: string;
  summary: string;
  callsign: string;
  updatedAt: number;
}

export class CommunityError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'CommunityError';
  }
}

function endpoint(op: string, params: Record<string, string | number> = {}, base?: string): string {
  const url = new URL(`${COMMUNITY_PATH}?op=${op}`, base ?? location.href);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.href;
}

async function call<T>(op: string, options: { params?: Record<string, string | number>; post?: unknown; base?: string } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(endpoint(op, options.params, options.base), {
      method: options.post === undefined ? 'GET' : 'POST',
      // The custom header is the CSRF lock: a foreign page cannot send it (see the PHP).
      headers: options.post === undefined ? undefined : { 'Content-Type': 'application/json', 'X-EMWS': '1' },
      body: options.post === undefined ? undefined : JSON.stringify(options.post),
      cache: 'no-store',
    });
  } catch (e) {
    throw new CommunityError(`The community store could not be reached. ${e instanceof Error ? e.message : String(e)}`);
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const said = body as { error?: string; detail?: string } | undefined;
    const message = said?.error ? `${said.error}.${said.detail ? ` ${said.detail}` : ''}` : `The community store answered HTTP ${response.status}.`;
    throw new CommunityError(message, response.status);
  }
  return body as T;
}

/**
 * Whether this site has a store at all. Asked once per page load; undefined means the
 * feature does not exist here, and the tools draw nothing for it.
 */
export async function probeCommunity(base?: string): Promise<{ version: number; mail: boolean } | undefined> {
  try {
    const answer = await call<{ service?: string; version?: number; mail?: boolean }>('health', { base });
    return answer.service === 'emws-community' ? { version: answer.version ?? 1, mail: answer.mail === true } : undefined;
  } catch {
    return undefined;
  }
}

/** Who is signed in, and - to its owner only - the reset email on the account. */
export async function me(base?: string): Promise<{ callsign: string | null; email: string | null }> {
  return call('me', { base });
}

/** The signed-in callsign, or null. */
export async function whoAmI(base?: string): Promise<string | null> {
  return (await me(base)).callsign;
}

export async function register(callsign: string, password: string, email = '', base?: string): Promise<string> {
  const answer = await call<{ callsign: string }>('register', { post: { callsign, password, email }, base });
  return answer.callsign;
}

/** Sets, changes or ('' ) removes the reset email on the signed-in account. */
export async function setEmail(email: string, base?: string): Promise<void> {
  await call('set-email', { post: { email }, base });
}

/** Asks for a reset code by email. The answer never says whether the account exists. */
export async function requestReset(callsign: string, base?: string): Promise<void> {
  await call('reset-request', { post: { callsign }, base });
}

/** Trades a mailed code for a new password, and signs in. */
export async function resetPassword(callsign: string, code: string, password: string, base?: string): Promise<string> {
  const answer = await call<{ callsign: string }>('reset', { post: { callsign, code, password }, base });
  return answer.callsign;
}

export async function login(callsign: string, password: string, base?: string): Promise<string> {
  const answer = await call<{ callsign: string }>('login', { post: { callsign, password }, base });
  return answer.callsign;
}

export async function logout(base?: string): Promise<void> {
  await call('logout', { post: {}, base });
}

export interface SaveRequest {
  kind: CommunityKind;
  name: string;
  summary: string;
  /** The item itself, as the JSON text its own tool exports. */
  payload: string;
  /** Offered to everyone. Requires cc0. */
  public: boolean;
  /** The dedication that makes sharing possible at all. */
  cc0: boolean;
}

/** Saves under (kind, name); the same name saves over itself. */
export async function saveItem(request: SaveRequest, base?: string): Promise<{ id: number; updated: boolean }> {
  return call('save', { post: request, base });
}

export async function shareItem(id: number, isPublic: boolean, cc0: boolean, base?: string): Promise<void> {
  await call('share', { post: { id, public: isPublic, cc0 }, base });
}

export async function deleteItem(id: number, base?: string): Promise<void> {
  await call('delete', { post: { id }, base });
}

export async function myItems(base?: string): Promise<CommunityItem[]> {
  const { items } = await call<{ items: CommunityItem[] }>('mine', { base });
  return items;
}

export async function browseShared(kind: CommunityKind, base?: string): Promise<SharedItem[]> {
  const { items } = await call<{ items: SharedItem[] }>('browse', { params: { kind }, base });
  return items;
}

export async function fetchShared(id: number, base?: string): Promise<{ name: string; callsign: string; payload: string }> {
  return call('fetch', { params: { id }, base });
}
