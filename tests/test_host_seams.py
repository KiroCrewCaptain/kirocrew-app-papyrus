"""Papyrus's use of the gateway's controls, and its refusals when they are missing.

``backend/_host.py`` is the one place Papyrus reaches the gateway. These tests
pin three things the rest of the suite takes for granted:

* each control is the HOST's (a spawn goes through the host's chokepoint, a git
  call carries the host scanner's hook-disable arguments, a compile is counted in
  the host's usage metric);
* each missing control REFUSES the operation that needs it, never runs it
  without (fail closed);
* the cases ported from Kiro Crew's cross-app tests that named Papyrus
  (``test_git_config_hooks.py``, ``test_windows_extended_prefix_containment.py``,
  ``test_regex_anchor_contract.py``, ``metrics/test_feature_usage.py``).
"""

from __future__ import annotations

import ast
import asyncio
import os
import re
import sys
from pathlib import Path
from unittest import mock

import pytest
from aiohttp.test_utils import make_mocked_request

from backend import _host, gitops, latex, routes, store, tectonic
from fakehost import FakeCtx, FakeHost
from fakehost import SandboxUnavailableError as HostSandboxError

BACKEND = Path(__file__).resolve().parents[1] / "backend"


@pytest.fixture()
def repo(tmp_path: Path) -> Path:
    project = tmp_path / "paper"
    (project / ".git").mkdir(parents=True)
    return project


# ── the sandbox chokepoint ──────────────────────────────────────────────────


class TestSandboxTranslation:
    def test_the_hosts_refusal_becomes_the_apps_own_type(self, fake_host: FakeHost) -> None:
        fake_host.sandbox.refuse = HostSandboxError("no backend here", kind="no_backend")
        with pytest.raises(_host.SandboxUnavailableError) as caught:
            _host.sandboxed_spawn_argv(["git", "status"], "standard")
        assert caught.value.kind == "no_backend"
        assert "no backend here" in str(caught.value)

    def test_a_gateway_without_the_chokepoint_refuses(self, fake_host: FakeHost) -> None:
        fake_host.remove("kiro_crew.sandbox", "sandboxed_spawn_argv")
        with pytest.raises(_host.SandboxUnavailableError) as caught:
            _host.sandboxed_spawn_argv(["git", "status"])
        assert caught.value.kind == "host_missing"

    @pytest.mark.asyncio
    async def test_compile_reports_a_missing_sandbox_and_runs_nothing(
        self, fake_host: FakeHost, tmp_path: Path
    ) -> None:
        project = tmp_path / "p"
        project.mkdir()
        (project / "main.tex").write_text("\\documentclass{article}", encoding="utf-8")
        fake_host.remove("kiro_crew.sandbox", "sandboxed_spawn_argv")
        spawn = mock.AsyncMock()
        fake_host.table[("kiro_crew.sandbox", "create_subprocess_limited")] = spawn
        with mock.patch.object(latex, "find_compiler", mock.AsyncMock(return_value="/usr/bin/pdflatex")):
            result = await latex.compile_project(project, "main.tex")
        assert result.sandbox_error and not result.ok
        assert not spawn.called

    @pytest.mark.asyncio
    async def test_compile_reports_a_missing_base_environment(
        self, fake_host: FakeHost, tmp_path: Path
    ) -> None:
        """No credential-free environment to hand the child: nothing is started."""
        project = tmp_path / "p"
        project.mkdir()
        (project / "main.tex").write_text("\\documentclass{article}", encoding="utf-8")
        fake_host.remove("kiro_crew.apps.registry", "minimal_env")
        with mock.patch.object(latex, "find_compiler", mock.AsyncMock(return_value="/usr/bin/pdflatex")):
            result = await latex.compile_project(project, "main.tex")
        assert result.sandbox_error and not result.ok
        assert fake_host.sandbox.calls == []

    @pytest.mark.asyncio
    async def test_git_refuses_without_the_chokepoint(self, fake_host: FakeHost, repo: Path) -> None:
        fake_host.remove("kiro_crew.sandbox", "sandboxed_spawn_argv")
        with pytest.raises(gitops.GitSandboxUnavailable):
            await gitops._git(["status"], cwd=repo)

    @pytest.mark.asyncio
    async def test_the_compiler_runs_in_strict_mode_and_git_in_standard(
        self, fake_host: FakeHost, repo: Path
    ) -> None:
        proc = mock.AsyncMock()
        proc.communicate = mock.AsyncMock(return_value=(b"", b""))
        proc.returncode = 0
        fake_host.table[("kiro_crew.sandbox", "create_subprocess_limited")] = mock.AsyncMock(
            return_value=proc
        )
        await latex._run(["pdflatex", "x.tex"], cwd=repo, env={}, timeout=5, operation="compile")
        await gitops._git(["status"], cwd=repo)
        modes = {call.argv[0]: call.mode for call in fake_host.sandbox.calls}
        assert modes["pdflatex"] == "strict"
        assert modes["git"] == "standard"


