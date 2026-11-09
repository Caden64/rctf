#!/usr/bin/env python3
"""Packet sniffer used by the edge test (no scapy).

Usage: sniff.py IFACE MODE SECONDS OUTFILE
  MODE=udp   record IPv4/UDP packets (filtered by --dport)
  MODE=arp   record ARP packets
  MODE=eth   record every IPv4 Ethernet frame

Packets are observed at the interface after the kernel received them; because
nftables filtering happens later in the stack, a sniffer on the *receiving*
tap cannot by itself prove a drop. The harness uses it in the upstream netns
(after forwarding) for IP/MAC spoofs, and uses kernel neighbour learning for
ARP drops.
"""
import argparse
import json
import socket
import struct
import time


def parse_arp(pkt: bytes) -> dict:
    if len(pkt) < 42:
        return {}
    eth = struct.unpack("!6s6sH", pkt[:14])
    op = struct.unpack("!H", pkt[20:22])[0]
    sha = ":".join("%02x" % b for b in pkt[22:28])
    spa = socket.inet_ntoa(pkt[28:32])
    tha = ":".join("%02x" % b for b in pkt[32:38])
    tpa = socket.inet_ntoa(pkt[38:42])
    return {
        "eth_src": ":".join("%02x" % b for b in eth[0]),
        "eth_dst": ":".join("%02x" % b for b in eth[1]),
        "oper": op,
        "sender_mac": sha,
        "sender_ip": spa,
        "target_mac": tha,
        "target_ip": tpa,
    }


def parse_ip(pkt: bytes, want_udp: bool, dport: int | None) -> dict | None:
    if len(pkt) < 34:
        return None
    eth = struct.unpack("!6s6sH", pkt[:14])
    if eth[2] != 0x0800:
        return None
    ihl = (pkt[14] & 0x0F) * 4
    if len(pkt) < 14 + ihl + 8:
        return None
    proto = pkt[23]
    src = socket.inet_ntoa(pkt[26:30])
    dst = socket.inet_ntoa(pkt[30:34])
    rec = {
        "eth_src": ":".join("%02x" % b for b in eth[0]),
        "eth_dst": ":".join("%02x" % b for b in eth[1]),
        "ip_src": src,
        "ip_dst": dst,
        "proto": proto,
    }
    if proto == 17:
        udp = pkt[14 + ihl : 14 + ihl + 8]
        rec["sport"], rec["dport"] = struct.unpack("!HH", udp[:4])
        rec["payload"] = pkt[14 + ihl + 8 : 14 + ihl + 8 + 32].decode(
            "utf-8", "replace"
        )
        if want_udp and dport is not None and rec["dport"] != dport:
            return None
        if not want_udp:
            return None
    elif want_udp:
        return None
    return rec


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("iface")
    ap.add_argument("mode", choices=["udp", "arp", "eth"])
    ap.add_argument("seconds", type=float)
    ap.add_argument("outfile")
    ap.add_argument("--dport", type=int, default=None)
    args = ap.parse_args()

    sock = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(0x0003))
    sock.bind((args.iface, 0))
    sock.settimeout(0.2)
    deadline = time.time() + args.seconds
    seen = []
    with open(args.outfile, "w") as out:
        while time.time() < deadline:
            try:
                pkt, sa = sock.recvfrom(65535)
            except socket.timeout:
                continue
            if sa[2] == socket.PACKET_OUTGOING:
                continue
            rec = None
            if args.mode == "arp":
                if len(pkt) >= 14 and struct.unpack("!H", pkt[12:14])[0] == 0x0806:
                    rec = parse_arp(pkt)
            elif args.mode == "udp":
                rec = parse_ip(pkt, True, args.dport)
            else:
                rec = parse_ip(pkt, False, None)
            if rec:
                seen.append(rec)
                out.write(json.dumps(rec) + "\n")
                out.flush()
    sock.close()
    print("sniffed %d matching packets on %s mode=%s" % (len(seen), args.iface, args.mode))


if __name__ == "__main__":
    main()
