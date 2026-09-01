#!/usr/bin/env python3
"""KiCad library indexer for the bundled KiCad symbol/footprint subset.

Pure standard library. Parses KiCad 8 monolithic ``.kicad_sym`` symbol
libraries and ``.kicad_mod`` footprints (both S-expressions) into a JSON
index with on-disk caching keyed by source file fingerprints.
"""

from __future__ import annotations

import json
import hashlib
import math
import os
import re
import sys
import tempfile
from copy import deepcopy
from pathlib import Path

_INDEX_VERSION = 4
SYMBOL_IR_SCHEMA = "actoviq.symbol-ir.v1"
SYMBOL_IR_BUNDLE_SCHEMA = "actoviq.symbol-ir-bundle.v1"
_MM_PER_INTERNAL_UNIT = 0.127
_IR_MEMORY_CACHE: dict[str, dict] = {}
_IR_CACHE_VERSION = 2
_UNIT_SUFFIX_RE = re.compile(r"_(\d+)_(\d+)$")

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
    if isinstance(node, list) and node and isinstance(node[0], str):
        return node[0]
    return ""


def _find(node, tag: str):
    for child in node:
        if isinstance(child, list) and _head(child) == tag:
            return child
    return None


def _find_all(node, tag: str):
    return [c for c in node if isinstance(c, list) and _head(c) == tag]


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


def _extract_unit_pins(symbol_node) -> list:
    units: dict[int, list] = {}
    for subunit in _find_all(symbol_node, "symbol"):
        name = str(subunit[1]) if len(subunit) > 1 else ""
        match = _UNIT_SUFFIX_RE.search(name)
        if match is None or int(match.group(1)) <= 0:
            continue
        unit = int(match.group(1))
        pins = units.setdefault(unit, [])
        seen = {str(pin.get("number", "")) for pin in pins}
        for pin in _find_all(subunit, "pin"):
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
            pins.append({
                "number": number,
                "name": name_node[1] if name_node is not None and len(name_node) > 1 else "",
                "etype": pin[1],
                "shape": pin[2],
                "x": _float(at[1]) if at is not None and len(at) > 1 else 0.0,
                "y": _float(at[2]) if at is not None and len(at) > 2 else 0.0,
                "angle": angle,
                "orientation": {0: "R", 90: "U", 180: "L", 270: "D"}.get(int(angle) % 360, "R"),
                "length": _float(length[1]) if length is not None and len(length) > 1 else 0.0,
            })
    return [{"unit": unit, "pins": pins} for unit, pins in sorted(units.items())]


def _unit_count(symbol_node) -> int:
    units = {
        int(match.group(1))
        for unit in _find_all(symbol_node, "symbol")
        if len(unit) > 1
        and (match := _UNIT_SUFFIX_RE.search(str(unit[1])))
        and int(match.group(1)) > 0
    }
    return len(units) or 1


