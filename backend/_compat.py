"""Small platform helpers Papyrus used from ``kiro_crew.platform_compat``.

The constants and the three file helpers are restated here: they are a few
lines each, carry no security decision, and are exercised by this repository's
tests on every OS the manifest names. The two process-tree kills are the
gateway's own when it provides them (they carry its pid-reuse and own-group
guards); the fallback kills only the direct child, which can never reach a
process this app did not start.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import shutil
import signal
import stat
import subprocess
import sys
from typing import Any

from . import _host

logger = logging.getLogger("kirocrew.app.papyrus")

IS_WINDOWS: bool = sys.platform == "win32"
IS_POSIX: bool = not IS_WINDOWS
SIGKILL: int = getattr(signal, "SIGKILL", 9)
CREATE_NEW_PROCESS_GROUP: int = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)

#: Ceiling on reaping a killed child, so cleanup cannot hang a timeout path.
REAP_TIMEOUT_SECS = 10.0


def strip_extended_length_prefix(path: Any) -> Any:
    r"""*path* without Windows' extended-length prefix; unchanged elsewhere.

    ``Path.resolve()`` can return ``\\?\C:\...`` for one side of a comparison and
    the plain spelling for the other, and the lone prefix then reads as an
    escape. LEXICAL on purpose: resolving again could bless a redirect.
    """
    text = str(path)
    if text.startswith("\\\\?\\UNC\\"):
        return type(path)("\\\\" + text[8:])
    if text.startswith("\\\\?\\"):
        return type(path)(text[4:])
    return path


def fchmod_safe(fd: int, mode: int) -> None:
    """Apply *mode* through *fd*; a no-op on Windows (no POSIX permission bits)."""
    if IS_POSIX:
        try:
            os.fchmod(fd, mode)
        except OSError:
            logger.warning("papyrus: cannot set permissions on fd %d", fd)


def _clear_readonly_and_retry(func: Any, target: str, exc: BaseException) -> None:
    if isinstance(exc, FileNotFoundError):
        return
    try:
        os.chmod(target, stat.S_IWRITE | stat.S_IREAD)
    except OSError:
        raise exc from None
    func(target)


def rmtree_force(path: str | os.PathLike) -> bool:
    """Remove a tree, defeating Windows read-only files. Never raises.

    Returns whether *path* is gone afterwards. ``ignore_errors=True`` is wrong for
    a git checkout: on Windows the read-only loose objects refuse to unlink, the
    failure is swallowed, and the caller reports success over a tree still on
    disk.
    """
    try:
        if sys.version_info >= (3, 12):
            shutil.rmtree(path, onexc=_clear_readonly_and_retry)
        else:  # pragma: no cover - the gateway requires Python 3.12+

            def _legacy(func: Any, target: str, exc_info: Any) -> None:
                _clear_readonly_and_retry(func, target, exc_info[1])

            shutil.rmtree(path, onerror=_legacy)
    except FileNotFoundError:
        return not os.path.lexists(path)
    except OSError:
        logger.warning("papyrus: cannot remove %s", path)
        return False
    return not os.path.lexists(path)


def _kill_tree_sync(pid: int, sig: int) -> bool:
    """Signal *pid*'s tree without the gateway's helper.

    POSIX: the whole process group, but only when *pid* leads its own group (the
    children here are started with ``start_new_session``) and that group is not
    this process's, so the signal cannot reach the gateway or a stranger's
    group; otherwise just *pid*. Windows: ``taskkill /T /F``.
    """
    if IS_POSIX:
        try:
            own_group = os.getpgid(pid) == pid and pid != os.getpgrp()
        except OSError:
            own_group = False
        if own_group:
            os.killpg(pid, sig)
        else:
            os.kill(pid, sig)
        return True
    result = subprocess.run(
        ["taskkill", "/T", "/F", "/PID", str(pid)],
        capture_output=True,
        timeout=10,
        check=False,
    )
    return result.returncode == 0


async def kill_process_tree_async(pid: int, sig: int = SIGKILL) -> bool:
    """Kill *pid* and its descendants (the gateway's helper when it has one)."""
    impl = _host.host_platform("kill_process_tree_async")
    if callable(impl):
        return bool(await impl(pid, sig))
    if IS_POSIX:
        return _kill_tree_sync(pid, sig)
    return await asyncio.to_thread(_kill_tree_sync, pid, sig)


async def kill_and_reap(proc: asyncio.subprocess.Process) -> None:
    """Kill *proc* and its tree, then reap it under a bound; never raises.

    The gateway's own helper when it has one. Otherwise the same sequence: the
    tree is signalled only while *proc* is unreaped (its pid cannot have been
    reused), then the direct child, then the pipes are drained so the reap
    cannot hang on a full pipe. Shielded, so a repeated cancel cannot skip it.
    """
    impl = _host.host_platform("kill_and_reap")
    if callable(impl):
        await impl(proc)
        return

    async def _cleanup() -> None:
        if proc.returncode is None:
            with contextlib.suppress(Exception):
                await kill_process_tree_async(proc.pid, SIGKILL)
        with contextlib.suppress(Exception):
            proc.kill()
        with contextlib.suppress(Exception, asyncio.TimeoutError):
            await asyncio.wait_for(proc.communicate(), timeout=REAP_TIMEOUT_SECS)

    task = asyncio.ensure_future(_cleanup())
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            if task.done():
                break
            current = asyncio.current_task()
            if current is not None:
                current.uncancel()
            continue
