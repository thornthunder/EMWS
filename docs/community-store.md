# The community store

EMWS cannot ship manufacturers' component data: the project is public domain, and their
curves are theirs. What it *can* carry is what its users measured themselves — a NanoVNA
sweep of a ferrite core is the property of whoever swept it, and theirs to give away.
The community store is the shelf for exactly that: a site with a database lets visitors
register a callsign, keep their measured cores under it, and — if they dedicate a
measurement to the public domain (CC0 1.0) — share it for every visitor to use.

**EMWS never needs this.** On a static host, a downloaded copy, or a site that never set
it up, the app asks once (`community/index.php?op=health`), gets nothing, and shows
nothing. Nothing leaves a visitor's browser except what they typed into the sign-in box
or pressed *Share* on.

## What the site operator sets up

1. **PHP on the site**, the same way as for the solver proxy (both live behind one
   registration):

   ```powershell
   .\scripts\enable-php-proxy.ps1 -SiteName emws.local `
       -DbDsn 'mysql:host=127.0.0.1;dbname=emws;charset=utf8mb4' -DbUser emws -DbPass '...'
   ```

   Add `-SolverUrl` too if the site also proxies a solver; the script keeps both sets of
   variables on the one FastCGI registration.

   `EMWS_DB_DSN` takes either a full PDO DSN, as above, or **just the host**
   (`127.0.0.1`), in which case the store builds the DSN itself with `EMWS_DB_PORT`
   (`-DbPort`) and the database name from `EMWS_DB_NAME` (`-DbName`, default `emws`).

2. **A MySQL account.** The store builds its own home: the database named in the DSN
   is created if it is missing, the two tables (`users`, `items`) are created on first
   use, and columns added by later EMWS versions are added to older tables - so a fresh
   deployment, or a database server bolted on later, needs nothing by hand. All the
   account needs is the right to do that:

   ```sql
   CREATE USER 'emws'@'localhost' IDENTIFIED BY '...';
   GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX ON emws.* TO 'emws'@'localhost';
   ```

   (Creating the database yourself first works just as well; then the account can do
   without `CREATE` once the tables exist.) A server on a non-standard port goes in the
   DSN, or in `EMWS_DB_PORT` / `-DbPort`.

3. **HTTPS**, ideally. The session cookie is marked `Secure` automatically on https, and
   a password deserves better than plain http (`scripts/enable-https.ps1` for a private
   network).

Check it with `curl https://your-site/community/index.php?op=health` — the answer is
`{"service":"emws-community","version":1}` when it is alive, and a plain "this site has
no community store" where the variables are missing.

## Mail, and password reset

Give the site SMTP and it can reset passwords:

```powershell
.\scripts\enable-php-proxy.ps1 -SiteName emws.local -DbDsn '...' -DbUser emws -DbPass '...' `
    -MailDsn 'smtp://mail.example.net' -MailUser 'emws@example.net' -MailPass '...'
```

`smtp://host` speaks STARTTLS when the server offers it (port 587 unless
`EMWS_MAIL_PORT` says otherwise); `smtps://host` is TLS from the first byte (465).
`EMWS_MAIL_FROM` sets the From address; without it, `EMWS_MAIL_USER` is used when it
looks like one. The SMTP client is EMWS's own hundred lines
(`public/community/mail.php`) - the usual PHP mail libraries are LGPL, which a
public-domain project does not ship.

With mail set up, registration offers an **optional email**, used for password-reset
codes and nothing else - never shown, never shared. Forgot-password mails an 8-character
code good for 15 minutes; five wrong guesses burn it, a new one can be asked for once a
minute, and the answer never says whether a callsign has an account. An account
registered **without** an email still has no reset, and the sign-up box says so.

## Accounts, honestly

An account is a callsign, a password, and at most that one reset email. If someone
without an email is locked out, the operator decides who they are by whatever means
amateurs use, and clears the account so they can register afresh:

```sql
DELETE FROM users WHERE callsign = 'ZR1JT';   -- their shared items go with user_id
DELETE FROM items WHERE user_id NOT IN (SELECT id FROM users);
```

Passwords are stored as `password_hash()` output (bcrypt today), five wrong guesses cost
a quarter of an hour, and every write needs the app's own request header, which a foreign
page cannot send — the standard cross-site locks, kept simple.

## What is stored, and the licence line

An item is `(callsign, kind, name, summary, payload)`, where the payload is the JSON its
own tool exports — for a core, the `{ emws: 'core-profiles', version: 1 }` format with
the raw sweep in it. Saving the same name saves over itself. Private items are the
owner's backup; **public items are always CC0**, because the Share button will not act
until the dedication is confirmed, and the store refuses `public` without `cc0` even if
asked directly. That is what lets the project — and anyone else — pass shared
measurements on without a licensing knot.

Payloads are capped at 1 MB; the only kind today is `core-profile` (the balun tool's
measured cores), and the kind field is how saved baluns or antennas would join later.

The operator moderates by SQL: `UPDATE items SET is_public = 0 WHERE id = ...` takes
something off the shelf; `DELETE FROM items WHERE id = ...` removes it. Back the
database up like any other; the payloads are small.

## On the app's side

Importing a shared core goes through exactly the same path as opening a profile file:
validation, fresh ids, and re-deriving the curve from the sweep — the sweep is the truth
there too. The imported core lands in the visitor's bin named with its measurer
("Ferrite Core A — ZR1JT") and carries a note saying it was shared CC0.

Tests: `tests/community.test.ts` runs the real PHP over HTTP against SQLite (same PDO
code the site runs against MySQL);
`node scripts/smoke-browser.mjs http://127.0.0.1:8090/ --community` walks two visitors
through measure → share → import → design in a real browser, with `dist/` served by
`php -S` and a scratch SQLite database.
