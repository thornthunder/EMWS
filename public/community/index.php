<?php
/**
 * EMWS community store.
 *
 * Measurements are the one kind of component data a public-domain project can share:
 * nobody may republish a manufacturer's curves, but a sweep YOU made of YOUR core is
 * yours to give away. This lets a signed-in visitor keep such measurements on the site,
 * and - if they dedicate them to the public domain (CC0) - share them for everyone.
 *
 * The whole feature is OPTIONAL, like the solver proxy: EMWS works standalone, and only
 * a site whose FastCGI environment names a database offers it. Nothing here is taken
 * from the request but the visitor's own data:
 *
 *     EMWS_DB_DSN    PDO DSN, e.g. mysql:host=127.0.0.1;dbname=emws;charset=utf8mb4
 *     EMWS_DB_PORT   appended to a mysql DSN that names no port
 *     EMWS_DB_USER   database account (not needed for sqlite:)
 *     EMWS_DB_PASS   its password
 *     EMWS_MAIL_*    optional SMTP for password-reset codes; see mail.php
 *
 * A fresh deployment needs no hand-made schema: the MySQL database itself is created if
 * the account may, the tables are created on first use, and columns added since are
 * added to older tables. Accounts are a callsign and a password; an email may be given,
 * used for password-reset codes and nothing else, and only on a site whose operator set
 * mail up. Without one there is still no reset - the operator can clear a hash by hand
 * (docs/community-store.md). Sharing requires the CC0 box: without that dedication the
 * project could not let others use what was shared.
 *
 * Public domain (The Unlicense), like the rest of EMWS. By ZR1JT.
 */

declare(strict_types=1);

// Measured cores; balun designs (with the core they are wound on); antenna models (a NEC
// deck in a small JSON envelope - every payload stays JSON, which the check below holds).
// Each is its owning tool's own format, so taking one is that tool's import and its
// validation, nothing else's.
const KINDS = ['core-profile', 'balun-design', 'antenna-model'];
const MAX_PAYLOAD_BYTES = 1000000;
const MAX_BODY_BYTES = 1200000;
const LOGIN_ATTEMPTS = 5;
const LOGIN_COOLDOWN_S = 900;
const RESET_LIFETIME_S = 900;
const RESET_ATTEMPTS = 5;
/** No lookalikes: a code someone reads off a phone screen and types. */
const RESET_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const BROWSE_LIMIT = 200;

header('Cache-Control: no-store');
header('Content-Type: application/json');
header('X-Content-Type-Options: nosniff');

/** Reads a setting from the environment, however this server chooses to pass it along. */
function setting(string $name, string $fallback = ''): string
{
    foreach ([getenv($name), $_SERVER[$name] ?? null, $_ENV[$name] ?? null] as $value) {
        if (is_string($value) && trim($value) !== '') {
            return trim($value);
        }
    }
    return $fallback;
}

/** What went wrong, for the visitor; anything private goes to the server's log only. */
function fail(int $status, string $error, string $detail = '', string $private = ''): never
{
    if ($private !== '') {
        error_log('EMWS community store: ' . $error . ' - ' . $private);
    }
    http_response_code($status);
    echo json_encode(['error' => $error, 'detail' => $detail], JSON_UNESCAPED_SLASHES);
    exit;
}

function ok(array $body): never
{
    echo json_encode($body, JSON_UNESCAPED_SLASHES);
    exit;
}

require __DIR__ . '/mail.php';

$operations = [
    'health' => 'GET', 'me' => 'GET', 'mine' => 'GET', 'browse' => 'GET', 'fetch' => 'GET',
    'register' => 'POST', 'login' => 'POST', 'logout' => 'POST',
    'set-email' => 'POST', 'reset-request' => 'POST', 'reset' => 'POST',
    'save' => 'POST', 'share' => 'POST', 'delete' => 'POST',
];
$op = isset($_GET['op']) && is_string($_GET['op']) ? $_GET['op'] : 'health';
if (!array_key_exists($op, $operations)) {
    fail(404, 'Unknown operation');
}
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}
if ($method !== $operations[$op]) {
    fail(405, 'Wrong method', sprintf('%s needs %s.', $op, $operations[$op]));
}

