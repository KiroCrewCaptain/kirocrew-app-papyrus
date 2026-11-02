"""Every place Papyrus reaches into the Kiro Crew gateway, in one module.

An external app's Python runs inside the gateway process. Papyrus needs two
kinds of host surface:

1. **The App Kit context** handed to its hooks (``ctx``): the data directory,
   the owner gate (``ctx.require_owner``), the audit log (``ctx.audit``) and
   outbound redaction (``ctx.scrub``). These are public seams; each is read off
   the context with ``getattr`` and has a fallback that is never MORE permissive
   than the host: no owner gate refuses everyone, no scrubber withholds the
   text, no audit sink logs locally.

2. **Security controls that have no App Kit seam yet.** Papyrus runs a TeX
   compiler and ``git`` over content that may have arrived by ``git clone`` from
   anywhere, so every child goes through the gateway's OS sandbox chokepoint,
   every path through its sensitive-path gate, and the managed compiler through
   its verified downloader. Copying those controls into this repository would
   leave a security control that looks present and drifts from the one the
   gateway enforces, so they are imported from the running gateway instead, and
   only here (``tests/test_no_host_imports.py`` pins that). Each import is lazy
   and resolved at call time through :func:`_host_attr`; when the gateway does
   not provide one, the operation that needs it is REFUSED (compile, git and the
   compiler install answer "sandbox unavailable", a path reads as sensitive, a
   config read fails), never run without it. ``PORTING.md`` lists each one as a
   gap with the generic seam that would replace it.

Everything else Papyrus used from the gateway is either replaced by the context
above or restated in ``_compat.py`` (small, non-security helpers).
"""

from __future__ import annotations

import importlib
import logging
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

logger = logging.getLogger("kirocrew.app.papyrus")

APP_NAME = "papyrus"

#: The App Kit seam level this app is written against.
REQUIRED_SDK_LEVEL = 1

#: Shown when the gateway lacks the sandboxed spawn chain. Names the cause and
#: what the operator can do, without an internal module path.
NO_HOST_SANDBOX = (
    "This Kiro Crew does not provide the sandboxed process launch Papyrus needs "
    "to run the compiler and git safely, so nothing was run. Update Kiro Crew."
)


# ── host resolution ─────────────────────────────────────────────────────────


def _host_attr(module: str, name: str) -> Any | None:
    """``module.name`` from the running gateway, or ``None`` when it has none.

    The one seam tests replace: a fake host answers here, so no test needs a
    Kiro Crew install.
    """
    try:
        mod = importlib.import_module(module)
    except Exception:  # noqa: BLE001 - any import failure means "not provided"
        return None
    return getattr(mod, name, None)


class HostCapabilityMissing(RuntimeError):
    """The gateway does not provide a control this operation requires."""


def _required(module: str, name: str) -> Any:
    value = _host_attr(module, name)
    if value is None:
        raise HostCapabilityMissing(f"{module}.{name}")
    return value


class _HostModule:
    """A host module resolved attribute by attribute at call time.

    A missing attribute raises :class:`HostCapabilityMissing`, so a caller that
    needs it fails instead of running without it. A test sets an attribute on
    the instance to replace one function.
    """

    def __init__(self, module: str) -> None:
        self._module = module

    def __getattr__(self, name: str) -> Any:
        if name.startswith("__"):
            raise AttributeError(name)
        return _required(self._module, name)


#: The gateway's verified downloader and its descriptor-pinned file helpers,
#: used only by the managed Tectonic install (``tectonic.py``).
asset_downloader = _HostModule("kiro_crew.asset_downloader")
pinned_fs = _HostModule("kiro_crew.pinned_fs")


# ── route records ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Route:
    """One ``hooks.routes`` record, accepted structurally by the gateway.

    A level-1 ``RouteRegistry`` takes any record with a str ``method``, a str
    ``path`` (relative to ``/api/apps/papyrus``) and a callable
    ``handler(request, ctx)``.
    """

    method: str
    path: str
    handler: Callable[[Any, Any], Awaitable[Any]]


