"""Version-aware steps of the image's Hermes stage (packages/server/Dockerfile).

Run with the Hermes venv's interpreter from the Hermes checkout (the current directory):

    python prepare.py stamp <ref>                 before the checkout's .git is removed
    python prepare.py channel-specs <feature>...  the PyPI specs of the channels the image carries
    python prepare.py channel-check <feature>...  Hermes's own answer: are they installed?
    python prepare.py lazy-target                 Core Hub's durable optional-package store, when needed
    python prepare.py pm-tools <dir>              Hermes's own pinned Node and npm, sealed

Features are the image's channel names (``platform.telegram``, ``platform.discord``,
``platform.slack``). Every step works for both layouts Hermes has shipped
(docs/changes/2026-10-09-twuijri-hermes-0-21-6.md):

- up to v2026.9.24 (the floor, v2026.9.14, included): ``tools/lazy_deps.py`` holds the
  ``LAZY_DEPS`` table Hermes installs a channel's client from on first use, ``is_available`` is
  what it asks first, and ``pyproject.toml`` carries the release's version;
- from v0.21.6: lazy installs belong to Hermes's package manager (``pm``). A channel's client is
  the pyproject extra of the same name (``telegram``, ``discord``, ``slack``), ``pm.extras.available``
  is what Hermes asks before it would install one, the ``messaging`` extra is the set Hermes's own
  Docker image bakes, and ``pyproject.toml`` says ``0.0.0``: the version comes from an install
  stamp (``install-stamp.json``) or the checkout's git tags.
"""

from __future__ import annotations

import importlib
import re
import subprocess
import sys
import tomllib
from pathlib import Path

ROOT = Path.cwd()
sys.path.insert(0, str(ROOT))

# The module that proves each channel's client imports (the gateway adapter's own import).
MODULES = {"platform.telegram": "telegram.ext", "platform.discord": "discord", "platform.slack": "slack_bolt"}
SEMVER_TAG = re.compile(r"^v(\d{1,3}\.\d+\.\d+)$")


def _project() -> dict:
    with (ROOT / "pyproject.toml").open("rb") as handle:
        return tomllib.load(handle)["project"]


def _legacy_table() -> dict | None:
    """The LAZY_DEPS table of a Hermes up to v2026.9.24, or None for a later one."""
    try:
        from tools.lazy_deps import LAZY_DEPS  # type: ignore[attr-defined]
    except ImportError:
        return None
    return LAZY_DEPS


def stamp(ref: str) -> None:
    """Gives a Hermes whose pyproject has no version (v0.21.6 on) the release's version.

    Without it, a checkout with no .git (the image removes it) prints ``Hermes Agent vunknown
    (<release date>)``, and the hub would read the date as the version. The stamp is the file
    Hermes's own packagers write, with the script they use; ``external``: the image is replaced,
    never updated in place. No ``--distribution``: ``docker`` (or ``nix``) tells Hermes's package
    manager a packaged runtime of its own ships beside the code (``pm/runtime.py``
    §_resident_runtime), which this image does not have, and every package operation then fails.
    """
    version = str(_project().get("version") or "")
    if version and version != "0.0.0":
        print(f"stamp: pyproject says {version}; nothing to write")
        return
    match = SEMVER_TAG.match(ref)
    writer = ROOT / "scripts" / "write_install_stamp.py"
    if not match or not writer.is_file():
        raise SystemExit(f"stamp: {ref} has no version in pyproject.toml and is not a vX.Y.Z tag")
    subprocess.run(
        [sys.executable, str(writer), "--output", str(ROOT / "install-stamp.json"),
         "--base-version", match.group(1), "--distance", "0", "--update-mechanism", "external"],
        check=True,
    )


def channel_specs(features: list[str]) -> list[str]:
    table = _legacy_table()
    if table is not None:
        return [spec for feature in features for spec in table[feature]]
    extras = _project().get("optional-dependencies", {})
    if "messaging" in extras:
        return list(extras["messaging"])
    return [spec for feature in features for spec in extras[feature.removeprefix("platform.")]]


def channel_check(features: list[str]) -> None:
    for feature in features:
        if feature in MODULES:
            importlib.import_module(MODULES[feature])
    if _legacy_table() is not None:
        from tools import lazy_deps

        missing = [lazy_deps.feature_missing(f) for f in features if not lazy_deps.is_available(f)]
    else:
        from pm.extras import available

        missing = [f for f in features if not available(f.removeprefix("platform."))]
    if missing:
        raise SystemExit(f"channel clients Hermes does not see as installed: {missing}")
    print("channels installed:", " ".join(features))


def lazy_target() -> None:
    """Installs ``corehub_hermes_packages`` (beside this file) into the venv, for a Hermes whose
    own durable optional-package store is gone (v0.21.6 on); a Hermes that still has it (the
    floor) keeps its own and gets nothing."""
    import shutil
    import sysconfig

    if _legacy_table() is not None or not (ROOT / "pm" / "extras.py").is_file():
        print("lazy-target: this Hermes keeps its own durable store; nothing to install")
        return
    site_packages = Path(sysconfig.get_paths()["purelib"])
    shutil.copyfile(Path(__file__).with_name("corehub_hermes_packages.py"),
                    site_packages / "corehub_hermes_packages.py")
    (site_packages / "corehub_hermes_packages.pth").write_text("import corehub_hermes_packages\n", encoding="utf-8")
    print(f"lazy-target: installed into {site_packages}")