$dsn = setting('EMWS_DB_DSN');
if ($dsn === '') {
    fail(503, 'This site has no community store', 'Saving and sharing need the site to be set up with a database; everything else works without one.');
}
// A bare host name here means "my MySQL is over there": build the DSN from it, with
// EMWS_DB_NAME (default emws) as the database. A real PDO DSN passes through untouched.
if (!preg_match('/^[a-z][a-z0-9]*:/i', $dsn)) {
    $dsn = 'mysql:host=' . $dsn . ';dbname=' . (setting('EMWS_DB_NAME') ?: 'emws') . ';charset=utf8mb4';
}
if (setting('EMWS_DB_PORT') !== '' && str_starts_with($dsn, 'mysql:') && !str_contains($dsn, 'port=')) {
    $dsn .= ';port=' . setting('EMWS_DB_PORT');
}

$connect = static fn (string $to): PDO => new PDO($to, setting('EMWS_DB_USER') ?: null, setting('EMWS_DB_PASS') ?: null, [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
]);
try {
    try {
        $db = $connect($dsn);
    } catch (PDOException $e) {
        // A fresh deployment: the server is there but the database is not. Make it,
        // if the account is allowed to, so "add a DSN" is the whole setup.
        if (!str_starts_with($dsn, 'mysql:') || !str_contains($e->getMessage(), 'Unknown database') || !preg_match('/dbname=([^;]+)/', $dsn, $named)) {
            throw $e;
        }
        $server = $connect(preg_replace('/dbname=[^;]+;?/', '', $dsn));
        $server->exec('CREATE DATABASE IF NOT EXISTS `' . str_replace('`', '', $named[1]) . '` CHARACTER SET utf8mb4');
        $db = $connect($dsn);
    }
} catch (PDOException $e) {
    fail(503, "This site's community store is not answering", 'Try again later.', $e->getMessage());
}

// ---- the tables, created on first use ----
$driver = $db->getAttribute(PDO::ATTR_DRIVER_NAME);
$id = $driver === 'sqlite' ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY';
$text = $driver === 'sqlite' ? 'TEXT' : 'MEDIUMTEXT';
$suffix = $driver === 'sqlite' ? '' : ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4';
$db->exec("CREATE TABLE IF NOT EXISTS users (
    id $id,
    callsign VARCHAR(20) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    created_at INT NOT NULL,
    failed_logins INT NOT NULL DEFAULT 0,
    last_failed_at INT NOT NULL DEFAULT 0,
    email VARCHAR(190) NOT NULL DEFAULT '',
    reset_hash VARCHAR(255) NOT NULL DEFAULT '',
    reset_expires INT NOT NULL DEFAULT 0,
    reset_attempts INT NOT NULL DEFAULT 0
)$suffix");
// A table made by an older EMWS gains the columns added since; both dialects ALTER alike.
foreach ([
    'email' => "VARCHAR(190) NOT NULL DEFAULT ''",
    'reset_hash' => "VARCHAR(255) NOT NULL DEFAULT ''",
    'reset_expires' => 'INT NOT NULL DEFAULT 0',
    'reset_attempts' => 'INT NOT NULL DEFAULT 0',
] as $column => $ddl) {
    try {
        $db->query("SELECT $column FROM users LIMIT 1");
    } catch (PDOException) {
        $db->exec("ALTER TABLE users ADD COLUMN $column $ddl");
    }
}
$browseIndex = $driver === 'sqlite' ? '' : ', KEY browse_idx (kind, is_public, updated_at)';
$db->exec("CREATE TABLE IF NOT EXISTS items (
    id $id,
    user_id INT NOT NULL,
    kind VARCHAR(32) NOT NULL,
    name VARCHAR(120) NOT NULL,
    summary VARCHAR(300) NOT NULL DEFAULT '',
    payload $text NOT NULL,
    is_public INT NOT NULL DEFAULT 0,
    cc0 INT NOT NULL DEFAULT 0,
    created_at INT NOT NULL,
    updated_at INT NOT NULL,
    UNIQUE (user_id, kind, name)$browseIndex
)$suffix");
if ($driver === 'sqlite') {
    $db->exec('CREATE INDEX IF NOT EXISTS browse_idx ON items (kind, is_public, updated_at)');
}