#: What each group of host controls is needed for, for the health report.
_CAPABILITIES: tuple[tuple[str, tuple[tuple[str, str], ...]], ...] = (
    (
        "compiling and git are refused: this Kiro Crew has no sandboxed process launch",
        (
            ("kiro_crew.sandbox", "sandboxed_spawn_argv"),
            ("kiro_crew.sandbox", "shielded_prepare_off_loop"),
            ("kiro_crew.sandbox", "create_subprocess_limited"),
            ("kiro_crew.apps.registry", "minimal_env"),
            ("kiro_crew.security", "sensitive_home_dirs"),
            ("kiro_crew.config.loader", "config_dir"),
        ),
    ),
    (
        "git is refused: this Kiro Crew cannot check a repository's git hooks",
        (("kiro_crew.git_config_hooks", "config_hook_disable_args_sandboxed_async"),),
    ),
    (
        "every file is refused: this Kiro Crew has no sensitive-path gate",
        (("kiro_crew.security", "is_sensitive_path"),),
    ),
    (
        "paper settings cannot be read: this Kiro Crew has no pinned file reader",
        (("kiro_crew.hooks", "safe_read_file_bytes_nolink"),),
    ),
    (
        "the one-click compiler install is refused: this Kiro Crew has no verified downloader",
        (
            ("kiro_crew.asset_downloader", "download_to"),
            ("kiro_crew.asset_downloader", "open_staging_nofollow"),
            ("kiro_crew.asset_downloader", "install_verified"),
            ("kiro_crew.pinned_fs", "fd_real_path"),
        ),
    ),
)


def capability_issues(ctx: Any) -> list[str]:
    """Why this gateway serves Papyrus only in part; ``[]`` when it serves all of it."""
    issues: list[str] = []
    if sdk_level(ctx) < REQUIRED_SDK_LEVEL or not callable(getattr(ctx, "require_owner", None)):
        issues.append(
            "every request is refused: this Kiro Crew has no owner gate for apps "
            f"(App Kit level {sdk_level(ctx)}, Papyrus needs {REQUIRED_SDK_LEVEL})"
        )
    if not redaction_available_on(ctx):
        issues.append("compiler and git output is withheld: this Kiro Crew has no redaction seam")
    for issue, names in _CAPABILITIES:
        if any(not callable(_host_attr(module, name)) for module, name in names):
            issues.append(issue)
    return issues


# ── the bound app context ───────────────────────────────────────────────────

_ctx: Any | None = None
_ctx_lock = threading.Lock()


def bind(ctx: Any) -> None:
    """Remember the context the gateway handed to ``register_routes``.

    Papyrus's work reaches the context from places no request passes through
    (the compiler-install thread, the git and compiler runners), so the context
    is held here. A later context replaces an earlier one: an update or a
    re-enable hands a fresh one.
    """
    global _ctx
    with _ctx_lock:
        _ctx = ctx


def bound() -> Any | None:
    with _ctx_lock:
        return _ctx


def data_dir() -> Path:
    """The app's data directory (``<data home>/apps/papyrus/data``).

    Raises when no context is bound rather than guessing a location: a guess
    would put papers somewhere the gateway does not manage.
    """
    ctx = bound()
    path = getattr(ctx, "data_dir", None)
    if path is None:
        raise RuntimeError("papyrus: no app context is bound")
    return Path(path)


def sdk_level(ctx: Any) -> int:
    """The seam level the gateway reports; 0 for a gateway that predates the field."""
    level = getattr(ctx, "sdk_level", 0)
    return level if isinstance(level, int) and not isinstance(level, bool) else 0


# ── owner gate ──────────────────────────────────────────────────────────────


async def require_owner(ctx: Any, request: Any, operation: str) -> Any | None:
    """``None`` when the caller is the dashboard owner, else the refusal to return.

    *operation* is bare (``"compile"``): the host prefixes the app name when it
    audits a denial. A gateway without the seam refuses everyone.
    """
    gate = getattr(ctx, "require_owner", None)
    if not callable(gate):
        from aiohttp import web

        return web.json_response(
            {"error": "owner authorization required", "code": "owner_only"}, status=403
        )
    return await gate(request, operation)


# ── outbound redaction ──────────────────────────────────────────────────────


def redact(text: str) -> str | None:
    """*text* through the gateway's active redaction policy, or ``None``.

    ``None`` means the text must be withheld: the context has no scrubber, or the
    scrubber raised (a host whose companion policy could not compose raises on
    purpose, and the answer to that is not to show the text unscanned).
    """
    scrub = getattr(bound(), "scrub", None)
    outbound = getattr(scrub, "outbound", None)
    if not callable(outbound):
        return None
    try:
        result = outbound(text)
    except Exception:  # noqa: BLE001 - fail closed: withhold, never forward unscanned
        logger.warning("papyrus: redaction failed; output withheld")
        return None
    cleaned = getattr(result, "text", None)
    return cleaned if isinstance(cleaned, str) else None


