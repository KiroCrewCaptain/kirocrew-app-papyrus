"""A stand-in for the Kiro Crew gateway, so the tests need no Kiro Crew install.

``backend/_host.py`` resolves every host control through one function,
``_host._host_attr(module, name)``. :class:`FakeHost` answers it from a table of
small, offline implementations; a test that needs a different host (one without
the sandbox, one whose sandbox refuses) edits the table through the ``fake_host``
fixture.

These fakes stand in for the host's controls, they do not re-implement them: the
sandbox fake runs the argv unwrapped, the sensitive-path fake knows a handful of
names. What the tests check is that Papyrus routes every spawn, path and read
through the host and refuses when the host does. The controls themselves are
tested in Kiro Crew.

:class:`FakeCtx` is the ``AppContext`` the gateway hands the hooks at App Kit
level 1, with the fields Papyrus reads.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import stat
import sys
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from aiohttp import web

# ── sandbox ─────────────────────────────────────────────────────────────────


class SandboxUnavailableError(RuntimeError):
    """The host's own refusal type (``kiro_crew.sandbox.SandboxUnavailableError``)."""

    def __init__(self, message: str = "no sandbox backend", *, kind: str = "no_backend") -> None:
        super().__init__(message)
        self.kind = kind


@dataclass
class SpawnRecord:
    argv: list[str]
    mode: str
    kwargs: dict[str, Any]


class FakeSandbox:
    """The host's spawn chokepoint: records each call, returns the argv unwrapped."""

    def __init__(self) -> None:
        self.calls: list[SpawnRecord] = []
        self.refuse: BaseException | None = None

    def sandboxed_spawn_argv(
        self, argv: list[str], mode: str = "standard", *, env: dict[str, str] | None = None, **kw: Any
    ) -> tuple[list[str], dict[str, str], str | None]:
        self.calls.append(SpawnRecord(list(argv), mode, dict(kw, env=env)))
        if self.refuse is not None:
            raise self.refuse
        return list(argv), dict(env if env is not None else os.environ), None

    @staticmethod
    async def shielded_prepare_off_loop(prepare: Callable[[], Any], *, executor: Any = None) -> Any:
        loop = asyncio.get_running_loop()
        return await asyncio.shield(loop.run_in_executor(executor, prepare))

    @staticmethod
    async def create_subprocess_limited(*argv: str, **kwargs: Any) -> Any:
        return await asyncio.create_subprocess_exec(*argv, **kwargs)


# ── security ────────────────────────────────────────────────────────────────

#: Home-relative paths the fake treats as sensitive, in the host's shape.
SENSITIVE_HOME_DIRS: tuple[str, ...] = (
    ".ssh",
    ".aws",
    ".gnupg",
    ".kiro/crew/.env",
    ".kiro/crew/.local_secret",
    ".kiro/crew/sel_hmac.key",
    ".kiro/crew/token_signing.key",
    ".kiro/crew/security_policy.json",
)


def sensitive_home_dirs() -> tuple[str, ...]:
    return SENSITIVE_HOME_DIRS


#: Path components the fake's sensitive-path gate refuses wherever they appear.
SENSITIVE_COMPONENTS = frozenset({".ssh", ".aws", ".gnupg", ".local_secret", "sel_hmac.key"})


def is_sensitive_path(path: str, base_dir: str | None = None) -> bool:
    parts = {p.lower() for p in Path(path).parts}
    return bool(parts & SENSITIVE_COMPONENTS)


def minimal_env(**extra: str) -> dict[str, str]:
    keep = ("PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "TMPDIR", "TEMP", "TMP", "LANG")
    env = {k: os.environ[k] for k in keep if k in os.environ}
    env.update(extra)
    return env


class FileTooLargeError(Exception):
    """The host's ``kiro_crew.hooks.FileTooLargeError``."""


def safe_read_file_bytes_nolink(
    raw: str, within_root: str | None = None, *, max_bytes: int | None = None, **_kw: Any
) -> bytes | None:
    """No-follow, hard-link-refusing, contained, capped read (the host's contract)."""
    try:
        fd = os.open(raw, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0))
    except FileNotFoundError:
        return None
    except OSError:
        return None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink > 1:
            return None
        if within_root is not None:
            real = os.path.realpath(raw)
            root = os.path.realpath(within_root)
            if os.path.commonpath([real, root]) != root:
                return None
        if max_bytes is not None and st.st_size > max_bytes:
            raise FileTooLargeError(raw)
        chunks = []
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks)
    finally:
        os.close(fd)


# ── git config hooks ────────────────────────────────────────────────────────


class ConfigHookScanError(RuntimeError):
    """The host's ``kiro_crew.git_config_hooks.ConfigHookScanError``."""