// ---- the session ----
session_name('EMWSCOMMUNITY');
session_set_cookie_params([
    'httponly' => true,
    'samesite' => 'Strict',
    'secure' => (($_SERVER['HTTPS'] ?? '') !== '' && ($_SERVER['HTTPS'] ?? 'off') !== 'off'),
    'path' => '/',
]);
session_start();

/**
 * Cross-site request forgery: a foreign page can make a browser POST here with the
 * visitor's cookie, but it cannot add a custom header without a CORS preflight this
 * server never grants. So every POST must carry one. SameSite=Strict is the second lock.
 */
if ($method === 'POST' && ($_SERVER['HTTP_X_EMWS'] ?? '') === '') {
    fail(403, 'Missing request header', 'POSTs need the X-EMWS header; the EMWS page sends it itself.');
}

function body(): array
{
    $raw = file_get_contents('php://input', length: MAX_BODY_BYTES + 1);
    if ($raw === false || strlen($raw) > MAX_BODY_BYTES) {
        fail(413, 'That is too large to store');
    }
    $parsed = $raw === '' ? [] : json_decode($raw, true);
    if (!is_array($parsed)) {
        fail(400, 'The request body is not JSON');
    }
    return $parsed;
}

function str_of(array $body, string $key, int $max, string $fallback = ''): string
{
    $value = $body[$key] ?? $fallback;
    if (!is_string($value) || strlen($value) > $max) {
        fail(400, "Bad field: $key");
    }
    return $value;
}

function userId(): int
{
    $id = $_SESSION['uid'] ?? null;
    if (!is_int($id)) {
        fail(401, 'Sign in first');
    }
    return $id;
}

function signIn(int $id, string $callsign): never
{
    session_regenerate_id(true);
    $_SESSION['uid'] = $id;
    $_SESSION['callsign'] = $callsign;
    ok(['callsign' => $callsign]);
}

