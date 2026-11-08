#!/usr/bin/env python3
"""Authenticate a recorded process and signal it through a pidfd.

Both deploy/firecracker/vmtest/vm.sh and deploy/firecracker/multihost/vm.sh
record versioned pidfiles (boot id, /proc/<pid>/stat start ticks, canonical
executable and run-specific argv).  This helper is the only code that turns
such a record into a signal.

Why a pidfd and not `kill <pid>`:

  * A PID is not an identity.  Between "the pidfile still matches" and
    "kill <pid>" the target can exit and the kernel can hand the same PID to
    an unrelated process.  `kill` would then TERM/KILL that stranger.
  * A pidfd (Linux >= 5.3, Python >= 3.9) is a stable reference to the
    process that held the PID when the fd was opened.  Signals sent through
    it can only reach that process; after it exits the same call fails with
    ESRCH instead of resolving the PID again.

Ordering (the point of this file):

  1. parse and authenticate the pidfile record (boot id, kind, fields);
  2. open the pidfd FIRST;
  3. validate the recorded identity from /proc/<pid>/... *while holding the
     pidfd*: start ticks, exe and recorded/required argv;
  4. re-read the start ticks immediately before signalling, so a user-space
     reuse that happened between the first read and the signal is caught;
  5. send TERM and (if needed) KILL through the same pidfd only.

There is deliberately no second PID-based signal path.

Exit codes: 0 handled, 1 no authenticated process (stale pidfile), 2 usage,
3 observation failure (pidfd/proc could not be read; nothing was signalled).

The --test-hook options exist only for the unprivileged decoy self-tests in
both vm.sh scripts; they let a test simulate a PID reuse race without needing
to actually recycle a PID:

  start-delta-after-validate=N   pretend the live start ticks changed by N
                                 between validation and the signal; the helper
                                 must refuse to signal.
  reuse-after-validate=PID       pretend a naive implementation re-resolved
                                 the pidfile to PID after validation; the
                                 helper must still signal only through the
                                 pidfd opened before (never PID).
"""

from __future__ import annotations

import argparse
import errno
import os
import select
import signal
import sys
import time

TERM_POLL_SLICE = 0.2  # vm.sh's historical "term wait tick"
PROC_GONE_GRACE = 2.0  # let the parent reap after the process exited


def eprint(message: str) -> None:
    print(message, file=sys.stderr)


class Stale(Exception):
    """The pidfile does not describe a live, authenticated process."""


class ProbeError(Exception):
    """The observation itself failed; nothing was signalled."""


def current_boot_id() -> str:
    try:
        with open("/proc/sys/kernel/random/boot_id", "r", encoding="ascii") as f:
            return f.read().strip()
    except OSError as error:
        raise ProbeError(f"could not read the current boot id: {error}") from error