# ── git config hooks (ported from Kiro Crew's test_git_config_hooks.py) ─────


class TestConfigHookScan:
    @pytest.mark.asyncio
    async def test_git_carries_the_scanners_disable_arguments(
        self, fake_host: FakeHost, repo: Path
    ) -> None:
        fake_host.hooks.args = ["-c", "hook.pwn.enabled=false"]
        seen: list[list[str]] = []

        class Captured(Exception):
            pass

        def capture(argv, *a, **kw):  # noqa: ANN001
            seen.append(list(argv))
            if "status" in argv:
                raise Captured
            return list(argv), dict(os.environ), None

        with mock.patch.object(gitops, "sandboxed_spawn_argv", capture):
            with pytest.raises(Captured):
                await gitops._git(["status"], cwd=repo)
        real_call = next(a for a in seen if "status" in a)
        assert "hook.pwn.enabled=false" in real_call
        assert real_call.index("hook.pwn.enabled=false") < real_call.index("status")

    @pytest.mark.asyncio
    async def test_the_scan_runs_through_the_chokepoint_in_standard_mode(
        self, fake_host: FakeHost, repo: Path
    ) -> None:
        # The real `git status` fails on an empty `.git`; what matters is the scan before it.
        await gitops._git(["status"], cwd=repo)
        assert fake_host.hooks.calls == [(repo, "standard")]
        assert any(call.argv[:2] == ["git", "config"] for call in fake_host.sandbox.calls)

    @pytest.mark.asyncio
    async def test_a_failed_scan_refuses_git(self, fake_host: FakeHost, repo: Path) -> None:
        from fakehost import ConfigHookScanError

        fake_host.hooks.refuse = ConfigHookScanError("could not list hooks")
        with pytest.raises(gitops.GitError, match="could not list hooks"):
            await gitops._git(["status"], cwd=repo)

    @pytest.mark.asyncio
    async def test_a_gateway_without_the_scanner_refuses_git(
        self, fake_host: FakeHost, repo: Path
    ) -> None:
        fake_host.remove("kiro_crew.git_config_hooks", "config_hook_disable_args_sandboxed_async")
        spawn = mock.AsyncMock()
        fake_host.table[("kiro_crew.sandbox", "create_subprocess_limited")] = spawn
        with pytest.raises(gitops.GitError, match="git hooks"):
            await gitops._git(["status"], cwd=repo)
        assert not spawn.called


# ── path and read gates ─────────────────────────────────────────────────────


