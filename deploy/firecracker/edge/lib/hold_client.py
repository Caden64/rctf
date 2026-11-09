#!/usr/bin/env python3
"""Open one TCP connection, hold it, and report lifecycle.

Usage: hold_client.py ADDR PORT [SOURCE_PORT] [SECONDS]
Prints "connected", then "closed" if the peer/connection goes away, or
"failed: ..."; exits 0 when it connected at least once.
"""
import os
import socket
import sys
import time

addr, port = sys.argv[1], int(sys.argv[2])
source_port = int(sys.argv[3]) if len(sys.argv) > 3 else 0
seconds = float(sys.argv[4]) if len(sys.argv) > 4 else 30.0

last = None
s = None
deadline = time.time() + 8.0
while True:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    # A clean close would leave a TIME_WAIT tuple; the reuse test needs the exact
    # same 5-tuple again, so make close send RST.
    s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, b"\x01\x00\x00\x00\x00\x00\x00\x00")
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        if source_port:
            s.bind(("0.0.0.0", source_port))
        s.settimeout(2)
        s.connect((addr, port))
        break
    except OSError as exc:
        last = exc
        s.close()
        s = None
        if time.time() >= deadline:
            print("failed: %s" % last, flush=True)
            sys.exit(1)
        time.sleep(0.2)
print("connected", flush=True)
deadline = time.time() + seconds
quiet = os.environ.get("HOLD_QUIET", "0") == "1"
try:
    s.settimeout(0.2)
    last_send = 0.0
    while time.time() < deadline:
        if quiet:
            # Keep the socket (and therefore its conntrack tuple) open without
            # sending: no new packet can recreate the entry after a flush.
            time.sleep(0.2)
            continue
        now = time.time()
        # Keep the flow alive so the harness can observe release tearing it
        # down (a silent socket would not notice until the hold expires).
        if now - last_send >= 0.3:
            try:
                s.sendall(b"ping\n")
            except OSError as exc:
                print("closed: send %s" % exc, flush=True)
                break
            last_send = now
        try:
            data = s.recv(1024)
            if not data:
                print("closed", flush=True)
                break
        except socket.timeout:
            continue
        except OSError as exc:
            print("closed: %s" % exc, flush=True)
            break
finally:
    s.close()
