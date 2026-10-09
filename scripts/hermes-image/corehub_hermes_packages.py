"""Core Hub's image glue: Hermes's optional packages in the data volume, for a Hermes with its own
package manager (v0.21.6 and later).

Installed into the image's Hermes venv with ``corehub_hermes_packages.pth`` (which imports it at
every interpreter start) by ``scripts/hermes-image/prepare.py lazy-target`` — only for a Hermes
that needs it. Not Hermes's code; written for Core Hub
(docs/changes/2026-10-09-twuijri-hermes-0-21-6.md).

Why. The image is sealed: Hermes's venv is read-only, and ``HERMES_DISABLE_LAZY_INSTALLS=1`` says
so. Up to v2026.9.24 Hermes then installed an optional package a feature needs (Edge voices,
Bedrock, Vertex, the Matrix, Feishu, DingTalk, Teams and Google Chat channels …) into
``HERMES_LAZY_INSTALL_TARGET`` — ``/data/hermes-packages`` — and put that folder on ``sys.path``,
so it survived the container being recreated (docs/changes/2026-09-23-twuijri-sealed-image.md).
v0.21.6 retired that path: its package manager (``pm``) refuses every on-demand install while the
switch is on (its own Docker image bakes what it supports instead), and with the switch off it
builds a whole new environment generation under the Hermes home, keyed by the code's path — which
an image upgrade keeps, so the next Hermes would boot into the previous one's packages.

What this does, in Hermes's own terms and only while both variables are set:

- at start, the store goes on the END of ``sys.path`` when it was filled for this interpreter
  (the ``.python-abi`` stamp Hermes's own store carried): it can add modules, never replace one of
  the venv's;
- when Hermes asks ``pm.extras.ensure_import(<extra>)`` and its package manager declines, the
  extra's requirements — read from Hermes's own ``pyproject.toml`` — are installed into the store
  with ``pip --target``, the venv's current versions as constraints (no core package moves), and
  Hermes's answer is asked again. ``security.allow_lazy_installs: false`` in the profile's config
  still forbids it, as it always did.

It never raises at start: a failure here leaves Hermes exactly as it would be without it.
"""

from __future__ import annotations

import os
import sys

_TARGET_ENV = "HERMES_LAZY_INSTALL_TARGET"
_SEALED_ENV = "HERMES_DISABLE_LAZY_INSTALLS"
_STAMP = ".python-abi"
_WRAPPED = "_corehub_durable_store"


def _target() -> str | None:
    raw = os.environ.get(_TARGET_ENV, "").strip()
    return raw or None


def _sealed() -> bool:
    return os.environ.get(_SEALED_ENV, "").strip().lower() in ("1", "true", "yes")


def _abi() -> str:
    import sysconfig

    return f"{sys.version_info.major}.{sys.version_info.minor}:{sysconfig.get_config_var('EXT_SUFFIX') or ''}"


def _stamp_matches(target: str) -> bool:
    try:
        with open(os.path.join(target, _STAMP), encoding="utf-8") as handle:
            return handle.read().strip() == _abi()
    except OSError:
        return False


def _activate(target: str) -> None:
    """The store on the end of sys.path, its .pth files honoured (site.addsitedir puts them first)."""
    import importlib
    import site

    if target not in sys.path:
        before = list(sys.path)
        site.addsitedir(target)
        added = [entry for entry in sys.path if entry not in before]
        sys.path[:] = [entry for entry in sys.path if entry not in added] + added
    importlib.invalidate_caches()


def _extra_specs(extra: str) -> list[str]:
    """The extra's requirements from Hermes's pyproject, `hermes-agent[x]` references expanded."""
    import re
    import tomllib

    from pm.paths import repo_root

    with (repo_root() / "pyproject.toml").open("rb") as handle:
        project = tomllib.load(handle)["project"]
    name = str(project.get("name") or "hermes-agent")
    table = project.get("optional-dependencies") or {}
    own = re.compile(rf"^\s*{re.escape(name)}\s*\[([^\]]+)\]\s*$")
    specs: list[str] = []
    seen: set[str] = set()

    def walk(key: str) -> None:
        if key in seen:
            return
        seen.add(key)
        for spec in table.get(key) or ():
            match = own.match(spec)
            if match:
                for inner in match.group(1).split(","):
                    walk(inner.strip())
            elif spec not in specs:
                specs.append(spec)

    walk(extra)
    return specs