class FakeHookScanner:
    def __init__(self) -> None:
        self.calls: list[tuple[Path, str]] = []
        self.args: list[str] = []
        self.refuse: BaseException | None = None

    async def config_hook_disable_args_sandboxed_async(
        self, cwd: Path, *, spawn_argv: Callable[..., Any], mode: str, env: Any = None
    ) -> list[str]:
        self.calls.append((Path(cwd), mode))
        # The host runs its scan through the caller's chokepoint; so does this.
        spawn_argv(["git", "config", "--get-regexp", r"^hook\."], mode=mode, env=env)
        if self.refuse is not None:
            raise self.refuse
        return list(self.args)


# ── verified downloader and descriptor paths ────────────────────────────────


def fd_real_path(fd: int) -> str | None:
    """Where an open descriptor really is (``/proc/self/fd``, ``F_GETPATH``, Win32)."""
    try:
        if sys.platform.startswith("linux"):
            return os.readlink(f"/proc/self/fd/{fd}")
        if sys.platform == "darwin":
            import fcntl

            buf = fcntl.fcntl(fd, getattr(fcntl, "F_GETPATH", 50), b"\0" * 1024)
            return os.fsdecode(buf.split(b"\0", 1)[0])
        if sys.platform == "win32":
            import ctypes
            import msvcrt
            from ctypes import wintypes

            handle = msvcrt.get_osfhandle(fd)
            get = ctypes.windll.kernel32.GetFinalPathNameByHandleW  # type: ignore[attr-defined]
            get.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
            get.restype = wintypes.DWORD
            buf = ctypes.create_unicode_buffer(32768)
            n = get(handle, buf, 32768, 0)
            if not n:
                return None
            text = buf.value
            if text.startswith("\\\\?\\UNC\\"):
                return "\\\\" + text[8:]
            if text.startswith("\\\\?\\"):
                return text[4:]
            return text
    except OSError:
        return None
    return None


@dataclass(frozen=True)
class TargetDir:
    path: Path


def file_identity(st: os.stat_result) -> tuple[int, int]:
    return (st.st_dev, st.st_ino)


def open_staging_nofollow(where: TargetDir, name: str) -> Any:
    target = Path(where.path) / name
    try:
        os.unlink(target)
    except FileNotFoundError:
        pass
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    fd = os.open(target, flags, 0o600)
    return os.fdopen(fd, "wb")


def install_verified(
    where: TargetDir, staging_name: str, target_name: str, *, verified: Any, restrict_to_owner: bool
) -> None:
    base = Path(where.path)
    os.replace(base / staging_name, base / target_name)
    st = os.lstat(base / target_name)
    if not stat.S_ISREG(st.st_mode) or (os.name != "nt" and file_identity(st) != verified):
        os.unlink(base / target_name)
        raise OSError("the staged file was replaced during the transfer")


def redact_url(url: str) -> str:
    """Scheme, host and port only (the host's shape)."""
    parsed = urllib.parse.urlsplit(url)
    host = parsed.hostname or ""
    port = f":{parsed.port}" if parsed.port else ""
    return f"{parsed.scheme}://{host}{port}"


def download_to(
    archive: Path,
    url: str,
    *,
    sha256: str,
    timeout_secs: float,
    chunk_bytes: int,
    progress_every_bytes: int = 0,
    on_progress: Callable[[int, int], None] | None = None,
    on_verifying: Callable[[], None] | None = None,
    allow_cross_host_redirects: bool = False,
    label: str = "",
) -> tuple[bool, str]:
    """Stream *url* beside *archive*, hash it, rename only on a digest match. Never raises."""
    staging = archive.with_name(archive.name + ".part")
    digest = hashlib.sha256()
    try:
        opener = urllib.request.build_opener()
        with opener.open(url, timeout=timeout_secs) as response, open(staging, "wb") as out:
            total = int(getattr(response, "headers", {}).get("Content-Length") or 0)
            done = 0
            while True:
                chunk = response.read(chunk_bytes)
                if not chunk:
                    break
                out.write(chunk)
                digest.update(chunk)
                done += len(chunk)
                if on_progress is not None:
                    on_progress(done, total)
        if on_verifying is not None:
            on_verifying()
        if digest.hexdigest() != sha256:
            staging.unlink(missing_ok=True)
            return False, f"sha256 mismatch from {redact_url(url)}"
        os.replace(staging, archive)
        return True, ""
    except Exception as exc:  # noqa: BLE001 - the host's downloader never raises
        staging.unlink(missing_ok=True)
        return False, f"download failed ({type(exc).__name__}) from {redact_url(url)}"


# ── the host table ──────────────────────────────────────────────────────────


