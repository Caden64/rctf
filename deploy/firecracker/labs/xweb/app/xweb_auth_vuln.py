"""XWEB-500 query seam — VULNERABLE build (the lab's bug).

This module reproduces the class of defect described in the public XWEB-500
advisories: query text is assembled with string concatenation from
request-controlled values, so a crafted operator name or archive filter
changes the meaning of the SQL itself.

Two unauthenticated surfaces are injectable here:
  * POST /login  -> find_user(username, password)
  * GET  /archive?probe=... -> search_archive(probe)

SQL faults are reported to the caller as XwebSqlError, which the portal
renders as a firmware-style debug page (as an unpatched appliance would).
"""

AUTH_MODE = 'concat'


class XwebSqlError(Exception):
    """A SQLite fault caught while running a request-built query."""

    def __init__(self, sql, detail):
        super().__init__(detail)
        self.sql = sql
        self.detail = detail


def find_user(conn, username, password):
    """Login lookup. XWEB-AUTH-VULN: SQL built by string concatenation."""
    sql = ("SELECT id, username FROM users"
           " WHERE username = '" + username +
           "' AND password = '" + password + "'")
    try:
        return conn.execute(sql).fetchone()
    except Exception as exc:  # sqlite3.Error, deliberately reported up
        raise XwebSqlError(sql, str(exc)) from exc


def search_archive(conn, probe):
    """Diagnostics archive filter. XWEB-AUTH-VULN: concatenated LIKE."""
    sql = ("SELECT ts, label, detail FROM events"
           " WHERE label LIKE '%" + probe +
           "%' OR detail LIKE '%" + probe + "%'"
           " ORDER BY ts")
    try:
        rows = conn.execute(sql).fetchall()
    except Exception as exc:  # sqlite3.Error, deliberately reported up
        raise XwebSqlError(sql, str(exc)) from exc
    return [tuple(r) for r in rows]
