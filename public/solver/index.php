<?php
/**
 * EMWS solver proxy.
 *
 * The browser cannot reach a NEC service on the network directly: a page's security
 * policy blocks other origins, and an HTTPS page may not call a plain HTTP one at all.
 * This forwards those requests from the web server instead, so to the browser the solver
 * looks like part of this site.
 *
 * It is NOT a general proxy: the destination comes from the server's own configuration
 * and is never taken from the request. Set it with an environment variable on the site
 * (IIS: FastCGI environment variables, or the site's app settings):
 *
 *     EMWS_SOLVER_URL      http://192.168.0.124:8073   (default)
 *     EMWS_SOLVER_TOKEN    optional, sent as Authorization: Bearer <token>
 *     EMWS_SOLVER_TIMEOUT  seconds to wait for a solve (default 300)
 *
 * Public domain (The Unlicense), like the rest of EMWS. By ZR1JT.
 */

declare(strict_types=1);

const DEFAULT_SOLVER_URL = 'http://192.168.0.124:8073';
const DEFAULT_TIMEOUT_SECONDS = 300;
const CONNECT_TIMEOUT_SECONDS = 5;
/** Refuse anything larger, rather than tie the server up with it. */
const MAX_BODY_BYTES = 33554432; // 32 MiB

header('Cache-Control: no-store');
header('Content-Type: application/json');

/** Reads a setting from the environment, however this server chooses to pass it along. */
function setting(string $name, string $fallback): string
{
    foreach ([getenv($name), $_SERVER[$name] ?? null, $_ENV[$name] ?? null] as $value) {
        if (is_string($value) && trim($value) !== '') {
            return trim($value);
        }
    }
    return $fallback;
}

/**
 * The browser is told what went wrong, never where. The solver's address is the site
 * operator's business: it goes to the server's log, so they can find the fault, and not
 * over the wire, so a visitor cannot map the network behind this site.
 */
function fail(int $status, string $error, string $detail = '', string $private = ''): never
{
    if ($private !== '') {
        error_log('EMWS solver proxy: ' . $error . ' - ' . $private);
    }
    http_response_code($status);
    echo json_encode(['error' => $error, 'detail' => $detail], JSON_UNESCAPED_SLASHES);
    exit;
}

$operations = ['health' => 'GET', 'solve' => 'POST', 'solve-batch' => 'POST'];
$op = isset($_GET['op']) && is_string($_GET['op']) ? $_GET['op'] : 'health';
if (!array_key_exists($op, $operations)) {
    fail(404, 'Unknown operation', 'Use ?op=health, ?op=solve or ?op=solve-batch.');
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}
if ($method !== $operations[$op]) {
    fail(405, 'Wrong method', sprintf('%s needs %s.', $op, $operations[$op]));
}

$target = rtrim(setting('EMWS_SOLVER_URL', DEFAULT_SOLVER_URL), '/');
$parts = parse_url($target);
if ($parts === false || !isset($parts['scheme'], $parts['host']) || !in_array($parts['scheme'], ['http', 'https'], true)) {
    fail(500, 'This site has no solver configured', 'Set EMWS_SOLVER_URL on the site to the address of a NEC solver.');
}

$body = '';
if ($method === 'POST') {
    $body = file_get_contents('php://input');
    if ($body === false) {
        fail(400, 'Could not read the request');
    }
    if (strlen($body) > MAX_BODY_BYTES) {
        fail(413, 'That model is too large to forward', sprintf('The limit is %d bytes.', MAX_BODY_BYTES));
    }
    if (json_decode($body) === null && json_last_error() !== JSON_ERROR_NONE) {
        fail(400, 'The request body is not JSON', json_last_error_msg());
    }
}

$timeout = (int) setting('EMWS_SOLVER_TIMEOUT', (string) DEFAULT_TIMEOUT_SECONDS);
if ($timeout < 1 || $timeout > 3600) {
    $timeout = DEFAULT_TIMEOUT_SECONDS;
}

$headers = ['Accept: application/json'];
if ($method === 'POST') {
    $headers[] = 'Content-Type: application/json';
}
$token = setting('EMWS_SOLVER_TOKEN', '');
if ($token !== '') {
    $headers[] = 'Authorization: Bearer ' . $token;
}

$url = $target . '/' . $op;
$started = microtime(true);

/**
 * cURL where it is available, PHP's own streams where it is not, so this works on a
 * plain PHP install without anyone having to enable an extension first.
 */
if (function_exists('curl_init')) {
    $curl = curl_init($url);
    curl_setopt_array($curl, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => CONNECT_TIMEOUT_SECONDS,
        CURLOPT_TIMEOUT => $timeout,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_HEADER => false,
    ]);
    if ($method === 'POST') {
        curl_setopt($curl, CURLOPT_POST, true);
        curl_setopt($curl, CURLOPT_POSTFIELDS, $body);
    }
    $response = curl_exec($curl);
    $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    $problem = curl_error($curl);
    $timedOut = curl_errno($curl) === CURLE_OPERATION_TIMEDOUT;
    curl_close($curl);
} else {
    $context = stream_context_create(['http' => [
        'method' => $method,
        'header' => implode("\r\n", $headers),
        'content' => $method === 'POST' ? $body : null,
        'timeout' => $timeout,
        'ignore_errors' => true,
        'follow_location' => 0,
    ]]);
    $response = @file_get_contents($url, false, $context);
    $status = 0;
    foreach ($http_response_header ?? [] as $line) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $found) === 1) {
            $status = (int) $found[1];
        }
    }
    $problem = $response === false ? (error_get_last()['message'] ?? 'no answer') : '';
    $timedOut = str_contains($problem, 'timed out');
}

$elapsedMs = (microtime(true) - $started) * 1000;

if ($response === false) {
    $seconds = $elapsedMs / 1000;
    fail(
        $timedOut ? 504 : 502,
        $timedOut ? 'This site’s solver did not answer in time' : 'This site’s solver is not answering',
        $timedOut
            ? sprintf('It was still working after %.0f seconds. Try a smaller model, or solve in your browser.', $seconds)
            : sprintf('Nothing answered at the configured address after %.1f seconds. It may be switched off.', $seconds),
        sprintf('%s (%s after %.0f ms)', $problem, $parts['host'], $elapsedMs)
    );
}

http_response_code($status === 0 ? 502 : $status);
echo $response;
