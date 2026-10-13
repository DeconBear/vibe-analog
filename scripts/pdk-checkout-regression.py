#!/usr/bin/env python3
"""Offline regression for the nightly workflow's public PDK submodule transport."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
from unittest.mock import patch


def main() -> None:
    workflow = (Path(__file__).resolve().parents[1]
                / ".github/workflows/ic-platform-nightly.yml").read_text(encoding="utf-8")
    # Execute the real checkout step against a fake lock without downloading PDKs.
    source = textwrap.dedent(workflow.split("python - <<'PY'\n", 1)[1].split("          PY\n", 1)[0])
    lock = {"open_pdks": {"sky130": {
        "repository": "https://github.com/google/skywater-pdk.git",
        "revision": "1" * 40,
    }}}
    with patch.object(Path, "read_text", return_value=json.dumps(lock)), \
            patch.object(Path, "mkdir"), patch.object(subprocess, "run") as run:
        exec(compile(source, "nightly-pdk-checkout", "exec"), {})
    commands = [call.args[0] for call in run.call_args_list]
    assert all(call.kwargs.get("check") is True for call in run.call_args_list)
    assert ["git", "-C", "output/pdks/sky130", "fetch", "--depth", "1",
            "origin", "1" * 40] in commands, "Preserve the locked source revision"
    command, = [command for command in commands if "submodule" in command]
    assert command[-4:] == ["submodule", "update", "--init", "--recursive"]
    config = command[1:command.index("-C")]
    assert config, "Recursive checkout must configure public SSH URLs as HTTPS"

    # Ask real Git to resolve each URL, including inside a spawned Git process.
    # Isolate the test from user/system config; no network or credentials needed.
    with tempfile.TemporaryDirectory(prefix="pdk-checkout-") as temporary:
        root = Path(temporary)
        env = {key: value for key, value in os.environ.items()
               if not key.startswith("GIT_CONFIG")}
        env.update(HOME=str(root), XDG_CONFIG_HOME=str(root),
                   GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
        def git(*args: str) -> str:
            return subprocess.check_output(["git", "-C", str(root), *args],
                                           env=env, text=True).strip()
        git("init", "--quiet")
        for original, expected in [
            ("git+ssh://github.com/SymbiFlow/make-env.git",
             "https://github.com/SymbiFlow/make-env.git"),
            ("https://github.com/google/skywater-pdk.git",
             "https://github.com/google/skywater-pdk.git"),
            ("git+ssh://example.org/private.git", "git+ssh://example.org/private.git"),
        ]:
            git("config", "remote.origin.url", original)
            assert git(*config, "remote", "get-url", "origin") == expected
            assert git(*config, "-c", "alias.child=!git remote get-url origin", "child") == expected
            assert git("remote", "get-url", "origin") == original, "No persistent rewrite"
    print("PDK checkout regression passed: locked revision, recursive HTTPS, scoped config")


if __name__ == "__main__":
    main()