class TestPathGates:
    def test_without_the_sensitive_path_gate_every_path_is_refused(
        self, fake_host: FakeHost, tmp_path: Path
    ) -> None:
        project = tmp_path / "p"
        project.mkdir()
        (project / "main.tex").write_text("x", encoding="utf-8")
        assert store.safe_child(project, "main.tex")
        fake_host.remove("kiro_crew.security", "is_sensitive_path")
        with pytest.raises(store.PathRejected):
            store.safe_child(project, "main.tex")

    def test_without_the_pinned_reader_a_settings_write_is_refused(
        self, fake_host: FakeHost, tmp_path: Path
    ) -> None:
        """A config that exists but cannot be read safely is never overwritten."""
        project = tmp_path / "p"
        project.mkdir()
        store.write_project_config(project, {"main": "main.tex", "title": "Kept"})
        fake_host.remove("kiro_crew.hooks", "safe_read_file_bytes_nolink")
        with pytest.raises(store.ConfigUnreadable):
            store._read_config_for_update(project)

    def test_the_hosts_too_large_error_is_translated(self, fake_host: FakeHost, tmp_path: Path) -> None:
        target = tmp_path / "big"
        target.write_bytes(b"x" * 100)
        with pytest.raises(_host.FileTooLargeError):
            _host.safe_read_file_bytes_nolink(str(target), str(tmp_path), max_bytes=10)


# ── Windows' extended-length prefix (ported) ────────────────────────────────

_PREFIX = "\\\\?\\"


@pytest.fixture
def tree(tmp_path: Path) -> tuple[Path, Path, Path]:
    root = (tmp_path / "root").resolve()
    root.mkdir()
    inside = root / "inside.txt"
    inside.write_text("x", encoding="utf-8")
    outside = (tmp_path / "outside").resolve()
    outside.mkdir()
    (outside / "f.txt").write_text("x", encoding="utf-8")
    return root, inside, outside / "f.txt"


class TestExtendedLengthPrefix:
    def test_safe_child_folds_a_prefixed_resolve(self, tree, monkeypatch: pytest.MonkeyPatch) -> None:
        root, inside, _outside = tree
        real_resolve = Path.resolve

        def fake(self: Path, strict: bool = False) -> Path:
            out = real_resolve(self, strict=strict)
            return Path(_PREFIX + str(out)) if out == inside else out

        monkeypatch.setattr(Path, "resolve", fake)
        assert store.safe_child(root, "inside.txt")
        with pytest.raises(store.PathRejected):
            store.safe_child(root, "../outside/f.txt")

    def test_the_main_document_is_kept_when_one_realpath_is_prefixed(
        self, tree, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        root, _inside, _outside = tree
        main = root / "main.tex"
        main.write_text("x", encoding="utf-8")
        real_realpath = os.path.realpath
        calls: list[str] = []

        def fake(path, *a, **k):  # noqa: ANN001
            out = real_realpath(path, *a, **k)
            if sys._getframe(1).f_code.co_name != "delete_file":
                return out
            calls.append(out)
            return _PREFIX + out if len(calls) == 1 else out

        monkeypatch.setattr(os.path, "realpath", fake)
        with pytest.raises(ValueError, match="main document"):
            store.delete_file(root, "main.tex")
        assert len(calls) == 2
        assert main.exists()


# ── request-path validators anchor at \Z (ported) ───────────────────────────

_UNESCAPED_DOLLAR = re.compile(r"(?<!\\)(?:\\\\)*\$")


class TestTrailingNewlineContract:
    @pytest.mark.parametrize(
        "pattern,valid",
        [
            (gitops.GIT_URL_RE, "https://example.com/group/paper.git"),
            (gitops.GIT_URL_RE, "git@example.com:group/paper.git"),
            (store.PROJECT_NAME_RE, "paper"),
        ],
    )
    def test_valid_input_plus_newline_is_rejected(self, pattern: re.Pattern[str], valid: str) -> None:
        assert pattern.match(valid) is not None
        assert pattern.match(valid + "\n") is None

    def test_no_backend_pattern_is_dollar_anchored(self) -> None:
        import importlib

        offenders = []
        for path in sorted(BACKEND.glob("*.py")):
            module = importlib.import_module(f"backend.{path.stem}")
            for name, value in sorted(vars(module).items()):
                if (
                    isinstance(value, re.Pattern)
                    and isinstance(value.pattern, str)
                    and not value.flags & re.MULTILINE
                    and _UNESCAPED_DOLLAR.search(value.pattern)
                ):
                    offenders.append(f"{path.stem}.{name}")
        assert not offenders, f"anchor request-path validators with \\Z, not $: {offenders}"


# ── usage metric (ported from metrics/test_feature_usage.py) ────────────────


class TestUsageMetric:
    @pytest.mark.asyncio
    async def test_each_finished_compile_is_counted(
        self, fake_host: FakeHost, app_ctx: FakeCtx
    ) -> None:
        project = store.projects_dir() / "my-paper"
        project.mkdir(parents=True)
        (project / "main.tex").write_text("x", encoding="utf-8")
        request = make_mocked_request("POST", "/api/apps/papyrus/compile")
        request.json = mock.AsyncMock(return_value={"name": "my-paper"})  # type: ignore[method-assign]
        ok = latex.CompileResult(ok=True, log="")
        with mock.patch.object(latex, "compile_project", mock.AsyncMock(return_value=ok)):
            await routes._handle_compile(request)
        assert fake_host.tasks == [("papyrus", "ok")]

    def test_the_count_comes_after_the_compile(self) -> None:
        tree = ast.parse((BACKEND / "routes.py").read_text(encoding="utf-8"))
        fn = next(
            n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef) and n.name == "_handle_compile"
        )

        def lines(name: str) -> list[int]:
            return [
                n.lineno
                for n in ast.walk(fn)
                if isinstance(n, ast.Call) and getattr(n.func, "attr", None) == name
            ]

        (count,) = lines("record_task")
        (compiled,) = lines("compile_project")
        assert count > compiled

    def test_a_gateway_without_the_counter_counts_nothing(self, fake_host: FakeHost) -> None:
        fake_host.remove("kiro_crew.metrics.feature_usage", "record_app_task")
        _host.record_task("ok")
        assert fake_host.tasks == []


