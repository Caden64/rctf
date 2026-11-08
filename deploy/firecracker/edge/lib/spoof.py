#!/usr/bin/env python3
"""Raw-packet probes for the anti-spoof test (no scapy, no libpcap).

Modes:
  ip IFACE SRC_IP DST_IP DPORT PAYLOAD
      IPv4/UDP packet with a spoofed source address (IP_HDRINCL).
  eth IFACE SRC_MAC DST_MAC SRC_IP DST_IP DPORT PAYLOAD
      full Ethernet frame with a spoofed source MAC.
  arp IFACE OP SRC_MAC SRC_IP TGT_MAC TGT_IP
      raw ARP request (OP=1) or reply (OP=2).

All packets are injected into the *guest's* network namespace; the receiving
side is the host tap/veth, exactly where the agent's rules live.
"""
import socket
import struct
import sys


def ip_checksum(data: bytes) -> int:
    if len(data) % 2:
        data += b"\x00"
    total = sum(struct.unpack("!%dH" % (len(data) // 2), data))
    while total >> 16:
        total = (total & 0xFFFF) + (total >> 16)
    return ~total & 0xFFFF


def ipv4_udp(src: str, dst: str, dport: int, payload: bytes) -> bytes:
    udp = struct.pack("!HHHH", 40000, dport, 8 + len(payload), 0) + payload
    total = 20 + len(udp)
    hdr = struct.pack(
        "!BBHHHBBH4s4s",
        0x45,
        0,
        total,
        0x1234,
        0,
        64,
        17,
        0,
        socket.inet_aton(src),
        socket.inet_aton(dst),
    )
    hdr = hdr[:10] + struct.pack("!H", ip_checksum(hdr)) + hdr[12:]
    return hdr + udp


def arp_frame(op: int, src_mac: str, src_ip: str, tgt_mac: str, tgt_ip: str) -> bytes:
    def mac(text: str) -> bytes:
        return bytes(int(part, 16) for part in text.split(":"))

    eth = struct.pack(
        "!6s6sH",
        mac("ff:ff:ff:ff:ff:ff") if op == 1 else mac(tgt_mac),
        mac(src_mac),
        0x0806,
    )
    body = struct.pack(
        "!HHBBH6s4s6s4s",
        1,
        0x0800,
        6,
        4,
        op,
        mac(src_mac),
        socket.inet_aton(src_ip),
        mac(tgt_mac),
        socket.inet_aton(tgt_ip),
    )
    return eth + body


def main() -> None:
    mode = sys.argv[1]
    iface = sys.argv[2]
    if mode == "ip":
        _, _, _, src_ip, dst_ip, dport, payload = sys.argv
        s = socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_RAW)
        s.setsockopt(socket.IPPROTO_IP, socket.IP_HDRINCL, 1)
        s.sendto(ipv4_udp(src_ip, dst_ip, int(dport), payload.encode()), (dst_ip, 0))
        print("sent spoofed-ip src=%s dst=%s dport=%s" % (src_ip, dst_ip, dport))
        return
    if mode == "eth":
        _, _, _, src_mac, dst_mac, src_ip, dst_ip, dport, payload = sys.argv
        def mac(text: str) -> bytes:
            return bytes(int(part, 16) for part in text.split(":"))
        frame = (
            struct.pack("!6s6sH", mac(dst_mac), mac(src_mac), 0x0800)
            + ipv4_udp(src_ip, dst_ip, int(dport), payload.encode())
        )
        s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW)
        s.bind((iface, 0))
        s.send(frame)
        print("sent spoofed-mac src=%s dst=%s" % (src_mac, dst_ip))
        return
    if mode == "arp":
        _, _, _, op, src_mac, src_ip, tgt_mac, tgt_ip = sys.argv
        s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW)
        s.bind((iface, 0))
        s.send(arp_frame(int(op), src_mac, src_ip, tgt_mac, tgt_ip))
        print(
            "sent arp op=%s sender=%s/%s target=%s/%s"
            % (op, src_ip, src_mac, tgt_ip, tgt_mac)
        )
        return
    raise SystemExit("unknown mode %s" % mode)


if __name__ == "__main__":
    main()
