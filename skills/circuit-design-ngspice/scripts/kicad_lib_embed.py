"""Extract real KiCad symbol definitions from the bundled KiCad libraries.

Components that carry ``eda.symbol`` (for example
``MCU_ST_STM32F1:STM32F103C8Tx``) must export with the genuine library
symbol, not a generated generic box.  This module locates the bundled
``.kicad_sym`` file, resolves KiCad 8 ``extends`` inheritance into a flat
definition, renames it for schematic embedding (``lib_symbols`` uses the full
``Library:Cell`` id while the project-local library file keeps the bare cell
name), and serializes it back with the standard library only.
"""

from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from typing import Any
import re

from eda_kicad_validate import _children, _head, _parse_sexpr


def _library_search_paths(library: str) -> list[Path]:
    here = Path(__file__).resolve()
    candidates = [
        # skills/circuit-design-ngspice/assets/kicad-lib/symbols
        here.parents[1] / "assets" / "kicad-lib" / "symbols" / f"{library}.kicad_sym",
        # embedded/circuit-design/assets/kicad-lib/symbols (repo mirror)
        here.parents[3] / "embedded" / "circuit-design" / "assets" / "kicad-lib" / "symbols" / f"{library}.kicad_sym",
    ]
    return candidates


def find_library_file(library: str) -> Path:
    for candidate in _library_search_paths(library):
        if candidate.is_file():
            return candidate
    searched = ", ".join(str(candidate) for candidate in _library_search_paths(library))
    raise ValueError(f"bundled KiCad symbol library not found for {library!r} (searched: {searched})")


_SYMBOL_CACHE: dict[Path, dict[str, list[Any]]] = {}
_FLAT_CACHE: dict[tuple[Path, str], list[Any]] = {}


def _load_symbols(path: Path) -> dict[str, list[Any]]:
    cached = _SYMBOL_CACHE.get(path)
    if cached is not None:
        return cached
    parsed = _parse_sexpr(path.read_text(encoding="utf-8"))
    if _head(parsed) != "kicad_symbol_lib":
        raise ValueError(f"invalid KiCad symbol library root: {path}")
    symbols: dict[str, list[Any]] = {}
    for symbol in _children(parsed, "symbol"):
        if len(symbol) < 2 or isinstance(symbol[1], list):
            raise ValueError(f"unnamed KiCad symbol in {path}")
        symbols[str(symbol[1])] = symbol
    _SYMBOL_CACHE[path] = symbols
    return symbols


def _flatten_symbol(symbols: dict[str, list[Any]], cell: str, stack: tuple[str, ...] = ()) -> list[Any]:
    """Return a deep copy of ``cell`` with ``extends`` inheritance resolved."""

    if cell in stack:
        raise ValueError(f"cyclic KiCad symbol inheritance: {' -> '.join((*stack, cell))}")
    node = symbols.get(cell)
    if node is None:
        raise ValueError(f"KiCad symbol {cell!r} not found in bundled library")
    result = deepcopy(node)
    extends = _children(result, "extends")
    if not extends:
        return result
    if len(extends) != 1 or len(extends[0]) < 2 or isinstance(extends[0][1], list):
        raise ValueError(f"KiCad symbol {cell!r} has a malformed extends clause")
    parent_name = str(extends[0][1])
    parent = _flatten_symbol(symbols, parent_name, (*stack, cell))
    result = [child for child in result if _head(child) != "extends"]
    present_heads = {_head(child) for child in result[2:] if isinstance(child, list)}
    present_properties = {
        str(child[1])
        for child in _children(result, "property")
        if len(child) >= 2 and not isinstance(child[1], list)
    }
    for child in parent[2:]:
        if not isinstance(child, list):
            continue
        head = _head(child)
        if head == "symbol":
            subunit = deepcopy(child)
            subunit_name = str(subunit[1])
            if not subunit_name.startswith(parent_name):
                raise ValueError(f"KiCad symbol {parent_name!r} has an unexpected subunit {subunit_name!r}")
            subunit[1] = cell + subunit_name[len(parent_name):]
            result.append(subunit)
        elif head == "property":
            if len(child) >= 2 and not isinstance(child[1], list) and str(child[1]) not in present_properties:
                result.append(deepcopy(child))
        elif head and head not in present_heads:
            result.append(deepcopy(child))
            present_heads.add(head)
    return result


def _rename_definition(node: list[Any], cell: str, name: str) -> list[Any]:
    # Only the parent symbol takes the (possibly fully qualified) name.  The
    # _0_1/_1_1 subunits keep their bare cell prefix: KiCad rejects embedded
    # lib_symbols subunit names that contain the "Library:" prefix, and the
    # exporter's generated symbols follow the same convention.
    result = deepcopy(node)
    result[1] = name
    return result


def _format_atom(value: Any, *, force_quote: bool = False) -> str:
    text = str(value)
    if force_quote or not re.fullmatch(r"[A-Za-z0-9_+./~-]+", text):
        escaped = text.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'
    return text


# Child-name positions that KiCad parses strictly as quoted strings.
_QUOTED_NAME_HEADS = {"symbol", "name", "number", "lib_id", "property", "label", "global_label", "hierarchical_label"}


