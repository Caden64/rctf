#!/usr/bin/env python3
"""XWEB-500 supervisor portal — lab-authored training fixture (original work).

This is a deliberately small, auditable web application that reproduces the
*class* of bug described in the public XWEB-500 advisories (documented default
credentials and an unauthenticated SQL-injection surface) inside a disposable
rCTF Firecracker microVM. It is not a copy of any vendor firmware.

Layout
------
/app/xweb_common.py   this file: HTTP service, theme, sessions, DB bootstrap
/app/xweb_auth.py     the query seam, staged at build time from exactly ONE of:
                        app/xweb_auth_vuln.py     (string-concatenated SQL)
                        app/xweb_auth_patched.py  (parameterized queries only)

The flag arrives only through MMDS: /rctf/init writes it to
$RCTF_FLAGS_DIR/<sanitised provider> (tmpfs) and this program inserts it into
the service-notes table at boot. The provider name depends on who provisioned
the instance: the lab runner registers flags under the provider "main", while
the platform resolves the challenge's registered flag entry — for this
challenge `{provider: "flags/static"}` — and the guest init sanitises the
provider name (`[^A-Za-z0-9._-]` -> "_"), so the platform-delivered flag
lands at "flags_static". resolve_flag_path() accepts both delivery names,
then falls back to the single file in the flags directory when exactly one
exists; an ambiguous or empty directory boots the portal flagless. The
database lives on tmpfs (/run) and the flag never touches the ext4 rootfs.

Every page carries the machine-readable marker ids used by the runner:
xweb-login / xweb-dashboard / xweb-service / xweb-archive / xweb-denied /
xweb-sqlerror / xweb-empty, plus the build comment:
    <!-- xweb build: IMAGE=<image> stack=<python> auth=<mode> -->
"""
import html
import http.cookies
import os
import secrets
import sqlite3
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# The query seam. The image build stages exactly one variant as xweb_auth.py
# and build.sh asserts which one is present in each image.
from xweb_auth import AUTH_MODE, XwebSqlError, find_user, search_archive  # noqa: E402

APP_NAME = 'XWEB-500'
FIRMWARE = 'FW 5.00.10'
PORT = int(os.environ.get('XWEB_PORT', '8080'))
DB_PATH = os.environ.get('XWEB_DB', '/run/xweb/portal.db')
FLAGS_DIR = os.environ.get('RCTF_FLAGS_DIR', '/run/rctf/flags')
INSTANCE_ID = os.environ.get('RCTF_INSTANCE_ID', 'xweb-unknown-node')
BUILD_IMAGE = 'unknown'
# The guest records its build identity in /etc/xweb-build (written by build.sh);
# XWEB_BUILD_FILE lets the unprivileged host selftest point at a temp copy
# instead of touching the host's /etc.
BUILD_FILE = os.environ.get('XWEB_BUILD_FILE', '/etc/xweb-build')
try:
    with open(BUILD_FILE, encoding='utf-8') as _bf:
        for _line in _bf:
            if _line.startswith('IMAGE='):
                BUILD_IMAGE = _line.split('=', 1)[1].strip()
except OSError:
    pass
STACK = 'python3-stdlib-sqlite3'

