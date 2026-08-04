#!/usr/bin/env python3
"""KiCad library indexer for the bundled KiCad symbol/footprint subset.

Pure standard library. Parses KiCad 8 monolithic ``.kicad_sym`` symbol
libraries and ``.kicad_mod`` footprints (both S-expressions) into a JSON
index with on-disk caching keyed by source file fingerprints.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

_INDEX_VERSION = 1
_UNIT_SUFFIX_RE = re.compile(r"_\d+_\d+$")

_DEFAULT_CACHE = (
    Path.home()
    / ".actoviq"
    / "circuit-design-ngspice"
    / "parts-cache"
    / "kicad-library.index.json"
)


# ---------------------------------------------------------------------------
# S-expression parsing
# ---------------------------------------------------------------------------


class SList(list):
    """A parsed S-expression list; keeps source offsets for raw slices."""

    __slots__ = ("start", "end")

    def __init__(self, items=(), start: int = 0, end: int = 0):
        super().__init__(items)
        self.start = start
        self.end = end


_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\"}


def _tokenize(text: str):
    tokens = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c in " \t\r\n":
            i += 1
        elif c == "(":
            tokens.append(("open", None, i))
            i += 1
        elif c == ")":
            tokens.append(("close", None, i))
            i += 1
        elif c == '"':
            j = i + 1
            buf = []
            while j < n:
                ch = text[j]
                if ch == "\\" and j + 1 < n:
                    buf.append(_ESCAPES.get(text[j + 1], text[j + 1]))
                    j += 2
                elif ch == '"':
                    j += 1
                    break
                else:
                    buf.append(ch)
                    j += 1
            tokens.append(("value", "".join(buf), i))
            i = j
        else:
            j = i
            while j < n and text[j] not in ' \t\r\n()"':
                j += 1
            tokens.append(("value", text[i:j], i))
            i = j
    return tokens


def parse_sexpr(text: str) -> SList:
    """Parse S-expression text into nested SList/str nodes."""
    tokens = _tokenize(text)
    root = SList(start=0, end=len(text))
    stack = [root]
    for kind, value, pos in tokens:
        if kind == "open":
            node = SList(start=pos)
            stack[-1].append(node)
            stack.append(node)
        elif kind == "close":
            if len(stack) <= 1:
                raise ValueError(f"unbalanced ')' at offset {pos}")
            node = stack.pop()
            node.end = pos + 1
        else:
            stack[-1].append(value)
    if len(stack) != 1:
        raise ValueError("unbalanced '(' at end of input")
    return root


def _head(node) -> str:
    if isinstance(node, SList) and node and isinstance(node[0], str):
        return node[0]
    return ""


def _find(node, tag: str):
    for child in node:
        if isinstance(child, SList) and _head(child) == tag:
            return child
    return None


def _find_all(node, tag: str):
    return [c for c in node if isinstance(c, SList) and _head(c) == tag]


def _float(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# Symbol / footprint extraction
# ---------------------------------------------------------------------------


def _property(symbol_node, name: str) -> str:
    for child in _find_all(symbol_node, "property"):
        if len(child) >= 3 and child[1] == name:
            return child[2]
    return ""


def _extract_pins(symbol_node) -> list:
    pins = []
    seen = set()
    for unit in _find_all(symbol_node, "symbol"):
        unit_name = unit[1] if len(unit) > 1 else ""
        if not _UNIT_SUFFIX_RE.search(unit_name):
            continue
        for pin in _find_all(unit, "pin"):
            if len(pin) < 3:
                continue
            at = _find(pin, "at")
            length = _find(pin, "length")
            name_node = _find(pin, "name")
            number_node = _find(pin, "number")
            number = number_node[1] if number_node is not None and len(number_node) > 1 else ""
            if number in seen:
                continue
            seen.add(number)
            angle = _float(at[3]) if at is not None and len(at) > 3 else 0.0
            orientation = {0: "R", 90: "U", 180: "L", 270: "D"}.get(int(angle) % 360, "R")
            pins.append(
                {
                    "number": number,
                    "name": name_node[1] if name_node is not None and len(name_node) > 1 else "",
                    "etype": pin[1],
                    "x": _float(at[1]) if at is not None and len(at) > 1 else 0.0,
                    "y": _float(at[2]) if at is not None and len(at) > 2 else 0.0,
                    "orientation": orientation,
                    "length": _float(length[1]) if length is not None and len(length) > 1 else 0.0,
                }
            )
    return pins


def _index_symbol_file(path: Path, warnings: list) -> dict:
    lib = path.stem
    text = path.read_text(encoding="utf-8")
    tree = parse_sexpr(text)
    lib_node = _find(tree, "kicad_symbol_lib")
    if lib_node is None:
        raise ValueError(f"no kicad_symbol_lib node in {path}")
    nodes = {}
    for node in lib_node:
        if _head(node) == "symbol" and len(node) >= 2:
            name = node[1]
            if not _UNIT_SUFFIX_RE.search(name):
                nodes[name] = node

    # Resolve (extends ...) inheritance: child properties/pins win, missing
    # values fall back to the parent chain.
    resolved: dict = {}

    def resolve(name: str, stack: frozenset):
        if name in resolved:
            return resolved[name]
        node = nodes.get(name)
        if node is None or name in stack:
            return None
        parent = None
        extends = _find(node, "extends")
        if extends is not None:
            parent_name = extends[1] if len(extends) > 1 else ""
            parent = resolve(parent_name, stack | {name})
            if parent is None:
                warnings.append(
                    f"{lib}:{name} extends unresolvable parent {parent_name}; skipped"
                )
                resolved[name] = None
                return None
        info = {}
        for key, prop in (
            ("description", "Description"),
            ("keywords", "ki_keywords"),
            ("default_footprint", "Footprint"),
            ("datasheet", "Datasheet"),
        ):
            value = _property(node, prop)
            if not value and parent is not None:
                value = parent[key]
            info[key] = value
        pins = _extract_pins(node)
        if not pins and parent is not None:
            pins = parent["pins"]
        info["pins"] = pins
        info["ancestors"] = ([parent_name] + parent["ancestors"]) if parent is not None else []
        resolved[name] = info
        return info

    entries = {}
    for name, node in nodes.items():
        info = resolve(name, frozenset())
        if info is None:
            continue
        raw = text[node.start : node.end]
        for ancestor in info["ancestors"]:
            ancestor_node = nodes.get(ancestor)
            if ancestor_node is not None:
                raw += "\n" + text[ancestor_node.start : ancestor_node.end]
        entries[f"{lib}:{name}"] = {
            "lib": lib,
            "name": name,
            "id": f"{lib}:{name}",
            "description": info["description"],
            "keywords": info["keywords"],
            "default_footprint": info["default_footprint"],
            "datasheet": info["datasheet"],
            "pins": info["pins"],
            "raw": raw,
        }
    return entries


def _index_footprint_file(path: Path, lib: str) -> dict:
    text = path.read_text(encoding="utf-8")
    tree = parse_sexpr(text)
    node = _find(tree, "footprint")
    if node is None or len(node) < 2:
        raise ValueError(f"no footprint node in {path}")
    name = node[1]
    pads = []
    for pad in _find_all(node, "pad"):
        if len(pad) < 4:
            continue
        at = _find(pad, "at")
        size = _find(pad, "size")
        pads.append(
            {
                "number": pad[1],
                "type": pad[2],
                "shape": pad[3],
                "x": _float(at[1]) if at is not None and len(at) > 1 else 0.0,
                "y": _float(at[2]) if at is not None and len(at) > 2 else 0.0,
                "w": _float(size[1]) if size is not None and len(size) > 1 else 0.0,
                "h": _float(size[2]) if size is not None and len(size) > 2 else 0.0,
            }
        )
    return {
        "lib": lib,
        "name": name,
        "id": f"{lib}:{name}",
        "pads": pads,
    }


# ---------------------------------------------------------------------------
# Index build / cache
# ---------------------------------------------------------------------------


def _fingerprint(lib_root: Path) -> list:
    entries = []
    for path in sorted(lib_root.rglob("*")):
        if path.is_file() and path.suffix in (".kicad_sym", ".kicad_mod"):
            stat = path.stat()
            entries.append(
                {
                    "path": str(path.relative_to(lib_root)),
                    "size": stat.st_size,
                    "mtime": stat.st_mtime,
                }
            )
    return entries


def _build_index(lib_root: Path) -> dict:
    warnings: list = []
    symbols: dict = {}
    footprints: dict = {}
    symbols_dir = lib_root / "symbols"
    if symbols_dir.is_dir():
        for path in sorted(symbols_dir.glob("*.kicad_sym")):
            symbols.update(_index_symbol_file(path, warnings))
    footprints_dir = lib_root / "footprints"
    if footprints_dir.is_dir():
        for path in sorted(footprints_dir.rglob("*.kicad_mod")):
            entry = _index_footprint_file(path, path.parent.name[: -len(".pretty")])
            footprints[entry["id"]] = entry
    return {
        "version": _INDEX_VERSION,
        "lib_root": str(lib_root),
        "symbols": symbols,
        "footprints": footprints,
        "warnings": warnings,
    }


def load_index(lib_root: Path, cache_path: Path | None = None, force: bool = False) -> dict:
    """Load the KiCad library index, using the on-disk cache when fresh."""
    lib_root = Path(lib_root).resolve()
    if cache_path is None:
        cache_path = _DEFAULT_CACHE
    cache_path = Path(cache_path)
    fingerprint = _fingerprint(lib_root)
    if not force and cache_path.is_file():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            if cached.get("fingerprint") == fingerprint:
                index = cached["index"]
                index["cache_hit"] = True
                index["cache_path"] = str(cache_path)
                return index
        except (json.JSONDecodeError, KeyError, OSError):
            pass
    index = _build_index(lib_root)
    index["cache_hit"] = False
    index["cache_path"] = str(cache_path)
    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(
            json.dumps({"fingerprint": fingerprint, "index": index}, ensure_ascii=False),
            encoding="utf-8",
        )
    except OSError:
        pass
    return index


def resolve_lib_root() -> Path:
    """Locate the bundled kicad-lib directory.

    Order: ACTOVIQ_KICAD_LIB_ROOT env var, the skill's own assets directory,
    then the repo's embedded/circuit-design copy.
    """
    env = os.environ.get("ACTOVIQ_KICAD_LIB_ROOT", "").strip()
    if env:
        return Path(env)
    skill_assets = Path(__file__).resolve().parents[1] / "assets" / "kicad-lib"
    if skill_assets.is_dir():
        return skill_assets
    embedded = (
        Path(__file__).resolve().parents[3]
        / "embedded"
        / "circuit-design"
        / "assets"
        / "kicad-lib"
    )
    if embedded.is_dir():
        return embedded
    raise FileNotFoundError(
        "kicad-lib not found; set ACTOVIQ_KICAD_LIB_ROOT to its location"
    )


# ---------------------------------------------------------------------------
# Queries
# ---------------------------------------------------------------------------


def get_symbol(index: dict, symbol_id: str) -> dict | None:
    return index.get("symbols", {}).get(symbol_id)


def get_footprint(index: dict, footprint_id: str) -> dict | None:
    return index.get("footprints", {}).get(footprint_id)


def search_symbols(index: dict, query: str, limit: int = 10) -> list:
    """Case-insensitive search over name/lib/keywords/description.

    Prefix matches on the symbol name rank first, then substring matches on
    the name, then matches on lib/keywords/description.
    """
    q = query.strip().lower()
    if not q:
        return []
    scored = []
    for entry in index.get("symbols", {}).values():
        name = entry.get("name", "").lower()
        lib = entry.get("lib", "").lower()
        haystack = " ".join(
            [
                name,
                lib,
                entry.get("keywords", "").lower(),
                entry.get("description", "").lower(),
                entry.get("id", "").lower(),
            ]
        )
        if q not in haystack:
            continue
        if name.startswith(q):
            rank = 0
        elif q in name:
            rank = 1
        else:
            rank = 2
        scored.append((rank, entry.get("name", ""), entry))
    scored.sort(key=lambda item: (item[0], item[1]))
    return [entry for _, _, entry in scored[:limit]]


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="KiCad library indexer.")
    parser.add_argument("--lib-root", default="")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("reindex")
    args = parser.parse_args()

    lib_root = Path(args.lib_root) if args.lib_root else resolve_lib_root()
    if args.command == "reindex":
        index = load_index(lib_root, force=True)
        print(
            json.dumps(
                {
                    "ok": True,
                    "symbols": len(index["symbols"]),
                    "footprints": len(index["footprints"]),
                    "warnings": len(index["warnings"]),
                    "cache_path": index["cache_path"],
                },
                ensure_ascii=False,
            )
        )
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
