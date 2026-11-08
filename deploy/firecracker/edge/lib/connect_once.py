#!/usr/bin/env python3
"""Fire one TCP SYN at ADDR:PORT and exit after a short delay.

Used to create a real conntrack entry (DNAT mapping + UNREPLIED flow) without
needing a live service behind it. The entry outlives this process.
"""
import socket
import sys
import time

addr, port = sys.argv[1], int(sys.argv[2])
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setblocking(False)
try:
    s.connect_ex((addr, port))
except OSError:
    pass
time.sleep(0.25)
s.close()
