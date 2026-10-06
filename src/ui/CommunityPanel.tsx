// The club library: sharing measured cores, balun designs and antenna models, where the
// site offers it.
//
// The section only exists on a site whose operator set a database up: one probe on mount
// decides, and on a static host or a downloaded copy this renders nothing at all, keeping
// EMWS the standalone tool it was built as. Accounts are a callsign and a password, nothing
// more. Browsing what others shared needs no account; keeping and sharing your own does,
// and sharing always goes through the CC0 dedication - a measurement or a design only
// becomes everyone's when its owner gives it away.
//
// One account, several SHELVES: each tool says what it keeps (its kind), how one of its
// own becomes a file, and what taking a shared one means. The file is always the owning
// tool's own format, so taking one is that tool's file import and nothing else.
//
// Public domain (The Unlicense). By ZR1JT.

import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  type CommunityItem,
  type CommunityKind,
  type SharedItem,
  browseShared,
  deleteItem,
  fetchShared,
  login,
  logout,
  me,
  myItems,
  probeCommunity,
  register,
  requestReset,
  resetPassword,
  saveItem,
  setEmail,
  shareItem,
} from '../lib/community';

/** Something of yours a shelf can keep or share. */
export interface LocalItem {
  id: string;
  name: string;
  summary: string;
  /** The tool's own file for it. May throw, with a reason, when it cannot be shared faithfully. */
  payload: () => string;
}

export interface CommunityShelf {
  kind: CommunityKind;
  /** "Measured cores", "Balun designs", "Antenna models". */
  title: string;
  local: LocalItem[];
  /** What to say when there is nothing of yours to keep yet. */
  emptyLocal: string;
  /** The button on a shared item: "Add to my cores", "Open it". */
  takeLabel: string;
  /** Takes a shared item's file in, by the tool's own import. May throw, with a reason. */
  onTake: (payload: string, item: SharedItem) => void;
}

export interface CommunityPanelProps {
  shelves: CommunityShelf[];
  /** The section's heading. */
  title?: string;
  /** A share asked for elsewhere (a core chip's menu): scroll here and start the dedication. */
  shareRequest?: { kind: CommunityKind; id: string };
  onShareHandled?: () => void;
  /** Told once the probe has answered, so menus offer Share only where a store exists. Keep it stable. */
  onReady?: (ready: boolean) => void;
}

/** What a share means, said before it happens. */
interface Pending {
  what: string;
  action: () => Promise<void>;
}