def _allowed_by_config() -> bool:
    """`security.allow_lazy_installs` in the active profile's config; unreadable means allowed,
    the rule Hermes's durable store always had."""
    try:
        from hermes_cli.config import cfg_get, load_config_readonly

        return cfg_get(load_config_readonly() or {}, "security", "allow_lazy_installs", default=True) is not False
    except Exception:
        return True


def _install(extra: str, target: str) -> None:
    import fcntl
    import importlib.metadata
    import shutil
    import subprocess
    import tempfile

    specs = _extra_specs(extra)
    if not specs:
        raise RuntimeError(f"Hermes declares no packages for {extra!r}")
    os.makedirs(target, exist_ok=True)
    with open(os.path.join(target, ".lock"), "w", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not _stamp_matches(target):
            # Filled for another interpreter (the image moved Python): its compiled modules must
            # never be imported. Empty it, keep the lock.
            for child in os.listdir(target):
                if child == ".lock":
                    continue
                path = os.path.join(target, child)
                if os.path.isdir(path) and not os.path.islink(path):
                    shutil.rmtree(path, ignore_errors=True)
                else:
                    try:
                        os.unlink(path)
                    except OSError:
                        pass
            with open(os.path.join(target, _STAMP), "w", encoding="utf-8") as stamp:
                stamp.write(_abi())
        # The venv's own versions are the constraints: nothing the store adds moves a core package.
        venv = os.path.realpath(sys.prefix)
        pins = sorted({
            f"{dist.metadata['Name']}=={dist.version}"
            for dist in importlib.metadata.distributions()
            if dist.metadata["Name"]
            and os.path.realpath(str(dist.locate_file(""))).startswith(venv + os.sep)
        })
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as handle:
            handle.write("\n".join(pins) + "\n")
            constraints = handle.name
        try:
            subprocess.run(
                [sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check",
                 "--no-input", "--target", target, "--constraint", constraints, *specs],
                check=True, stdin=subprocess.DEVNULL, timeout=900,
            )
        finally:
            os.unlink(constraints)
    _activate(target)


def _wrap(extras_module) -> None:
    original = getattr(extras_module, "ensure_import", None)
    if original is None or getattr(original, _WRAPPED, False):
        return

    def ensure_import(extra: str) -> None:
        try:
            return original(extra)
        except Exception:
            target = _target()
            if (not target or not _sealed() or not _allowed_by_config()
                    or extras_module.available(extra)
                    or not extras_module.extra_supported(extra)):
                raise
            import logging

            logging.getLogger("hermes_cli.plugins").info(
                "Installing Hermes's optional %r into %s (Core Hub's durable store)", extra, target)
            _install(extra, target)
            if not extras_module.available(extra):
                raise
            return None

    setattr(ensure_import, _WRAPPED, True)
    ensure_import.__doc__ = original.__doc__
    extras_module.ensure_import = ensure_import


class _WrappingLoader:
    def __init__(self, loader):
        self._loader = loader

    def create_module(self, spec):
        create = getattr(self._loader, "create_module", None)
        return create(spec) if create else None

    def exec_module(self, module):
        self._loader.exec_module(module)
        try:
            _wrap(module)
        except Exception:
            pass

    def __getattr__(self, name):
        return getattr(self._loader, name)


class _Finder:
    """Wraps `pm.extras` as it is imported; finds nothing else."""

    def find_spec(self, name, path=None, target=None):
        if name != "pm.extras":
            return None
        for finder in sys.meta_path:
            if finder is self or not hasattr(finder, "find_spec"):
                continue
            spec = finder.find_spec(name, path, target)
            if spec is not None:
                if spec.loader is not None and hasattr(spec.loader, "exec_module"):
                    spec.loader = _WrappingLoader(spec.loader)
                return spec
        return None


def _start() -> None:
    target = _target()
    if not target or not _sealed():
        return
    if os.path.isdir(target) and _stamp_matches(target):
        _activate(target)
    already = sys.modules.get("pm.extras")
    if already is not None:
        _wrap(already)
    elif not any(isinstance(finder, _Finder) for finder in sys.meta_path):
        sys.meta_path.insert(0, _Finder())


try:
    _start()
except Exception:  # never in Hermes's way
    pass