def flatten_symbol_node(symbols: dict[str, list], cell: str, stack: tuple[str, ...] = ()) -> list:
    """Flatten one KiCad symbol's ``extends`` chain for index, IR, and export."""
    if cell in stack:
        raise ValueError(f"cyclic KiCad symbol inheritance: {' -> '.join((*stack, cell))}")
    node = symbols.get(cell)
    if node is None:
        raise ValueError(f"KiCad symbol {cell!r} not found in bundled library")
    result = deepcopy(node)
    extends = _find_all(result, "extends")
    if not extends:
        return result
    if len(extends) != 1 or len(extends[0]) < 2 or isinstance(extends[0][1], list):
        raise ValueError(f"KiCad symbol {cell!r} has a malformed extends clause")
    parent_name = str(extends[0][1])
    parent = flatten_symbol_node(symbols, parent_name, (*stack, cell))
    result = [child for child in result if _head(child) != "extends"]
    present_heads = {_head(child) for child in result[2:] if isinstance(child, list)}
    present_properties = {
        str(child[1])
        for child in _find_all(result, "property")
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

    entries = {}
    for name, node in nodes.items():
        try:
            flattened = flatten_symbol_node(nodes, name)
        except ValueError as exc:
            warnings.append(f"{lib}:{name}: {exc}; skipped")
            continue
        ancestors = []
        ancestor_node = node
        while (extends := _find(ancestor_node, "extends")) is not None and len(extends) > 1:
            ancestor_name = str(extends[1])
            ancestors.append(ancestor_name)
            ancestor_node = nodes.get(ancestor_name)
            if ancestor_node is None:
                break
        raw = text[node.start : node.end]
        for ancestor in ancestors:
            ancestor_node = nodes.get(ancestor)
            if ancestor_node is not None:
                raw += "\n" + text[ancestor_node.start : ancestor_node.end]
        entries[f"{lib}:{name}"] = {
            "lib": lib,
            "name": name,
            "id": f"{lib}:{name}",
            "description": _property(flattened, "Description"),
            "keywords": _property(flattened, "ki_keywords"),
            "default_footprint": _property(flattened, "Footprint"),
            "datasheet": _property(flattened, "Datasheet"),
            "pins": _extract_pins(flattened),
            "units": _extract_unit_pins(flattened),
            "unit_count": _unit_count(flattened),
            "raw": raw,
        }
    return entries


def _ir_number(value, *, invert: bool = False) -> float:
    number = _float(value) / _MM_PER_INTERNAL_UNIT
    return round(-number if invert else number, 6)


def _ir_point(node, tag: str) -> dict | None:
    point = _find(node, tag)
    if point is None or len(point) < 3:
        return None
    return {"x": _ir_number(point[1]), "y": _ir_number(point[2], invert=True)}


def _ir_effects(node) -> dict:
    effects = _find(node, "effects")
    if effects is None:
        return {"font_size": 10.0, "justify": [], "bold": False, "italic": False, "visible": True}
    font = _find(effects, "font")
    size = _find(font, "size") if font is not None else None
    justify = _find(effects, "justify")
    hidden = _find(effects, "hide")
    return {
        "font_size": _ir_number(size[1]) if size is not None and len(size) > 1 else 10.0,
        "justify": [str(value) for value in justify[1:] if not isinstance(value, list)] if justify else [],
        "bold": _find(font, "bold") is not None if font is not None else False,
        "italic": _find(font, "italic") is not None if font is not None else False,
        "visible": hidden is None,
    }


def _ir_stroke(node) -> dict:
    stroke = _find(node, "stroke")
    width = _find(stroke, "width") if stroke is not None else None
    style = _find(stroke, "type") if stroke is not None else None
    return {
        "width": _ir_number(width[1]) if width is not None and len(width) > 1 else 0.0,
        "style": str(style[1]) if style is not None and len(style) > 1 else "default",
    }


def _ir_fill(node) -> str:
    fill = _find(node, "fill")
    fill_type = _find(fill, "type") if fill is not None else None
    return str(fill_type[1]) if fill_type is not None and len(fill_type) > 1 else "none"


def _ir_graphic(node) -> dict | None:
    kind = _head(node)
    common = {"stroke": _ir_stroke(node), "fill": _ir_fill(node)}
    if kind == "polyline":
        pts = _find(node, "pts")
        points = [] if pts is None else [
            {"x": _ir_number(point[1]), "y": _ir_number(point[2], invert=True)}
            for point in _find_all(pts, "xy") if len(point) >= 3
        ]
        return {"kind": kind, "points": points, **common} if len(points) >= 2 else None
    if kind == "rectangle":
        start, end = _ir_point(node, "start"), _ir_point(node, "end")
        return {"kind": kind, "start": start, "end": end, **common} if start and end else None
    if kind == "circle":
        center = _ir_point(node, "center")
        radius = _find(node, "radius")
        return {
            "kind": kind,
            "center": center,
            "radius": _ir_number(radius[1]),
            **common,
        } if center and radius is not None and len(radius) > 1 else None
    if kind == "arc":
        start, mid, end = _ir_point(node, "start"), _ir_point(node, "mid"), _ir_point(node, "end")
        return {"kind": kind, "start": start, "mid": mid, "end": end, **common} if start and mid and end else None
    if kind == "text":
        at = _find(node, "at")
        if len(node) < 2 or at is None or len(at) < 3:
            return None
        return {
            "kind": kind,
            "text": str(node[1]),
            "at": {"x": _ir_number(at[1]), "y": _ir_number(at[2], invert=True)},
            "angle": (-_float(at[3])) % 360 if len(at) > 3 else 0.0,
            "effects": _ir_effects(node),
        }
    return None


def _ir_pin(node) -> dict | None:
    if len(node) < 3:
        return None
    at = _find(node, "at")
    length = _find(node, "length")
    name = _find(node, "name")
    number = _find(node, "number")
    if at is None or len(at) < 3 or number is None or len(number) < 2:
        return None
    return {
        "number": str(number[1]),
        "name": str(name[1]) if name is not None and len(name) > 1 else "",
        "electrical_type": str(node[1]),
        "shape": str(node[2]),
        "at": {"x": _ir_number(at[1]), "y": _ir_number(at[2], invert=True)},
        "angle": (-_float(at[3])) % 360 if len(at) > 3 else 0.0,
        "length": _ir_number(length[1]) if length is not None and len(length) > 1 else 0.0,
        "name_effects": _ir_effects(name) if name is not None else _ir_effects([]),
        "number_effects": _ir_effects(number),
    }


def _ir_property(symbol, property_name: str) -> dict | None:
    for prop in _find_all(symbol, "property"):
        if len(prop) < 3 or str(prop[1]) != property_name:
            continue
        at = _find(prop, "at")
        if at is None or len(at) < 3:
            return None
        return {
            "at": {"x": _ir_number(at[1]), "y": _ir_number(at[2], invert=True)},
            "angle": (-_float(at[3])) % 360 if len(at) > 3 else 0.0,
            "effects": _ir_effects(prop),
        }
    return None


def _has_atom(node, value: str) -> bool:
    return isinstance(node, list) and any(not isinstance(child, list) and str(child) == value for child in node[1:])


def _ir_bounds(graphics: list, pins: list) -> dict:
    points: list[dict] = []
    for graphic in graphics:
        kind = graphic["kind"]
        if kind == "polyline":
            points.extend(graphic["points"])
        elif kind == "rectangle":
            points.extend([graphic["start"], graphic["end"]])
        elif kind == "circle":
            center, radius = graphic["center"], graphic["radius"]
            points.extend([
                {"x": center["x"] - radius, "y": center["y"] - radius},
                {"x": center["x"] + radius, "y": center["y"] + radius},
            ])
        elif kind == "arc":
            start, mid, end = graphic["start"], graphic["mid"], graphic["end"]
            points.extend([start, mid, end])
            determinant = 2 * (
                start["x"] * (mid["y"] - end["y"])
                + mid["x"] * (end["y"] - start["y"])
                + end["x"] * (start["y"] - mid["y"])
            )
            if abs(determinant) > 1e-9:
                start_square = start["x"] ** 2 + start["y"] ** 2
                mid_square = mid["x"] ** 2 + mid["y"] ** 2
                end_square = end["x"] ** 2 + end["y"] ** 2
                center_x = (
                    start_square * (mid["y"] - end["y"])
                    + mid_square * (end["y"] - start["y"])
                    + end_square * (start["y"] - mid["y"])
                ) / determinant
                center_y = (
                    start_square * (end["x"] - mid["x"])
                    + mid_square * (start["x"] - end["x"])
                    + end_square * (mid["x"] - start["x"])
                ) / determinant
                radius = math.hypot(start["x"] - center_x, start["y"] - center_y)
                start_angle = math.atan2(start["y"] - center_y, start["x"] - center_x)
                clockwise = lambda point: (
                    math.atan2(point["y"] - center_y, point["x"] - center_x) - start_angle
                ) % (math.pi * 2)
                end_delta = clockwise(end)
                sweep_clockwise = clockwise(mid) <= end_delta
                for angle in (0, math.pi / 2, math.pi, math.pi * 3 / 2):
                    delta = (angle - start_angle) % (math.pi * 2)
                    on_arc = delta <= end_delta if sweep_clockwise else delta >= end_delta
                    if on_arc:
                        points.append({
                            "x": center_x + math.cos(angle) * radius,
                            "y": center_y + math.sin(angle) * radius,
                        })
        elif kind == "text":
            font_size = graphic["effects"]["font_size"]
            half_width = max(font_size / 2, len(graphic["text"]) * font_size * 0.3)
            half_height = font_size * 0.6
            radians = graphic["angle"] * math.pi / 180.0
            for local_x, local_y in ((-half_width, -half_height), (half_width, -half_height), (half_width, half_height), (-half_width, half_height)):
                points.append({
                    "x": graphic["at"]["x"] + local_x * math.cos(radians) - local_y * math.sin(radians),
                    "y": graphic["at"]["y"] + local_x * math.sin(radians) + local_y * math.cos(radians),
                })
    for pin in pins:
        points.append(pin["at"])
        radians = pin["angle"] * 3.141592653589793 / 180.0
        points.append({
            "x": pin["at"]["x"] + math.cos(radians) * pin["length"],
            "y": pin["at"]["y"] + math.sin(radians) * pin["length"],
        })
    if not points:
        return {"minX": -40.0, "minY": -30.0, "maxX": 40.0, "maxY": 30.0}
    return {
        "minX": min(point["x"] for point in points),
        "minY": min(point["y"] for point in points),
        "maxX": max(point["x"] for point in points),
        "maxY": max(point["y"] for point in points),
    }


def build_symbol_ir(index: dict, symbol_id: str) -> dict:
    """Build one flattened, renderer-neutral symbol definition on demand."""
    entry = get_symbol(index, symbol_id)
    if entry is None:
        raise ValueError(f"symbol not found: {symbol_id}")
    content_hash = hashlib.sha256(str(entry.get("raw", "")).encode("utf-8")).hexdigest()
    cache_key = hashlib.sha256(
        f"{SYMBOL_IR_SCHEMA}:{_IR_CACHE_VERSION}:{content_hash}".encode("utf-8")
    ).hexdigest()
    cached = _IR_MEMORY_CACHE.get(cache_key)
    if cached is not None:
        return json.loads(json.dumps(cached))
    cache_path = Path(tempfile.gettempdir()) / "actoviq-symbol-ir-v1" / f"{cache_key}.json"
    try:
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
        if cached.get("schema") == SYMBOL_IR_SCHEMA and cached.get("id") == symbol_id:
            _IR_MEMORY_CACHE[cache_key] = cached
            return json.loads(json.dumps(cached))
    except (OSError, json.JSONDecodeError, AttributeError):
        pass
    library, _, cell = symbol_id.partition(":")
    from kicad_lib_embed import _flattened_symbol

    symbol = _flattened_symbol(library, cell)
    subunits: list[tuple[int, int, list]] = []
    for node in _find_all(symbol, "symbol"):
        name = str(node[1]) if len(node) > 1 else ""
        match = _UNIT_SUFFIX_RE.search(name)
        if match:
            subunits.append((int(match.group(1)), int(match.group(2)), node))
    units = sorted({unit for unit, _, _ in subunits if unit > 0}) or [1]
    variants = []
    diagnostics = []
    supported = {"polyline", "rectangle", "circle", "arc", "text", "pin"}
    for unit in units:
        conversions = sorted({convert for candidate, convert, _ in subunits if candidate in {0, unit} and convert > 0}) or [1]
        for variant in conversions:
            selected = [node for candidate, convert, node in subunits if candidate in {0, unit} and convert in {0, variant}]
            graphics, pins, unsupported = [], [], []
            for node in selected:
                for child in node[2:]:
                    if not isinstance(child, list):
                        continue
                    kind = _head(child)
                    if kind == "pin":
                        pin = _ir_pin(child)
                        if pin is not None and all(existing["number"] != pin["number"] for existing in pins):
                            pins.append(pin)
                        elif pin is None:
                            unsupported.append(kind)
                    elif kind in supported:
                        graphic = _ir_graphic(child)
                        if graphic is not None:
                            graphics.append(graphic)
                        else:
                            unsupported.append(kind)
                    elif kind:
                        unsupported.append(kind)
            if unsupported:
                diagnostics.append({
                    "code": "symbol_ir_unsupported",
                    "unit": unit,
                    "variant": variant,
                    "message": f"unsupported KiCad symbol nodes: {', '.join(sorted(set(unsupported)))}",
                })
            variants.append({
                "unit": unit,
                "variant": variant,
                "renderable": not unsupported,
                "graphics": graphics,
                "pins": pins,
                "bounds": _ir_bounds(graphics, pins),
            })
    pin_names = _find(symbol, "pin_names")
    pin_numbers = _find(symbol, "pin_numbers")
    manifest_path = resolve_lib_root() / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.is_file() else {}
    source = manifest.get("source") if isinstance(manifest.get("source"), dict) else {}
    result = {
        "schema": SYMBOL_IR_SCHEMA,
        "id": symbol_id,
        "source": {
            "format": "kicad",
            "library": library,
            "symbol": cell,
            "version": str(source.get("ref", "")),
            "content_hash": content_hash,
        },
        "unit_count": len(units),
        "pin_names": {
            "visible": not (pin_names is not None and (_find(pin_names, "hide") is not None or _has_atom(pin_names, "hide"))),
            "offset": _ir_number((_find(pin_names, "offset") or [None, 0])[1]) if pin_names is not None else 0.0,
        },
        "pin_numbers": {"visible": not (pin_numbers is not None and (_find(pin_numbers, "hide") is not None or _has_atom(pin_numbers, "hide")))},
        "properties": {
            "reference": _ir_property(symbol, "Reference"),
            "value": _ir_property(symbol, "Value"),
        },
        "variants": variants,
        "diagnostics": diagnostics,
    }
    _IR_MEMORY_CACHE[cache_key] = result
    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = cache_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        temporary.replace(cache_path)
    except OSError:
        pass
    return json.loads(json.dumps(result))


def build_symbol_ir_bundle(index: dict, symbol_ids: list[str]) -> dict:
    definitions, diagnostics = {}, []
    for symbol_id in dict.fromkeys(symbol_ids):
        try:
            definitions[symbol_id] = build_symbol_ir(index, symbol_id)
        except Exception as exc:
            diagnostics.append({
                "code": "symbol_ir_missing",
                "symbol_id": symbol_id,
                "message": str(exc) or exc.__class__.__name__,
            })
    return {
        "schema": SYMBOL_IR_BUNDLE_SCHEMA,
        "definitions": definitions,
        "diagnostics": diagnostics,
    }


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
            index = cached["index"]
            if (
                cached.get("fingerprint") == fingerprint
                and index.get("version") == _INDEX_VERSION
                and index.get("lib_root") == str(lib_root)
            ):
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