export function CommunityPanel({ shelves, title = 'Community', shareRequest, onShareHandled, onReady }: CommunityPanelProps) {
  const [store, setStore] = useState<'probing' | 'none' | 'ready'>('probing');
  const [mail, setMail] = useState(false);
  const [callsign, setCallsign] = useState<string | null>(null);
  const [email, setEmailShown] = useState<string | null>(null);
  const [mine, setMine] = useState<CommunityItem[]>([]);
  const [shared, setShared] = useState<Partial<Record<CommunityKind, SharedItem[]>>>({});
  const [form, setForm] = useState({ callsign: '', password: '', email: '' });
  /** The forgot-password walk: hidden, asking for the callsign, or typing the mailed code. */
  const [forgot, setForgot] = useState<'no' | 'ask' | 'code'>('no');
  const [reset, setReset] = useState({ callsign: '', code: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [taken, setTaken] = useState<string | undefined>();
  const [pending, setPending] = useState<Pending | undefined>();
  const kinds = shelves.map((s) => s.kind).join(',');

  const refresh = useCallback(
    async (who: string | null) => {
      const lists = await Promise.all(kinds.split(',').map(async (k) => [k, await browseShared(k as CommunityKind)] as const));
      setShared(Object.fromEntries(lists));
      setMine(who ? await myItems() : []);
    },
    [kinds],
  );

  useEffect(() => {
    let current = true;
    void (async () => {
      const probe = await probeCommunity();
      if (!current) return;
      if (!probe) {
        setStore('none');
        onReady?.(false);
        return;
      }
      setStore('ready');
      onReady?.(true);
      setMail(probe.mail);
      try {
        const who = await me();
        if (!current) return;
        setCallsign(who.callsign);
        setEmailShown(who.email);
        await refresh(who.callsign);
      } catch {
        // The store answered its health check but not this; the buttons will say why.
      }
    })();
    return () => {
      current = false;
    };
  }, [refresh, onReady]);

  const run = (work: () => Promise<void>) => {
    setError(undefined);
    setBusy(true);
    void work()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  /** The CC0 step: nothing is shared until the dedication is confirmed. */
  const askToShare = (what: string, action: () => Promise<void>) => setPending({ what, action });
  const confirmShare = () => {
    const p = pending;
    setPending(undefined);
    if (p) run(p.action);
  };
  const keep = (shelf: CommunityShelf, item: LocalItem, share: boolean) => {
    const save = async () => {
      await saveItem({ kind: shelf.kind, name: item.name, summary: item.summary, payload: item.payload(), public: share, cc0: share });
      await refresh(callsign);
    };
    if (share) askToShare(item.name, save);
    else run(save);
  };

  // A share asked for elsewhere: walk the eye here, then the same dedication step as the
  // panel's own Share button - or, signed out, say what to do.
  const rootRef = useRef<HTMLElement>(null);
  const requestKey = shareRequest ? `${shareRequest.kind}:${shareRequest.id}` : undefined;
  useEffect(() => {
    if (!shareRequest || store !== 'ready') return;
    rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const shelf = shelves.find((s) => s.kind === shareRequest.kind);
    const item = shelf?.local.find((l) => l.id === shareRequest.id);
    if (shelf && item) {
      if (callsign !== null) keep(shelf, item, true);
      else setError(`Sign in or register here first, then press Share… beside ${item.name}.`);
    }
    onShareHandled?.();
    // The handlers above are recreated every render; the request's identity is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, store]);

  if (store !== 'ready') return null;

  const signIn = (how: 'login' | 'register') => (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const who = how === 'login' ? await login(form.callsign, form.password) : await register(form.callsign, form.password, form.email);
      setCallsign(who);
      setEmailShown(how === 'register' && form.email !== '' ? form.email : (await me()).email);
      setForm({ callsign: '', password: '', email: '' });
      await refresh(who);
    });
  };

  const sendCode = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      await requestReset(reset.callsign);
      setForgot('code');
    });
  };

  const useCode = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const who = await resetPassword(reset.callsign, reset.code, reset.password);
      setCallsign(who);
      setEmailShown((await me()).email);
      setForgot('no');
      setReset({ callsign: '', code: '', password: '' });
      await refresh(who);
    });
  };

  const saveEmail = () =>
    run(async () => {
      await setEmail(form.email);
      setEmailShown(form.email !== '' ? form.email : null);
      setForm({ ...form, email: '' });
    });

  const signOut = () =>
    run(async () => {
      await logout();
      setCallsign(null);
      setMine([]);
      setPending(undefined);
    });

  const setPublic = (item: CommunityItem, isPublic: boolean) => {
    const flip = async () => {
      await shareItem(item.id, isPublic, isPublic);
      await refresh(callsign);
    };
    if (isPublic) askToShare(item.name, flip);
    else run(flip);
  };

  const remove = (item: CommunityItem) =>
    run(async () => {
      await deleteItem(item.id);
      await refresh(callsign);
    });

  const take = (shelf: CommunityShelf, item: SharedItem) =>
    run(async () => {
      const full = await fetchShared(item.id);
      shelf.onTake(full.payload, item);
      setTaken(`${item.name}, shared by ${item.callsign}, is yours to use.`);
    });

  return (
    <section ref={rootRef} className="form-section community">
      <h3>{title}</h3>
      {callsign === null && forgot !== 'no' ? (
        <>
          {forgot === 'ask' ? (
            <form className="field-row community-signin" onSubmit={sendCode}>
              <label className="field">
                <span className="field-label">Callsign</span>
                <input type="text" autoComplete="username" value={reset.callsign} onChange={(e) => setReset({ ...reset, callsign: e.target.value })} />
              </label>
              <div className="button-row">
                <button type="submit" className="small" disabled={busy}>
                  Email me a code
                </button>
                <button type="button" className="link" onClick={() => setForgot('no')}>
                  Back
                </button>
              </div>
            </form>
          ) : (
            <>
              <p className="muted">
                If that account has an email, a code is on its way. Give it a minute — and <strong>look in the spam or junk
                folder</strong>: a short automated mail like this often lands there, even from a well-behaved mail server. The
                code lasts 15 minutes.
              </p>
              <form className="field-row community-signin" onSubmit={useCode}>
                <label className="field">
                  <span className="field-label">Code</span>
                  <input type="text" autoComplete="one-time-code" value={reset.code} onChange={(e) => setReset({ ...reset, code: e.target.value })} />
                </label>
                <label className="field">
                  <span className="field-label">New password</span>
                  <input type="password" autoComplete="new-password" value={reset.password} onChange={(e) => setReset({ ...reset, password: e.target.value })} />
                </label>
                <div className="button-row">
                  <button type="submit" className="small" disabled={busy}>
                    Set the new password
                  </button>
                  <button type="button" className="link" onClick={() => setForgot('no')}>
                    Back
                  </button>
                </div>
              </form>
            </>
          )}
        </>
      ) : callsign === null ? (
        <>
          <p className="muted">
            This site can keep your work under your callsign and, if you choose, share it with everyone. Browsing what others shared
            needs no account.
          </p>
          <form className="field-row community-signin" onSubmit={signIn('login')}>
            <label className="field">
              <span className="field-label">Callsign</span>
              <input type="text" autoComplete="username" value={form.callsign} onChange={(e) => setForm({ ...form, callsign: e.target.value })} />
            </label>
            <label className="field">
              <span className="field-label">Password</span>
              <input type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </label>
            {mail && (
              <label className="field">
                <span className="field-label">Email (optional)</span>
                <input type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </label>
            )}
            <div className="button-row">
              <button type="submit" className="small" disabled={busy}>
                Sign in
              </button>
              <button type="button" className="small" disabled={busy} onClick={signIn('register')}>
                Register
              </button>
              {mail && (
                <button type="button" className="link" onClick={() => setForgot('ask')}>
                  Forgot password?
                </button>
              )}
            </div>
          </form>
          {mail ? (
            <p className="muted">The email is used for password-reset codes and nothing else. Register without one and there is no reset.</p>
          ) : (
            <p className="muted">No email is asked for, so there is no password reset: pick a password you will keep.</p>
          )}
        </>
      ) : (
        <>
          <p className="vna-status">
            Signed in as <strong>{callsign}</strong>.{' '}
            <button type="button" className="link" onClick={signOut}>
              Sign out
            </button>
          </p>
          {mail && (
            <div className="field-row community-signin">
              <label className="field">
                <span className="field-label">Password-reset email {email ? `(now ${email})` : '(none set)'}</span>
                <input type="email" autoComplete="email" value={form.email} placeholder={email ?? ''} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </label>
              <button type="button" className="small" disabled={busy} onClick={saveEmail}>
                {form.email === '' && email ? 'Remove it' : 'Save'}
              </button>
            </div>
          )}
        </>
      )}

      {pending && (
        <div className="community-dedication" role="alertdialog" aria-label="Public domain dedication">
          <p>
            Sharing <strong>{pending.what}</strong> offers your work to everyone, dedicated to the public domain (CC0 1.0) so the
            project may pass it on. Your callsign is shown beside it.
          </p>
          <div className="button-row">
            <button type="button" className="small" onClick={confirmShare}>
              Share it, CC0
            </button>
            <button type="button" className="small" onClick={() => setPending(undefined)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {shelves.map((shelf) => {
        const ours = mine.filter((m) => m.kind === shelf.kind);
        const onShelf = new Set(ours.map((m) => m.name));
        const theirs = shared[shelf.kind] ?? [];
        return (
          <div key={shelf.kind} className="community-shelf" data-kind={shelf.kind}>
            {shelves.length > 1 && <h4 className="community-shelf-title">{shelf.title}</h4>}
            {callsign !== null &&
              (shelf.local.length === 0 ? (
                <p className="muted">{shelf.emptyLocal}</p>
              ) : (
                <ul className="community-list">
                  {shelf.local.map((item) => (
                    <li key={item.id}>
                      <span className="community-name">{item.name}</span>
                      <button type="button" className="small" disabled={busy} onClick={() => keep(shelf, item, false)}>
                        {onShelf.has(item.name) ? 'Save again' : 'Keep on this site'}
                      </button>
                      <button type="button" className="small" disabled={busy} onClick={() => keep(shelf, item, true)}>
                        Share…
                      </button>
                    </li>
                  ))}
                </ul>
              ))}
            {ours.length > 0 && (
              <>
                <h4>On this site</h4>
                <ul className="community-list">
                  {ours.map((m) => (
                    <li key={m.id}>
                      <span className="community-name">
                        {m.name} <span className="muted">{m.public ? '· shared' : '· private'}</span>
                      </span>
                      <button type="button" className="small" disabled={busy} onClick={() => setPublic(m, !m.public)}>
                        {m.public ? 'Stop sharing' : 'Share…'}
                      </button>
                      <button type="button" className="small" disabled={busy} aria-label={`Delete ${m.name} from this site`} onClick={() => remove(m)}>
                        Delete
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <h4>Shared by the community</h4>
            {theirs.length === 0 ? (
              <p className="muted">Nothing shared here yet.</p>
            ) : (
              <ul className="community-list">
                {theirs.map((s) => (
                  <li key={s.id}>
                    <span className="community-name">
                      {s.name} <span className="muted">by {s.callsign} · {s.summary}</span>
                    </span>
                    <button type="button" className="small" disabled={busy} onClick={() => take(shelf, s)}>
                      {shelf.takeLabel}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {taken && !error && <p className="muted community-taken">{taken}</p>}
      {error && <p className="alert-inline">{error}</p>}
    </section>
  );
}