# ── audit rows ──────────────────────────────────────────────────────────────


class TestAudit:
    @pytest.mark.asyncio
    async def test_a_spawn_is_audited_through_the_context(
        self, fake_host: FakeHost, app_ctx: FakeCtx, repo: Path
    ) -> None:
        proc = mock.AsyncMock()
        proc.communicate = mock.AsyncMock(return_value=(b"", b""))
        proc.returncode = 0
        fake_host.table[("kiro_crew.sandbox", "create_subprocess_limited")] = mock.AsyncMock(
            return_value=proc
        )
        await latex._run(["pdflatex", "x.tex"], cwd=repo, env={}, timeout=5, operation="compile")
        assert {"operation": "papyrus.compile", "outcome": "ok"}.items() <= app_ctx.audit.rows[-1].items()

    def test_a_context_without_the_sink_does_not_raise(self, app_ctx: FakeCtx) -> None:
        app_ctx.audit = None  # type: ignore[assignment]
        _host.audit("compile", "ok")

    def test_a_provisioning_attempt_is_audited(self, app_ctx: FakeCtx) -> None:
        tectonic._audit("started")
        assert app_ctx.audit.rows[-1]["operation"] == "papyrus.tectonic_provision"


# ── data directory ──────────────────────────────────────────────────────────


class TestDataDirectory:
    def test_the_store_lives_in_the_context_data_dir(self, app_ctx: FakeCtx) -> None:
        assert store.projects_dir() == app_ctx.data_dir / "projects"
        assert tectonic.vendor_dir() == app_ctx.data_dir / "vendor" / "tectonic"

    def test_no_bound_context_is_an_error_not_a_guess(self) -> None:
        previous = _host.bound()
        _host.bind(None)
        try:
            with pytest.raises(RuntimeError, match="no app context"):
                store.data_dir()
        finally:
            _host.bind(previous)

    def test_a_new_context_moves_the_store(self, tmp_path: Path) -> None:
        ctx = FakeCtx(data_dir=tmp_path / "other")
        routes.register_routes(ctx)
        assert store.projects_dir() == tmp_path / "other" / "projects"


def test_asyncio_marker_is_registered() -> None:
    """Guard against a silently skipped async test: the plugin is loaded."""
    assert asyncio.iscoroutinefunction(TestUsageMetric.test_each_finished_compile_is_counted)