def parse_pidfile(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8", errors="surrogateescape") as f:
            lines = [line.rstrip("\n") for line in f]
    except FileNotFoundError:
        raise Stale("file is missing") from None
    except OSError as error:
        raise ProbeError(f"could not read pidfile {path}: {error}") from error

    record: dict = {
        "version": "",
        "kind": "",
        "pid": "",
        "boot_id": "",
        "start_ticks": "",
        "exe": "",
        "args": [],
    }
    known = {"version", "kind", "pid", "boot_id", "start_ticks", "exe", "arg"}
    for line in lines:
        if line == "":
            continue
        if "=" not in line:
            raise Stale(
                f"unsupported legacy pidfile (bare PID '{line}'); cannot authenticate"
            )
        key, value = line.split("=", 1)
        if key not in known:
            raise Stale(f"unknown field '{key}'")
        if key == "arg":
            record["args"].append(value)
        else:
            record[key] = value

    if record["version"] != "2":
        raise Stale(
            f"unsupported pidfile version '{record['version'] or 'none'}'"
        )
    pid = record["pid"]
    if not pid.isdigit():
        raise Stale(f"invalid pid '{pid}'")
    for field in ("boot_id", "start_ticks", "exe"):
        if record[field] == "":
            raise Stale(f"recorded field '{field}' is empty; cannot authenticate")
    recorded_boot = record["boot_id"]
    live_boot = current_boot_id()
    if recorded_boot != live_boot:
        raise Stale(
            f"recorded boot id '{recorded_boot}' != current '{live_boot}' "
            "(stale after reboot)"
        )
    record["pid"] = int(pid)
    return record


def read_start_ticks(pid: int) -> str | None:
    """Field 22 of /proc/<pid>/stat; None when the process is gone."""
    try:
        with open(f"/proc/{pid}/stat", "rb") as f:
            data = f.read().decode("utf-8", "replace")
    except (FileNotFoundError, ProcessLookupError):
        return None
    except OSError as error:
        if error.errno == errno.ESRCH:
            return None
        raise ProbeError(f"could not read /proc/{pid}/stat: {error}") from error
    # comm (field 2) may contain spaces and parentheses; fields resume after
    # the final ')'.  starttime is field 22, i.e. index 19 of that remainder.
    close = data.rfind(")")
    if close < 0:
        return None
    fields = data[close + 2 :].split()
    if len(fields) <= 19:
        return None
    return fields[19]


def read_exe(pid: int) -> str | None:
    try:
        return os.readlink(f"/proc/{pid}/exe")
    except (FileNotFoundError, ProcessLookupError):
        return None
    except OSError as error:
        if error.errno == errno.ESRCH:
            return None
        raise ProbeError(f"could not read /proc/{pid}/exe: {error}") from error


def read_cmdline(pid: int) -> list[str] | None:
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            raw = f.read()
    except (FileNotFoundError, ProcessLookupError):
        return None
    except OSError as error:
        if error.errno == errno.ESRCH:
            return None
        raise ProbeError(f"could not read /proc/{pid}/cmdline: {error}") from error
    return [os.fsdecode(part) for part in raw.split(b"\0") if part]


def open_and_authenticate(
    record: dict, required_args: list[str], expected_kind: str
) -> int:
    """Open the pidfd, then validate identity while holding it.

    Returns the pidfd.  Raises Stale (no authenticated process, safe to treat
    the pidfile as stale) or ProbeError (observation failed).
    """
    if record["kind"] != expected_kind:
        raise Stale(f"kind is '{record['kind']}', expected '{expected_kind}'")
    pid = record["pid"]

    # 1. Pin the current occupant of the PID before looking at anything else.
    try:
        pidfd = os.pidfd_open(pid)
    except ProcessLookupError:
        raise Stale(f"pid {pid} is not running") from None
    except OSError as error:
        raise ProbeError(f"pidfd_open({pid}) failed: {error}") from error

    try:
        # 2. Validate the recorded identity from /proc while the pidfd pins it.
        live_start = read_start_ticks(pid)
        if live_start is None:
            raise Stale(f"pid {pid} is not running")
        if live_start != record["start_ticks"]:
            raise Stale(
                f"pid {pid} start ticks '{record['start_ticks']}' != live "
                f"'{live_start}' (pid reused)"
            )
        live_exe = read_exe(pid)
        if live_exe is None:
            raise Stale(f"pid {pid} is not running")
        if live_exe != record["exe"]:
            raise Stale(
                f"pid {pid} executable '{record['exe']}' != live '{live_exe}'"
            )
        live_argv = read_cmdline(pid)
        if live_argv is None:
            raise Stale(f"pid {pid} is not running")
        for needle in required_args:
            if needle not in live_argv:
                raise Stale(
                    f"pid {pid} cmdline lacks required argument '{needle}' "
                    "(not this VM_DIR)"
                )
        for needle in record["args"]:
            if needle not in live_argv:
                raise Stale(
                    f"pid {pid} cmdline lacks recorded argument '{needle}'"
                )
    except Stale:
        os.close(pidfd)
        raise
    except ProbeError:
        os.close(pidfd)
        raise
    return pidfd


def parse_hooks(raw_hooks: list[str]) -> dict:
    hooks: dict = {}
    for raw in raw_hooks:
        name, sep, value = raw.partition("=")
        if name not in ("start-delta-after-validate", "reuse-after-validate"):
            raise ValueError(f"unknown test hook '{raw}'")
        if name == "start-delta-after-validate":
            if not sep or not value.lstrip("+-").isdigit():
                raise ValueError(f"test hook '{name}' needs an integer value")
            hooks[name] = int(value)
        else:
            if not sep or not value.isdigit() or int(value) <= 0:
                raise ValueError(f"test hook '{name}' needs a positive pid")
            hooks[name] = int(value)
    return hooks


def final_identity_check(pid: int, record: dict, signame: str, hooks: dict) -> None:
    """Re-read the start ticks immediately before the signal."""
    live = read_start_ticks(pid)
    if "start-delta-after-validate" in hooks:
        # Simulate a PID reuse that happens after validation: the live record
        # now belongs to a different process.  A PID-based signal would hit it.
        base = int(live) if live is not None else int(record["start_ticks"])
        live = str(base + hooks["start-delta-after-validate"])
    if live is None:
        raise Stale(f"pid {pid} is not running before {signame}")
    if live != record["start_ticks"]:
        raise Stale(
            f"pid {pid} changed identity before {signame}; not signalling "
            f"(pid reused: start ticks '{record['start_ticks']}' != live '{live}')"
        )


def wait_pidfd(fd: int, seconds: float) -> bool:
    """True when the process behind the pidfd exited within `seconds`."""
    if seconds <= 0:
        return False
    poller = select.poll()
    poller.register(fd, select.POLLIN)
    deadline = time.monotonic() + seconds
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        if poller.poll(max(1, int(remaining * 1000))):
            return True


def send_through_pidfd(fd: int, sig: int, pid: int) -> bool:
    """True when the signal was delivered; False when the process is gone."""
    try:
        signal.pidfd_send_signal(fd, sig)
        return True
    except ProcessLookupError:
        return False
    except OSError as error:
        if error.errno == errno.ESRCH:
            return False
        raise ProbeError(f"pidfd_send_signal({pid}, {sig}) failed: {error}") from error


def wait_proc_gone(pid: int, seconds: float) -> None:
    """Best effort: give the parent time to reap so `kill -0` stops succeeding."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not os.path.exists(f"/proc/{pid}"):
            return
        time.sleep(0.05)


def do_stop(
    record: dict,
    required_args: list[str],
    expected_kind: str,
    label: str,
    term_ticks: int,
    hooks: dict,
) -> None:
    pid = record["pid"]
    pidfd = open_and_authenticate(record, required_args, expected_kind)
    try:
        final_identity_check(pid, record, "SIGTERM", hooks)
        if "reuse-after-validate" in hooks:
            # A naive implementation would now re-read the pidfile and kill
            # this PID.  We only look at it, to make the safety property
            # observable to the self-test (it must stay alive).
            eprint(
                "test hook: pidfile would re-resolve to pid "
                f"{hooks['reuse-after-validate']} after validation; signalling "
                f"only through the pidfd for pid {pid}"
            )
        eprint(f"stopping {label} (pid {pid})")
        if send_through_pidfd(pidfd, signal.SIGTERM, pid):
            exited = wait_pidfd(pidfd, term_ticks * TERM_POLL_SLICE)
            if not exited:
                send_through_pidfd(pidfd, signal.SIGKILL, pid)
                if not wait_pidfd(pidfd, 10.0):
                    raise ProbeError(
                        f"pid {pid} is still alive after SIGTERM and SIGKILL"
                    )
        wait_proc_gone(pid, PROC_GONE_GRACE)
    finally:
        os.close(pidfd)


def do_kill(
    record: dict,
    required_args: list[str],
    expected_kind: str,
    label: str,
    sig: int,
    hooks: dict,
) -> None:
    pid = record["pid"]
    pidfd = open_and_authenticate(record, required_args, expected_kind)
    try:
        signame = signal.Signals(sig).name
        final_identity_check(pid, record, signame, hooks)
        eprint(f"killing {label} (pid {pid}) with {signame}")
        send_through_pidfd(pidfd, sig, pid)
        if not wait_pidfd(pidfd, 10.0):
            raise ProbeError(f"pid {pid} is still alive after {signame}")
        wait_proc_gone(pid, PROC_GONE_GRACE)
    finally:
        os.close(pidfd)


def do_verify(record: dict, required_args: list[str], expected_kind: str) -> None:
    pidfd = open_and_authenticate(record, required_args, expected_kind)
    os.close(pidfd)
    print(record["pid"])


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        add_help=True,
        description="authenticate a recorded process and signal it through a pidfd",
    )
    parser.add_argument("action", choices=("verify", "stop", "kill"))
    parser.add_argument("--pidfile", required=True)
    parser.add_argument("--kind", required=True)
    parser.add_argument("--require-arg", action="append", default=[])
    parser.add_argument("--label", default="process")
    parser.add_argument("--term-wait-ticks", type=int, default=25)
    parser.add_argument(
        "--signal", choices=("SIGTERM", "SIGKILL"), default="SIGKILL"
    )
    parser.add_argument("--test-hook", action="append", default=[])
    args = parser.parse_args(argv)

    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        eprint("pidguard: pidfd support requires Python >= 3.9 on Linux")
        return 2
    try:
        hooks = parse_hooks(args.test_hook)
    except ValueError as error:
        eprint(f"pidguard: {error}")
        return 2

    try:
        record = parse_pidfile(args.pidfile)
        if args.action == "verify":
            do_verify(record, args.require_arg, args.kind)
        elif args.action == "stop":
            do_stop(
                record,
                args.require_arg,
                args.kind,
                args.label,
                max(0, args.term_wait_ticks),
                hooks,
            )
        else:
            do_kill(
                record,
                args.require_arg,
                args.kind,
                args.label,
                getattr(signal, args.signal),
                hooks,
            )
    except Stale as error:
        eprint(str(error))
        return 1
    except ProbeError as error:
        eprint(str(error))
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