switch ($op) {
    case 'health':
        ok(['service' => 'emws-community', 'version' => 1, 'mail' => mailConfigured()]);

    // ---- accounts ----
    case 'register': {
        $b = body();
        $callsign = strtoupper(trim(str_of($b, 'callsign', 20)));
        $password = str_of($b, 'password', 200);
        if (!preg_match('#^[A-Z0-9][A-Z0-9/\-]{2,15}$#', $callsign)) {
            fail(400, 'That does not look like a callsign', 'Three to sixteen letters, digits, / or -.');
        }
        if (strlen($password) < 8) {
            fail(400, 'The password needs at least 8 characters', 'Pick one you will keep.');
        }
        $email = trim(str_of($b, 'email', 190));
        if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            fail(400, 'That does not look like an email address', 'It is optional, and used only for password-reset codes.');
        }
        try {
            $insert = $db->prepare('INSERT INTO users (callsign, password_hash, created_at, email) VALUES (?, ?, ?, ?)');
            $insert->execute([$callsign, password_hash($password, PASSWORD_DEFAULT), time(), $email]);
        } catch (PDOException $e) {
            if (str_starts_with($e->getCode(), '23')) {
                fail(409, 'That callsign already has an account', 'Sign in instead, or pick another.');
            }
            throw $e;
        }
        signIn((int) $db->lastInsertId(), $callsign);
    }

    case 'login': {
        $b = body();
        $callsign = strtoupper(trim(str_of($b, 'callsign', 20)));
        $password = str_of($b, 'password', 200);
        $find = $db->prepare('SELECT id, callsign, password_hash, failed_logins, last_failed_at FROM users WHERE callsign = ?');
        $find->execute([$callsign]);
        $user = $find->fetch();
        if ($user && (int) $user['failed_logins'] >= LOGIN_ATTEMPTS && time() - (int) $user['last_failed_at'] < LOGIN_COOLDOWN_S) {
            fail(429, 'Too many wrong passwords', 'Wait a quarter of an hour and try again.');
        }
        if (!$user || !password_verify($password, $user['password_hash'])) {
            if ($user) {
                $db->prepare('UPDATE users SET failed_logins = failed_logins + 1, last_failed_at = ? WHERE id = ?')->execute([time(), $user['id']]);
            }
            fail(401, 'Wrong callsign or password');
        }
        $db->prepare('UPDATE users SET failed_logins = 0 WHERE id = ?')->execute([$user['id']]);
        signIn((int) $user['id'], $user['callsign']);
    }

    case 'logout':
        $_SESSION = [];
        session_destroy();
        ok(['callsign' => null]);

    case 'me': {
        if (!is_int($_SESSION['uid'] ?? null)) {
            ok(['callsign' => null, 'email' => null]);
        }
        $who = $db->prepare('SELECT callsign, email FROM users WHERE id = ?');
        $who->execute([$_SESSION['uid']]);
        $row = $who->fetch();
        ok(['callsign' => $row['callsign'] ?? null, 'email' => ($row['email'] ?? '') !== '' ? $row['email'] : null]);
    }

    case 'set-email': {
        $uid = userId();
        $email = trim(str_of(body(), 'email', 190));
        if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            fail(400, 'That does not look like an email address');
        }
        $db->prepare('UPDATE users SET email = ? WHERE id = ?')->execute([$email, $uid]);
        ok(['email' => $email !== '' ? $email : null]);
    }

    case 'reset-request': {
        if (!mailConfigured()) {
            fail(503, 'This site cannot send email', 'So it cannot reset passwords; ask the site operator.');
        }
        $callsign = strtoupper(trim(str_of(body(), 'callsign', 20)));
        $find = $db->prepare('SELECT id, callsign, email, reset_expires FROM users WHERE callsign = ?');
        $find->execute([$callsign]);
        $user = $find->fetch();
        // One answer whatever was found: the shelf does not say who has an account.
        if ($user && $user['email'] !== '') {
            $issuedAt = (int) $user['reset_expires'] - RESET_LIFETIME_S;
            if (time() - $issuedAt < 60) {
                fail(429, 'A code was just sent', 'Give it a minute, and check the spam folder.');
            }
            $code = '';
            for ($i = 0; $i < 8; $i++) {
                $code .= RESET_ALPHABET[random_int(0, strlen(RESET_ALPHABET) - 1)];
            }
            $db->prepare('UPDATE users SET reset_hash = ?, reset_expires = ?, reset_attempts = 0 WHERE id = ?')
                ->execute([password_hash($code, PASSWORD_DEFAULT), time() + RESET_LIFETIME_S, $user['id']]);
            $site = $_SERVER['HTTP_HOST'] ?? 'an EMWS site';
            try {
                sendMail(
                    $user['email'],
                    'EMWS password reset',
                    "Hello {$user['callsign']},

Someone - hopefully you - asked to reset your EMWS community password on $site.

The code is:  $code

It is good for 15 minutes. If this was not you, do nothing; your password is unchanged.

73",
                );
            } catch (MailNotSent $e) {
                fail(502, 'This site could not send email just now', 'Tell the site operator.', $e->getMessage());
            }
        }
        ok(['sent' => true]);
    }

    case 'reset': {
        $b = body();
        $callsign = strtoupper(trim(str_of($b, 'callsign', 20)));
        $code = strtoupper(trim(str_of($b, 'code', 20)));
        $password = str_of($b, 'password', 200);
        if (strlen($password) < 8) {
            fail(400, 'The password needs at least 8 characters');
        }
        $find = $db->prepare('SELECT id, callsign, reset_hash, reset_expires, reset_attempts FROM users WHERE callsign = ?');
        $find->execute([$callsign]);
        $user = $find->fetch();
        $usable = $user && $user['reset_hash'] !== '' && (int) $user['reset_expires'] > time() && (int) $user['reset_attempts'] < RESET_ATTEMPTS;
        if (!$usable || !password_verify($code, $user['reset_hash'])) {
            if ($user) {
                // Five wrong guesses burn the code: eight friendly characters carry
                // enough entropy only while guessing stays this expensive.
                $burn = $usable && (int) $user['reset_attempts'] + 1 >= RESET_ATTEMPTS;
                $db->prepare('UPDATE users SET reset_attempts = reset_attempts + 1' . ($burn ? ", reset_hash = ''" : '') . ' WHERE id = ?')
                    ->execute([$user['id']]);
            }
            fail(401, 'Wrong or expired code', 'Ask for a fresh one if it keeps failing.');
        }
        $db->prepare("UPDATE users SET password_hash = ?, reset_hash = '', reset_expires = 0, reset_attempts = 0, failed_logins = 0 WHERE id = ?")
            ->execute([password_hash($password, PASSWORD_DEFAULT), $user['id']]);
        signIn((int) $user['id'], $user['callsign']);
    }

    // ---- the visitor's own shelf ----
    case 'save': {
        $uid = userId();
        $b = body();
        $kind = str_of($b, 'kind', 32);
        if (!in_array($kind, KINDS, true)) {
            fail(400, 'Unknown kind of item', 'This store keeps: ' . implode(', ', KINDS) . '.');
        }
        $name = trim(str_of($b, 'name', 120));
        if ($name === '') {
            fail(400, 'The item needs a name');
        }
        $summary = trim(str_of($b, 'summary', 300));
        $payload = str_of($b, 'payload', MAX_PAYLOAD_BYTES);
        if (json_decode($payload) === null) {
            fail(400, 'The payload is not JSON');
        }
        $cc0 = ($b['cc0'] ?? false) === true;
        $public = ($b['public'] ?? false) === true;
        if ($public && !$cc0) {
            fail(400, 'Sharing needs the CC0 dedication', 'Only measurements given to the public domain can be offered to everyone.');
        }
        $now = time();
        // The same name saves over itself: "Ferrite Core A, again" means an update.
        $existing = $db->prepare('SELECT id FROM items WHERE user_id = ? AND kind = ? AND name = ?');
        $existing->execute([$uid, $kind, $name]);
        $id = $existing->fetchColumn();
        if ($id !== false) {
            $db->prepare('UPDATE items SET summary = ?, payload = ?, is_public = ?, cc0 = ?, updated_at = ? WHERE id = ? AND user_id = ?')
                ->execute([$summary, $payload, $public ? 1 : 0, $cc0 ? 1 : 0, $now, $id, $uid]);
            ok(['id' => (int) $id, 'updated' => true]);
        }
        $db->prepare('INSERT INTO items (user_id, kind, name, summary, payload, is_public, cc0, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            ->execute([$uid, $kind, $name, $summary, $payload, $public ? 1 : 0, $cc0 ? 1 : 0, $now, $now]);
        ok(['id' => (int) $db->lastInsertId(), 'updated' => false]);
    }

    case 'share': {
        $uid = userId();
        $b = body();
        $itemId = $b['id'] ?? null;
        $public = ($b['public'] ?? false) === true;
        if (!is_int($itemId)) {
            fail(400, 'Bad field: id');
        }
        if ($public && ($b['cc0'] ?? false) !== true) {
            fail(400, 'Sharing needs the CC0 dedication', 'Only measurements given to the public domain can be offered to everyone.');
        }
        // Two plain statements, not a CASE on a bound parameter: PDO binds integers as
        // strings, and SQLite says '1' = 1 is false where MySQL would coerce - a CASE
        // here once left cc0 unset and the shared item invisible.
        $update = $public
            ? $db->prepare('UPDATE items SET is_public = 1, cc0 = 1, updated_at = ? WHERE id = ? AND user_id = ?')
            : $db->prepare('UPDATE items SET is_public = 0, updated_at = ? WHERE id = ? AND user_id = ?');
        $update->execute([time(), $itemId, $uid]);
        if ($update->rowCount() === 0) {
            fail(404, 'No such item of yours');
        }
        ok(['id' => $itemId, 'public' => $public]);
    }

    case 'delete': {
        $uid = userId();
        $b = body();
        $itemId = $b['id'] ?? null;
        if (!is_int($itemId)) {
            fail(400, 'Bad field: id');
        }
        $remove = $db->prepare('DELETE FROM items WHERE id = ? AND user_id = ?');
        $remove->execute([$itemId, $uid]);
        ok(['deleted' => $remove->rowCount() > 0]);
    }

    case 'mine': {
        $uid = userId();
        $list = $db->prepare('SELECT id, kind, name, summary, is_public, updated_at FROM items WHERE user_id = ? ORDER BY updated_at DESC');
        $list->execute([$uid]);
        ok(['items' => array_map(static fn (array $r) => [
            'id' => (int) $r['id'], 'kind' => $r['kind'], 'name' => $r['name'], 'summary' => $r['summary'],
            'public' => (bool) $r['is_public'], 'updatedAt' => (int) $r['updated_at'],
        ], $list->fetchAll())]);
    }

    // ---- what the community shares; no account needed to look ----
    case 'browse': {
        $kind = is_string($_GET['kind'] ?? null) ? $_GET['kind'] : KINDS[0];
        if (!in_array($kind, KINDS, true)) {
            fail(400, 'Unknown kind of item');
        }
        $list = $db->prepare('SELECT items.id, items.name, items.summary, items.updated_at, users.callsign
            FROM items JOIN users ON users.id = items.user_id
            WHERE items.kind = ? AND items.is_public = 1 AND items.cc0 = 1
            ORDER BY items.updated_at DESC LIMIT ' . BROWSE_LIMIT);
        $list->execute([$kind]);
        ok(['items' => array_map(static fn (array $r) => [
            'id' => (int) $r['id'], 'name' => $r['name'], 'summary' => $r['summary'],
            'callsign' => $r['callsign'], 'updatedAt' => (int) $r['updated_at'],
        ], $list->fetchAll())]);
    }

    case 'fetch': {
        $itemId = (int) ($_GET['id'] ?? 0);
        $find = $db->prepare('SELECT items.*, users.callsign FROM items JOIN users ON users.id = items.user_id WHERE items.id = ?');
        $find->execute([$itemId]);
        $item = $find->fetch();
        $mine = $item && is_int($_SESSION['uid'] ?? null) && (int) $item['user_id'] === $_SESSION['uid'];
        if (!$item || (!$mine && !((int) $item['is_public'] === 1 && (int) $item['cc0'] === 1))) {
            fail(404, 'No such shared item');
        }
        ok([
            'id' => (int) $item['id'], 'kind' => $item['kind'], 'name' => $item['name'], 'summary' => $item['summary'],
            'callsign' => $item['callsign'], 'payload' => $item['payload'], 'cc0' => (bool) $item['cc0'],
            'public' => (bool) $item['is_public'], 'updatedAt' => (int) $item['updated_at'],
        ]);
    }
}

fail(500, 'Unhandled operation');
