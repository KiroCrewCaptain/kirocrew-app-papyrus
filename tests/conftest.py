"""Test session setup: the app root on ``sys.path``, and a fake gateway.

The gateway loads hook files into a synthetic package named after the app, so
the backend never needs to be on ``sys.path`` there. A plain pytest run has no
such loader, so the app root is put on the path for the test session only.

Every test runs against :class:`fakehost.FakeHost` (the host controls
``backend/_host.py`` resolves) and a bound :class:`fakehost.FakeCtx` whose
``data_dir`` is a fresh temporary directory, so no test reads or writes a real
data home and none needs Kiro Crew installed.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Iterator

import pytest

TESTS = Path(__file__).resolve().parent
APP_ROOT = TESTS.parent
for entry in (str(APP_ROOT), str(TESTS)):
    if entry not in sys.path:
        sys.path.insert(0, entry)

from backend import _host, latex, tectonic  # noqa: E402
from fakehost import FakeCtx, FakeHost  # noqa: E402


@pytest.fixture(autouse=True)
def fake_host(tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch) -> FakeHost:
    """The fake gateway every ``_host`` lookup answers from."""
    host = FakeHost(tmp_path_factory.mktemp("data-home"))
    monkeypatch.setattr(_host, "_host_attr", host.attr)
    return host


@pytest.fixture(autouse=True)
def app_ctx(tmp_path_factory: pytest.TempPathFactory) -> Iterator[FakeCtx]:
    """A bound app context whose data dir is a fresh temporary directory."""
    ctx = FakeCtx(data_dir=tmp_path_factory.mktemp("papyrus-data"))
    previous = _host.bound()
    _host.bind(ctx)
    latex.reset_compiler_cache()
    tectonic.reset_provision_state()
    yield ctx
    _host.bind(previous)
    latex.reset_compiler_cache()
    tectonic.reset_provision_state()