def _serialize(node: list[Any], indent: str) -> list[str]:
    head = _format_atom(node[0]) if node else ""
    rest = node[1:]
    quote_first = str(node[0]) in _QUOTED_NAME_HEADS
    if all(not isinstance(child, list) for child in rest):
        atoms = [
            _format_atom(child, force_quote=quote_first and index == 0)
            for index, child in enumerate(rest)
        ]
        return [f"{indent}({' '.join([head, *atoms])})"]
    opening = f"{indent}({head}"
    children = rest
    if rest and not isinstance(rest[0], list):
        opening += f" {_format_atom(rest[0], force_quote=quote_first)}"
        children = rest[1:]
    lines = [opening]
    for child in children:
        if isinstance(child, list):
            lines.extend(_serialize(child, indent + "  "))
        else:
            lines.append(f"{indent}  {_format_atom(child)}")
    lines.append(f"{indent})")
    return lines


def _flattened_symbol(library: str, cell: str) -> list[Any]:
    path = find_library_file(library)
    key = (path, cell)
    flattened = _FLAT_CACHE.get(key)
    if flattened is None:
        flattened = _flatten_symbol(_load_symbols(path), cell)
        _FLAT_CACHE[key] = flattened
    return flattened


def symbol_definition_lines(library: str, cell: str, *, name: str | None = None, indent: str = "  ") -> list[str]:
    """Return the flattened library symbol serialized for export.

    ``name`` is the symbol id to write: the bare cell name for a project-local
    ``.kicad_sym`` library, or the full ``Library:Cell`` lib_id for the
    schematic's embedded ``lib_symbols`` section.
    """

    definition = _rename_definition(_flattened_symbol(library, cell), cell, name or cell)
    return _serialize(definition, indent)


def symbol_footprint(library: str, cell: str) -> str:
    """Return the default Footprint property of a bundled symbol.

    ``extends`` inheritance is resolved first, so a cell that inherits its
    footprint from a parent symbol reports the parent's value.  Returns ""
    when the property is unset (the common case for generic Device symbols).
    """

    flattened = _flattened_symbol(library, cell)
    for child in _children(flattened, "property"):
        if len(child) >= 3 and not isinstance(child[1], list) and str(child[1]) == "Footprint":
            return "" if isinstance(child[2], list) else str(child[2]).strip()
    return ""


def _footprint_search_paths(footprint_id: str) -> list[Path]:
    library, _, name = footprint_id.partition(":")
    relative = Path("footprints") / f"{library}.pretty" / f"{name}.kicad_mod"
    here = Path(__file__).resolve()
    return [
        # skills/circuit-design-ngspice/assets/kicad-lib/footprints
        here.parents[1] / "assets" / "kicad-lib" / relative,
        # embedded/circuit-design/assets/kicad-lib/footprints (repo mirror)
        here.parents[3] / "embedded" / "circuit-design" / "assets" / "kicad-lib" / relative,
    ]


def find_footprint_file(footprint_id: str) -> Path | None:
    """Return the bundled ``.kicad_mod`` for a ``Library:Name`` id, or None.

    None means the footprint is not part of the bundled library; the caller
    decides whether to skip it (the id may still resolve against the user's
    own KiCad footprint libraries).
    """

    for candidate in _footprint_search_paths(footprint_id):
        if candidate.is_file():
            return candidate
    return None


def footprint_pad_numbers(path: Path) -> set[str]:
    """Return the pad numbers declared by a ``.kicad_mod`` footprint file."""

    parsed = _parse_sexpr(path.read_text(encoding="utf-8"))
    if _head(parsed) != "footprint":
        raise ValueError(f"invalid KiCad footprint root: {path}")
    return {
        str(pad[1])
        for pad in _children(parsed, "pad")
        if len(pad) >= 2 and not isinstance(pad[1], list)
    }


def symbol_pin_positions(library: str, cell: str) -> dict[str, tuple[float, float, float]]:
    """Return ``{pin number: (x_mm, y_mm, angle_deg)}`` for a bundled symbol.

    Instances of a real library symbol expose their pins at the symbol's own
    coordinates, so net-label stubs for ``eda.symbol`` components must start
    there instead of at the generated generic-box anchors.
    """

    path = find_library_file(library)
    key = (path, cell)
    flattened = _FLAT_CACHE.get(key)
    if flattened is None:
        flattened = _flatten_symbol(_load_symbols(path), cell)
        _FLAT_CACHE[key] = flattened
    pins: dict[str, tuple[float, float, float]] = {}
    for subunit in _children(flattened, "symbol"):
        for entry in subunit[2:]:
            if not isinstance(entry, list) or _head(entry) != "pin":
                continue
            number = None
            for child in _children(entry, "number"):
                if len(child) >= 2 and not isinstance(child[1], list):
                    number = str(child[1])
                    break
            at = _children(entry, "at")
            if number is None or not at or len(at[0]) < 3:
                continue
            angle = float(at[0][3]) if len(at[0]) > 3 and not isinstance(at[0][3], list) else 0.0
            pins[number] = (float(at[0][1]), float(at[0][2]), angle)
    if not pins:
        raise ValueError(f"KiCad symbol {library}:{cell} has no pins in the bundled library")
    return pins