def pm_tools(folder: str) -> None:
    """Stages Hermes's own pinned Node and npm, read-only, for a Hermes with a package
    manager (v0.21.6 on): ``<folder>/store`` is the store (the image's ``HERMES_RUNTIME_DIR``) and
    ``<folder>/manifest.json`` beside it marks it sealed.

    That Hermes never runs a Node from ``PATH``: a bare ``npx``/``node``/``npm`` MCP server, the
    WhatsApp bridge and every other Node user resolve its package manager's pinned copy
    (``hermes_constants.find_node_executable``, ``tools/mcp_tool_config.py`` §_managed_launcher)
    and, in a sealed image, cannot download it. Hermes's own Docker image stages its tools the same
    way (``ensure(name, explicit=True)``). A store with a ``manifest.json`` beside it is Hermes's
    sealed layout (``pm/paths.py`` §writable_store_root, ``pm.install.sealed``): it is only read,
    and whatever its package manager must write — locks, a plugin's environment — goes to the
    Hermes home's own ``tools/``. Hermes also counts its pinned ffmpeg (126 MB) and ripgrep among
    the tools an install must have; neither is staged (the image never carried that ffmpeg; its own
    ripgrep stays, and staging Hermes's pulls in a second 390 MB CPython), and Hermes says so on its
    startup line. What no Node user needs goes:
    the C headers (addon builds fetch their own), the docs, and the npm and corepack Node bundles
    (Hermes's npm is the separate ``npm`` package beside it).
    """
    import json
    import os
    import shutil
    import tempfile

    if not (ROOT / "pm" / "install.py").is_file():
        print("pm-tools: this Hermes runs the Node on PATH; nothing to stage")
        return
    store = str(Path(folder) / "store")
    home = tempfile.mkdtemp(prefix="hermes-pm-build-")
    os.environ["HERMES_RUNTIME_DIR"] = store
    os.environ["HERMES_HOME"] = home
    try:
        import hermes_bootstrap  # noqa: F401  (every Hermes entry point imports it first)
        from pm.install import ensure

        ensure("npm", explicit=True)
        from pm import installed_package

        node = installed_package("node")
        if node is None or installed_package("npm") is None:
            raise SystemExit("pm-tools: Hermes does not see its Node and npm as installed")
        for rel in ("include", "share", "lib/node_modules/npm", "lib/node_modules/corepack",
                    "bin/npm", "bin/npx", "bin/corepack", "CHANGELOG.md", "README.md"):
            target = node.path / rel
            if target.is_dir() and not target.is_symlink():
                shutil.rmtree(target)
            elif target.exists() or target.is_symlink():
                target.unlink()
        # Only these two, for the image's size: a future Hermes whose Node pulled more in (its
        # CPython is 390 MB) fails the build here instead of growing the image unnoticed.
        (Path(store) / ".install.lock").unlink(missing_ok=True)
        others = sorted(p.name for p in Path(store).iterdir()
                        if p.name != "facts.json" and not p.name.startswith(("node-", "npm-")))
        if others:
            raise SystemExit(f"pm-tools: the store holds more than Node and npm: {others}")
        (Path(folder) / "manifest.json").write_text(json.dumps({
            "about": "Core Hub's sealed copy of the tools Hermes's package manager pins "
                     "(scripts/hermes-image/prepare.py pm-tools); read-only.",
            "store": "store",
        }, indent=2) + "\n", encoding="utf-8")
        # Staged by root with owner-only files (facts.json is 0600): every user reads them in the
        # image, nobody but root writes them.
        for current, _dirs, filenames in os.walk(folder):
            os.chmod(current, (os.stat(current).st_mode | 0o555) & ~0o022)
            for name in filenames:
                file = Path(current) / name
                if not file.is_symlink():
                    os.chmod(file, (file.stat().st_mode | 0o444) & ~0o022)
        # As the image's runtime user will: not root, lazy installs off, a fresh home.
        probe = ("import hermes_bootstrap\n"
                 "from hermes_constants import find_node_executable as find\n"
                 "from pm.paths import writable_store_root\n"
                 "missing = [c for c in ('node', 'npm', 'npx') if not find(c)]\n"
                 "assert not missing, f'no {missing} for a user who is not root'\n"
                 f"assert str(writable_store_root()).startswith('/tmp/pm-tools-check'), writable_store_root()\n")
        subprocess.run(["runuser", "-u", "nobody", "--", sys.executable, "-c", probe], check=True, cwd="/",
                       env={"PATH": os.environ.get("PATH", ""), "HOME": "/tmp", "HERMES_HOME": "/tmp/pm-tools-check",
                            "HERMES_RUNTIME_DIR": store, "HERMES_DISABLE_LAZY_INSTALLS": "1"})
        print(f"pm-tools: Node {node.version} and npm staged, sealed, in {store}")
    finally:
        shutil.rmtree(home, ignore_errors=True)
        shutil.rmtree("/tmp/pm-tools-check", ignore_errors=True)


def main(argv: list[str]) -> None:
    if not argv or (argv[0] != "lazy-target" and len(argv) < 2):
        raise SystemExit(__doc__)
    command, args = argv[0], argv[1:]
    if command == "stamp":
        stamp(args[0])
    elif command == "channel-specs":
        print(" ".join(channel_specs(args)))
    elif command == "channel-check":
        channel_check(args)
    elif command == "lazy-target":
        lazy_target()
    elif command == "pm-tools":
        pm_tools(args[0])
    else:
        raise SystemExit(f"unknown command: {command}")


if __name__ == "__main__":
    main(sys.argv[1:])