SESSIONS = {}
SESSIONS_LOCK = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    role TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cold_rooms (
    room_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    setpoint_c REAL NOT NULL,
    return_c REAL NOT NULL,
    defrost TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    event_id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    label TEXT NOT NULL,
    detail TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS service_notes (
    note_id INTEGER PRIMARY KEY,
    created TEXT NOT NULL,
    author TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL
);
"""

# --- themed seed data (original text, no vendor material) --------------------
SEED_USERS = [
    # the documented XWEB-500 factory default, inserted FIRST: the classic
    # ' OR 1=1-- bypass matches the first row of this table.
    ('admin', '1234', 'administrator'),
    ('storeops', 'xweb500-storeops', 'cold-store operator'),
]

SEED_ROOMS = [
    ('COLD ROOM 01 · FROZEN', -18.0, -17.4, 'IDLE'),
    ('COLD ROOM 02 · CHILL', 2.0, 2.6, 'IDLE'),
    ('CASE LINE A · DISPLAY', -2.0, -1.1, 'DEFROST 04:12'),
    ('CASE LINE B · DISPLAY', -2.0, 1.9, 'HIGH RETURN'),
    ('BLAST CELL 01', -28.0, -26.8, 'IDLE'),
    ('ANTE-ROOM · AMBIENT', 8.0, 9.4, 'IDLE'),
]

SEED_EVENTS = [
    ('2026-11-12 03:10', 'DEFROST', 'Case line A defrost cycle complete (21 min)'),
    ('2026-11-12 04:44', 'DOOR', 'Cold room 01 door held open 02:11 — high-temp watch'),
    ('2026-11-12 05:02', 'ALARM', 'Case line B return temperature above cut-in (+1.9 C)'),
    ('2026-11-12 05:03', 'COMPRESSOR', 'Rack 1 stage 2 cut-in, suction -12.4 C'),
    ('2026-11-12 07:30', 'SENSOR', 'Return probe R-12 recalibrated, offset -0.2 C'),
    ('2026-11-12 09:15', 'SERVICE', 'Condenser coil cleaning scheduled, ticket 4471'),
    ('2026-11-12 11:58', 'DEFROST', 'Cold room 02 defrost terminated on time limit'),
    ('2026-11-12 12:40', 'POWER', 'Supply phase L2 dip 186 V for 00:03, rack stable'),
]

SEED_NOTES = [
    ('2026-10-02', 'commissioning',
     'Commissioning checklist 4471-A',
     'Rack, cases and cold rooms verified against the store drawing. Setpoints '
     'as per commissioning sheet; no customer-specific macros loaded.'),
    ('2026-10-19', 'field-service',
     'Weekly condenser service',
     'Coils cleaned, fan bearings inspected. Next service window in four '
     'weeks; keep the grilles unobstructed.'),
    ('2026-11-08', 'factory',
     'Firmware and web portal audit note',
     'Portal firmware 5.00.10 audited against the advisory checklist. '
     'Operator console and diagnostics archive reviewed with the store '
     'manager.'),
]

FLAG_NOTE_TITLE = 'Service note 07 — factory maintenance override'


# Flag delivery names (MMDS provider names sanitised by /rctf/init):
#   main          the lab runner's provider name (lab path)
#   flags_static  the platform's registered provider `flags/static` for this
#                 challenge, sanitised (`/` -> `_`) by the guest init
FLAG_PROVIDER_MAIN = 'main'
FLAG_PROVIDER_PLATFORM = 'flags_static'


def resolve_flag_path():
    """Pick the flag file for this boot, or None for a flagless boot.

    Order: the lab provider name, then the platform provider name, then the
    single file in the flags directory when exactly one exists. Two or more
    unrecognised files are ambiguous and boot flagless (fail-closed, never a
    wrong flag).
    """
    for name in (FLAG_PROVIDER_MAIN, FLAG_PROVIDER_PLATFORM):
        path = os.path.join(FLAGS_DIR, name)
        if os.path.isfile(path):
            return path
    try:
        entries = sorted(os.listdir(FLAGS_DIR))
    except OSError:
        return None
    files = [e for e in entries
             if os.path.isfile(os.path.join(FLAGS_DIR, e))]
    if len(files) == 1:
        return os.path.join(FLAGS_DIR, files[0])
    return None


def read_flag():
    """Return the per-run flag delivered by MMDS via tmpfs, or None."""
    path = resolve_flag_path()
    if path is None:
        return None
    try:
        with open(path, 'rb') as fh:
            return fh.read().decode('utf-8')
    except OSError:
        return None


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def bootstrap_database():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    os.makedirs(FLAGS_DIR, exist_ok=True)
    conn = db()
    try:
        conn.executescript(SCHEMA)
        conn.execute('DELETE FROM users')
        conn.executemany(
            'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
            SEED_USERS)
        conn.execute('DELETE FROM cold_rooms')
        conn.executemany(
            'INSERT INTO cold_rooms (name, setpoint_c, return_c, defrost) '
            'VALUES (?, ?, ?, ?)', SEED_ROOMS)
        conn.execute('DELETE FROM events')
        conn.executemany(
            'INSERT INTO events (ts, label, detail) VALUES (?, ?, ?)',
            SEED_EVENTS)
        conn.execute('DELETE FROM service_notes')
        conn.executemany(
            'INSERT INTO service_notes (created, author, title, body) '
            'VALUES (?, ?, ?, ?)', SEED_NOTES)
        flag = read_flag()
        if flag is not None:
            # The flag exists ONLY as this themed service-note row; it is read
            # from the MMDS-written tmpfs file and the DB itself is on tmpfs.
            conn.execute(
                'INSERT INTO service_notes (created, author, title, body) '
                'VALUES (?, ?, ?, ?)',
                ('2026-11-19', 'factory',
                 FLAG_NOTE_TITLE,
                 'Factory maintenance override code for this controller: '
                 + flag))
        conn.commit()
    finally:
        conn.close()
    return read_flag() is not None


# --- sessions ----------------------------------------------------------------
def session_user(token):
    if not token:
        return None
    with SESSIONS_LOCK:
        return SESSIONS.get(token)


def open_session(username):
    token = secrets.token_hex(16)
    with SESSIONS_LOCK:
        SESSIONS[token] = username
    return token


def drop_session(token):
    with SESSIONS_LOCK:
        SESSIONS.pop(token, None)


# --- theme (all original) ----------------------------------------------------
CSS = """
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #10161c; color: #c9d6df; font: 14px/1.45 system-ui,
  'Segoe UI', sans-serif; }
