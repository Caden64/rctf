#!/usr/bin/env python3
"""'Upstream' HTTP + hold servers for the edge test, run in its own netns."""
import argparse
import socket
import threading
import time

BODY = b"upstream-ok\n"


def http_server(port: int) -> None:
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("0.0.0.0", port))
    srv.listen(64)
    while True:
        conn, _ = srv.accept()
        try:
            conn.settimeout(2)
            conn.recv(4096)
            conn.sendall(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n"
                b"Content-Length: " + str(len(BODY)).encode() + b"\r\n"
                b"Connection: close\r\n\r\n" + BODY
            )
        except OSError:
            pass
        finally:
            conn.close()


def hold_server(port: int) -> None:
    """Accept a connection and keep it open until the peer goes away."""
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("0.0.0.0", port))
    srv.listen(64)
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=_hold, args=(conn,), daemon=True).start()


def _hold(conn: socket.socket) -> None:
    try:
        conn.settimeout(120)
        while True:
            data = conn.recv(1024)
            if not data:
                break
    except OSError:
        pass
    finally:
        conn.close()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--http", type=int, action="append", default=[])
    ap.add_argument("--hold", type=int, action="append", default=[])
    args = ap.parse_args()
    threads = []
    for port in args.http:
        threads.append(threading.Thread(target=http_server, args=(port,), daemon=True))
    for port in args.hold:
        threads.append(threading.Thread(target=hold_server, args=(port,), daemon=True))
    for t in threads:
        t.start()
    print("upstream ready http=%s hold=%s" % (args.http, args.hold), flush=True)
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
