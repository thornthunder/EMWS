<?php
/**
 * A small SMTP client, so the community store can send password-reset codes.
 *
 * PHP's own mail() cannot speak authenticated SMTP on Windows, and the usual libraries
 * are LGPL - which a public-domain project does not ship. SMTP itself is a short
 * conversation, so it is spoken here directly:
 *
 *     EMWS_MAIL_DSN    smtp://host (STARTTLS when the server offers it, port 587)
 *                      smtps://host (TLS from the first byte, port 465)
 *                      a bare host name means smtp://host
 *     EMWS_MAIL_PORT   overrides the port
 *     EMWS_MAIL_USER   AUTH LOGIN account, if the server wants one
 *     EMWS_MAIL_PASS   its password
 *     EMWS_MAIL_FROM   the From address; defaults to EMWS_MAIL_USER when that is an
 *                      address, else emws@<this site's host>
 *
 * Only plain-text mail, one recipient, no attachments: all a reset code needs.
 *
 * Public domain (The Unlicense), like the rest of EMWS. By ZR1JT.
 */

declare(strict_types=1);

final class MailNotSent extends RuntimeException
{
}

function mailConfigured(): bool
{
    return setting('EMWS_MAIL_DSN') !== '';
}

function mailFrom(): string
{
    $from = setting('EMWS_MAIL_FROM');
    if ($from !== '') {
        return $from;
    }
    $user = setting('EMWS_MAIL_USER');
    if (filter_var($user, FILTER_VALIDATE_EMAIL)) {
        return $user;
    }
    $host = $_SERVER['HTTP_HOST'] ?? 'emws.local';
    return 'emws@' . preg_replace('/:\d+$/', '', $host);
}

/** One line (or multi-line reply) from the server; throws unless it starts with $expect. */
function smtpExpect($socket, string $expect, string $doing): string
{
    $all = '';
    for (;;) {
        $line = fgets($socket, 2048);
        if ($line === false) {
            throw new MailNotSent("no answer while $doing");
        }
        $all .= $line;
        if (!preg_match('/^\d{3}-/', $line)) {
            break;
        }
    }
    if (!str_starts_with($all, $expect)) {
        throw new MailNotSent("$doing: " . trim($all));
    }
    return $all;
}

function smtpSay($socket, string $line, string $expect, string $doing): string
{
    fwrite($socket, $line . "\r\n");
    return smtpExpect($socket, $expect, $doing);
}

/** Sends one plain-text mail, or throws MailNotSent with a detail for the server log. */
function sendMail(string $to, string $subject, string $body): void
{
    $dsn = setting('EMWS_MAIL_DSN');
    if ($dsn === '') {
        throw new MailNotSent('EMWS_MAIL_DSN is not set');
    }
    if (!str_contains($dsn, '://')) {
        $dsn = 'smtp://' . $dsn;
    }
    $parts = parse_url($dsn);
    $host = $parts['host'] ?? '';
    if ($host === '' || !in_array($parts['scheme'] ?? '', ['smtp', 'smtps'], true)) {
        throw new MailNotSent("EMWS_MAIL_DSN is not usable: $dsn");
    }
    $implicitTls = ($parts['scheme'] ?? '') === 'smtps';
    $port = (int) (setting('EMWS_MAIL_PORT') ?: ($parts['port'] ?? ($implicitTls ? 465 : 587)));

    $socket = @stream_socket_client(($implicitTls ? 'tls://' : 'tcp://') . $host . ':' . $port, $errno, $error, 10);
    if ($socket === false) {
        throw new MailNotSent("could not reach $host:$port - $error");
    }
    stream_set_timeout($socket, 15);
    try {
        smtpExpect($socket, '220', 'greeting');
        $me = preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'] ?? 'emws.local');
        $hello = smtpSay($socket, "EHLO $me", '250', 'EHLO');

        if (!$implicitTls && stripos($hello, 'STARTTLS') !== false) {
            smtpSay($socket, 'STARTTLS', '220', 'STARTTLS');
            if (!stream_socket_enable_crypto($socket, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
                throw new MailNotSent('TLS negotiation failed');
            }
            $hello = smtpSay($socket, "EHLO $me", '250', 'EHLO after STARTTLS');
        }

        $user = setting('EMWS_MAIL_USER');
        if ($user !== '') {
            smtpSay($socket, 'AUTH LOGIN', '334', 'AUTH LOGIN');
            smtpSay($socket, base64_encode($user), '334', 'AUTH username');
            smtpSay($socket, base64_encode(setting('EMWS_MAIL_PASS')), '235', 'AUTH password');
        }

        $from = mailFrom();
        smtpSay($socket, "MAIL FROM:<$from>", '250', 'MAIL FROM');
        smtpSay($socket, "RCPT TO:<$to>", '250', 'RCPT TO');
        smtpSay($socket, 'DATA', '354', 'DATA');

        $headers = [
            "From: EMWS community store <$from>",
            "To: <$to>",
            'Subject: ' . $subject,
            'Date: ' . date(DATE_RFC2822),
            'Message-ID: <' . bin2hex(random_bytes(12)) . '@' . $me . '>',
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
        ];
        // CRLF everywhere, and a line of the body may not begin with the terminating dot.
        $text = implode("\r\n", $headers) . "\r\n\r\n" . preg_replace('/^\./m', '..', str_replace(["\r\n", "\n"], ["\n", "\r\n"], $body));
        smtpSay($socket, $text . "\r\n.", '250', 'message body');
        smtpSay($socket, 'QUIT', '221', 'QUIT');
    } finally {
        fclose($socket);
    }
}