def redaction_available_on(ctx: Any) -> bool:
    scrub = getattr(ctx, "scrub", None)
    return callable(getattr(scrub, "outbound", None))


# ── audit ───────────────────────────────────────────────────────────────────


def audit(operation: str, outcome: str, *, resources: str = "", error: str = "") -> None:
    """One security-event row through ``ctx.audit``. Fire-and-forget.

    *operation* is bare; the host records it as ``papyrus.<operation>``.
    """
    sink = getattr(bound(), "audit", None)
    record = getattr(sink, "record", None)
    if not callable(record):
        logger.info("papyrus: %s %s (no audit sink)", operation, outcome)
        return
    try:
        record(operation, outcome, resources=resources[:200], error=error[:200] if error else "")
    except Exception:  # noqa: BLE001 - auditing must never break the operation
        logger.debug("papyrus: audit emit failed", exc_info=True)


# ── usage counter ───────────────────────────────────────────────────────────


def record_task(outcome: str) -> None:
    """Count one finished compile in the gateway's feature-usage metrics.

    Best effort and optional: a gateway without the counter counts nothing.
    """
    record = _host_attr("kiro_crew.metrics.feature_usage", "record_app_task")
    if not callable(record):
        return
    try:
        record(APP_NAME, outcome)
    except Exception:  # noqa: BLE001 - a metric must never fail a compile
        logger.debug("papyrus: usage count failed", exc_info=True)


# ── sandboxed child processes ───────────────────────────────────────────────


class SandboxUnavailableError(RuntimeError):
    """No child was started: the gateway could not (or cannot) sandbox it.

    ``kind`` is the host's own classification when it refused
    (``"no_backend"``, ``"transient"``, ...), or ``"host_missing"`` when the
    gateway has no sandboxed spawn chain at all.
    """

    def __init__(self, message: str, *, kind: str = "host_missing") -> None:
        super().__init__(message)
        self.kind = kind


def _host_sandbox_errors() -> tuple[type[BaseException], ...]:
    err = _host_attr("kiro_crew.sandbox", "SandboxUnavailableError")
    return (err,) if isinstance(err, type) and issubclass(err, BaseException) else ()


def _translate(exc: BaseException) -> SandboxUnavailableError:
    return SandboxUnavailableError(str(exc), kind=str(getattr(exc, "kind", "") or "no_backend"))


def sandboxed_spawn_argv(
    argv: list[str], mode: str = "standard", **kwargs: Any
) -> tuple[list[str], dict[str, str], str | None]:
    """The gateway's sandbox chokepoint: ``(wrapped argv, scrubbed env, cleanup path)``.

    Raises :class:`SandboxUnavailableError` when the host refuses or lacks it.
    """
    impl = _host_attr("kiro_crew.sandbox", "sandboxed_spawn_argv")
    if not callable(impl):
        raise SandboxUnavailableError(NO_HOST_SANDBOX)
    try:
        return impl(argv, mode, **kwargs)
    except _host_sandbox_errors() as exc:
        raise _translate(exc) from exc


async def shielded_prepare_off_loop(
    prepare: Callable[[], tuple[list[str], dict[str, str], str | None]],
    *,
    executor: Any = None,
) -> tuple[list[str], dict[str, str], str | None]:
    """Run a spawn preparation off the event loop, shielded from cancellation."""
    impl = _host_attr("kiro_crew.sandbox", "shielded_prepare_off_loop")
    if not callable(impl):
        raise SandboxUnavailableError(NO_HOST_SANDBOX)
    try:
        return await impl(prepare, executor=executor)
    except _host_sandbox_errors() as exc:
        raise _translate(exc) from exc


async def create_subprocess_limited(*argv: str, **kwargs: Any) -> Any:
    """``asyncio.create_subprocess_exec`` with the gateway's resource limits."""
    impl = _host_attr("kiro_crew.sandbox", "create_subprocess_limited")
    if not callable(impl):
        raise SandboxUnavailableError(NO_HOST_SANDBOX)
    return await impl(*argv, **kwargs)


