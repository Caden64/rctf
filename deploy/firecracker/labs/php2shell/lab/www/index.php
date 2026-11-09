<?php
/*
 * PHP2Shell training-lab landing page.
 *
 * The session.upload_progress chain does not need this page to call
 * session_start(): the session is initialized by the multipart parser before
 * RINIT. Calling session_start() unconditionally on the POST is actively
 * harmful: it re-sends the session cookie and PHP removes the earlier
 * Set-Cookie header, which is exactly the stage-1 leak channel. So the page
 * starts a session for ordinary GET visitors (a normal session-using page)
 * and leaves the multipart POST path untouched.
 *
 * The flag is placed at /www/flag.txt by /app/start from the Firecracker
 * MMDS tmpfs, so the lab objective is "use the chain to read the flag"; the
 * runner's proof is stronger and simpler: it executes `id>/www/p` and asserts
 * the Apache worker uid.
 */
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET' && session_status() === PHP_SESSION_NONE) {
    session_start();
}
header('Content-Type: text/plain; charset=utf-8');
echo "OK\n";
echo 'PHP ' . PHP_VERSION . "\n";
