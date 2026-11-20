"""XWEB-500 query seam — PATCHED control build.

Identical portal theme and content, but every query binds request values as
SQL parameters (`?` placeholders with a parameter tuple), so operator names
and archive filters can only ever be *data*. This is the patched reference
image: the documented default credentials still work (that is a separate
advisory, addressed by credential rotation, not by this build) while every
injection payload fails closed as a literal no-match.
"""

AUTH_MODE = 'parameterized'


class XwebSqlError(Exception):
    """Kept for interface parity; this build never raises it."""

    def __init__(self, sql, detail):
        super().__init__(detail)
        self.sql = sql
        self.detail = detail


def find_user(conn, username, password):
    """Login lookup. XWEB-AUTH-PATCHED: parameterized query only."""
    return conn.execute(
        "SELECT id, username FROM users"
        " WHERE username = ? AND password = ?",
        (username, password)).fetchone()


def search_archive(conn, probe):
    """Diagnostics archive filter. XWEB-AUTH-PATCHED: bound LIKE pattern."""
    pattern = '%' + probe + '%'
    rows = conn.execute(
        "SELECT ts, label, detail FROM events"
        " WHERE label LIKE ? OR detail LIKE ?"
        " ORDER BY ts",
        (pattern, pattern)).fetchall()
    return [tuple(r) for r in rows]