def host_platform(name: str) -> Any | None:
    """One of the gateway's ``platform_compat`` helpers, or ``None`` (see ``_compat``)."""
    return _host_attr("kiro_crew.platform_compat", name)


def subprocess_executor() -> Any:
    """The gateway's bounded pool for subprocess-related blocking work.

    ``None`` (the loop's default pool) on a gateway without one.
    """
    impl = _host_attr("kiro_crew.executors", "subprocess_executor")
    return impl() if callable(impl) else None


def minimal_env(**extra: str) -> dict[str, str]:
    """The gateway's credential-free base environment for a child, plus *extra*."""
    impl = _host_attr("kiro_crew.apps.registry", "minimal_env")
    if not callable(impl):
        raise SandboxUnavailableError(NO_HOST_SANDBOX)
    return impl(**extra)


def sensitive_home_dirs() -> tuple[str, ...]:
    """The gateway's read+write-blocked home-relative paths."""
    impl = _host_attr("kiro_crew.security", "sensitive_home_dirs")
    if not callable(impl):
        raise SandboxUnavailableError(NO_HOST_SANDBOX)
    return tuple(impl())


def data_home() -> Path:
    """The live Kiro Crew data home (``KIROCREW_HOME`` or ``~/.kiro/crew``)."""
    impl = _host_attr("kiro_crew.config.loader", "config_dir")
    if not callable(impl):
        raise SandboxUnavailableError(NO_HOST_SANDBOX)
    return Path(impl())


# ── path and read gates ─────────────────────────────────────────────────────


def is_sensitive_path(path: str) -> bool:
    """The gateway's sensitive-path gate. ``True`` (refuse) when it has none."""
    impl = _host_attr("kiro_crew.security", "is_sensitive_path")
    if not callable(impl):
        return True
    return bool(impl(path))


class FileTooLargeError(Exception):
    """A read exceeded its byte cap (also raised for the host's own type)."""


def safe_read_file_bytes_nolink(
    path: str, within_root: str, *, max_bytes: int, within_root_is_canonical: bool = False
) -> bytes | None:
    """The gateway's descriptor-pinned, link-refusing file read.

    ``None`` for an absent or refused file, as the host answers. Raises
    ``OSError`` when the gateway has no such reader, so the caller treats the
    file as unreadable rather than reading it by name.
    """
    impl = _host_attr("kiro_crew.hooks", "safe_read_file_bytes_nolink")
    if not callable(impl):
        raise OSError("papyrus: the gateway provides no pinned file reader")
    host_too_large = _host_attr("kiro_crew.hooks", "FileTooLargeError")
    too_large: tuple[type[BaseException], ...] = (
        (host_too_large,)
        if isinstance(host_too_large, type) and issubclass(host_too_large, BaseException)
        else ()
    )
    try:
        return impl(
            path,
            within_root,
            max_bytes=max_bytes,
            within_root_is_canonical=within_root_is_canonical,
        )
    except too_large as exc:
        raise FileTooLargeError(str(exc)) from exc


# ── git config hooks ────────────────────────────────────────────────────────


class ConfigHookScanError(RuntimeError):
    """The repository's config hooks could not be enumerated, so git must not run."""


async def config_hook_disable_args_sandboxed_async(
    cwd: Path, *, spawn_argv: Callable[..., Any], mode: str
) -> list[str]:
    """``-c`` arguments disabling every config-defined hook git can see in *cwd*.

    The scan itself runs through *spawn_argv* (the sandbox chokepoint). A gateway
    without the scanner refuses: git is not run with hooks it could not list.
    """
    impl = _host_attr("kiro_crew.git_config_hooks", "config_hook_disable_args_sandboxed_async")
    if not callable(impl):
        raise ConfigHookScanError(
            "This Kiro Crew cannot check the repository's git hooks, so git was not run. "
            "Update Kiro Crew."
        )
    host_err = _host_attr("kiro_crew.git_config_hooks", "ConfigHookScanError")
    scan_errors: tuple[type[BaseException], ...] = (
        (host_err,) if isinstance(host_err, type) and issubclass(host_err, BaseException) else ()
    )
    try:
        return list(await impl(cwd, spawn_argv=spawn_argv, mode=mode))
    except scan_errors as exc:
        raise ConfigHookScanError(str(exc)) from exc