class FakeHost:
    """Answers ``_host._host_attr`` from :attr:`table`."""

    def __init__(self, data_home: Path) -> None:
        self.sandbox = FakeSandbox()
        self.hooks = FakeHookScanner()
        self.data_home = data_home
        self.tasks: list[tuple[str, str]] = []
        self.table: dict[tuple[str, str], Any] = {
            ("kiro_crew.sandbox", "sandboxed_spawn_argv"): self.sandbox.sandboxed_spawn_argv,
            ("kiro_crew.sandbox", "shielded_prepare_off_loop"): FakeSandbox.shielded_prepare_off_loop,
            ("kiro_crew.sandbox", "create_subprocess_limited"): FakeSandbox.create_subprocess_limited,
            ("kiro_crew.sandbox", "SandboxUnavailableError"): SandboxUnavailableError,
            ("kiro_crew.executors", "subprocess_executor"): lambda: None,
            ("kiro_crew.apps.registry", "minimal_env"): minimal_env,
            ("kiro_crew.security", "sensitive_home_dirs"): sensitive_home_dirs,
            ("kiro_crew.security", "is_sensitive_path"): is_sensitive_path,
            ("kiro_crew.config.loader", "config_dir"): lambda: self.data_home,
            ("kiro_crew.hooks", "safe_read_file_bytes_nolink"): safe_read_file_bytes_nolink,
            ("kiro_crew.hooks", "FileTooLargeError"): FileTooLargeError,
            (
                "kiro_crew.git_config_hooks",
                "config_hook_disable_args_sandboxed_async",
            ): self.hooks.config_hook_disable_args_sandboxed_async,
            ("kiro_crew.git_config_hooks", "ConfigHookScanError"): ConfigHookScanError,
            ("kiro_crew.asset_downloader", "download_to"): download_to,
            ("kiro_crew.asset_downloader", "TargetDir"): TargetDir,
            ("kiro_crew.asset_downloader", "open_staging_nofollow"): open_staging_nofollow,
            ("kiro_crew.asset_downloader", "file_identity"): file_identity,
            ("kiro_crew.asset_downloader", "install_verified"): install_verified,
            ("kiro_crew.asset_downloader", "redact_url"): redact_url,
            ("kiro_crew.pinned_fs", "fd_real_path"): fd_real_path,
            ("kiro_crew.metrics.feature_usage", "record_app_task"): self._record_task,
        }

    def _record_task(self, app: str, outcome: str) -> None:
        self.tasks.append((app, outcome))

    def attr(self, module: str, name: str) -> Any | None:
        return self.table.get((module, name))

    def remove(self, module: str, name: str) -> None:
        self.table.pop((module, name), None)


# ── the app context ─────────────────────────────────────────────────────────


@dataclass
class ScrubResult:
    text: str
    credentials_removed: int = 0
    urls_removed: int = 0
    redacted: bool = False


class FakeScrub:
    """``ctx.scrub``: redacts the credential shapes the tests use; ``raises`` fails it."""

    def __init__(self) -> None:
        self.calls = 0
        self.raises: BaseException | None = None

    def outbound(self, text: str) -> ScrubResult:
        self.calls += 1
        if self.raises is not None:
            raise self.raises
        import re

        out = re.sub(
            r"(ghp_|glpat-|xoxb-|sk-)[A-Za-z0-9_\-]{6,}|AKIA[A-Z0-9]{12,}|"
            r"(?=[A-Za-z0-9/+]*\d)(?=[A-Za-z0-9/+]*[A-Za-z])[A-Za-z0-9/+]{32,}|password=\S+|https?://[^\s/@:]+:[^\s/@]+@",
            "[REDACTED]",
            text,
        )
        return ScrubResult(out, redacted=out != text)


class FakeAudit:
    def __init__(self) -> None:
        self.rows: list[dict[str, str]] = []

    def record(self, operation: str, outcome: str, *, resources: str = "", error: str = "") -> None:
        self.rows.append(
            {"operation": f"papyrus.{operation}", "outcome": outcome, "resources": resources, "error": error}
        )


class FakeHealth:
    def __init__(self) -> None:
        self.status = "healthy"
        self.issues: list[str] = []

    def mark_degraded(self, issue: str) -> None:
        self.status = "degraded"
        self.issues.append(issue)


OWNER = "U-OWNER"


@dataclass
class FakeCtx:
    """The gateway's ``AppContext`` at App Kit level 1, as Papyrus reads it.

    ``require_owner`` is the host predicate: the configured owner, as a dashboard
    subject (no app claim). Everyone else gets the host's 403 ``owner_only``.
    """

    data_dir: Path
    name: str = "papyrus"
    sdk_level: int = 1
    scrub: FakeScrub = field(default_factory=FakeScrub)
    audit: FakeAudit = field(default_factory=FakeAudit)
    health: FakeHealth = field(default_factory=FakeHealth)
    owner: str | None = OWNER
    owner_calls: list[str] = field(default_factory=list)

    async def require_owner(self, request: web.Request, operation: str) -> web.StreamResponse | None:
        self.owner_calls.append(operation)
        user = request.get("user", OWNER)
        app_claim = request.get("app", "")
        if self.owner is not None and user == self.owner and app_claim == "" and "app" in request:
            return None
        if self.owner is not None and "user" not in request and "app" not in request:
            # A test request that carries no identity is the owner's dashboard call.
            return None
        return web.json_response({"error": "owner only", "code": "owner_only"}, status=403)
