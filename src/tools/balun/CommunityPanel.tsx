// Sharing measured cores with the community, where the site offers it.
//
// The section only exists on a site whose operator set a database up: one probe on
// mount decides, and on a static host or a downloaded copy this renders nothing at all,
// keeping EMWS the standalone tool it was built as. Accounts are a callsign and a
// password, nothing more. Browsing what others shared needs no account; keeping and
// sharing your own does, and sharing always goes through the CC0 dedication - a
// measurement only becomes everyone's when its owner gives it away.
//
// Public domain (The Unlicense). By ZR1JT.

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  type CommunityItem,
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
} from '../../lib/community';
import { type CoreProfile, exportProfiles, importProfiles } from './profiles';

export interface CommunityPanelProps {
  /** The cores measured and kept in this browser. */
  profiles: CoreProfile[];
  /** Takes imported community cores into the local bin. */
  onAddProfiles: (profiles: CoreProfile[]) => void;
}

/** What a share means, said before it happens. */
interface Pending {
  what: string;
  action: () => Promise<void>;
}

const describeProfile = (p: CoreProfile) => `${p.size.name} in ${p.mix}, ${p.setup.turns} turns, ${p.sweep.length} points`;

export function CommunityPanel({ profiles, onAddProfiles }: CommunityPanelProps) {
  const [store, setStore] = useState<'probing' | 'none' | 'ready'>('probing');
  const [mail, setMail] = useState(false);
  const [callsign, setCallsign] = useState<string | null>(null);
  const [email, setEmailShown] = useState<string | null>(null);
  const [mine, setMine] = useState<CommunityItem[]>([]);
  const [shared, setShared] = useState<SharedItem[]>([]);
  const [form, setForm] = useState({ callsign: '', password: '', email: '' });
  /** The forgot-password walk: hidden, asking for the callsign, or typing the mailed code. */
  const [forgot, setForgot] = useState<'no' | 'ask' | 'code'>('no');
  const [reset, setReset] = useState({ callsign: '', code: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState<Pending | undefined>();

  const refresh = useCallback(async (who: string | null) => {
    setShared(await browseShared('core-profile'));
    setMine(who ? await myItems() : []);
  }, []);

  useEffect(() => {
    let current = true;
    void (async () => {
      const probe = await probeCommunity();
      if (!current) return;
      if (!probe) {
        setStore('none');
        return;
      }
      setStore('ready');
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
  }, [refresh]);

  if (store !== 'ready') return null;

  const run = (work: () => Promise<void>) => {
    setError(undefined);
    setBusy(true);
    void work()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

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

  const keepPrivately = (profile: CoreProfile) =>
    run(async () => {
      await saveItem({ kind: 'core-profile', name: profile.name, summary: describeProfile(profile), payload: exportProfiles([profile]), public: false, cc0: false });
      await refresh(callsign);
    });

  /** The CC0 step: nothing is shared until the dedication is confirmed. */
  const askToShare = (what: string, action: () => Promise<void>) => setPending({ what, action });
  const confirmShare = () => {
    const p = pending;
    setPending(undefined);
    if (p) run(p.action);
  };

  const shareProfile = (profile: CoreProfile) =>
    askToShare(profile.name, async () => {
      await saveItem({ kind: 'core-profile', name: profile.name, summary: describeProfile(profile), payload: exportProfiles([profile]), public: true, cc0: true });
      await refresh(callsign);
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

  const take = (item: SharedItem) =>
    run(async () => {
      const full = await fetchShared(item.id);
      // The community payload goes through exactly the file-import path: its validation,
      // its fresh ids, and the re-derivation that keeps the sweep the truth.
      const imported = importProfiles(full.payload).map((p) => ({
        ...p,
        name: p.name.includes(item.callsign) ? p.name : `${p.name} — ${item.callsign}`,
        notes: [p.notes, `Shared CC0 by ${item.callsign}.`].filter(Boolean).join(' '),
      }));
      onAddProfiles(imported);
    });

  const onShelf = new Set(mine.map((m) => m.name));

  return (
    <section className="form-section community">
      <h3>Community</h3>
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
            This site can keep your measured cores under your callsign and, if you choose, share them with everyone. Browsing what others
            shared needs no account.
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
          {profiles.length === 0 && <p className="muted">Measure a core (above) and it can be kept here, or shared.</p>}
          {profiles.length > 0 && (
            <ul className="community-list">
              {profiles.map((p) => (
                <li key={p.id}>
                  <span className="community-name">{p.name}</span>
                  <button type="button" className="small" disabled={busy} onClick={() => keepPrivately(p)}>
                    {onShelf.has(p.name) ? 'Save again' : 'Keep on this site'}
                  </button>
                  <button type="button" className="small" disabled={busy} onClick={() => shareProfile(p)}>
                    Share…
                  </button>
                </li>
              ))}
            </ul>
          )}
          {mine.length > 0 && (
            <>
              <h4>On this site</h4>
              <ul className="community-list">
                {mine.map((m) => (
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
        </>
      )}

      {pending && (
        <div className="community-dedication" role="alertdialog" aria-label="Public domain dedication">
          <p>
            Sharing <strong>{pending.what}</strong> offers your measurement to everyone, dedicated to the public domain
            (CC0 1.0) so the project may pass it on. Your callsign is shown beside it.
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

      <h4>Shared by the community</h4>
      {shared.length === 0 ? (
        <p className="muted">Nothing shared here yet.</p>
      ) : (
        <ul className="community-list">
          {shared.map((s) => (
            <li key={s.id}>
              <span className="community-name">
                {s.name} <span className="muted">by {s.callsign} · {s.summary}</span>
              </span>
              <button type="button" className="small" disabled={busy} onClick={() => take(s)}>
                Add to my cores
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="alert-inline">{error}</p>}
    </section>
  );
}
