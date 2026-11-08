#!/usr/bin/env python3
"""Validate and remove the multihost private-link endpoints safely.

The link is a pair of AF_UNIX datagram sockets.  Their directory is the trust
boundary: it must be a direct child of a run-owned root, with no symlink in any
component up to that root, no group/other write permission, and owned by this
uid (or root for the trusted root itself).  A path outside the validated
directory (or one that resolves there through a symlink) is rejected.

Removal is relative to an opened directory fd:

  1. open the validated directory with O_DIRECTORY|O_NOFOLLOW;
  2. fstat the fd and re-check mode/owner (the path cannot be swapped after);
  3. lstat the basename through that same fd;
  4. unlink only when it is an AF_UNIX socket owned by this uid.

There is deliberately no path-based `rm`: a path can be replaced between the
check and the unlink, an fd cannot.

Usage:
  linkguard.py check  --root DIR --dir DIR [--local PATH --peer PATH]
  linkguard.py unlink --root DIR --dir DIR --path PATH

Exit codes: 0 ok, 2 usage, 3 observation/validation failure (nothing removed).
"""

from __future__ import annotations

import argparse
import stat
import sys

import os


def eprint(message: str) -> None:
    print(f"linkguard: {message}", file=sys.stderr)


def fail(message: str) -> int:
    eprint(message)
    return 3


def strip_trailing(path: str) -> str:
    while len(path) > 1 and path.endswith("/"):
        path = path[:-1]
    return path


def check_root(root: str) -> str | None:
    root = strip_trailing(root)
    if not os.path.isabs(root):
        return f"trusted root {root!r} is not absolute"
    try:
        info = os.lstat(root)
    except OSError as error:
        return f"cannot lstat trusted root {root}: {error}"
    if stat.S_ISLNK(info.st_mode):
        return f"trusted root {root} is a symlink"
    if not stat.S_ISDIR(info.st_mode):
        return f"trusted root {root} is not a directory"
    if info.st_uid not in (os.getuid(), 0):
        return f"trusted root {root} is owned by uid {info.st_uid}, expected {os.getuid()} or 0"
    if info.st_mode & 0o022:
        return f"trusted root {root} is writable by group/other (mode {oct(info.st_mode & 0o7777)})"
    real = os.path.realpath(root)
    if real != root:
        return f"trusted root {root} resolves through a symlink to {real}"
    return None


def check_dir(root: str, directory: str) -> str | None:
    root = strip_trailing(root)
    directory = strip_trailing(directory)
    if not os.path.isabs(directory):
        return f"link directory {directory!r} is not absolute"
    # The directory must be a direct child of the trusted root: this rejects
    # every '..', symlinked ancestor and nested path before any lstat.
    if os.path.dirname(directory) != root:
        return (
            f"link directory {directory} is not a direct child of the trusted "
            f"root {root}"
        )
    if os.path.basename(directory) in ("", ".", ".."):
        return f"invalid link directory name {directory!r}"
    try:
        info = os.lstat(directory)
    except OSError as error:
        return f"cannot lstat link directory {directory}: {error}"
    if stat.S_ISLNK(info.st_mode):
        return f"link directory {directory} is a symlink"
    if not stat.S_ISDIR(info.st_mode):
        return f"link directory {directory} is not a directory"
    if stat.S_IMODE(info.st_mode) != 0o700:
        return (
            f"link directory {directory} is mode "
            f"{oct(stat.S_IMODE(info.st_mode))}, expected 0o700"
        )
    if info.st_uid != os.getuid():
        return (
            f"link directory {directory} is owned by uid {info.st_uid}, "
            f"expected {os.getuid()}"
        )
    real = os.path.realpath(directory)
    if real != directory:
        return f"link directory {directory} resolves through a symlink to {real}"
    return None


def check_endpoint(directory: str, path: str, label: str) -> str | None:
    normal = strip_trailing(path)
    if not os.path.isabs(normal):
        return f"{label} {path!r} is not absolute"
    if os.path.dirname(normal) != directory:
        return f"{label} {normal} is not a direct child of {directory}"
    name = os.path.basename(normal)
    if name in ("", ".", ".."):
        return f"invalid {label} name {name!r}"
    if len(normal.encode()) > 103:
        return f"{label} unix socket path is too long ({len(normal.encode())} > 103)"
    return None


def open_dir(directory: str) -> int:
    return os.open(
        directory,
        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
    )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("action", choices=("check", "unlink"))
    parser.add_argument("--root", required=True)
    parser.add_argument("--dir", required=True)
    parser.add_argument("--local", default="")
    parser.add_argument("--peer", default="")
    parser.add_argument("--path", default="")
    args = parser.parse_args(argv)

    problem = check_root(args.root) or check_dir(args.root, args.dir)
    if problem is not None:
        return fail(problem)

    if args.action == "check":
        for label, path in (("local", args.local), ("peer", args.peer)):
            if path == "":
                return fail(f"--{label} is required for check")
            problem = check_endpoint(strip_trailing(args.dir), path, label)
            if problem is not None:
                return fail(problem)
        return 0

    if args.path == "":
        return fail("--path is required for unlink")
    normal = strip_trailing(args.path)
    problem = check_endpoint(strip_trailing(args.dir), normal, "endpoint")
    if problem is not None:
        return fail(problem)
    name = os.path.basename(normal)

    try:
        fd = open_dir(strip_trailing(args.dir))
    except OSError as error:
        return fail(f"cannot open link directory {args.dir}: {error}")
    try:
        info = os.fstat(fd)
        if not stat.S_ISDIR(info.st_mode):
            return fail(f"link directory fd is not a directory")
        if stat.S_IMODE(info.st_mode) != 0o700 or info.st_uid != os.getuid():
            return fail(
                "link directory changed identity while opening it "
                f"(mode {oct(stat.S_IMODE(info.st_mode))}, uid {info.st_uid})"
            )
        try:
            entry = os.lstat(name, dir_fd=fd)
        except FileNotFoundError:
            return 0
        except OSError as error:
            return fail(f"cannot lstat {name} through the directory fd: {error}")
        if not stat.S_ISSOCK(entry.st_mode):
            return fail(f"{normal} is not a unix socket (lstat through dir fd)")
        if entry.st_uid != os.getuid():
            return fail(
                f"{normal} is owned by uid {entry.st_uid}, expected {os.getuid()}"
            )
        try:
            os.unlink(name, dir_fd=fd)
        except FileNotFoundError:
            return 0
        except OSError as error:
            return fail(f"cannot unlink {name} through the directory fd: {error}")
        return 0
    finally:
        os.close(fd)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