a { color: #7dfc8b; text-decoration: none; }
a:hover { text-decoration: underline; }
pre { font: 12px/1.4 ui-monospace, 'DejaVu Sans Mono', monospace; }
#xweb-wrap { max-width: 980px; margin: 0 auto; padding: 16px; }
#xweb-head { display: flex; align-items: center; gap: 14px; padding: 10px 14px;
  background: #16202a; border: 1px solid #24313d; border-radius: 6px; }
#xweb-logo { font: 700 20px ui-monospace, monospace; color: #53f06a;
  letter-spacing: 2px; border: 1px solid #2f6b3a; padding: 4px 10px;
  background: #0b2814; border-radius: 4px; }
#xweb-sub { color: #6f8291; font-size: 12px; }
#xweb-head-right { margin-left: auto; text-align: right; font-size: 12px; }
.xweb-led { color: #53f06a; }
.xweb-led-amber { color: #ffb347; }
#xweb-nav { display: flex; gap: 10px; margin: 10px 0; font-size: 13px; }
#xweb-nav span { padding: 4px 10px; background: #16202a;
  border: 1px solid #24313d; border-radius: 4px; }
#xweb-nav a { color: #c9d6df; }
.xweb-card { background: #16202a; border: 1px solid #24313d; border-radius: 6px;
  padding: 14px; margin: 10px 0; }
h2 { font-size: 15px; color: #7dfc8b; letter-spacing: 1px; margin-bottom: 8px;
  font-family: ui-monospace, monospace; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; color: #6f8291; font-weight: 600; border-bottom:
  1px solid #24313d; padding: 6px 8px; }
td { border-bottom: 1px solid #1c2833; padding: 6px 8px; vertical-align: top; }
.xweb-room { display: inline-block; width: 30%; min-width: 210px; margin: 4px;
  padding: 10px; background: #0d141b; border: 1px solid #24313d;
  border-radius: 4px; font-family: ui-monospace, monospace; }
.xweb-room .name { color: #ffb347; font-size: 12px; letter-spacing: 1px; }
.xweb-room .temp { color: #7dfc8b; font-size: 22px; margin: 4px 0; }
.xweb-room .meta { color: #6f8291; font-size: 11px; }
.xweb-form { display: inline-block; text-align: left; }
.xweb-form p { margin: 10px 0 4px; color: #6f8291; font-size: 12px; }
.xweb-form input { width: 260px; background: #0d141b; color: #7dfc8b;
  border: 1px solid #24313d; border-radius: 4px; padding: 8px;
  font: 13px ui-monospace, monospace; }
.xweb-btn { margin-top: 14px; background: #0b2814; color: #53f06a;
  border: 1px solid #2f6b3a; border-radius: 4px; padding: 9px 22px;
  font: 13px ui-monospace, monospace; letter-spacing: 1px; cursor: pointer; }
.xweb-btn:hover { background: #123f20; }
.xweb-note { color: #6f8291; font-size: 11px; margin-top: 12px; }
#xweb-denied { border: 1px solid #7a2f2f; background: #2a1113; color: #ff5c5c;
  padding: 12px 14px; border-radius: 4px; margin: 14px 0;
  font-family: ui-monospace, monospace; letter-spacing: 1px; }
#xweb-sqlerror { border: 1px solid #7a5a1f; background: #2a2011;
  color: #ffb347; padding: 12px 14px; border-radius: 4px; margin: 14px 0; }
#xweb-sqlerror pre { margin-top: 8px; color: #d8b36a; white-space: pre-wrap;
  word-break: break-all; }
#xweb-empty { color: #6f8291; font-style: italic; padding: 10px; }
#xweb-foot { margin: 18px 0 6px; color: #4d5e6b; font-size: 11px;
  font-family: ui-monospace, monospace; }
.flagcell { color: #53f06a; font-family: ui-monospace, monospace; }
"""


def build_comment():
    return ('<!-- xweb build: IMAGE=%s stack=%s auth=%s -->'
            % (html.escape(BUILD_IMAGE), STACK, html.escape(AUTH_MODE)))


def page(title, body, nav='', head_right=None):
    if nav:
        nav_html = '<nav id="xweb-nav">%s</nav>' % nav
    else:
        nav_html = ''
    right = head_right or ('Node: <span class="xweb-led">%s</span>'
                           % html.escape(INSTANCE_ID))
    return ('<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">'
            '\n<meta name="viewport" content="width=device-width, '
            'initial-scale=1">\n<title>%s · %s</title>\n<style>%s</style>\n'
            '</head>\n<body>\n%s\n<div id="xweb-wrap">\n'
            '<div id="xweb-head">\n<div id="xweb-logo">%s</div>\n'
            '<div><div id="xweb-sub">Refrigeration Supervisor Portal</div>'
            '<div id="xweb-sub">Web console · %s · WEB-IO FIRMWARE</div></div>\n'
            '<div id="xweb-head-right">%s</div>\n</div>\n%s\n%s\n'
            '<div id="xweb-foot">%s · %s · WEB-IO FIRMWARE · '
            'training fixture, not a vendor product</div>\n</div>\n</body>\n'
            '</html>\n'
            % (html.escape(title), APP_NAME, CSS, build_comment(), APP_NAME,
               FIRMWARE, right, nav_html, body, APP_NAME, FIRMWARE))


def head_status(username=None):
    if username:
        return ('Operator: <span class="xweb-led">%s</span> · '
                'Node: <span class="xweb-led">%s</span>'
                % (html.escape(username), html.escape(INSTANCE_ID)))
    return ('Node: <span class="xweb-led">%s</span>'
            % html.escape(INSTANCE_ID))


def login_page(err_kind=None, err_text=None):
    rooms = ''.join(
        '<div class="xweb-room"><div class="name">%s</div>'
        '<div class="temp">%+.1f&deg;C</div>'
        '<div class="meta">set %+.1f · ret %+.1f · %s</div></div>'
        % (html.escape(r[0]), r[2], r[1], r[2], html.escape(r[3]))
        for r in SEED_ROOMS[:3])
    banner = ''
    if err_kind == 'denied':
        banner = ('<div id="xweb-denied">ACCESS DENIED — invalid operator '
                  'credentials for this console.</div>')
    elif err_kind == 'sqlerror':
        banner = ('<div id="xweb-sqlerror"><b>FIRMWARE SQL FAULT</b> — the '
                  'diagnostics layer could not complete the query.'
                  '<pre>%s</pre></div>' % html.escape(err_text or ''))
    body = ('<div class="xweb-card" id="xweb-login">\n<h2>OPERATOR ACCESS'
            '</h2>\n%s\n<form class="xweb-form" method="POST" action="/login">'
            '\n<p>OPERATOR NAME</p>\n<input name="username" autofocus>'
            '\n<p>ACCESS CODE</p>\n<input name="password" type="password">'
            '\n<br/><button class="xweb-btn" type="submit">OPEN CONSOLE'
            '</button>\n</form>\n'
            '<div class="xweb-note">Factory default credentials are listed on '
            'the commissioning sheet shipped with the controller. Lost codes '
            'require a site visit.</div>\n</div>\n'
            '<div class="xweb-card">\n<h2>PLANT OVERVIEW</h2>\n%s\n</div>\n'
            % (banner, rooms))
    return page('Operator login', body, head_right=head_status())


def dashboard_page(username):
    conn = db()
    try:
        rooms = conn.execute('SELECT name, setpoint_c, return_c, defrost '
                             'FROM cold_rooms ORDER BY room_id').fetchall()
        events = conn.execute('SELECT ts, label, detail FROM events '
                               'ORDER BY event_id DESC LIMIT 8').fetchall()
    finally:
        conn.close()
    rooms_html = ''.join(
        '<div class="xweb-room"><div class="name">%s</div>'
        '<div class="temp">%+.1f&deg;C</div>'
        '<div class="meta">set %+.1f · ret %+.1f · %s</div></div>'
        % (html.escape(r['name']), r['return_c'], r['setpoint_c'],
           r['return_c'], html.escape(r['defrost']))
        for r in rooms)
    events_html = ''.join(
        '<tr><td>%s</td><td>%s</td><td>%s</td></tr>'
        % (html.escape(e['ts']), html.escape(e['label']),
           html.escape(e['detail']))
        for e in events)
    body = ('<div class="xweb-card" id="xweb-dashboard">\n<h2>COLD ROOMS &amp;'
            ' CASES</h2>\n%s\n</div>\n'
            '<div class="xweb-card">\n<h2>ALARM &amp; EVENT LOG</h2>\n'
            '<table><tr><th>time</th><th>kind</th><th>detail</th></tr>\n%s'
            '\n</table>\n</div>\n' % (rooms_html, events_html))
    nav = ('<a href="/dashboard">Dashboard</a> · '
           '<a href="/service">Service notes</a> · '
           '<a href="/archive">Archive</a> · '
           '<a href="/logout">Logout</a>')
    return page('Dashboard', body, nav=nav,
                head_right=head_status(username))


def service_page(username):
    conn = db()
    try:
        notes = conn.execute('SELECT created, author, title, body '
                             'FROM service_notes ORDER BY note_id').fetchall()
    finally:
        conn.close()
    rows = ''.join(
        '<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>'
        % (html.escape(n['created']), html.escape(n['author']),
           html.escape(n['title']), html.escape(n['body']))
        for n in notes)
    body = ('<div class="xweb-card" id="xweb-service">\n<h2>SYSTEM / SERVICE '
            'NOTES</h2>\n<p class="xweb-note">Maintenance records kept by the '
            'factory service tool. Visible to the administrator account '
            'only.</p>\n<table><tr><th>created</th><th>author</th>'
            '<th>title</th><th>note</th></tr>\n%s\n</table>\n</div>\n' % rows)
    nav = ('<a href="/dashboard">Dashboard</a> · <b>Service notes</b> · '
           '<a href="/archive">Archive</a> · <a href="/logout">Logout</a>')
    return page('Service notes', body, nav=nav,
                head_right=head_status(username))


def forbidden_page(username):
    body = ('<div id="xweb-denied">ACCESS DENIED — service notes are '
            'restricted to the administrator account.</div>')
    return page('Access denied', body,
                nav='<a href="/dashboard">Dashboard</a>',
                head_right=head_status(username))


def archive_page(rows, probe):
    if rows:
        rows_html = ''.join(
            '<tr><td>%s</td><td>%s</td><td class="flagcell">%s</td></tr>'
            % (html.escape(r[0]), html.escape(r[1]), html.escape(r[2]))
            for r in rows)
        table = ('<table><tr><th>time</th><th>kind</th><th>detail</th></tr>'
                 '\n%s\n</table>' % rows_html)
    else:
        table = '<div id="xweb-empty">no matching records in the diagnostics ' \
                'archive</div>'
    body = ('<div class="xweb-card" id="xweb-archive">\n<h2>DIAGNOSTICS '
            'ARCHIVE — PUBLIC VIEW</h2>\n<p class="xweb-note">Read-only event '
            'archive exposed for remote assistance. Filter text is applied to '
            'both the event kind and detail.</p>\n'
            '<form method="GET" action="/archive" class="xweb-form">'
            '\n<p>FILTER</p>\n<input name="probe" value="%s">'
            '\n<br/><button class="xweb-btn" type="submit">APPLY FILTER'
            '</button>\n</form>\n%s\n</div>\n'
            % (html.escape(probe or ''), table))
    return page('Diagnostics archive', body, head_right=head_status())


def sql_error_page(exc):
    body = ('<div class="xweb-card" id="xweb-archive">\n<h2>DIAGNOSTICS '
            'ARCHIVE — PUBLIC VIEW</h2>\n'
            '<div id="xweb-sqlerror"><b>FIRMWARE SQL FAULT</b> — the '
            'diagnostics layer could not complete the filter query.\n'
            '<pre>query: %s\nsqlite: %s</pre></div>\n</div>\n'
            % (html.escape(exc.sql), html.escape(exc.detail)))
    return page('Diagnostics archive', body, head_right=head_status())


def not_found_page():
    body = ('<div class="xweb-card" id="xweb-notfound">\n<h2>NO SUCH PAGE'
            '</h2>\n<p class="xweb-note">The requested console page does not '
            'exist on this controller.</p>\n</div>')
    return page('Not found', body)


# --- HTTP service -------------------------------------------------------------
class PortalHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'XWEB500'
    sys_version = FIRMWARE

    def log_message(self, fmt, *args):  # keep the serial console quiet
        pass

    # -- helpers --
    def send_html(self, status, text, headers=()):
        data = text.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('X-XWEB-Firmware', FIRMWARE)
        for key, value in headers:
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def redirect(self, location, headers=()):
        self.send_response(302)
        self.send_header('Location', location)
        self.send_header('Content-Length', '0')
        for key, value in headers:
            self.send_header(key, value)
        self.end_headers()

    def cookie_token(self):
        raw = self.headers.get('Cookie', '')
        try:
            jar = http.cookies.SimpleCookie(raw)
        except http.cookies.CookieError:
            return None
        morsel = jar.get('xwebsess')
        return morsel.value if morsel else None

    def read_form(self):
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = 0
        if length <= 0 or length > 65536:
            return {}
        body = self.rfile.read(length).decode('utf-8', 'replace')
        parsed = urllib.parse.parse_qs(body, keep_blank_values=True)
        return {k: v[0] for k, v in parsed.items() if v}

    # -- routes --
    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        path = url.path
        if path == '/':
            token = self.cookie_token()
            if session_user(token):
                self.redirect('/dashboard')
            else:
                self.send_html(200, login_page())
            return
        if path == '/dashboard':
            token = self.cookie_token()
            username = session_user(token)
            if not username:
                self.redirect('/')
                return
            self.send_html(200, dashboard_page(username))
            return
        if path == '/service':
            token = self.cookie_token()
            username = session_user(token)
            if not username:
                self.redirect('/')
                return
            if username != 'admin':
                self.send_html(403, forbidden_page(username))
                return
            self.send_html(200, service_page(username))
            return
        if path == '/archive':
            query = urllib.parse.parse_qs(url.query, keep_blank_values=True)
            probe = query.get('probe', [None])[0]
            if probe is None:
                conn = db()
                try:
                    rows = conn.execute(
                        'SELECT ts, label, detail FROM events '
                        'ORDER BY event_id DESC LIMIT 12').fetchall()
                    rows = [(r['ts'], r['label'], r['detail'])
                            for r in rows]
                finally:
                    conn.close()
                self.send_html(200, archive_page(rows, ''))
                return
            conn = db()
            try:
                rows = search_archive(conn, probe)
            except XwebSqlError as exc:
                self.send_html(200, sql_error_page(exc))
                return
            finally:
                conn.close()
            self.send_html(200, archive_page(rows, probe))
            return
        if path == '/logout':
            token = self.cookie_token()
            if token:
                drop_session(token)
            self.redirect('/', headers=[
                ('Set-Cookie', 'xwebsess=; Path=/; Max-Age=0')])
            return
        self.send_html(404, not_found_page())

    def do_POST(self):
        url = urllib.parse.urlsplit(self.path)
        if url.path != '/login':
            self.send_html(404, not_found_page())
            return
        form = self.read_form()
        username = form.get('username', '')
        password = form.get('password', '')
        conn = db()
        try:
            try:
                row = find_user(conn, username, password)
            except XwebSqlError as exc:
                self.send_html(200, login_page(err_kind='sqlerror',
                                               err_text='%s\nsqlite: %s'
                                               % (exc.sql, exc.detail)))
                return
        finally:
            conn.close()
        if row is None:
            self.send_html(200, login_page(err_kind='denied'))
            return
        matched = row[1]
        token = open_session(matched)
        self.redirect('/dashboard', headers=[
            ('Set-Cookie',
             'xwebsess=%s; Path=/; HttpOnly' % token)])


def main():
    have_flag = bootstrap_database()
    print('xweb portal: image=%s auth=%s db=%s port=%d flag=%s'
          % (BUILD_IMAGE, AUTH_MODE, DB_PATH, PORT,
             'present' if have_flag else 'absent'), flush=True)
    server = ThreadingHTTPServer(('0.0.0.0', PORT), PortalHandler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == '__main__':
    main()
