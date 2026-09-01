#!/usr/bin/env python3
"""Deterministic EDA IR, layout quality, and editable schematic exporters."""

from __future__ import annotations

import hashlib
import heapq
import html as html_lib
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import uuid
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from eda_kicad_validate import find_kicad_cli, validate_kicad_package, validate_kicad_xml_connectivity
from eda_portable_validate import validate_altium_import_package, validate_orcad_edif, validate_virtuoso_package
from eda_symbols import (
    KICAD_LIBRARY_ROLE_PIN_NUMBERS,
    assign_refdes,
    binding_for,
    prepare_component,
    resolve_symbol_map,
)
from kicad_lib_embed import (
    find_footprint_file,
    footprint_pad_numbers,
    symbol_definition_lines,
    symbol_footprint,
    symbol_pin_positions,
)


EDA_IR_SCHEMA = "actoviq.eda-ir.v1"
QUALITY_SCHEMA = "actoviq.layout-quality.v1"
PATCH_SCHEMA = "actoviq.layout-patch.v1"
PATCH_SET_SCHEMA = "actoviq.layout-patch-set.v1"
LAYOUT_REVIEW_STATE_SCHEMA = "actoviq.layout-review-state.v1"
ROUTED_CONNECTIVITY_SCHEMA = "actoviq.routed-connectivity.v1"
SYMBOL_MAP_SCHEMA = "actoviq.eda-symbol-map.v1"
MANIFEST_SCHEMA = "actoviq.eda-export-manifest.v1"
GRID = 20.0
MM_PER_UNIT = 0.127
TARGETS = ("kicad", "altium", "orcad", "virtuoso")
ROTATIONS = {0, 90, 180, 270}
PIN_SIDES = {"left", "right", "top", "bottom"}
_LAYOUT_CACHE: dict[str, dict[str, Any]] = {}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _safe_name(value: str, fallback: str = "design") -> str:
    result = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(value).strip()).strip("._")
    return result or fallback


def _declared_net_maps(module: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
    by_id: dict[str, dict[str, Any]] = {}
    ids_by_name: dict[str, str] = {}
    for net in module.get("nets", []):
        net_id = str(net.get("id", ""))
        net_name = str(net.get("name", ""))
        if not net_id:
            continue
        by_id[net_id] = net
        for name in (net_name, *net.get("aliases", [])):
            if str(name):
                ids_by_name[str(name)] = net_id
    return by_id, ids_by_name


def _endpoint_net_id(endpoint: dict[str, Any], ids_by_name: dict[str, str]) -> str:
    net_name = str(endpoint.get("net", ""))
    return str(endpoint.get("net_id") or ids_by_name.get(net_name) or net_name)


def _write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        handle.write(content)
        temporary = Path(handle.name)
    os.replace(temporary, path)


def _write_json(path: Path, value: Any) -> None:
    _write_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


class _UnionFind:
    def __init__(self) -> None:
        self.parent: dict[str, str] = {}

    def find(self, value: str) -> str:
        self.parent.setdefault(value, value)
        if self.parent[value] != value:
            self.parent[value] = self.find(self.parent[value])
        return self.parent[value]

    def union(self, left: str, right: str) -> None:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root != right_root:
            self.parent[max(left_root, right_root)] = min(left_root, right_root)


def _project_net_aliases(project: dict[str, Any], modules: dict[str, dict[str, Any]]) -> dict[str, str]:
    union = _UnionFind()
    endpoint_to_local: dict[str, str] = {}
    for module_id, module in modules.items():
        _, ids_by_name = _declared_net_maps(module)
        for port in module.get("ports", []):
            endpoint = f"{module_id}:{port.get('id', '')}"
            local = f"{module_id}:{_endpoint_net_id(port, ids_by_name)}"
            endpoint_to_local[endpoint] = local
            union.union(endpoint, local)
    for connection in project.get("connections", []):
        left = connection.get("from") or {}
        right = connection.get("to") or {}
        left_key = f"{left.get('module_id', '')}:{left.get('port_id', '')}"
        right_key = f"{right.get('module_id', '')}:{right.get('port_id', '')}"
        union.union(left_key, right_key)
    groups: dict[str, list[str]] = {}
    for key in list(union.parent):
        groups.setdefault(union.find(key), []).append(key)
    aliases: dict[str, str] = {}
    for values in groups.values():
        network_names = sorted({
            str(connection.get("network"))
            for connection in project.get("connections", [])
            if connection.get("network") and any(
                f"{endpoint.get('module_id', '')}:{endpoint.get('port_id', '')}" in values
                for endpoint in (connection.get("from") or {}, connection.get("to") or {})
            )
        })
        local_names = sorted(value for value in values if value in endpoint_to_local.values())
        canonical = network_names[0] if network_names else (local_names[0] if local_names else sorted(values)[0])
        for value in values:
            if value in endpoint_to_local.values():
                aliases[value] = canonical
    return aliases


def _included_component(component: dict[str, Any], view: str) -> bool:
    if str(component.get("type", "")).upper() == "GND":
        # Ground pseudo-components are schematic anchors, not physical devices;
        # the ground net still exports through pins and the promoted GND port.
        return False
    if view == "simulation":
        return True
    mount_policy = str(component.get("mount_policy", ""))
    if mount_policy == "testbench_exclude":
        return False
    if mount_policy == "design_include":
        return True
    # Ideal SPICE sources are testbench objects unless a project explicitly
    # declares that they represent a physical design component.
    return str(component.get("type", "")).upper() not in {"V", "I"}


def _project_module_view(module: dict[str, Any], view: str) -> dict[str, Any]:
    projected = json.loads(json.dumps(module))
    if view != "design":
        return projected
    declared_by_id, ids_by_name = _declared_net_maps(projected)

    def identified_nets(components: Iterable[dict[str, Any]]) -> dict[str, str]:
        result: dict[str, str] = {}
        for component in components:
            for pin in component.get("pins", []):
                if not pin.get("net"):
                    continue
                net_id = _endpoint_net_id(pin, ids_by_name)
                definition = declared_by_id.get(net_id) or {}
                result[net_id] = str(definition.get("name") or pin.get("net") or net_id)
        return result

    existing_net_ids = {
        _endpoint_net_id(port, ids_by_name)
        for port in projected.get("ports", [])
    }
    promoted_nets = identified_nets(
        component for component in module.get("components", []) if not _included_component(component, view)
    )
    remaining_pin_nets = identified_nets(
        component for component in module.get("components", []) if _included_component(component, view)
    )
    promoted_nets.update({
        net_id: name
        for net_id, name in remaining_pin_nets.items()
        if name.lower() in {"0", "gnd"}
    })
    for net_id in sorted(set(promoted_nets) - existing_net_ids):
        net = promoted_nets[net_id]
        ground = net.lower() in {"0", "gnd"}
        projected.setdefault("ports", []).append({
            "id": f"export_{_safe_name(net)}",
            "name": "GND" if ground else net,
            "direction": "bidirectional",
            "signal_type": "ground" if ground else "analog",
            "net": net,
            "net_id": net_id,
            "export_promoted": True,
        })
    return projected


def _component_size(component: dict[str, Any]) -> tuple[float, float]:
    if component.get("type") == "BLOCK":
        block = component.get("block") or {}
        width, height = float(block.get("width", 120)), float(block.get("height", 80))
    elif component.get("type") in {"M", "Q", "E"}:
        width, height = 90.0, 90.0
    elif component.get("type") in {"V", "I"}:
        width, height = 70.0, 100.0
    else:
        width, height = 100.0, 50.0
        pins = component.get("pins") or []
        if len(pins) > 2 and str(component.get("type", "")).upper() not in {"M", "Q", "E"}:
            # Generic multi-pin symbols (for example board-level X devices)
            # place their pins on the left/right box edges like a BLOCK.  The
            # default 50-unit height only separates two pins; grow the box so
            # every side pin keeps its own grid row instead of collapsing onto
            # one shared point.
            side_counts: dict[str, int] = {}
            for index, pin in enumerate(pins):
                side = _pin_side(component, pin, index)
                side_counts[side] = side_counts.get(side, 0) + 1
            per_side = max(side_counts.values(), default=1)
            height = max(height, (per_side + 1) * GRID)
    # KiCad's normal schematic connection grid is 50 mil (1.27 mm), which is
    # half of an Vibe Analog 20-unit grid step.  Grid-aligned symbol dimensions keep
    # both pin connection points and routed wire endpoints on that grid.
    width = math.ceil(width / GRID) * GRID
    height = math.ceil(height / GRID) * GRID
    if int(round(float(component.get("rotation", 0)))) % 180 == 90:
        return height, width
    return width, height


def _component_bounds(component: dict[str, Any]) -> dict[str, float]:
    position = component.get("position") or {}
    x, y = float(position.get("x", 0)), float(position.get("y", 0))
    if component.get("type") == "BLOCK" or (
        len(component.get("pins") or []) > 2
        and str(component.get("type", "")).upper() not in {"M", "Q", "E"}
    ):
        width, height = _component_size(component)
        return {"min_x": x - width / 2, "min_y": y - height / 2, "max_x": x + width / 2, "max_y": y + height / 2}
    pin_points = [_pin_position(component, pin, index) for index, pin in enumerate(component.get("pins") or [])]
    xs = [x - 52.0, x + 52.0, *(point["x"] for point in pin_points)]
    ys = [y - 52.0, y + 52.0, *(point["y"] for point in pin_points)]
    return {"min_x": min(xs), "min_y": min(ys), "max_x": max(xs), "max_y": max(ys)}


def _rotate_point(x: float, y: float, rotation: int) -> tuple[float, float]:
    rotation %= 360
    if rotation == 90:
        return -y, x
    if rotation == 180:
        return -x, -y
    if rotation == 270:
        return y, -x
    return x, y


def _pin_side(component: dict[str, Any], pin: dict[str, Any], index: int) -> str:
    pins = component.get("pins") or []
    side = pin.get("side")
    if side in {"left", "right", "top", "bottom"}:
        return str(side)
    if len(pins) == 2:
        return "left" if index == 0 else "right"
    if component.get("type") == "M":
        return ("top", "left", "bottom", "right")[min(index, 3)]
    if component.get("type") == "Q":
        return ("top", "left", "bottom")[min(index, 2)]
    return "left" if index < math.ceil(len(pins) / 2) else "right"


def _pin_position(component: dict[str, Any], pin: dict[str, Any], index: int) -> dict[str, float]:
    component_type = str(component.get("type", "")).upper()
    key = f"{pin.get('id', '')} {pin.get('name', '')}".lower()
    if component_type == "BLOCK" or (len(component.get("pins") or []) > 2 and component_type not in {"M", "Q", "E"}):
        # Generic multi-pin devices (X subcircuits, connectors, ICs without a
        # dedicated geometry) share the BLOCK side/order box layout.  Without
        # this every pin past the first collapsed onto one point, which made
        # distinct nets physically unrouteable and shorted them in any target
        # export that trusted the coordinates.
        pins = component.get("pins") or []
        width, height = _component_size({**component, "rotation": 0})
        side = _pin_side(component, pin, index)
        side_entries = [
            (entry_index, entry)
            for entry_index, entry in enumerate(pins)
            if _pin_side(component, entry, entry_index) == side
        ]
        side_entries.sort(key=lambda item: (float(item[1].get("order", item[0])), item[0]))
        side_pins = [entry for _, entry in side_entries]
        side_index = side_pins.index(pin) if pin in side_pins else 0
        side_offset = (side_index - (len(side_pins) - 1) / 2) * GRID
        if side == "left":
            local = (-width / 2, side_offset)
        elif side == "right":
            local = (width / 2, side_offset)
        elif side == "top":
            local = (side_offset, -height / 2)
        else:
            local = (side_offset, height / 2)
    elif component_type == "M":
        pmos = re.search(
            r"pmos|pfet|p-channel|p channel|\bp\b",
            f"{component.get('id', '')} {component.get('name', '')} {component.get('value', '')}",
            re.IGNORECASE,
        ) is not None
        if re.search(r"gate|\bg\b", key):
            local = (-58.0, 0.0)
        elif re.search(r"drain|\bd\b", key):
            local = (22.0, 52.0 if pmos else -52.0)
        elif re.search(r"source|\bs\b", key):
            local = (22.0, -52.0 if pmos else 52.0)
        else:
            local = (58.0, 0.0)
    elif component_type == "Q":
        if re.search(r"base|\bb\b", key):
            local = (-58.0, 0.0)
        elif re.search(r"collector|\bc\b", key):
            local = (30.0, -52.0)
        else:
            local = (30.0, 52.0)
    elif component_type == "E":
        if re.search(r"out\+|\bp\b", key):
            local = (64.0, 0.0)
        elif re.search(r"out-|\bn\b|ref", key):
            local = (0.0, 58.0)
        elif re.search(r"\+|non|cp|in\+", key):
            local = (-58.0, 24.0)
        elif re.search(r"-|inv|cn|in-", key):
            local = (-58.0, -24.0)
        else:
            local = (0.0, 58.0)
    else:
        local = (-52.0 if index == 0 else 52.0, 0.0)
    dx, dy = _rotate_point(*local, int(round(float(component.get("rotation", 0)))))
    position = component.get("position") or {}
    return {"x": float(position.get("x", 0)) + dx, "y": float(position.get("y", 0)) + dy}


def _snap(value: float) -> float:
    return round(value / GRID) * GRID


def _port_positions(module: dict[str, Any], components: list[dict[str, Any]]) -> dict[str, dict[str, float]]:
    bounds = [_component_bounds(component) for component in components]
    min_x = min((item["min_x"] for item in bounds), default=0) - 3 * GRID
    max_x = max((item["max_x"] for item in bounds), default=12 * GRID) + 3 * GRID
    min_y = min((item["min_y"] for item in bounds), default=0) - 3 * GRID
    max_y = max((item["max_y"] for item in bounds), default=8 * GRID) + 3 * GRID
    result: dict[str, dict[str, float]] = {}
    counters = {"left": 0, "right": 0, "top": 0, "bottom": 0}
    for port in sorted(module.get("ports", []), key=lambda item: str(item.get("id", ""))):
        stored = port.get("position")
        if isinstance(stored, dict) and all(isinstance(stored.get(axis), (int, float)) for axis in ("x", "y")):
            result[str(port["id"])] = {"x": _snap(float(stored["x"])), "y": _snap(float(stored["y"]))}
            continue
        if port.get("signal_type") == "ground" or str(port.get("net", "")).lower() in {"0", "gnd"}:
            side = "bottom"
        elif port.get("signal_type") == "power":
            side = "top"
        elif port.get("direction") == "output":
            side = "right"
        else:
            side = "left"
        index = counters[side]
        counters[side] += 1
        if side in {"left", "right"}:
            result[str(port["id"])] = {"x": _snap(min_x if side == "left" else max_x), "y": _snap(min_y + (index + 2) * 3 * GRID)}
        else:
            result[str(port["id"])] = {"x": _snap(min_x + (index + 2) * 4 * GRID), "y": _snap(min_y if side == "top" else max_y)}
    return result


def _layout_candidates(module: dict[str, Any], view: str) -> list[list[dict[str, Any]]]:
    source = [prepare_component(component) for component in module.get("components", []) if _included_component(component, view)]
    if not source:
        return [source]
    local_candidates: list[list[dict[str, Any]]] = []
    rank_candidates: list[list[dict[str, Any]]] = []
    input_nets = {port.get("net") for port in module.get("ports", []) if port.get("direction") == "input"}
    output_nets = {port.get("net") for port in module.get("ports", []) if port.get("direction") == "output"}
    power_nets = {port.get("net") for port in module.get("ports", []) if port.get("signal_type") == "power"}
    ground_nets = {port.get("net") for port in module.get("ports", []) if port.get("signal_type") == "ground" or str(port.get("net", "")).lower() in {"0", "gnd"}}

    def rank(component: dict[str, Any]) -> int:
        nets = {pin.get("net") for pin in component.get("pins", [])}
        if nets & input_nets:
            return 0
        if nets & output_nets:
            return 3
        if nets & power_nets or nets & ground_nets:
            return 1
        return 2

    movable = sorted(
        (component for component in source if component.get("position") and len(component.get("pins", [])) >= 3),
        key=lambda component: (-len({pin.get("net") for pin in component.get("pins", [])}), str(component.get("id", ""))),
    )[:2]
    for movable_index, component in enumerate(movable):
        offsets = [(-2, 0), (2, 0), (0, -6)]
        if movable_index == 0:
            offsets.append((0, 2))
        for dx_grid, dy_grid in offsets:
            candidate = [json.loads(json.dumps(item)) for item in source]
            moved = next(item for item in candidate if item.get("id") == component.get("id"))
            moved["position"]["x"] = _snap(float(moved["position"].get("x", 0)) + dx_grid * GRID)
            moved["position"]["y"] = _snap(float(moved["position"].get("y", 0)) + dy_grid * GRID)
            local_candidates.append(candidate)
        if len(component.get("pins", [])) >= 3:
            rotation_offsets = (0, -2) if movable_index == 0 else (0,)
            for rotation in (90, 270):
                for dx_grid in rotation_offsets:
                    candidate = [json.loads(json.dumps(item)) for item in source]
                    rotated = next(item for item in candidate if item.get("id") == component.get("id"))
                    rotated["position"]["x"] = _snap(float(rotated["position"].get("x", 0)) + dx_grid * GRID)
                    rotated["rotation"] = rotation
                    local_candidates.append(candidate)

    for variant in range(1, 9):
        candidate = [json.loads(json.dumps(component)) for component in source]
        groups: dict[int, list[dict[str, Any]]] = {}
        for component in candidate:
            groups.setdefault(rank(component), []).append(component)
        # A candidate lane must fit both 52-unit symbol half-extents and the
        # 40-unit pin escape used by the orthogonal maze router.  The old
        # 100–140-unit lane spacing could place one component directly over a
        # neighbour's escape point (for example PMOS.D above RPU), making an
        # otherwise valid net impossible to route.  Eight grid steps is the
        # smallest deterministic clearance above 52 + 40 + 52 units.
        x_gap = (8 + variant % 3) * GRID
        y_gap = (8 + (variant // 3) % 3) * GRID
        for component_rank, group in sorted(groups.items()):
            ordered = sorted(group, key=lambda item: str(item.get("id", "")), reverse=bool(variant & 1))
            top_lane = 0
            main_lane = 0
            bottom_lane = 0
            for component in ordered:
                nets = {pin.get("net") for pin in component.get("pins", [])}
                if nets & power_nets and not nets & ground_nets:
                    lane_y = -(top_lane + 1) * y_gap
                    top_lane += 1
                elif nets & ground_nets and not nets & power_nets:
                    lane_y = (len(ordered) + bottom_lane + 1) * y_gap
                    bottom_lane += 1
                else:
                    lane_y = main_lane * y_gap
                    main_lane += 1
                component["position"] = {"x": component_rank * x_gap, "y": lane_y}
                if len(component.get("pins", [])) == 2:
                    component["rotation"] = 90 if variant in {3, 6} and (nets & (power_nets | ground_nets)) else 0
        rank_candidates.append(candidate)
    ordered = [source, *local_candidates[:7], *rank_candidates]
    candidates: list[list[dict[str, Any]]] = []
    seen: set[bytes] = set()
    for candidate in ordered:
        key = _canonical_json(candidate)
        if key in seen:
            continue
        seen.add(key)
        candidates.append(candidate)
        if len(candidates) == 16:
            break
    return candidates


def _endpoint_ref(endpoint: dict[str, Any]) -> dict[str, Any]:
    return {key: endpoint[key] for key in endpoint if key not in {"x", "y", "kind", "_egress"}}


def _tree_wires(net_name: str, net_id: str, endpoints: list[dict[str, Any]], trunk: float, vertical_trunk: bool) -> list[dict[str, Any]]:
    projected: list[tuple[dict[str, Any], dict[str, float]]] = []
    wires: list[dict[str, Any]] = []
    for endpoint_index, endpoint in enumerate(endpoints):
        endpoint_point = {"x": endpoint["x"], "y": endpoint["y"]}
        egress = endpoint.get("_egress") or {"x": 0, "y": 0}
        escape = {
            "x": endpoint["x"] + float(egress.get("x", 0)) * 2 * GRID,
            "y": endpoint["y"] + float(egress.get("y", 0)) * 2 * GRID,
        }
        projection = {"x": trunk, "y": escape["y"]} if vertical_trunk else {"x": escape["x"], "y": trunk}
        projected.append((endpoint, projection))
        if endpoint_point != projection:
            points = [endpoint_point]
            if escape != endpoint_point and escape != projection:
                points.append(escape)
            points.append(projection)
            wires.append({
                "id": f"{_safe_name(net_id)}-branch-{endpoint_index}", "net_id": net_id, "net": net_name,
                "from": _endpoint_ref(endpoint), "to": {"x": projection["x"], "y": projection["y"]},
                "points": points,
            })
    unique_projections = sorted({(projection["x"], projection["y"]) for _, projection in projected}, key=lambda point: point[1] if vertical_trunk else point[0])
    for index in range(len(unique_projections) - 1):
        left = {"x": unique_projections[index][0], "y": unique_projections[index][1]}
        right = {"x": unique_projections[index + 1][0], "y": unique_projections[index + 1][1]}
        if left != right:
            wires.append({"id": f"{_safe_name(net_id)}-trunk-{index}", "net_id": net_id, "net": net_name, "from": {**left}, "to": {**right}, "points": [left, right]})
    if not wires and len(endpoints) >= 2:
        start = {"x": endpoints[0]["x"], "y": endpoints[0]["y"]}
        end = {"x": endpoints[-1]["x"], "y": endpoints[-1]["y"]}
        wires.append({"id": f"{_safe_name(net_id)}-direct", "net_id": net_id, "net": net_name, "from": _endpoint_ref(endpoints[0]), "to": _endpoint_ref(endpoints[-1]), "points": [start, end]})
    return wires


def _point_key(point: dict[str, Any]) -> tuple[float, float]:
    return round(float(point["x"]), 6), round(float(point["y"]), 6)


def _point_on_segment(point: dict[str, Any], start: dict[str, Any], end: dict[str, Any], *, strict: bool = False) -> bool:
    px, py = _point_key(point)
    sx, sy = _point_key(start)
    ex, ey = _point_key(end)
    if sx == ex:
        if px != sx:
            return False
        lower, upper = sorted((sy, ey))
        return lower < py < upper if strict else lower <= py <= upper
    if sy == ey:
        if py != sy:
            return False
        lower, upper = sorted((sx, ex))
        return lower < px < upper if strict else lower <= px <= upper
    return False


def _different_net_segment_contact(
    left: tuple[dict[str, Any], dict[str, Any], dict[str, Any]],
    right: tuple[dict[str, Any], dict[str, Any], dict[str, Any]],
) -> dict[str, Any] | None:
    """Return contacts that schematic editors treat as an unintended junction.

    A strict interior/interior perpendicular crossing remains a visual crossing
    and is deliberately not a connection.  Shared endpoints, an endpoint on the
    other segment, and positive-length collinear overlap are hard errors.
    """

    a, b, aw = left
    c, d, bw = right
    if str(aw.get("net_id", "")) == str(bw.get("net_id", "")):
        return None
    ax, ay = _point_key(a)
    bx, by = _point_key(b)
    cx, cy = _point_key(c)
    dx, dy = _point_key(d)
    a_vertical = ax == bx
    c_vertical = cx == dx
    if not (a_vertical or ay == by) or not (c_vertical or cy == dy):
        return {"category": "non_orthogonal_segment"}
    if a_vertical == c_vertical:
        same_axis = ax == cx if a_vertical else ay == cy
        if not same_axis:
            return None
        left_interval = sorted((ay, by)) if a_vertical else sorted((ax, bx))
        right_interval = sorted((cy, dy)) if c_vertical else sorted((cx, dx))
        lower = max(left_interval[0], right_interval[0])
        upper = min(left_interval[1], right_interval[1])
        if lower > upper:
            return None
        if a_vertical:
            bounds = {"min_x": ax, "min_y": lower, "max_x": ax, "max_y": upper}
        else:
            bounds = {"min_x": lower, "min_y": ay, "max_x": upper, "max_y": ay}
        return {"category": "collinear_overlap" if lower < upper else "shared_endpoint", "bounds": bounds}
    vertical_start, vertical_end, horizontal_start, horizontal_end = (a, b, c, d) if a_vertical else (c, d, a, b)
    x = _point_key(vertical_start)[0]
    y = _point_key(horizontal_start)[1]
    if not (
        min(_point_key(vertical_start)[1], _point_key(vertical_end)[1]) <= y <= max(_point_key(vertical_start)[1], _point_key(vertical_end)[1])
        and min(_point_key(horizontal_start)[0], _point_key(horizontal_end)[0]) <= x <= max(_point_key(horizontal_start)[0], _point_key(horizontal_end)[0])
    ):
        return None
    point = {"x": x, "y": y}
    if _point_on_segment(point, vertical_start, vertical_end, strict=True) and _point_on_segment(point, horizontal_start, horizontal_end, strict=True):
        return None
    return {
        "category": "endpoint_on_segment",
        "bounds": {"min_x": x, "min_y": y, "max_x": x, "max_y": y},
    }


def _candidate_route_cost(candidate: list[dict[str, Any]], occupied: list[dict[str, Any]], component_bounds: dict[str, dict[str, float]]) -> tuple[int, int, int, float, int]:
    candidate_segments = list(_segments(candidate))
    occupied_segments = list(_segments(occupied))
    hard_contacts = sum(
        _different_net_segment_contact(left, right) is not None
        for left in candidate_segments
        for right in occupied_segments
    )
    obstructions = 0
    for start, end, wire in candidate_segments:
        obstructions += sum(_segment_intersects_bounds(start, end, bounds) for bounds in component_bounds.values())
    crossings = sum(_strict_segment_cross(left, right) is not None for left in candidate_segments for right in occupied_segments)
    length = sum(abs(end["x"] - start["x"]) + abs(end["y"] - start["y"]) for start, end, _ in candidate_segments)
    return hard_contacts, obstructions, crossings, length, len(candidate)


def _route_set_cost(wires: list[dict[str, Any]], component_bounds: dict[str, dict[str, float]]) -> tuple[int, int, int, float, int]:
    segments = list(_segments(wires))
    hard_contacts = sum(
        _different_net_segment_contact(left, right) is not None
        for index, left in enumerate(segments)
        for right in segments[index + 1:]
    )
    obstructions = sum(_segment_intersects_bounds(start, end, bounds) for start, end, _ in segments for bounds in component_bounds.values())
    crossings = sum(_strict_segment_cross(left, right) is not None for index, left in enumerate(segments) for right in segments[index + 1:])
    length = sum(abs(end["x"] - start["x"]) + abs(end["y"] - start["y"]) for start, end, _ in segments)
    bends = sum(max(0, len(wire.get("points") or []) - 2) for wire in wires)
    return hard_contacts, obstructions, crossings, length, bends


def _replace_wire_segment(wires: list[dict[str, Any]], wire_index: int, point_index: int, replacement: list[dict[str, float]]) -> list[dict[str, Any]]:
    result = json.loads(json.dumps(wires))
    points = result[wire_index]["points"]
    compact: list[dict[str, float]] = []
    for point in [*points[:point_index], *replacement, *points[point_index + 2:]]:
        if not compact or compact[-1] != point:
            compact.append(point)
    result[wire_index]["points"] = compact
    return result


def _maze_reroute_wire(wires: list[dict[str, Any]], wire_index: int, component_bounds: dict[str, dict[str, float]]) -> list[dict[str, Any]] | None:
    wire = wires[wire_index]
    points = wire.get("points") or []
    if len(points) < 2:
        return None
    prefix = points[:2] if len(points) >= 3 else points[:1]
    start = prefix[-1]
    end = points[-1]
    # Pin locations land on half-grid coordinates; a half-grid search preserves
    # those endpoints without the unbounded state growth of the old 5-unit maze.
    step = GRID / 2
    all_points = [point for candidate in wires for point in candidate.get("points", [])]
    min_x = math.floor((min([point["x"] for point in all_points] + [bounds["min_x"] for bounds in component_bounds.values()]) - 8 * GRID) / step) * step
    max_x = math.ceil((max([point["x"] for point in all_points] + [bounds["max_x"] for bounds in component_bounds.values()]) + 8 * GRID) / step) * step
    min_y = math.floor((min([point["y"] for point in all_points] + [bounds["min_y"] for bounds in component_bounds.values()]) - 8 * GRID) / step) * step
    max_y = math.ceil((max([point["y"] for point in all_points] + [bounds["max_y"] for bounds in component_bounds.values()]) + 8 * GRID) / step) * step
    blocked_axes: dict[tuple[float, float], set[str]] = {}
    for candidate in wires:
        if candidate is wire or candidate.get("net_id") == wire.get("net_id"):
            continue
        for left, right, _ in _segments([candidate]):
            axis = "vertical" if left["x"] == right["x"] else "horizontal"
            length = int(max(abs(right["x"] - left["x"]), abs(right["y"] - left["y"])) / step)
            for index in range(length + 1):
                ratio = index / max(1, length)
                point = (round((left["x"] + (right["x"] - left["x"]) * ratio) / step) * step, round((left["y"] + (right["y"] - left["y"]) * ratio) / step) * step)
                blocked_axes.setdefault(point, set()).add(axis)
    start_key = (round(start["x"] / step) * step, round(start["y"] / step) * step)
    end_key = (round(end["x"] / step) * step, round(end["y"] / step) * step)
    blocked_axes.pop(start_key, None)
    blocked_axes.pop(end_key, None)

    def forbidden(x: float, y: float) -> bool:
        if (x, y) in {start_key, end_key}:
            return False
        return any(bounds["min_x"] < x < bounds["max_x"] and bounds["min_y"] < y < bounds["max_y"] for bounds in component_bounds.values())

    directions = ((step, 0.0), (-step, 0.0), (0.0, step), (0.0, -step))
    queue: list[tuple[float, float, float, float, int]] = []
    heapq.heappush(queue, (0.0, 0.0, start_key[0], start_key[1], -1))
    best: dict[tuple[float, float, int], float] = {(start_key[0], start_key[1], -1): 0.0}
    parent: dict[tuple[float, float, int], tuple[float, float, int]] = {}
    goal: tuple[float, float, int] | None = None
    expanded = 0
    while queue:
        expanded += 1
        if expanded > 5_000:
            return None
        _, cost, x, y, direction = heapq.heappop(queue)
        state = (x, y, direction)
        if cost != best.get(state):
            continue
        if (x, y) == end_key:
            goal = state
            break
        for next_direction, (dx, dy) in enumerate(directions):
            nx, ny = x + dx, y + dy
            if nx < min_x or nx > max_x or ny < min_y or ny > max_y or forbidden(nx, ny):
                continue
            crossing_axis = "vertical" if dx else "horizontal"
            wire_penalty = 10_000.0 if crossing_axis in blocked_axes.get((nx, ny), set()) else 0.0
            next_cost = cost + 1.0 + wire_penalty + (0.35 if direction not in {-1, next_direction} else 0.0)
            next_state = (nx, ny, next_direction)
            if next_cost >= best.get(next_state, float("inf")):
                continue
            best[next_state] = next_cost
            parent[next_state] = state
            heuristic = (abs(end_key[0] - nx) + abs(end_key[1] - ny)) / step
            heapq.heappush(queue, (next_cost + heuristic, next_cost, nx, ny, next_direction))
    if goal is None:
        return None
    path: list[dict[str, float]] = []
    state = goal
    while True:
        path.append({"x": state[0], "y": state[1]})
        if state not in parent:
            break
        state = parent[state]
    path.reverse()
    compact: list[dict[str, float]] = []
    for point in [*prefix[:-1], *path]:
        if compact and compact[-1] == point:
            continue
        if len(compact) >= 2:
            left, middle = compact[-2], compact[-1]
            if (left["x"] == middle["x"] == point["x"]) or (left["y"] == middle["y"] == point["y"]):
                compact[-1] = point
                continue
        compact.append(point)
    result = json.loads(json.dumps(wires))
    result[wire_index]["points"] = compact
    return result


def _ripup_crossings(wires: list[dict[str, Any]], component_bounds: dict[str, dict[str, float]]) -> list[dict[str, Any]]:
    current = wires
    for _ in range(12):
        indexed_segments = [
            (wire_index, point_index, points[point_index], points[point_index + 1], wire)
            for wire_index, wire in enumerate(current)
            for points in [wire.get("points") or []]
            for point_index in range(len(points) - 1)
        ]
        crossing_pair = next((
            (left, right)
            for index, left in enumerate(indexed_segments)
            for right in indexed_segments[index + 1:]
            if _strict_segment_cross((left[2], left[3], left[4]), (right[2], right[3], right[4])) is not None
        ), None)
        if not crossing_pair:
            break
        variants: list[list[dict[str, Any]]] = []
        for segment, obstacle in (crossing_pair, (crossing_pair[1], crossing_pair[0])):
            wire_index, point_index, start, end, _ = segment
            obstacle_start, obstacle_end = obstacle[2], obstacle[3]
            obstacle_points = obstacle[4].get("points") or [obstacle_start, obstacle_end]
            if start["y"] == end["y"]:
                for offset in (2, 4, 6, 8):
                    for detour_y in (min(point["y"] for point in obstacle_points) - offset * GRID, max(point["y"] for point in obstacle_points) + offset * GRID):
                        variants.append(_replace_wire_segment(current, wire_index, point_index, [start, {"x": start["x"], "y": detour_y}, {"x": end["x"], "y": detour_y}, end]))
            elif start["x"] == end["x"]:
                for offset in (2, 4, 6, 8):
                    for detour_x in (min(point["x"] for point in obstacle_points) - offset * GRID, max(point["x"] for point in obstacle_points) + offset * GRID):
                        variants.append(_replace_wire_segment(current, wire_index, point_index, [start, {"x": detour_x, "y": start["y"]}, {"x": detour_x, "y": end["y"]}, end]))
        baseline = _route_set_cost(current, component_bounds)
        improving = [variant for variant in variants if _route_set_cost(variant, component_bounds)[:3] < baseline[:3]]
        if not improving:
            for wire_index in {crossing_pair[0][0], crossing_pair[1][0]}:
                variant = _maze_reroute_wire(current, wire_index, component_bounds)
                if variant is not None and _route_set_cost(variant, component_bounds)[:3] < baseline[:3]:
                    improving.append(variant)
        if not improving:
            break
        current = min(improving, key=lambda variant: _route_set_cost(variant, component_bounds))
    return current


def _grid_path(
    start: dict[str, float],
    end: dict[str, float],
    *,
    blocked_nodes: set[tuple[float, float]],
    component_bounds: Iterable[dict[str, float]],
    search_bounds: tuple[float, float, float, float],
) -> list[dict[str, float]] | None:
    """Find a deterministic orthogonal path without touching foreign nets.

    This is the whole-net fallback used when trunk routing leaves a crossing.
    All schematic coordinates land on the half-grid, so blocking occupied grid
    nodes prevents perpendicular crossings, shared endpoints, and collinear
    overlap while still allowing paths of the same net to share geometry.
    """

    step = GRID / 2
    start_key = (round(float(start["x"]) / step) * step, round(float(start["y"]) / step) * step)
    end_key = (round(float(end["x"]) / step) * step, round(float(end["y"]) / step) * step)
    min_x, min_y, max_x, max_y = search_bounds

    def forbidden(x: float, y: float) -> bool:
        if (x, y) in {start_key, end_key}:
            return False
        return any(bounds["min_x"] < x < bounds["max_x"] and bounds["min_y"] < y < bounds["max_y"] for bounds in component_bounds)

    directions = ((step, 0.0), (-step, 0.0), (0.0, step), (0.0, -step))
    queue: list[tuple[float, float, float, float, int]] = []
    heapq.heappush(queue, (0.0, 0.0, start_key[0], start_key[1], -1))
    best: dict[tuple[float, float, int], float] = {(start_key[0], start_key[1], -1): 0.0}
    parent: dict[tuple[float, float, int], tuple[float, float, int]] = {}
    goal: tuple[float, float, int] | None = None
    expanded = 0
    while queue:
        expanded += 1
        if expanded > 30_000:
            return None
        _, cost, x, y, direction = heapq.heappop(queue)
        state = (x, y, direction)
        if cost != best.get(state):
            continue
        if (x, y) == end_key:
            goal = state
            break
        for next_direction, (dx, dy) in enumerate(directions):
            nx, ny = x + dx, y + dy
            if nx < min_x or nx > max_x or ny < min_y or ny > max_y:
                continue
            if (nx, ny) in blocked_nodes or forbidden(nx, ny):
                continue
            next_cost = cost + 1.0 + (0.35 if direction not in {-1, next_direction} else 0.0)
            next_state = (nx, ny, next_direction)
            if next_cost >= best.get(next_state, float("inf")):
                continue
            best[next_state] = next_cost
            parent[next_state] = state
            heuristic = (abs(end_key[0] - nx) + abs(end_key[1] - ny)) / step
            heapq.heappush(queue, (next_cost + heuristic, next_cost, nx, ny, next_direction))
    if goal is None:
        return None
    path: list[dict[str, float]] = []
    state = goal
    while True:
        path.append({"x": state[0], "y": state[1]})
        if state not in parent:
            break
        state = parent[state]
    path.reverse()
    compact: list[dict[str, float]] = []
    for point in path:
        if len(compact) >= 2:
            left, middle = compact[-2], compact[-1]
            if (left["x"] == middle["x"] == point["x"]) or (left["y"] == middle["y"] == point["y"]):
                compact[-1] = point
                continue
        compact.append(point)
    return compact


def _wire_grid_nodes(wire: dict[str, Any]) -> set[tuple[float, float]]:
    step = GRID / 2
    result: set[tuple[float, float]] = set()
    for start, end, _ in _segments([wire]):
        length = int(max(abs(float(end["x"]) - float(start["x"])), abs(float(end["y"]) - float(start["y"]))) / step)
        for index in range(length + 1):
            ratio = index / max(1, length)
            result.add((
                round((float(start["x"]) + (float(end["x"]) - float(start["x"])) * ratio) / step) * step,
                round((float(start["y"]) + (float(end["y"]) - float(start["y"])) * ratio) / step) * step,
            ))
    return result


def _grid_unit_nodes(start: dict[str, Any], end: dict[str, Any]) -> list[tuple[float, float]]:
    step = GRID / 2
    start_key = _point_key(start)
    end_key = _point_key(end)
    dx = 0.0 if start_key[0] == end_key[0] else step if end_key[0] > start_key[0] else -step
    dy = 0.0 if start_key[1] == end_key[1] else step if end_key[1] > start_key[1] else -step
    if dx and dy:
        raise ValueError("grid segment must be orthogonal")
    result = [start_key]
    while result[-1] != end_key:
        x, y = result[-1]
        result.append((x + dx, y + dy))
    return result


def _endpoint_escape(endpoint: dict[str, Any], length: float = 2 * GRID) -> dict[str, float]:
    egress = endpoint.get("_egress") or {"x": 0, "y": 0}
    step = GRID / 2
    return {
        "x": round((float(endpoint["x"]) + float(egress.get("x", 0)) * length) / step) * step,
        "y": round((float(endpoint["y"]) + float(egress.get("y", 0)) * length) / step) * step,
    }


def _endpoint_stub_nodes(endpoint: dict[str, Any]) -> list[tuple[float, float]]:
    """Connect an exact symbol pin to the half-grid maze access lattice."""

    start = _point_key(endpoint)
    access = _point_key(_endpoint_escape(endpoint))
    if start == access:
        return [start]
    egress = endpoint.get("_egress") or {"x": 0, "y": 0}
    if float(egress.get("x", 0)):
        corner = (access[0], start[1])
    else:
        corner = (start[0], access[1])
    result = [start]
    if corner != result[-1]:
        result.append(corner)
    if access != result[-1]:
        result.append(access)
    return result


def _grid_path_to_tree(
    start: tuple[float, float],
    tree_nodes: set[tuple[float, float]],
    forbidden_nodes: set[tuple[float, float]],
    proximity_nodes: set[tuple[float, float]],
    component_bounds: Iterable[dict[str, float]],
    search_bounds: tuple[float, float, float, float],
) -> list[tuple[float, float]] | None:
    if start in tree_nodes:
        return [start]
    step = GRID / 2
    min_x, min_y, max_x, max_y = search_bounds
    bounds = list(component_bounds)
    tree_min_x = min(x for x, _ in tree_nodes)
    tree_max_x = max(x for x, _ in tree_nodes)
    tree_min_y = min(y for _, y in tree_nodes)
    tree_max_y = max(y for _, y in tree_nodes)

    def heuristic(x: float, y: float) -> float:
        dx = tree_min_x - x if x < tree_min_x else x - tree_max_x if x > tree_max_x else 0.0
        dy = tree_min_y - y if y < tree_min_y else y - tree_max_y if y > tree_max_y else 0.0
        return (dx + dy) / step

    directions = ((step, 0.0), (-step, 0.0), (0.0, step), (0.0, -step))
    queue: list[tuple[float, float, float, float, int]] = [(heuristic(*start), 0.0, start[0], start[1], -1)]
    best: dict[tuple[float, float, int], float] = {(start[0], start[1], -1): 0.0}
    parent: dict[tuple[float, float, int], tuple[float, float, int]] = {}
    goal: tuple[float, float, int] | None = None
    expanded = 0
    while queue:
        expanded += 1
        if expanded > 80_000:
            return None
        _, cost, x, y, direction = heapq.heappop(queue)
        state = (x, y, direction)
        if cost != best.get(state):
            continue
        if (x, y) in tree_nodes:
            goal = state
            break
        for next_direction, (dx, dy) in enumerate(directions):
            nx, ny = x + dx, y + dy
            node = (nx, ny)
            if nx < min_x or nx > max_x or ny < min_y or ny > max_y:
                continue
            if node != start and node not in tree_nodes and node in forbidden_nodes:
                continue
            edge_start = {"x": x, "y": y}
            edge_end = {"x": nx, "y": ny}
            if any(_segment_intersects_bounds(edge_start, edge_end, item) for item in bounds):
                continue
            bend = 0.4 if direction not in {-1, next_direction} else 0.0
            near = sum((nx + offset_x, ny + offset_y) in proximity_nodes for offset_x, offset_y in directions)
            next_cost = cost + 1.0 + bend + 0.12 * near
            next_state = (nx, ny, next_direction)
            if next_cost >= best.get(next_state, float("inf")):
                continue
            best[next_state] = next_cost
            parent[next_state] = state
            heapq.heappush(queue, (next_cost + heuristic(nx, ny), next_cost, nx, ny, next_direction))
    if goal is None:
        return None
    path: list[tuple[float, float]] = []
    state = goal
    while True:
        path.append((state[0], state[1]))
        if state not in parent:
            break
        state = parent[state]
    path.reverse()
    return path


def _compress_grid_nodes(nodes: list[tuple[float, float]]) -> list[dict[str, float]]:
    result: list[dict[str, float]] = []
    for x, y in nodes:
        point = {"x": x, "y": y}
        if len(result) >= 2:
            left, middle = result[-2], result[-1]
            if (left["x"] == middle["x"] == x) or (left["y"] == middle["y"] == y):
                result[-1] = point
                continue
        result.append(point)
    return result


def _grid_route_nets(
    nets: list[dict[str, Any]],
    route_order: list[dict[str, Any]],
    component_bounds: dict[str, dict[str, float]],
    diagnostics: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]] | None:
    all_points = [endpoint for net in nets for endpoint in net.get("endpoints", [])]
    margin = 8 * GRID
    min_x = math.floor((min([float(point["x"]) for point in all_points] + [bounds["min_x"] for bounds in component_bounds.values()]) - margin) / (GRID / 2)) * (GRID / 2)
    max_x = math.ceil((max([float(point["x"]) for point in all_points] + [bounds["max_x"] for bounds in component_bounds.values()]) + margin) / (GRID / 2)) * (GRID / 2)
    min_y = math.floor((min([float(point["y"]) for point in all_points] + [bounds["min_y"] for bounds in component_bounds.values()]) - margin) / (GRID / 2)) * (GRID / 2)
    max_y = math.ceil((max([float(point["y"]) for point in all_points] + [bounds["max_y"] for bounds in component_bounds.values()]) + margin) / (GRID / 2)) * (GRID / 2)
    reserved_by_net = {
        str(net.get("id", "")): {
            _point_key(_endpoint_escape(endpoint))
            for endpoint in net.get("endpoints", [])
        }
        for net in nets
    }
    preferred_order_ids = [str(item.get("id", "")) for item in route_order]

    def fail(reason: str, *, net_id: str, endpoint_ids: Iterable[str] = (), order_ids: list[str] | None = None) -> None:
        if diagnostics is not None and len(diagnostics) < 64:
            diagnostics.append({
                "reason": reason,
                "net_id": net_id,
                "endpoint_ids": sorted({value for value in endpoint_ids if value}),
                "route_order": order_ids or preferred_order_ids,
            })
        return None

    def route_one_net(
        net: dict[str, Any],
        occupied: set[tuple[float, float]],
        order_ids: list[str],
    ) -> tuple[list[dict[str, Any]], set[tuple[float, float]]] | None:
        endpoints = list(net.get("endpoints", []))
        if len(endpoints) < 2:
            return [], set()
        root_index = next((index for index, endpoint in enumerate(endpoints) if endpoint.get("_egress")), 0)
        root = endpoints[root_index]
        root_stub = _endpoint_stub_nodes(root)
        root_access = root_stub[-1]
        net_id = str(net.get("id", ""))
        future_reserved = set().union(*(nodes for other_id, nodes in reserved_by_net.items() if other_id != net_id))
        forbidden = occupied | future_reserved
        if root_access in forbidden:
            return fail("root_escape_blocked", net_id=net_id, endpoint_ids=[_routed_endpoint_id(root)], order_ids=order_ids)
        # The root escape stub is reserved geometry, but only its outer end is
        # initially a legal connection target.  Allowing a first branch to
        # terminate on an interior stub node leaves an electrically meaningless
        # tail that KiCad reports as an unconnected wire endpoint.
        tree_nodes = {root_access}
        net_wires = [{
            "id": f"{_safe_name(net_id)}-grid-root",
            "net_id": net_id,
            "net": str(net.get("name", net_id)),
            "from": _endpoint_ref(root),
            "to": {"x": root_access[0], "y": root_access[1]},
            "points": _compress_grid_nodes(root_stub),
        }]
        remaining = [endpoint for index, endpoint in enumerate(endpoints) if index != root_index]
        branch_index = 0
        while remaining:
            candidates: list[tuple[int, str, int, list[tuple[float, float]], list[tuple[float, float]], dict[str, Any]]] = []
            blocked_stubs: list[str] = []
            for endpoint_index, endpoint in enumerate(remaining):
                stub = _endpoint_stub_nodes(endpoint)
                if stub[-1] in forbidden:
                    blocked_stubs.append(_routed_endpoint_id(endpoint))
                    continue
                path = _grid_path_to_tree(
                    stub[-1],
                    tree_nodes,
                    forbidden,
                    occupied,
                    component_bounds.values(),
                    (min_x, min_y, max_x, max_y),
                )
                if path is not None:
                    candidates.append((len(path), _routed_endpoint_id(endpoint), endpoint_index, stub, path, endpoint))
            if not candidates:
                remaining_ids = [_routed_endpoint_id(endpoint) for endpoint in remaining]
                reason = "endpoint_escape_blocked" if blocked_stubs and len(blocked_stubs) == len(remaining) else "path_to_net_tree_not_found"
                return fail(reason, net_id=net_id, endpoint_ids=remaining_ids, order_ids=order_ids)
            _, _, endpoint_index, stub, path, endpoint = min(candidates)
            combined = [*stub[:-1], *path]
            tree_nodes.update(path)
            net_wires.append({
                "id": f"{_safe_name(net_id)}-grid-{branch_index}",
                "net_id": net_id,
                "net": str(net.get("name", net_id)),
                "from": _endpoint_ref(endpoint),
                "to": {"x": combined[-1][0], "y": combined[-1][1]},
                "points": _compress_grid_nodes(combined),
            })
            branch_index += 1
            remaining.pop(endpoint_index)
        return net_wires, tree_nodes

    routed: list[dict[str, Any]] = []
    occupied: set[tuple[float, float]] = set()
    for net in route_order:
        if len(net.get("endpoints", [])) < 2:
            continue
        result = route_one_net(net, occupied, preferred_order_ids)
        if result is None:
            return None
        net_wires, tree_nodes = result
        routed.extend(net_wires)
        occupied.update(tree_nodes)
    return routed


def _grid_route_nets_independently(
    nets: list[dict[str, Any]],
    component_bounds: dict[str, dict[str, float]],
    diagnostics: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]] | None:
    """Last-resort route that preserves connectivity without false contacts.

    Each net gets its own obstacle-avoiding tree.  The merged geometry is still
    passed through ``verify_routed_connectivity``; strict interior crossings are
    permitted visually but endpoint/segment contacts and overlaps are rejected.
    The quality scorer therefore sees any remaining crossings and can request a
    better layout without ever changing the source net partition.
    """

    beam: list[list[dict[str, Any]]] = [[]]
    for net in nets:
        if len(net.get("endpoints", [])) < 2:
            continue
        endpoints = list(net.get("endpoints", []))
        variants: list[list[dict[str, Any]]] = []
        seen_variants: set[bytes] = set()
        root_indexes = [index for index, endpoint in enumerate(endpoints) if endpoint.get("_egress")] or [0]
        for root_index in root_indexes:
            variant_net = {
                **net,
                "endpoints": [endpoints[root_index], *endpoints[:root_index], *endpoints[root_index + 1:]],
            }
            net_wires = _grid_route_nets([variant_net], [variant_net], component_bounds, diagnostics)
            if net_wires is None:
                continue
            key = _canonical_json(net_wires)
            if key not in seen_variants:
                seen_variants.add(key)
                variants.append(net_wires)
        if not variants:
            return None
        expanded = [[*routed, *variant] for routed in beam for variant in variants]
        # Keep enough partial combinations for later nets to avoid crossings;
        # pruning solely on an early partial length can discard the only clean
        # final tree even in a modest six-net analog schematic.
        beam = sorted(expanded, key=lambda wires: _route_set_cost(wires, component_bounds))[:128]
    for routed in sorted(beam, key=lambda wires: _route_set_cost(wires, component_bounds)):
        if verify_routed_connectivity(nets, routed)["ok"]:
            return routed
    return None


def _module_net_endpoints(
    module: dict[str, Any],
    components: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, dict[str, float]], dict[str, dict[str, float]]]:
    """Build the source net partition with absolute pin/port geometry."""

    ports = _port_positions(module, components)
    declared_by_id, ids_by_name = _declared_net_maps(module)
    endpoints_by_net: dict[str, list[dict[str, Any]]] = {}
    net_names: dict[str, str] = {}
    for component in components:
        component_type = str(component.get("type", "")).upper()
        side_layout = component_type == "BLOCK" or (
            len(component.get("pins") or []) > 2 and component_type not in {"M", "Q", "E"}
        )
        side_egress = {
            "left": {"x": -1, "y": 0}, "right": {"x": 1, "y": 0},
            "top": {"x": 0, "y": -1}, "bottom": {"x": 0, "y": 1},
        }
        for index, pin in enumerate(component.get("pins", [])):
            point = _pin_position(component, pin, index)
            position = component.get("position") or {}
            dx = point["x"] - float(position.get("x", 0))
            dy = point["y"] - float(position.get("y", 0))
            if side_layout:
                # Tall multi-pin boxes place pins along their side walls; the
                # dominant-axis heuristic points far-from-centre pins along
                # the wall and straight through their neighbours.
                egress = dict(side_egress[_pin_side(component, pin, index)])
            else:
                egress = {"x": (1 if dx > 0 else -1) if abs(dx) >= abs(dy) else 0, "y": (1 if dy > 0 else -1) if abs(dy) > abs(dx) else 0}
            net_id = _endpoint_net_id(pin, ids_by_name)
            net_names[net_id] = str((declared_by_id.get(net_id) or {}).get("name") or pin.get("net") or net_id)
            endpoints_by_net.setdefault(net_id, []).append({
                "kind": "pin", "component_id": component["id"], "pin_id": pin["id"], "_egress": egress, **point,
            })
    for port in module.get("ports", []):
        if str(port.get("id", "")) in ports:
            net_id = _endpoint_net_id(port, ids_by_name)
            net_names[net_id] = str((declared_by_id.get(net_id) or {}).get("name") or port.get("net") or net_id)
            endpoints_by_net.setdefault(net_id, []).append({
                "kind": "port", "port_id": port["id"], **ports[str(port["id"])],
            })
    nets: list[dict[str, Any]] = []
    for net_id, endpoints in sorted(endpoints_by_net.items()):
        endpoints = sorted(endpoints, key=lambda item: (item["x"], item["y"], item.get("component_id", ""), item.get("port_id", "")))
        nets.append({"id": net_id, "name": net_names.get(net_id, net_id), "endpoints": endpoints})
    component_bounds = {str(component["id"]): _component_bounds(component) for component in components}
    return nets, ports, component_bounds


def _apply_library_symbol_pin_positions(nets: list[dict[str, Any]], components: list[dict[str, Any]]) -> None:
    """Anchor label stubs at the real library symbol pin coordinates.

    A component with ``eda.symbol`` exports the genuine KiCad symbol, whose
    pins sit at the library's own positions rather than the generated
    generic-box anchors.  Override those endpoints (position plus escape
    direction from the symbol pin angle) so the exported stub wire touches
    the real graphical pin.
    """

    overrides: dict[tuple[str, str], tuple[float, float, dict[str, int]]] = {}
    for component in components:
        eda = component.get("eda") or {}
        eda_symbol = str(eda.get("symbol", "")).strip()
        if not eda_symbol:
            continue
        library, _, cell = eda_symbol.partition(":")
        pin_positions = symbol_pin_positions(library, cell, unit=int(eda.get("unit") or 1))
        position = component.get("position") or {}
        base_x = _kicad_snap_internal(float(position.get("x", 0)))
        base_y = _kicad_snap_internal(float(position.get("y", 0)))
        rotation = int(round(float(component.get("rotation", 0)))) % 360
        for pin in component.get("pins", []):
            pin_id = str(pin.get("id", ""))
            number = pin_id
            if number not in pin_positions:
                # Native primitives keep internal pin ids (a/b); translate
                # through the canonical role onto the KiCad package pin.
                role = str((pin.get("eda") or {}).get("role", ""))
                number = KICAD_LIBRARY_ROLE_PIN_NUMBERS.get(role, number)
            if number not in pin_positions:
                raise ValueError(
                    f"pin {pin_id!r} of component {component.get('id', '')} is not present in KiCad symbol {eda_symbol}"
                )
            x_mm, y_mm, angle = pin_positions[number]
            dx, dy = _rotate_point(x_mm / MM_PER_UNIT, -y_mm / MM_PER_UNIT, rotation)
            # KiCad pin angles point from the connection end into the symbol
            # body, so the stub leaves the other way.
            vector = {0: (-1, 0), 90: (0, 1), 180: (1, 0), 270: (0, -1)}[(int(round(angle / 90.0)) * 90) % 360]
            egress_x, egress_y = _rotate_point(float(vector[0]), float(vector[1]), rotation)
            overrides[(str(component.get("id", "")), pin_id)] = (
                _kicad_snap_internal(base_x + dx),
                _kicad_snap_internal(base_y + dy),
                {"x": int(round(egress_x)), "y": int(round(egress_y))},
            )
    if not overrides:
        return
    for net in nets:
        for endpoint in net.get("endpoints", []):
            if endpoint.get("kind") != "pin":
                continue
            key = (str(endpoint.get("component_id", "")), str(endpoint.get("pin_id", "")))
            if key in overrides:
                endpoint["x"], endpoint["y"], endpoint["_egress"] = overrides[key]
        net["endpoints"] = sorted(
            net.get("endpoints", []),
            key=lambda item: (item["x"], item["y"], item.get("component_id", ""), item.get("port_id", "")),
        )


def _label_route_module(
    module: dict[str, Any],
    components: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, dict[str, float]]]:
    """Connect every net through per-pin stub wires and same-named net labels.

    Board-level designs (connectors, ICs, high-fanout power nets) are drawn
    with labels in real schematics; the orthogonal autorouter is only
    guaranteed for compact analog cells.  Each pin gets a short stub along its
    escape direction and the KiCad writer anchors a local net label at the
    stub end, so same-named labels reproduce the source partition exactly.
    The stub geometry still flows through ``verify_routed_connectivity`` so
    accidental physical contact between stubs of different nets is rejected.
    """

    nets, ports, _ = _module_net_endpoints(module, components)
    _apply_library_symbol_pin_positions(nets, components)

    def touches(left_start: dict[str, float], left_end: dict[str, float], right_start: dict[str, float], right_end: dict[str, float]) -> bool:
        if _point_on_segment(left_start, right_start, right_end) or _point_on_segment(left_end, right_start, right_end):
            return True
        if _point_on_segment(right_start, left_start, left_end) or _point_on_segment(right_end, left_start, left_end):
            return True
        return _strict_segment_cross((left_start, left_end, {}), (right_start, right_end, {})) is not None

    placed: list[tuple[str, dict[str, float], dict[str, float]]] = []
    anchors = [
        (str(net.get("id", "")), {"x": float(endpoint["x"]), "y": float(endpoint["y"])})
        for net in nets
        for endpoint in net.get("endpoints", [])
        if endpoint.get("kind") in {"pin", "port"}
    ]
    wires: list[dict[str, Any]] = []
    for net in nets:
        net_id = str(net.get("id", ""))
        net["connection"] = "label"
        pin_points = [
            endpoint for endpoint in net.get("endpoints", []) if endpoint.get("kind") == "pin"
        ]
        for endpoint in net.get("endpoints", []):
            kind = endpoint.get("kind")
            if kind not in {"pin", "port"}:
                continue
            if kind == "port":
                if not pin_points:
                    # A port with no pins has nothing to join; its label still
                    # names the net exactly like the routed flow.
                    continue
                center_x = sum(float(point["x"]) for point in pin_points) / len(pin_points)
                center_y = sum(float(point["y"]) for point in pin_points) / len(pin_points)
                dx = center_x - float(endpoint["x"])
                dy = center_y - float(endpoint["y"])
                # A bare port label with no wire under it is a dangling-label
                # ERC error, so ports also get a stub pointing at their net.
                endpoint = {
                    **endpoint,
                    "_egress": {"x": (1 if dx > 0 else -1) if abs(dx) >= abs(dy) else 0, "y": (1 if dy > 0 else -1) if abs(dy) > abs(dx) else 0},
                }
                if not endpoint["_egress"]["x"] and not endpoint["_egress"]["y"]:
                    endpoint["_egress"] = {"x": 1, "y": 0}
            start = {"x": float(endpoint["x"]), "y": float(endpoint["y"])}
            # Dense board placements park opposing pins of different nets a
            # fixed distance apart, and real library symbols (for example an
            # MCU's column of left-side pins) fill a whole corridor with stub
            # endpoints.  A fixed direction/length can therefore always land
            # on a foreign contact.  Probe the natural escape direction first,
            # then the perpendiculars, then the opposite direction, each at
            # several lengths, in a deterministic order.
            base_egress = endpoint.get("_egress") or {}
            base_x = int(base_egress.get("x", 0) or 0)
            base_y = int(base_egress.get("y", 0) or 0)
            if base_x:
                directions = [(base_x, 0), (0, 1), (0, -1), (-base_x, 0)]
            elif base_y:
                directions = [(0, base_y), (1, 0), (-1, 0), (0, -base_y)]
            else:
                directions = [(1, 0), (-1, 0), (0, 1), (0, -1)]
            chosen: dict[str, float] | None = None
            chosen_direction: tuple[int, int] | None = None
            for direction_x, direction_y in directions:
                probe = {**endpoint, "_egress": {"x": direction_x, "y": direction_y}}
                for factor in (1, 2, 0.5, 3, 4, 5, 6):
                    escape = _endpoint_escape(probe, GRID * factor)
                    if _point_key(escape) == _point_key(start):
                        continue
                    clear = True
                    for other_net, anchor in anchors:
                        if other_net != net_id and _point_key(anchor) != _point_key(start) and _point_on_segment(anchor, start, escape):
                            clear = False
                            break
                    if clear:
                        for other_net, seg_start, seg_end in placed:
                            if other_net != net_id and touches(start, escape, seg_start, seg_end):
                                clear = False
                                break
                    if clear:
                        chosen = escape
                        chosen_direction = (direction_x, direction_y)
                        break
                if chosen is not None:
                    break
            if chosen is None or chosen_direction is None:
                raise ValueError(
                    f"label stub for {_routed_endpoint_id(endpoint) or 'endpoint'} "
                    "contacts a foreign net at every deterministic stub direction and length"
                )
            endpoint["_egress"] = {"x": chosen_direction[0], "y": chosen_direction[1]}
            placed.append((net_id, start, chosen))
            endpoint_token = _safe_name(str(endpoint.get("component_id", "")) or str(endpoint.get("port_id", "")))
            pin_token = _safe_name(str(endpoint.get("pin_id", "")) or "port")
            wires.append({
                "id": f"{_safe_name(net_id)}-label-{endpoint_token}-{pin_token}",
                "net_id": net_id,
                "net": str(net.get("name", net_id)),
                "from": _endpoint_ref(endpoint),
                "to": {"x": chosen["x"], "y": chosen["y"]},
                "points": [start, chosen],
                "label": True,
            })
    return nets, wires, ports


def _route_module(
    module: dict[str, Any],
    components: list[dict[str, Any]],
    *,
    allow_global_fallback: bool = True,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, dict[str, float]]]:
    nets, ports, component_bounds = _module_net_endpoints(module, components)

    def semantic_route_priority(net: dict[str, Any]) -> tuple[int, str]:
        name = str(net.get("name", net.get("id", ""))).lower()
        if name in {"fb", "feedback", "sense"}:
            priority = 0
        elif name in {"out", "output", "vout"}:
            priority = 1
        elif name in {"vref", "ref", "reference", "bias", "vb"}:
            priority = 2
        elif name in {"in", "input", "vin"}:
            priority = 3
        elif name in {"0", "gnd", "ground", "vss"}:
            priority = 4
        elif name in {"gate", "control", "ctrl"}:
            priority = 5
        else:
            priority = 3
        return priority, str(net.get("id", ""))

    control_names = {"gate", "control", "ctrl"}
    route_orders = [
        # Control/gate pins are commonly boxed in between the pass device and
        # pull-up/error-amplifier branches. Reserve that narrow corridor before
        # high-fanout supply and ground trees consume it.
        sorted(nets, key=lambda item: (
            str(item["name"]).lower() not in control_names,
            str(item["name"]).lower() in {"0", "gnd", "ground", "vss"},
            -len(item["endpoints"]),
            str(item["id"]),
        )),
        sorted(nets, key=lambda item: (
            str(item["name"]).lower() not in control_names,
            semantic_route_priority(item),
        )),
        sorted(nets, key=semantic_route_priority),
        sorted(nets, key=lambda item: (-len(item["endpoints"]), str(item["id"]))),
        sorted(nets, key=lambda item: (len(item["endpoints"]), str(item["id"]))),
        sorted(nets, key=lambda item: str(item["id"])),
        sorted(nets, key=lambda item: (str(item["name"]).lower() in {"0", "gnd"}, -len(item["endpoints"]), str(item["id"]))),
        sorted(nets, key=lambda item: (str(item["name"]).lower() not in {"0", "gnd"}, -len(item["endpoints"]), str(item["id"]))),
        sorted(nets, key=lambda item: (str(item["name"]).lower() not in {"out", "output", "fb", "feedback"}, -len(item["endpoints"]), str(item["id"]))),
    ]
    routed_variants: list[list[dict[str, Any]]] = []
    seen_orders: set[tuple[str, ...]] = set()
    for route_order in route_orders:
        order_key = tuple(str(net["id"]) for net in route_order)
        if order_key in seen_orders:
            continue
        seen_orders.add(order_key)
        routed: list[dict[str, Any]] = []
        for net in route_order:
            endpoints = net["endpoints"]
            if len(endpoints) < 2:
                continue
            route_candidates: list[list[dict[str, Any]]] = []
            for vertical_trunk in (True, False):
                axis = "x" if vertical_trunk else "y"
                coordinates = sorted(float(item[axis]) for item in endpoints)
                median = _snap(coordinates[len(coordinates) // 2])
                trunk_candidates = {median, *(_snap(value) for value in coordinates)}
                for offset in range(1, 9):
                    trunk_candidates.update({median - offset * GRID, median + offset * GRID})
                for trunk in sorted(trunk_candidates):
                    route_candidates.append(_tree_wires(net["name"], net["id"], endpoints, trunk, vertical_trunk))
            routed.extend(min(route_candidates, key=lambda candidate: _candidate_route_cost(candidate, routed, component_bounds)))
        routed_variants.append(routed)
    verified_variants: list[list[dict[str, Any]]] = []
    failed_verifications: list[dict[str, Any]] = []
    grid_diagnostics: list[dict[str, Any]] = []
    for raw_variant in sorted(routed_variants, key=lambda candidate: _route_set_cost(candidate, component_bounds)):
        verification = verify_routed_connectivity(nets, raw_variant)
        if verification["ok"]:
            verified_variants.append(raw_variant)
        else:
            failed_verifications.append(verification)
    if not verified_variants and allow_global_fallback:
        # The compact trunk candidates can all be electrically invalid (for
        # example, a branch may end on a foreign-net segment).  The whole-net
        # grid router is also the recovery path for this case, not only a
        # quality improvement after one trunk candidate happened to verify.
        # Compact candidates already cover several sequential net orders. If
        # all of them are electrically invalid, use the fast independent-net
        # safety route and accept it only after the strict merged-geometry and
        # partition verifier passes.
        grid_wires = _grid_route_nets_independently(nets, component_bounds, grid_diagnostics)
        if grid_wires is not None:
            verification = verify_routed_connectivity(nets, grid_wires)
            if verification["ok"]:
                verified_variants.append(grid_wires)
            else:
                failed_verifications.append(verification)
    if not verified_variants:
        categories = sorted({
            str(error["category"])
            for verification in failed_verifications
            for error in verification["errors"]
        })
        diagnostic_summary = ", ".join(
            f"{item['net_id']}:{item['reason']}[{'+'.join(item['endpoint_ids'])}]"
            for item in grid_diagnostics[:8]
        )
        suffix = f"; grid failures: {diagnostic_summary}" if diagnostic_summary else ""
        raise ValueError(f"autorouter could not preserve source connectivity: {', '.join(categories) or 'no valid route'}{suffix}")
    wires = min(verified_variants, key=lambda candidate: _route_set_cost(candidate, component_bounds))
    improved_wires = _ripup_crossings(wires, component_bounds)
    if verify_routed_connectivity(nets, improved_wires)["ok"] and _route_set_cost(improved_wires, component_bounds) < _route_set_cost(wires, component_bounds):
        wires = improved_wires
    if allow_global_fallback and _route_set_cost(wires, component_bounds)[:3] != (0, 0, 0):
        for route_order in route_orders:
            grid_wires = _grid_route_nets(nets, route_order, component_bounds, grid_diagnostics)
            if grid_wires is None:
                continue
            verification = verify_routed_connectivity(nets, grid_wires)
            if verification["ok"] and _route_set_cost(grid_wires, component_bounds) < _route_set_cost(wires, component_bounds):
                wires = grid_wires
            if _route_set_cost(wires, component_bounds)[:3] == (0, 0, 0):
                break
    _require_routed_connectivity(nets, wires)
    return nets, wires, ports


def _segments(wires: Iterable[dict[str, Any]]) -> Iterable[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]]:
    for wire in wires:
        points = wire.get("points") or []
        for index in range(len(points) - 1):
            yield points[index], points[index + 1], wire


def _routed_endpoint_id(endpoint: dict[str, Any]) -> str:
    if endpoint.get("kind") == "pin" or (endpoint.get("component_id") and endpoint.get("pin_id")):
        return f"component:{endpoint.get('component_id', '')}:pin:{endpoint.get('pin_id', '')}"
    if endpoint.get("kind") == "port" or endpoint.get("port_id"):
        return f"port:{endpoint.get('port_id', '')}"
    return ""


def verify_routed_connectivity(nets: list[dict[str, Any]], wires: list[dict[str, Any]]) -> dict[str, Any]:
    """Compare the routed orthogonal geometry with the source net partition.

    Geometry follows KiCad/Qucs-style junction semantics: a strict interior
    crossing does not connect, while an endpoint placed on another segment does.
    The latter is rejected when the two segments belong to different nets.
    """

    errors: list[dict[str, Any]] = []
    seen_errors: set[bytes] = set()

    def add_error(category: str, message: str, *, net_ids: Iterable[str] = (), wire_ids: Iterable[str] = (), endpoint_ids: Iterable[str] = (), bounds: dict[str, float] | None = None) -> None:
        error = {
            "category": category,
            "message": message,
            "net_ids": sorted({str(value) for value in net_ids if str(value)}),
            "wire_ids": sorted({str(value) for value in wire_ids if str(value)}),
            "endpoint_ids": sorted({str(value) for value in endpoint_ids if str(value)}),
            "bounds": bounds,
        }
        key = _canonical_json(error)
        if key not in seen_errors:
            seen_errors.add(key)
            errors.append(error)

    net_by_id = {str(net.get("id", "")): net for net in nets}
    # Label-connected nets carry no routed tree: their pins join through
    # same-named net labels in the target schematic.  They are exempt from the
    # routed-partition, dangling-stub and orphan checks, but their stub wires
    # still participate in wire well-formedness and foreign-net contact checks
    # so an accidental physical short is rejected here rather than in KiCad.
    label_net_ids = {
        net_id for net_id, net in net_by_id.items() if str(net.get("connection", "")) == "label"
    }
    expected_by_id: dict[str, tuple[str, dict[str, Any]]] = {}
    expected_by_net: dict[str, list[tuple[str, dict[str, Any]]]] = {}
    for net in nets:
        net_id = str(net.get("id", ""))
        for endpoint in net.get("endpoints", []):
            endpoint_id = _routed_endpoint_id(endpoint)
            if not endpoint_id:
                add_error("invalid_source_endpoint", "source endpoint has no stable pin or port identity", net_ids=[net_id])
                continue
            if endpoint_id in expected_by_id:
                add_error("duplicate_source_endpoint", f"source endpoint {endpoint_id} occurs more than once", net_ids=[net_id, expected_by_id[endpoint_id][0]], endpoint_ids=[endpoint_id])
                continue
            expected_by_id[endpoint_id] = (net_id, endpoint)
            expected_by_net.setdefault(net_id, []).append((endpoint_id, endpoint))

    valid_segments: list[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]] = []
    segments_by_net: dict[str, list[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]]] = {}
    for wire in wires:
        wire_id = str(wire.get("id", ""))
        net_id = str(wire.get("net_id", ""))
        net = net_by_id.get(net_id)
        if net is None:
            add_error("unknown_wire_net", f"wire {wire_id} references unknown net {net_id}", net_ids=[net_id], wire_ids=[wire_id])
            continue
        if str(wire.get("net", "")) != str(net.get("name", "")):
            add_error("wire_net_name_mismatch", f"wire {wire_id} net name does not match {net_id}", net_ids=[net_id], wire_ids=[wire_id])
        points = wire.get("points")
        if not isinstance(points, list) or len(points) < 2:
            add_error("malformed_wire", f"wire {wire_id} must contain at least two points", net_ids=[net_id], wire_ids=[wire_id])
            continue
        usable = True
        for point in points:
            if not isinstance(point, dict) or any(isinstance(point.get(axis), bool) or not isinstance(point.get(axis), (int, float)) or not math.isfinite(float(point[axis])) for axis in ("x", "y")):
                add_error("malformed_wire", f"wire {wire_id} contains an invalid point", net_ids=[net_id], wire_ids=[wire_id])
                usable = False
                break
        if not usable:
            continue
        for endpoint_name, point in (("from", points[0]), ("to", points[-1])):
            endpoint_ref = wire.get(endpoint_name) or {}
            endpoint_id = _routed_endpoint_id(endpoint_ref)
            if endpoint_id:
                expected = expected_by_id.get(endpoint_id)
                if expected is None:
                    add_error("unknown_wire_endpoint", f"wire {wire_id} references unknown endpoint {endpoint_id}", net_ids=[net_id], wire_ids=[wire_id], endpoint_ids=[endpoint_id])
                elif expected[0] != net_id:
                    add_error("wire_endpoint_net_mismatch", f"wire {wire_id} attaches {endpoint_id} to the wrong net", net_ids=[net_id, expected[0]], wire_ids=[wire_id], endpoint_ids=[endpoint_id])
                elif _point_key(expected[1]) != _point_key(point):
                    add_error("wire_endpoint_position_mismatch", f"wire {wire_id} does not start/end at {endpoint_id}", net_ids=[net_id], wire_ids=[wire_id], endpoint_ids=[endpoint_id])
            elif isinstance(endpoint_ref, dict) and "x" in endpoint_ref and "y" in endpoint_ref and _point_key(endpoint_ref) != _point_key(point):
                add_error("wire_endpoint_position_mismatch", f"wire {wire_id} endpoint coordinate does not match its path", net_ids=[net_id], wire_ids=[wire_id])
        for index in range(len(points) - 1):
            start, end = points[index], points[index + 1]
            sx, sy = _point_key(start)
            ex, ey = _point_key(end)
            if (sx, sy) == (ex, ey):
                add_error("zero_length_segment", f"wire {wire_id} contains a zero-length segment", net_ids=[net_id], wire_ids=[wire_id])
                continue
            if sx != ex and sy != ey:
                add_error("non_orthogonal_segment", f"wire {wire_id} contains a diagonal segment", net_ids=[net_id], wire_ids=[wire_id])
                continue
            segment = (start, end, wire)
            valid_segments.append(segment)
            if net_id not in label_net_ids:
                segments_by_net.setdefault(net_id, []).append(segment)

    for index, left in enumerate(valid_segments):
        for right in valid_segments[index + 1:]:
            contact = _different_net_segment_contact(left, right)
            if contact is None:
                continue
            add_error(
                str(contact["category"]),
                "different-net routed segments form an unintended electrical contact",
                net_ids=[str(left[2].get("net_id", "")), str(right[2].get("net_id", ""))],
                wire_ids=[str(left[2].get("id", "")), str(right[2].get("id", ""))],
                bounds=contact.get("bounds"),
            )

    for endpoint_id, (endpoint_net_id, endpoint) in expected_by_id.items():
        for start, end, wire in valid_segments:
            wire_net_id = str(wire.get("net_id", ""))
            if wire_net_id != endpoint_net_id and _point_on_segment(endpoint, start, end):
                x, y = _point_key(endpoint)
                add_error(
                    "endpoint_on_foreign_net",
                    f"source endpoint {endpoint_id} touches a routed segment from another net",
                    net_ids=[endpoint_net_id, wire_net_id],
                    wire_ids=[str(wire.get("id", ""))],
                    endpoint_ids=[endpoint_id],
                    bounds={"min_x": x, "min_y": y, "max_x": x, "max_y": y},
                )

    graph = _UnionFind()
    endpoint_nodes: dict[str, str] = {}
    segment_nodes_by_net: dict[str, set[str]] = {}
    neighbours_by_net: dict[str, dict[str, set[str]]] = {}

    def node_id(net_id: str, point: dict[str, Any]) -> str:
        x, y = _point_key(point)
        return f"{net_id}@{x:.6f},{y:.6f}"

    for net_id, entries in expected_by_net.items():
        if net_id in label_net_ids:
            continue
        for endpoint_id, endpoint in entries:
            node = node_id(net_id, endpoint)
            graph.find(node)
            endpoint_nodes[endpoint_id] = node

    for net_id, segments in segments_by_net.items():
        candidate_points = [point for start, end, _ in segments for point in (start, end)]
        candidate_points.extend(endpoint for _, endpoint in expected_by_net.get(net_id, []))
        for start, end, _ in segments:
            breakpoints = {_point_key(point): point for point in candidate_points if _point_on_segment(point, start, end)}
            ordered = sorted(breakpoints.values(), key=lambda point: (_point_key(point)[1], _point_key(point)[0]) if _point_key(start)[0] == _point_key(end)[0] else (_point_key(point)[0], _point_key(point)[1]))
            for point in ordered:
                segment_nodes_by_net.setdefault(net_id, set()).add(node_id(net_id, point))
            for left, right in zip(ordered, ordered[1:]):
                left_node = node_id(net_id, left)
                right_node = node_id(net_id, right)
                graph.union(left_node, right_node)
                neighbours_by_net.setdefault(net_id, {}).setdefault(left_node, set()).add(right_node)
                neighbours_by_net.setdefault(net_id, {}).setdefault(right_node, set()).add(left_node)

    semantic_nodes = set(endpoint_nodes.values())
    for net_id, neighbours in neighbours_by_net.items():
        for node, connected in neighbours.items():
            if len(connected) != 1 or node in semantic_nodes:
                continue
            coordinate = node.rsplit("@", 1)[-1]
            x_text, y_text = coordinate.split(",", 1)
            x, y = float(x_text), float(y_text)
            add_error(
                "dangling_routed_stub",
                f"net {net_id} contains a non-semantic dangling wire endpoint",
                net_ids=[net_id],
                bounds={"min_x": x, "min_y": y, "max_x": x, "max_y": y},
            )

    routed_groups: dict[str, list[str]] = {}
    for endpoint_id, node in endpoint_nodes.items():
        routed_groups.setdefault(graph.find(node), []).append(endpoint_id)
    for net_id, entries in expected_by_net.items():
        if net_id in label_net_ids:
            continue
        roots = {graph.find(endpoint_nodes[endpoint_id]) for endpoint_id, _ in entries if endpoint_id in endpoint_nodes}
        if len(roots) > 1:
            add_error(
                "missing_routed_connection",
                f"source net {net_id} is split into {len(roots)} routed groups",
                net_ids=[net_id],
                endpoint_ids=[endpoint_id for endpoint_id, _ in entries],
            )
        endpoint_roots = roots
        for node in segment_nodes_by_net.get(net_id, set()):
            if graph.find(node) not in endpoint_roots:
                add_error("orphan_routed_wire", f"net {net_id} contains routed geometry not attached to a source endpoint", net_ids=[net_id])
                break

    source_partition = sorted(sorted(endpoint_id for endpoint_id, _ in entries) for net_id, entries in sorted(expected_by_net.items()) if net_id not in label_net_ids)
    routed_partition = sorted(sorted(group) for group in routed_groups.values())
    source_partition_hash = _sha256_bytes(_canonical_json(source_partition))
    routed_partition_hash = _sha256_bytes(_canonical_json(routed_partition))
    if source_partition_hash != routed_partition_hash:
        add_error("connectivity_partition_mismatch", "routed endpoint partition differs from the source netlist")
    return {
        "schema": ROUTED_CONNECTIVITY_SCHEMA,
        "ok": not errors,
        "source_partition_hash": source_partition_hash,
        "routed_partition_hash": routed_partition_hash,
        "source_net_count": len(expected_by_net),
        "source_endpoint_count": len(expected_by_id),
        "wire_count": len(wires),
        "errors": errors,
    }


def _require_routed_connectivity(nets: list[dict[str, Any]], wires: list[dict[str, Any]]) -> dict[str, Any]:
    verification = verify_routed_connectivity(nets, wires)
    if not verification["ok"]:
        categories = ", ".join(sorted({str(error["category"]) for error in verification["errors"]}))
        raise ValueError(f"routed connectivity verification failed: {categories}")
    return verification


def _strict_segment_cross(left: tuple[dict[str, Any], dict[str, Any], dict[str, Any]], right: tuple[dict[str, Any], dict[str, Any], dict[str, Any]]) -> dict[str, float] | None:
    a, b, aw = left
    c, d, bw = right
    if aw.get("net_id") == bw.get("net_id"):
        return None
    a_vertical, c_vertical = a["x"] == b["x"], c["x"] == d["x"]
    if a_vertical == c_vertical:
        return None
    vertical_a, vertical_b, horizontal_a, horizontal_b = (a, b, c, d) if a_vertical else (c, d, a, b)
    x, y = vertical_a["x"], horizontal_a["y"]
    if min(vertical_a["y"], vertical_b["y"]) < y < max(vertical_a["y"], vertical_b["y"]) and min(horizontal_a["x"], horizontal_b["x"]) < x < max(horizontal_a["x"], horizontal_b["x"]):
        return {"x": x, "y": y}
    return None


def _segment_intersects_bounds(start: dict[str, float], end: dict[str, float], bounds: dict[str, float]) -> bool:
    epsilon = 1e-6
    if abs(start["x"] - end["x"]) < epsilon:
        x = start["x"]
        return bounds["min_x"] + epsilon < x < bounds["max_x"] - epsilon and max(min(start["y"], end["y"]), bounds["min_y"] + epsilon) < min(max(start["y"], end["y"]), bounds["max_y"] - epsilon)
    if abs(start["y"] - end["y"]) < epsilon:
        y = start["y"]
        return bounds["min_y"] + epsilon < y < bounds["max_y"] - epsilon and max(min(start["x"], end["x"]), bounds["min_x"] + epsilon) < min(max(start["x"], end["x"]), bounds["max_x"] - epsilon)
    return False


def _issue(category: str, severity: str, *, components: Iterable[str] = (), nets: Iterable[str] = (), bounds: dict[str, float] | None = None, fix: str) -> dict[str, Any]:
    return {
        "category": category, "severity": severity,
        "component_ids": sorted(set(components)), "net_ids": sorted(set(nets)),
        "bounds": bounds, "fix_category": fix,
    }


def score_layout(
    module_id: str,
    components: list[dict[str, Any]],
    nets: list[dict[str, Any]],
    wires: list[dict[str, Any]],
    ports: dict[str, dict[str, float]],
    connectivity_hash: str,
    port_defs: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    routed_connectivity = _require_routed_connectivity(nets, wires)
    issues: list[dict[str, Any]] = []
    for net in nets:
        if len(net["endpoints"]) < 2 and not any(endpoint.get("kind") == "port" for endpoint in net["endpoints"]):
            issues.append(_issue("unexpected_single_ended_net", "error", nets=[net["id"]], fix="connect_or_mark_no_connect"))
    component_bounds = {str(component["id"]): _component_bounds(component) for component in components}
    component_ids = sorted(component_bounds)
    for index, left_id in enumerate(component_ids):
        left = component_bounds[left_id]
        for right_id in component_ids[index + 1:]:
            right = component_bounds[right_id]
            if left["min_x"] < right["max_x"] and left["max_x"] > right["min_x"] and left["min_y"] < right["max_y"] and left["max_y"] > right["min_y"]:
                issues.append(_issue("component_overlap", "error", components=[left_id, right_id], bounds={
                    "min_x": max(left["min_x"], right["min_x"]), "min_y": max(left["min_y"], right["min_y"]),
                    "max_x": min(left["max_x"], right["max_x"]), "max_y": min(left["max_y"], right["max_y"]),
                }, fix="move_component"))
    segments = list(_segments(wires))
    for start, end, wire in segments:
        for component_id, bounds in component_bounds.items():
            if _segment_intersects_bounds(start, end, bounds):
                issues.append(_issue("wire_through_component", "error", components=[component_id], nets=[wire.get("net_id", "")], bounds=bounds, fix="reroute_net"))
    crossings: list[dict[str, float]] = []
    for index, left in enumerate(segments):
        for right in segments[index + 1:]:
            crossing = _strict_segment_cross(left, right)
            if crossing:
                crossings.append(crossing)
                issues.append(_issue("wire_crossing", "warning", nets=[left[2].get("net_id", ""), right[2].get("net_id", "")], bounds={"min_x": crossing["x"], "min_y": crossing["y"], "max_x": crossing["x"], "max_y": crossing["y"]}, fix="reroute_net"))
    label_boxes: list[tuple[str, dict[str, float]]] = []
    for component in components:
        component_id = str(component.get("id", ""))
        bounds = component_bounds[component_id]
        label_width = max(40.0, min(240.0, len(str(component.get("name", component_id))) * 10.0))
        center_y = float((component.get("position") or {}).get("y", 0))
        label_boxes.append((component_id, {
            "min_x": bounds["max_x"] + 10.0,
            "min_y": center_y - 14.0,
            "max_x": bounds["max_x"] + 10.0 + label_width,
            "max_y": center_y + 6.0,
        }))

    def overlap_bounds(left: dict[str, float], right: dict[str, float]) -> dict[str, float] | None:
        if left["min_x"] >= right["max_x"] or left["max_x"] <= right["min_x"] or left["min_y"] >= right["max_y"] or left["max_y"] <= right["min_y"]:
            return None
        return {
            "min_x": max(left["min_x"], right["min_x"]),
            "min_y": max(left["min_y"], right["min_y"]),
            "max_x": min(left["max_x"], right["max_x"]),
            "max_y": min(left["max_y"], right["max_y"]),
        }

    net_id_by_name = {
        str(net.get("name", "")): str(net.get("id", ""))
        for net in nets
    }

    def port_render_side(port: dict[str, Any], position: dict[str, float]) -> str:
        text = f"{port.get('name', '')} {port.get('net', '')} {port.get('signal_type', '')}".lower()
        if port.get("signal_type") == "ground" or "gnd" in text or str(port.get("net", "")) == "0":
            return "bottom"
        if port.get("signal_type") == "power":
            return "top"
        if port.get("direction") == "output":
            return "right"
        pin_points = [
            _pin_position(component, pin, index)
            for component in components
            for index, pin in enumerate(component.get("pins") or [])
            if str(pin.get("net", "")) == str(port.get("net", ""))
        ]
        if not pin_points:
            return "left"
        nearest = min(
            pin_points,
            key=lambda point: (
                float(position["x"]) - float(point["x"])
            ) ** 2 + (
                float(position["y"]) - float(point["y"])
            ) ** 2,
        )
        dx = float(position["x"]) - float(nearest["x"])
        dy = float(position["y"]) - float(nearest["y"])
        if abs(dx) >= abs(dy):
            return "right" if dx >= 0 else "left"
        return "bottom" if dy >= 0 else "top"

    def port_interaction_bounds(position: dict[str, float], side: str) -> dict[str, float]:
        x, y = float(position["x"]), float(position["y"])
        if side == "right":
            return {"min_x": x - 12, "min_y": y - 34, "max_x": x + 94, "max_y": y + 34}
        if side == "left":
            return {"min_x": x - 94, "min_y": y - 34, "max_x": x + 12, "max_y": y + 34}
        if side == "top":
            return {"min_x": x - 48, "min_y": y - 70, "max_x": x + 48, "max_y": y + 12}
        return {"min_x": x - 48, "min_y": y - 12, "max_x": x + 80, "max_y": y + 58}

    def port_visual_bounds(bounds: dict[str, float], position: dict[str, float], side: str) -> dict[str, float]:
        # The interaction target extends 12 units through the electrical
        # anchor. Exclude that inward allowance when checking components so a
        # port placed directly on a connected pin is not reported as a visual
        # collision.
        visual = dict(bounds)
        if side == "right":
            visual["min_x"] = float(position["x"])
        elif side == "left":
            visual["max_x"] = float(position["x"])
        elif side == "top":
            visual["max_y"] = float(position["y"])
        else:
            visual["min_y"] = float(position["y"])
        return visual

    port_boxes: list[dict[str, Any]] = []
    for port in port_defs or []:
        port_id = str(port.get("id", ""))
        position = ports.get(port_id)
        if not port_id or not isinstance(position, dict):
            continue
        try:
            normalized_position = {
                "x": float(position["x"]),
                "y": float(position["y"]),
            }
        except (KeyError, TypeError, ValueError):
            continue
        if not all(math.isfinite(value) for value in normalized_position.values()):
            continue
        side = port_render_side(port, normalized_position)
        bounds = port_interaction_bounds(normalized_position, side)
        net_name = str(port.get("net", ""))
        port_boxes.append({
            "id": port_id,
            "net_id": net_id_by_name.get(net_name, net_name),
            "position": normalized_position,
            "side": side,
            "bounds": bounds,
            "visual_bounds": port_visual_bounds(bounds, normalized_position, side),
        })
    for index, left in enumerate(port_boxes):
        for right in port_boxes[index + 1:]:
            overlap = overlap_bounds(left["bounds"], right["bounds"])
            if overlap:
                issues.append(_issue(
                    "port_overlap",
                    "warning",
                    nets=[left["net_id"], right["net_id"]],
                    bounds=overlap,
                    fix="move_ports",
                ))
        for component_id, bounds in component_bounds.items():
            overlap = overlap_bounds(left["visual_bounds"], bounds)
            if overlap:
                issues.append(_issue(
                    "port_component_overlap",
                    "warning",
                    components=[component_id],
                    nets=[left["net_id"]],
                    bounds=overlap,
                    fix="move_port_or_component",
                ))

    seen_label_issues: set[tuple[str, str, str]] = set()
    component_net_ids = {
        str(component.get("id", "")): {
            str(net.get("id", ""))
            for pin in component.get("pins", [])
            for net in nets
            if str(net.get("name", "")) == str(pin.get("net", ""))
        }
        for component in components
    }
    for index, (component_id, label_bounds) in enumerate(label_boxes):
        for other_id, other_bounds in component_bounds.items():
            if other_id == component_id:
                continue
            overlap = overlap_bounds(label_bounds, other_bounds)
            key = (component_id, "component", other_id)
            if overlap and key not in seen_label_issues:
                seen_label_issues.add(key)
                issues.append(_issue("label_overlap", "warning", components=[component_id, other_id], bounds=overlap, fix="move_component"))
        for start, end, wire in segments:
            net_id = str(wire.get("net_id", ""))
            if net_id in component_net_ids.get(component_id, set()):
                continue
            key = (component_id, "net", net_id)
            if key not in seen_label_issues and _segment_intersects_bounds(start, end, label_bounds):
                seen_label_issues.add(key)
                issues.append(_issue("label_overlap", "warning", components=[component_id], nets=[net_id], bounds=label_bounds, fix="move_component_or_reroute_net"))
        for other_id, other_label_bounds in label_boxes[index + 1:]:
            overlap = overlap_bounds(label_bounds, other_label_bounds)
            key = (component_id, "label", other_id)
            if overlap and key not in seen_label_issues:
                seen_label_issues.add(key)
                issues.append(_issue("label_overlap", "warning", components=[component_id, other_id], bounds=overlap, fix="spread_layout"))

    corridor_size = 4 * GRID
    corridor_nets: dict[tuple[int, int], set[str]] = {}
    corridor_segments: dict[tuple[int, int], int] = {}
    for start, end, wire in segments:
        min_cell_x = math.floor(min(float(start["x"]), float(end["x"])) / corridor_size)
        max_cell_x = math.floor(max(float(start["x"]), float(end["x"])) / corridor_size)
        min_cell_y = math.floor(min(float(start["y"]), float(end["y"])) / corridor_size)
        max_cell_y = math.floor(max(float(start["y"]), float(end["y"])) / corridor_size)
        cells = (
            ((cell_x, min_cell_y) for cell_x in range(min_cell_x, max_cell_x + 1))
            if float(start["y"]) == float(end["y"])
            else ((min_cell_x, cell_y) for cell_y in range(min_cell_y, max_cell_y + 1))
        )
        for cell in cells:
            corridor_nets.setdefault(cell, set()).add(str(wire.get("net_id", "")))
            corridor_segments[cell] = corridor_segments.get(cell, 0) + 1
    congested_cells = [
        (cell, corridor_nets[cell])
        for cell in sorted(corridor_nets)
        if len(corridor_nets[cell]) >= 4 or corridor_segments.get(cell, 0) >= 8
    ]
    for (cell_x, cell_y), net_ids in congested_cells:
        issues.append(_issue("corridor_congestion", "warning", nets=net_ids, bounds={
            "min_x": cell_x * corridor_size,
            "min_y": cell_y * corridor_size,
            "max_x": (cell_x + 1) * corridor_size,
            "max_y": (cell_y + 1) * corridor_size,
        }, fix="spread_layout_or_reroute_nets"))

    component_by_net = {
        str(net.get("id", "")): sorted({str(endpoint.get("component_id", "")) for endpoint in net.get("endpoints", []) if endpoint.get("component_id")})
        for net in nets
    }
    input_nets = [net for net in nets if str(net.get("name", "")).lower() in {"in", "input", "vin"} and any(endpoint.get("kind") == "port" for endpoint in net.get("endpoints", []))]
    output_nets = [net for net in nets if str(net.get("name", "")).lower() in {"out", "output", "vout"} and any(endpoint.get("kind") == "port" for endpoint in net.get("endpoints", []))]
    flow_issues = 0
    if input_nets and output_nets:
        input_points = [endpoint for net in input_nets for endpoint in net.get("endpoints", []) if endpoint.get("kind") == "port"]
        output_points = [endpoint for net in output_nets for endpoint in net.get("endpoints", []) if endpoint.get("kind") == "port"]
        input_x = sum(float(point["x"]) for point in input_points) / len(input_points)
        output_x = sum(float(point["x"]) for point in output_points) / len(output_points)
        if input_x >= output_x:
            flow_issues += 1
            all_points = [*input_points, *output_points]
            issues.append(_issue("signal_flow_violation", "warning", components=[
                *[component for net in input_nets for component in component_by_net.get(str(net.get("id", "")), [])],
                *[component for net in output_nets for component in component_by_net.get(str(net.get("id", "")), [])],
            ], nets=[*[str(net.get("id", "")) for net in input_nets], *[str(net.get("id", "")) for net in output_nets]], bounds={
                "min_x": min(float(point["x"]) for point in all_points),
                "min_y": min(float(point["y"]) for point in all_points),
                "max_x": max(float(point["x"]) for point in all_points),
                "max_y": max(float(point["y"]) for point in all_points),
            }, fix="move_ports_or_set_layout_lane"))
    feedback_nets = [net for net in nets if str(net.get("name", "")).lower() in {"fb", "feedback", "sense"}]
    if feedback_nets and components:
        median_y = sorted(float((component.get("position") or {}).get("y", 0)) for component in components)[len(components) // 2]
        for net in feedback_nets:
            endpoints = net.get("endpoints", [])
            if len(endpoints) >= 2 and sum(float(endpoint["y"]) for endpoint in endpoints) / len(endpoints) <= median_y:
                flow_issues += 1
                issues.append(_issue("feedback_readability", "warning", components=component_by_net.get(str(net.get("id", "")), []), nets=[str(net.get("id", ""))], bounds={
                    "min_x": min(float(endpoint["x"]) for endpoint in endpoints),
                    "min_y": min(float(endpoint["y"]) for endpoint in endpoints),
                    "max_x": max(float(endpoint["x"]) for endpoint in endpoints),
                    "max_y": max(float(endpoint["y"]) for endpoint in endpoints),
                }, fix="set_layout_lane"))
    symmetry_issues = 0

    def terminal_net(component: dict[str, Any], roles: set[str]) -> str:
        for pin in component.get("pins", []):
            role = str((pin.get("eda") or {}).get("role") or pin.get("name") or pin.get("id") or "").lower()
            if role in roles:
                return str(pin.get("net", ""))
        return ""

    active_components = [component for component in components if str(component.get("type", "")).upper() in {"M", "Q"}]
    for index, left in enumerate(active_components):
        left_type = str(left.get("type", "")).upper()
        common_roles = {"s", "source"} if left_type == "M" else {"e", "emitter"}
        left_common = terminal_net(left, common_roles)
        for right in active_components[index + 1:]:
            if str(right.get("type", "")).upper() != left_type or str(right.get("value", "")) != str(left.get("value", "")):
                continue
            if not left_common or terminal_net(right, common_roles) != left_common:
                continue
            left_position = left.get("position") or {}
            right_position = right.get("position") or {}
            if abs(float(left_position.get("y", 0)) - float(right_position.get("y", 0))) <= GRID:
                continue
            symmetry_issues += 1
            issues.append(_issue("symmetry_readability", "warning", components=[str(left.get("id", "")), str(right.get("id", ""))], bounds={
                "min_x": min(float(left_position.get("x", 0)), float(right_position.get("x", 0))),
                "min_y": min(float(left_position.get("y", 0)), float(right_position.get("y", 0))),
                "max_x": max(float(left_position.get("x", 0)), float(right_position.get("x", 0))),
                "max_y": max(float(left_position.get("y", 0)), float(right_position.get("y", 0))),
            }, fix="set_layout_lane"))
    bends = 0
    total_length = 0.0
    long_wires = 0
    net_routing: dict[str, dict[str, Any]] = {}
    for wire in wires:
        points = wire.get("points") or []
        wire_bends = max(0, len(points) - 2)
        wire_length = sum(
            abs(float(end["x"]) - float(start["x"])) + abs(float(end["y"]) - float(start["y"]))
            for start, end in zip(points, points[1:])
        )
        bends += wire_bends
        total_length += wire_length
        net_id = str(wire.get("net_id", ""))
        summary = net_routing.setdefault(net_id, {
            "bends": 0,
            "length": 0.0,
            "points": [],
        })
        summary["bends"] += wire_bends
        summary["length"] += wire_length
        summary["points"].extend(points)
        if wire_length > 20 * GRID:
            long_wires += 1
            issues.append(_issue("long_wire", "info", nets=[net_id], bounds={
                "min_x": min(float(point["x"]) for point in points),
                "min_y": min(float(point["y"]) for point in points),
                "max_x": max(float(point["x"]) for point in points),
                "max_y": max(float(point["y"]) for point in points),
            }, fix="move_components_or_reroute_net"))
    for net_id, summary in sorted(net_routing.items()):
        points = summary["points"]
        if summary["bends"] < 4 or not points:
            continue
        issues.append(_issue("excessive_bends", "info", nets=[net_id], bounds={
            "min_x": min(float(point["x"]) for point in points),
            "min_y": min(float(point["y"]) for point in points),
            "max_x": max(float(point["x"]) for point in points),
            "max_y": max(float(point["y"]) for point in points),
        }, fix="reroute_net_or_adjust_layout_lane"))
    category_counts = {category: sum(issue["category"] == category for issue in issues) for category in {
        "unexpected_single_ended_net", "component_overlap", "wire_through_component", "port_overlap", "port_component_overlap", "wire_crossing", "label_overlap", "corridor_congestion", "signal_flow_violation", "feedback_readability", "symmetry_readability",
    }}
    port_overlaps = category_counts.get("port_overlap", 0) + category_counts.get("port_component_overlap", 0)
    label_overlaps = category_counts.get("label_overlap", 0)
    congestion = category_counts.get("corridor_congestion", 0)
    readability = max(0.0, min(100.0, 100.0 - category_counts.get("unexpected_single_ended_net", 0) * 30 - category_counts.get("component_overlap", 0) * 25 - category_counts.get("wire_through_component", 0) * 20 - port_overlaps * 25 - len(crossings) * 8 - label_overlaps * 4 - congestion * 2 - flow_issues * 6 - symmetry_issues * 4 - bends * 0.15 - long_wires))
    routing_complexity = round(bends * 1_000_000 + long_wires * 100_000 + total_length, 3)
    vector = [
        category_counts.get("unexpected_single_ended_net", 0),
        category_counts.get("component_overlap", 0) + category_counts.get("wire_through_component", 0) + port_overlaps,
        len(crossings), label_overlaps, congestion, routing_complexity, flow_issues + symmetry_issues, round(100.0 - readability, 3),
    ]
    return {
        "schema": QUALITY_SCHEMA, "module_id": module_id, "connectivity_hash": connectivity_hash,
        "lexicographic_cost": vector, "readability_score": round(readability, 3),
        "metrics": {"missing_connections": category_counts.get("unexpected_single_ended_net", 0), "component_overlaps": category_counts.get("component_overlap", 0), "wire_through_components": category_counts.get("wire_through_component", 0), "port_overlaps": port_overlaps, "wire_crossings": len(crossings), "label_overlaps": label_overlaps, "congestion": congestion, "flow_feedback_issues": flow_issues, "symmetry_issues": symmetry_issues, "bends": bends, "long_wires": long_wires, "total_length": round(total_length, 3)},
        "issues": issues, "routed_connectivity": routed_connectivity,
    }


def _strict_integer(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{field} must be an integer")
    return value


def _strict_object_keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        unknown = sorted(actual - expected)
        details = []
        if missing:
            details.append(f"missing {missing}")
        if unknown:
            details.append(f"unknown {unknown}")
        raise ValueError(f"{label} fields are invalid: {', '.join(details)}")


def validate_layout_patch(
    patch: dict[str, Any],
    component_ids: set[str],
    port_ids: set[str],
    component_defs: Iterable[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    if not isinstance(patch, dict):
        raise ValueError("layout patch must be an object")
    _strict_object_keys(patch, {"schema", "operations"}, "layout patch")
    if patch.get("schema") != PATCH_SCHEMA:
        raise ValueError(f"layout patch schema must be {PATCH_SCHEMA}")
    operations = patch.get("operations")
    if not isinstance(operations, list) or len(operations) > 32:
        raise ValueError("layout patch operations must be a list with at most 32 entries")
    components = {str(component.get("id", "")): component for component in (component_defs or [])}
    normalized: list[dict[str, Any]] = []
    component_moves: dict[str, tuple[int, int]] = {}
    port_moves: dict[str, tuple[int, int]] = {}
    rotations: set[str] = set()
    lanes: set[str] = set()
    pin_sides: set[tuple[str, str]] = set()
    for index, operation in enumerate(operations):
        if not isinstance(operation, dict):
            raise ValueError(f"layout patch operation {index} must be an object")
        kind = operation.get("op")
        if kind == "move_component":
            _strict_object_keys(operation, {"op", "component_id", "dx_grid", "dy_grid"}, f"move_component operation {index}")
            component_id = operation.get("component_id")
            if not isinstance(component_id, str) or not component_id.strip() or component_id not in component_ids:
                raise ValueError(f"invalid move_component operation for {component_id}")
            dx = _strict_integer(operation.get("dx_grid"), "dx_grid")
            dy = _strict_integer(operation.get("dy_grid"), "dy_grid")
            if abs(dx) > 6 or abs(dy) > 6:
                raise ValueError(f"invalid move_component operation for {component_id}")
            previous_dx, previous_dy = component_moves.get(component_id, (0, 0))
            total = previous_dx + dx, previous_dy + dy
            if abs(total[0]) > 6 or abs(total[1]) > 6:
                raise ValueError(f"cumulative move_component exceeds 6 grid units for {component_id}")
            component_moves[component_id] = total
            normalized.append({"op": kind, "component_id": component_id, "dx_grid": dx, "dy_grid": dy})
        elif kind == "rotate_component":
            _strict_object_keys(operation, {"op", "component_id", "rotation"}, f"rotate_component operation {index}")
            component_id = operation.get("component_id")
            rotation = _strict_integer(operation.get("rotation"), "rotation")
            if not isinstance(component_id, str) or not component_id.strip() or component_id not in component_ids or rotation not in ROTATIONS:
                raise ValueError(f"invalid rotate_component operation for {component_id}")
            if component_id in rotations:
                raise ValueError(f"conflicting rotate_component operations for {component_id}")
            rotations.add(component_id)
            normalized.append({"op": kind, "component_id": component_id, "rotation": rotation})
        elif kind == "move_port":
            _strict_object_keys(operation, {"op", "port_id", "dx_grid", "dy_grid"}, f"move_port operation {index}")
            port_id = operation.get("port_id")
            if not isinstance(port_id, str) or not port_id.strip() or port_id not in port_ids:
                raise ValueError(f"invalid move_port operation for {port_id}")
            dx = _strict_integer(operation.get("dx_grid"), "dx_grid")
            dy = _strict_integer(operation.get("dy_grid"), "dy_grid")
            if abs(dx) > 6 or abs(dy) > 6:
                raise ValueError(f"invalid move_port operation for {port_id}")
            previous_dx, previous_dy = port_moves.get(port_id, (0, 0))
            total = previous_dx + dx, previous_dy + dy
            if abs(total[0]) > 6 or abs(total[1]) > 6:
                raise ValueError(f"cumulative move_port exceeds 6 grid units for {port_id}")
            port_moves[port_id] = total
            normalized.append({"op": kind, "port_id": port_id, "dx_grid": dx, "dy_grid": dy})
        elif kind == "set_block_pin_side":
            _strict_object_keys(operation, {"op", "component_id", "pin_id", "side"}, f"set_block_pin_side operation {index}")
            component_id = operation.get("component_id")
            pin_id = operation.get("pin_id")
            side = operation.get("side")
            component = components.get(str(component_id))
            if (
                not isinstance(component_id, str)
                or component_id not in component_ids
                or component is None
                or str(component.get("type", "")).upper() != "BLOCK"
                or not isinstance(pin_id, str)
                or pin_id not in {str(pin.get("id", "")) for pin in component.get("pins", [])}
                or side not in PIN_SIDES
            ):
                raise ValueError(f"invalid set_block_pin_side operation for {component_id}.{pin_id}")
            pin_key = (component_id, pin_id)
            if pin_key in pin_sides:
                raise ValueError(f"conflicting set_block_pin_side operations for {component_id}.{pin_id}")
            pin_sides.add(pin_key)
            normalized.append({"op": kind, "component_id": component_id, "pin_id": pin_id, "side": side})
        elif kind == "set_layout_lane":
            _strict_object_keys(operation, {"op", "component_id", "rank", "lane"}, f"set_layout_lane operation {index}")
            component_id = operation.get("component_id")
            rank = _strict_integer(operation.get("rank"), "rank")
            lane = _strict_integer(operation.get("lane"), "lane")
            if not isinstance(component_id, str) or component_id not in component_ids or not 0 <= rank <= 16 or not -16 <= lane <= 16:
                raise ValueError(f"invalid set_layout_lane operation for {component_id}")
            if component_id in lanes:
                raise ValueError(f"conflicting set_layout_lane operations for {component_id}")
            lanes.add(component_id)
            normalized.append({"op": kind, "component_id": component_id, "rank": rank, "lane": lane})
        else:
            raise ValueError(f"layout patch operation is not allowed: {kind}")
    return normalized


def validate_layout_patch_set(
    patch_set: dict[str, Any],
    *,
    expected_revision: int,
    expected_connectivity_hash: str,
    component_ids: set[str],
    port_ids: set[str],
    component_defs: Iterable[dict[str, Any]],
) -> list[list[dict[str, Any]]]:
    if not isinstance(patch_set, dict):
        raise ValueError("layout patch set must be an object")
    _strict_object_keys(patch_set, {"schema", "source_revision", "connectivity_hash", "candidates"}, "layout patch set")
    if patch_set.get("schema") != PATCH_SET_SCHEMA:
        raise ValueError(f"layout patch set schema must be {PATCH_SET_SCHEMA}")
    revision = _strict_integer(patch_set.get("source_revision"), "source_revision")
    if revision != expected_revision:
        raise ValueError(f"stale layout patch revision: expected {expected_revision}, got {revision}")
    patch_hash = patch_set.get("connectivity_hash")
    if not isinstance(patch_hash, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", patch_hash):
        raise ValueError("layout patch connectivity_hash must contain 64 hexadecimal characters")
    if patch_hash != expected_connectivity_hash:
        raise ValueError("layout patch connectivity_hash does not match the authoritative source")
    candidates = patch_set.get("candidates")
    if not isinstance(candidates, list) or len(candidates) > 4:
        raise ValueError("layout patch candidates must be a list with at most 4 entries")
    return [
        validate_layout_patch(candidate, component_ids, port_ids, component_defs)
        for candidate in candidates
    ]


def _connectivity_records(project: dict[str, Any], modules: dict[str, dict[str, Any]], scope_module: str | None, view: str) -> list[dict[str, str]]:
    aliases = _project_net_aliases(project, modules)
    records: list[dict[str, str]] = []
    for module_id, module in sorted(modules.items()):
        if scope_module and module_id != scope_module:
            continue
        _, ids_by_name = _declared_net_maps(module)
        for component in sorted(module.get("components", []), key=lambda item: str(item.get("id", ""))):
            if not _included_component(component, view):
                continue
            for pin in sorted(component.get("pins", []), key=lambda item: str(item.get("id", ""))):
                local_net = _endpoint_net_id(pin, ids_by_name)
                records.append({"module_id": module_id, "component_id": str(component.get("id", "")), "pin_id": str(pin.get("id", "")), "net": aliases.get(f"{module_id}:{local_net}", f"{module_id}:{local_net}")})
        for port in sorted(module.get("ports", []), key=lambda item: str(item.get("id", ""))):
            local_net = _endpoint_net_id(port, ids_by_name)
            records.append({"module_id": module_id, "port_id": str(port.get("id", "")), "net": aliases.get(f"{module_id}:{local_net}", f"{module_id}:{local_net}")})
    return records


def connectivity_hash(project: dict[str, Any], modules: dict[str, dict[str, Any]], scope_module: str | None = None, view: str = "design") -> str:
    return _sha256_bytes(_canonical_json(_connectivity_records(project, modules, scope_module, view)))


def _evaluate_layout_candidate(
    module_id: str,
    module: dict[str, Any],
    components: list[dict[str, Any]],
    source_connectivity_hash: str,
    *,
    allow_global_fallback: bool = True,
) -> dict[str, Any]:
    nets, wires, port_positions = _route_module(module, components, allow_global_fallback=allow_global_fallback)
    report = score_layout(
        module_id,
        components,
        nets,
        wires,
        port_positions,
        source_connectivity_hash,
        module.get("ports", []),
    )
    ports = [
        {**json.loads(json.dumps(port)), "position": port_positions.get(str(port.get("id", "")))}
        for port in module.get("ports", [])
    ]
    return {
        "components": components,
        "ports": ports,
        "nets": nets,
        "wires": wires,
        "quality": report,
    }


def _label_layout_candidate(
    module_id: str,
    module: dict[str, Any],
    components: list[dict[str, Any]],
    source_connectivity_hash: str,
) -> dict[str, Any]:
    nets, wires, port_positions = _label_route_module(module, components)
    report = score_layout(
        module_id,
        components,
        nets,
        wires,
        port_positions,
        source_connectivity_hash,
        module.get("ports", []),
    )
    ports = [
        {**json.loads(json.dumps(port)), "position": port_positions.get(str(port.get("id", "")))}
        for port in module.get("ports", [])
    ]
    return {
        "components": components,
        "ports": ports,
        "nets": nets,
        "wires": wires,
        "quality": report,
        "connection_mode": "label",
    }


# Nets with more endpoints than this are power/ground-style distribution
# trees; real schematics draw them with net labels, and the orthogonal
# autorouter is not guaranteed to find a clean tree for them.  The threshold
# sits above the fanout of the compact analog cells the router is tuned for
# (the regression LDO peaks at four endpoints).
LABEL_MODE_MAX_FANOUT = 6


def _module_prefers_label_routing(module: dict[str, Any], components: list[dict[str, Any]]) -> bool:
    """Deterministic fast path for modules the autorouter cannot or should not route."""

    for component in components:
        eda = component.get("eda") if isinstance(component.get("eda"), dict) else {}
        if str(eda.get("symbol", "")).strip():
            # Routed wires anchor at generated glyph geometry; a real library
            # symbol exposes its pins at the library's own coordinates, so
            # only label stubs (anchored via symbol_pin_positions) connect.
            return True
    _, ids_by_name = _declared_net_maps(module)
    fanout: dict[str, int] = {}
    for component in components:
        seen_points: dict[tuple[float, float], str] = {}
        for index, pin in enumerate(component.get("pins", [])):
            net_id = _endpoint_net_id(pin, ids_by_name)
            fanout[net_id] = fanout.get(net_id, 0) + 1
            point = _point_key(_pin_position(component, pin, index))
            if point in seen_points and seen_points[point] != net_id:
                # Two pins on different nets share one anchor, so any physical
                # route would be a foreign-net contact by construction.
                return True
            seen_points[point] = net_id
    for port in module.get("ports", []):
        net_id = _endpoint_net_id(port, ids_by_name)
        fanout[net_id] = fanout.get(net_id, 0) + 1
    return max(fanout.values(), default=0) > LABEL_MODE_MAX_FANOUT


def _label_effective_bounds(component: dict[str, Any]) -> dict[str, float]:
    """Placement bounds for label-mode candidates.

    Generated glyphs use the generic box; components carrying a real library
    symbol also cover the rotated library pin extents, because the exported
    instance is that symbol rather than the generic box.
    """

    bounds = _component_bounds(component)
    eda = component.get("eda") if isinstance(component.get("eda"), dict) else {}
    eda_symbol = str(eda.get("symbol", "")).strip()
    if not eda_symbol:
        return bounds
    library, separator, cell = eda_symbol.partition(":")
    if not separator:
        return bounds
    try:
        symbol_pins = symbol_pin_positions(library.strip(), cell.strip())
    except ValueError:
        return bounds
    if not symbol_pins:
        return bounds
    position = component.get("position") or {}
    rotation = int(round(float(component.get("rotation", 0)))) % 360
    xs: list[float] = []
    ys: list[float] = []
    for x_mm, y_mm, _angle in symbol_pins.values():
        dx, dy = _rotate_point(x_mm / MM_PER_UNIT, -y_mm / MM_PER_UNIT, rotation)
        xs.append(float(position.get("x", 0)) + dx)
        ys.append(float(position.get("y", 0)) + dy)
    margin = 2 * GRID
    return {
        "min_x": min(bounds["min_x"], min(xs) - margin),
        "min_y": min(bounds["min_y"], min(ys) - margin),
        "max_x": max(bounds["max_x"], max(xs) + margin),
        "max_y": max(bounds["max_y"], max(ys) + margin),
    }


def _bounds_overlap(left: dict[str, float], right: dict[str, float]) -> bool:
    return (
        left["min_x"] < right["max_x"] and left["max_x"] > right["min_x"]
        and left["min_y"] < right["max_y"] and left["max_y"] > right["min_y"]
    )


def _bounds_shape(component: dict[str, Any]) -> tuple[float, float, float, float]:
    """Return (width, height, center_dx, center_dy) relative to the position."""

    bounds = _label_effective_bounds(component)
    position = component.get("position") or {}
    return (
        bounds["max_x"] - bounds["min_x"],
        bounds["max_y"] - bounds["min_y"],
        (bounds["min_x"] + bounds["max_x"]) / 2 - float(position.get("x", 0)),
        (bounds["min_y"] + bounds["max_y"]) / 2 - float(position.get("y", 0)),
    )


def _deoverlap_label_candidate(components: list[dict[str, Any]]) -> list[dict[str, Any]] | None:
    """Keep source positions and shift only overlapping components.

    Auto-grid placement can assign identical coordinates to two components;
    rather than discarding the whole source layout for a lane candidate, move
    each colliding component to the nearest free grid slot (deterministic ring
    search, closest first).  Returns ``None`` when nothing overlaps.
    """

    candidate = json.loads(json.dumps(components))
    placed: list[dict[str, float]] = []
    moved = False
    for component in candidate:
        width, height, center_dx, center_dy = _bounds_shape(component)
        position = component.setdefault("position", {"x": 0.0, "y": 0.0})
        bounds = {
            "min_x": float(position.get("x", 0)) + center_dx - width / 2,
            "max_x": float(position.get("x", 0)) + center_dx + width / 2,
            "min_y": float(position.get("y", 0)) + center_dy - height / 2,
            "max_y": float(position.get("y", 0)) + center_dy + height / 2,
        }
        if not any(_bounds_overlap(bounds, other) for other in placed):
            placed.append(bounds)
            continue
        moved = True
        origin_x = _snap(float(position.get("x", 0)))
        origin_y = _snap(float(position.get("y", 0)))
        offsets = sorted(
            (
                (dx, dy)
                for radius in range(1, 25)
                for dx in range(-radius, radius + 1)
                for dy in range(-radius, radius + 1)
                if max(abs(dx), abs(dy)) == radius
            ),
            key=lambda item: (max(abs(item[0]), abs(item[1])), item[0], item[1]),
        )
        chosen: dict[str, float] | None = None
        for dx, dy in offsets:
            trial_bounds = {
                "min_x": origin_x + dx * GRID + center_dx - width / 2,
                "max_x": origin_x + dx * GRID + center_dx + width / 2,
                "min_y": origin_y + dy * GRID + center_dy - height / 2,
                "max_y": origin_y + dy * GRID + center_dy + height / 2,
            }
            if any(_bounds_overlap(trial_bounds, other) for other in placed):
                continue
            position["x"], position["y"] = origin_x + dx * GRID, origin_y + dy * GRID
            chosen = trial_bounds
            break
        if chosen is None:
            return None
        placed.append(chosen)
    return candidate if moved else None


def _compact_label_candidate(components: list[dict[str, Any]]) -> list[dict[str, Any]] | None:
    """Arrange components into a compact multi-column grid.

    Deterministic order: the largest pin-count component first, then greedily
    by connectivity adjacency to already-placed components.  The column count
    targets a landscape-ish bounding box instead of one tall column.
    """

    if not components:
        return None
    candidate = json.loads(json.dumps(components))
    nets_by_component = {
        str(component.get("id", "")): {
            str(pin.get("net_id") or pin.get("net") or "")
            for pin in component.get("pins", [])
        }
        for component in candidate
    }
    remaining = {str(component.get("id", "")): component for component in candidate}
    order: list[dict[str, Any]] = []
    placed_ids: set[str] = set()
    while remaining:
        def rank(entry: dict[str, Any]) -> tuple[int, int, str]:
            nets = nets_by_component.get(str(entry.get("id", "")), set())
            adjacency = sum(1 for other in placed_ids if nets & nets_by_component.get(other, set()))
            return (-adjacency, -len(entry.get("pins", [])), str(entry.get("id", "")))

        chosen = min(remaining.values(), key=rank)
        chosen_id = str(chosen.get("id", ""))
        order.append(chosen)
        placed_ids.add(chosen_id)
        remaining.pop(chosen_id)
    columns = max(1, math.ceil(math.sqrt(len(order) * 1.4)))
    gap = 8 * GRID
    cursor_y = 0.0
    for row_start in range(0, len(order), columns):
        row = order[row_start:row_start + columns]
        row_height = 0.0
        cursor_x = 0.0
        for component in row:
            width, height, center_dx, center_dy = _bounds_shape(component)
            component["position"] = {
                "x": _snap(cursor_x + width / 2 - center_dx),
                "y": _snap(cursor_y + height / 2 - center_dy),
            }
            cursor_x += width + gap
            row_height = max(row_height, height)
        cursor_y += row_height + gap
    return candidate


def _label_candidate_order(candidates: list[list[dict[str, Any]]]) -> list[list[dict[str, Any]]]:
    """Order label-mode candidates: de-overlapped source, compact grid, source, lanes."""

    if not candidates:
        return []
    ordered: list[list[dict[str, Any]]] = []
    seen: set[bytes] = set()

    def offer(candidate: list[dict[str, Any]] | None) -> None:
        if candidate is None:
            return
        key = _canonical_json(candidate)
        if key not in seen:
            seen.add(key)
            ordered.append(candidate)

    source = candidates[0]
    # Overlapping source placements are perturbed minimally first; the raw
    # source remains as a later fallback in case the perturbation breaks stub
    # placement somewhere unexpected.
    offer(_deoverlap_label_candidate(source) or source)
    offer(_compact_label_candidate(source))
    offer(source)
    for candidate in candidates[1:]:
        offer(candidate)
    return ordered


def _first_label_layout_candidate(
    module_id: str,
    module: dict[str, Any],
    candidates: list[list[dict[str, Any]]],
    source_connectivity_hash: str,
) -> dict[str, Any]:
    """Return the first candidate whose label stubs avoid foreign contacts.

    Source placements may stack two library-symbol components so their real
    pins coincide (auto-grid collisions); a straight label stub from such a
    point contacts the foreign pin at every direction and length.  The
    candidate order keeps the source layout first, then a minimally perturbed
    de-overlapped source, then a compact grid, and only then the lane-based
    variants, so aesthetics survive whenever stub placement still succeeds.
    """

    failures: list[str] = []
    for components in _label_candidate_order(candidates):
        try:
            return _label_layout_candidate(module_id, module, components, source_connectivity_hash)
        except ValueError as error:
            failures.append(str(error))
    details = "; ".join(sorted(set(failures)))
    raise ValueError(f"no deterministic layout candidate avoided label stub conflicts: {details}")


def _best_layout_candidate(module_id: str, module: dict[str, Any], view: str, source_connectivity_hash: str) -> dict[str, Any]:
    cache_key = _sha256_bytes(_canonical_json({"module_id": module_id, "module": module, "view": view, "connectivity_hash": source_connectivity_hash}))
    cached = _LAYOUT_CACHE.get(cache_key)
    if cached is not None:
        return json.loads(json.dumps(cached))
    winners: list[dict[str, Any]] = []
    failures: list[str] = []
    candidates = _layout_candidates(module, view)
    if candidates and candidates[0] and _module_prefers_label_routing(module, candidates[0]):
        winner = _first_label_layout_candidate(module_id, module, candidates, source_connectivity_hash)
        _LAYOUT_CACHE[cache_key] = json.loads(json.dumps(winner))
        return winner
    for components in candidates:
        try:
            candidate = _evaluate_layout_candidate(module_id, module, components, source_connectivity_hash)
            winners.append(candidate)
            metrics = candidate["quality"]["metrics"]
            if (
                candidate["quality"]["readability_score"] >= 90
                and metrics["missing_connections"] == 0
                and metrics["component_overlaps"] == 0
                and metrics["wire_through_components"] == 0
                and metrics["port_overlaps"] == 0
                and metrics["wire_crossings"] == 0
                and metrics["label_overlaps"] == 0
                and metrics["congestion"] == 0
                and metrics["flow_feedback_issues"] == 0
                and metrics["symmetry_issues"] == 0
            ):
                break
        except ValueError as error:
            failures.append(str(error))
    if not winners:
        if candidates and candidates[0]:
            # Physical routing is best-effort.  A module whose placement the
            # autorouter cannot preserve still exports deterministically
            # through net-label stubs instead of failing the whole export.
            winner = _first_label_layout_candidate(module_id, module, candidates, source_connectivity_hash)
            _LAYOUT_CACHE[cache_key] = json.loads(json.dumps(winner))
            return winner
        details = "; ".join(sorted(set(failures)))
        raise ValueError(f"no deterministic layout candidate preserved routed connectivity: {details}")
    winner = min(winners, key=lambda candidate: candidate["quality"]["lexicographic_cost"])
    _LAYOUT_CACHE[cache_key] = json.loads(json.dumps(winner))
    return winner


def build_eda_ir(project: dict[str, Any], modules: dict[str, dict[str, Any]], *, scope: str, module_id: str | None, view: str, document_hash: str) -> tuple[dict[str, Any], dict[str, Any]]:
    selected = {key: value for key, value in modules.items() if scope == "project" or key == module_id}
    if scope == "module" and not selected:
        raise ValueError(f"module not found: {module_id}")
    source_connectivity_hash = connectivity_hash(project, selected, module_id if scope == "module" else None, view)
    pages: list[dict[str, Any]] = []
    reports: list[dict[str, Any]] = []
    for selected_module_id, module in sorted(selected.items()):
        projected_module = _project_module_view(module, view)
        winner = _best_layout_candidate(selected_module_id, projected_module, view, source_connectivity_hash)
        components = winner["components"]
        nets = winner["nets"]
        # EDA writers consume explicit schematic junctions, not the router's
        # compact Steiner geometry.  Materialize T contacts before the shared
        # IR is projected to any target format.
        wires = _materialize_routed_wires(nets, winner["wires"])
        ports = {str(port.get("id", "")): port.get("position") for port in winner["ports"]}
        report = winner["quality"]
        reports.append(report)
        pages.append({
            "id": selected_module_id, "name": module.get("name", selected_module_id),
            "revision": module.get("revision", 0), "components": components,
            "ports": [{**port, "position": ports.get(str(port.get("id", "")))} for port in projected_module.get("ports", [])],
            "nets": nets, "wires": wires, "annotations": module.get("annotations", []),
            "spice": module.get("spice", {}),
        })
    assign_refdes(pages)
    ir = {
        "schema": EDA_IR_SCHEMA,
        "source": {"project_id": project["project_id"], "revision": project["revision"], "document_hash": document_hash, "scope": scope, "module_id": module_id, "view": view},
        "coordinate_system": {"unit": "actoviq", "grid": GRID, "mm_per_unit": MM_PER_UNIT},
        "project": {
            "id": project["project_id"],
            "name": project.get("name", project["project_id"]),
            "project_kind": project.get("project_kind", "simulation"),
            "analog_ic_profile": project.get("analog_ic_profile"),
            "connections": project.get("connections", []),
        },
        "pages": pages,
        "connectivity": {"records": _connectivity_records(project, selected, module_id if scope == "module" else None, view), "hash": source_connectivity_hash},
    }
    aggregate = {
        "schema": QUALITY_SCHEMA, "scope": scope, "module_id": module_id,
        "connectivity_hash": source_connectivity_hash, "modules": reports,
        "lexicographic_cost": [sum(report["lexicographic_cost"][index] for report in reports) for index in range(8)],
        # Project quality is limited by its least-readable sheet.  Averaging
        # would let a 100-point page hide a sub-90 page under --strict-layout.
        "readability_score": round(min((report["readability_score"] for report in reports), default=100.0), 3),
        "issues": [issue for report in reports for issue in report["issues"]],
    }
    return ir, aggregate


def _same_net_junction_keys(wires: list[dict[str, Any]]) -> set[tuple[str, float, float]]:
    """Return explicit KiCad/Qucs-style same-net junction locations.

    Only wire endpoints participate in an interior-on-segment connection.  A
    strict interior/interior crossing therefore remains non-connecting, while
    a T branch has three distinct incident neighbours and receives a dot.
    """

    endpoints_by_net: dict[str, dict[tuple[float, float], dict[str, float]]] = {}
    for wire in wires:
        points = wire.get("points") or []
        if len(points) < 2:
            continue
        net_id = str(wire.get("net_id", ""))
        for point in (points[0], points[-1]):
            key = _point_key(point)
            endpoints_by_net.setdefault(net_id, {})[key] = {"x": key[0], "y": key[1]}

    neighbours: dict[tuple[str, float, float], set[tuple[float, float]]] = {}
    for start, end, wire in _segments(wires):
        net_id = str(wire.get("net_id", ""))
        candidates = {
            _point_key(start): start,
            _point_key(end): end,
            **{
                key: point
                for key, point in endpoints_by_net.get(net_id, {}).items()
                if _point_on_segment(point, start, end)
            },
        }
        sx, sy = _point_key(start)
        ordered = sorted(candidates, key=lambda key: abs(key[0] - sx) + abs(key[1] - sy))
        for left, right in zip(ordered, ordered[1:]):
            if left == right:
                continue
            neighbours.setdefault((net_id, *left), set()).add(right)
            neighbours.setdefault((net_id, *right), set()).add(left)
    return {key for key, connected in neighbours.items() if len(connected) >= 3}


def _expand_wire_junction_points(wires: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Insert same-net wire endpoints into every segment they terminate on."""

    endpoints_by_net: dict[str, dict[tuple[float, float], dict[str, float]]] = {}
    for wire in wires:
        points = wire.get("points") or []
        if len(points) < 2:
            continue
        net_id = str(wire.get("net_id", ""))
        for point in (points[0], points[-1]):
            key = _point_key(point)
            endpoints_by_net.setdefault(net_id, {})[key] = {"x": key[0], "y": key[1]}

    result: list[dict[str, Any]] = []
    for wire in wires:
        clone = json.loads(json.dumps(wire))
        points = clone.get("points") or []
        if len(points) < 2:
            result.append(clone)
            continue
        net_id = str(clone.get("net_id", ""))
        expanded: list[dict[str, float]] = []
        for start, end in zip(points, points[1:]):
            sx, sy = _point_key(start)
            candidates = {
                _point_key(start): {"x": sx, "y": sy},
                _point_key(end): {"x": _point_key(end)[0], "y": _point_key(end)[1]},
                **{
                    key: point
                    for key, point in endpoints_by_net.get(net_id, {}).items()
                    if _point_on_segment(point, start, end)
                },
            }
            ordered = sorted(candidates.values(), key=lambda point: abs(_point_key(point)[0] - sx) + abs(_point_key(point)[1] - sy))
            if expanded and ordered and _point_key(expanded[-1]) == _point_key(ordered[0]):
                ordered = ordered[1:]
            expanded.extend(ordered)
        clone["points"] = expanded
        result.append(clone)
    return result


def _materialize_routed_wires(nets: list[dict[str, Any]], wires: list[dict[str, Any]]) -> list[dict[str, Any]]:
    semantic_at: dict[tuple[str, float, float], list[dict[str, Any]]] = {}
    for net in nets:
        net_id = str(net.get("id", ""))
        for endpoint in net.get("endpoints", []):
            semantic_at.setdefault((net_id, *_point_key(endpoint)), []).append(endpoint)
    expanded_wires = _expand_wire_junction_points(wires)
    junction_keys = _same_net_junction_keys(expanded_wires)
    result: list[dict[str, Any]] = []
    used_wire_ids: set[str] = set()
    for wire_index, wire in enumerate(expanded_wires):
        points = json.loads(json.dumps(wire.get("points") or []))
        if len(points) < 2:
            continue
        net_id = str(wire.get("net_id", ""))

        def persistent_endpoint(name: str, point: dict[str, Any]) -> dict[str, Any]:
            reference = json.loads(json.dumps(wire.get(name) or {}))
            reference = {key: value for key, value in reference.items() if key not in {"kind", "_egress"}}
            reference["x"], reference["y"] = _point_key(point)
            identities = int(bool(reference.get("component_id") or reference.get("pin_id"))) + int(bool(reference.get("port_id"))) + int(bool(reference.get("junction_id")))
            if identities == 1:
                return reference
            matches = semantic_at.get((net_id, *_point_key(point)), [])
            if len(matches) == 1:
                return {**_endpoint_ref(matches[0]), "x": _point_key(point)[0], "y": _point_key(point)[1]}
            token = _sha256_bytes(f"{net_id}:{_point_key(point)[0]:.6f}:{_point_key(point)[1]:.6f}".encode("utf-8"))[:16]
            return {"x": _point_key(point)[0], "y": _point_key(point)[1], "junction_id": f"junction-{token}"}

        split_indexes = [0]
        split_indexes.extend(
            index
            for index, point in enumerate(points[1:-1], 1)
            if (net_id, *_point_key(point)) in junction_keys
        )
        split_indexes.append(len(points) - 1)
        base_wire_id = str(wire.get("id") or f"wire-{wire_index}")
        for part_index, (start_index, end_index) in enumerate(zip(split_indexes, split_indexes[1:])):
            part_points = points[start_index:end_index + 1]
            if len(part_points) < 2:
                continue
            requested_id = base_wire_id if part_index == 0 else f"{base_wire_id}-part-{part_index}"
            wire_id = requested_id
            suffix = 2
            while wire_id in used_wire_ids:
                wire_id = f"{requested_id}-{suffix}"
                suffix += 1
            used_wire_ids.add(wire_id)

            def part_endpoint(name: str, point: dict[str, Any], *, outer: bool) -> dict[str, Any]:
                if outer:
                    return persistent_endpoint(name, point)
                x, y = _point_key(point)
                token = _sha256_bytes(f"{net_id}:{x:.6f}:{y:.6f}".encode("utf-8"))[:16]
                return {"x": x, "y": y, "junction_id": f"junction-{token}"}

            result.append({
                "id": wire_id,
                "net_id": net_id,
                "net": str(wire.get("net", "")),
                "from": part_endpoint("from", part_points[0], outer=start_index == 0),
                "to": part_endpoint("to", part_points[-1], outer=end_index == len(points) - 1),
                "points": part_points,
                "source": "stored",
            })
    return result


def _module_schematic_for_candidate(
    source_module: dict[str, Any],
    candidate: dict[str, Any],
    visible_connectivity_hash: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    module = json.loads(json.dumps(source_module))
    candidate_components = {str(component.get("id", "")): component for component in candidate["components"]}
    for component in module.get("components", []):
        candidate_component = candidate_components.get(str(component.get("id", "")))
        if candidate_component is None:
            continue
        component["position"] = json.loads(json.dumps(candidate_component.get("position") or component.get("position") or {"x": 0, "y": 0}))
        component["rotation"] = int(candidate_component.get("rotation", component.get("rotation", 0)))
        for field in ("layout_rank", "layout_lane"):
            if field in candidate_component:
                component[field] = candidate_component[field]
        if str(component.get("type", "")).upper() == "BLOCK":
            candidate_pins = {str(pin.get("id", "")): pin for pin in candidate_component.get("pins", [])}
            for pin in component.get("pins", []):
                candidate_pin = candidate_pins.get(str(pin.get("id", "")))
                if candidate_pin and candidate_pin.get("side") in PIN_SIDES:
                    pin["side"] = candidate_pin["side"]
    candidate_ports = {str(port.get("id", "")): port for port in candidate["ports"]}
    for port in module.get("ports", []):
        candidate_port = candidate_ports.get(str(port.get("id", "")))
        if candidate_port and isinstance(candidate_port.get("position"), dict):
            port["position"] = json.loads(json.dumps(candidate_port["position"]))

    routed_components = [prepare_component(component) for component in module.get("components", [])]
    routed = None
    try:
        routed = _evaluate_layout_candidate(
            str(module.get("module_id", "module")),
            module,
            routed_components,
            visible_connectivity_hash,
            # A design-view winner is scored without ideal bench sources.  When
            # those sources are restored for persistence, their pins can make
            # the compact trunk router fail even though the reviewed component
            # placement is still usable.  Let the deterministic whole-net grid
            # router recover the complete source module before considering any
            # placement changes.  Its result still passes the same strict
            # routed-connectivity partition and foreign-net geometry checks.
            allow_global_fallback=True,
        )
    except ValueError:
        pass

    def visible_target_met(value: dict[str, Any]) -> bool:
        quality = value["quality"]
        metrics = quality["metrics"]
        return (
            quality["readability_score"] >= 90
            and metrics["missing_connections"] == 0
            and metrics["component_overlaps"] == 0
            and metrics["wire_through_components"] == 0
            and metrics["port_overlaps"] == 0
            and metrics["wire_crossings"] == 0
            and metrics["label_overlaps"] == 0
            and metrics["congestion"] == 0
            and metrics["flow_feedback_issues"] == 0
            and metrics["symmetry_issues"] == 0
        )

    if routed is None or not visible_target_met(routed):
        # A design-view winner may leave excluded bench sources in a routing
        # corridor or create crossings/label collisions when they are restored.
        # Preserve every reviewed component exactly and vary only excluded
        # objects across the finite deterministic rank/lane candidates.
        reviewed_ids = set(candidate_components)
        reviewed_components = {
            str(component.get("id", "")): component
            for component in routed_components
            if str(component.get("id", "")) in reviewed_ids
        }
        best = routed
        seen: set[bytes] = set()
        reviewed_bounds = [_component_bounds(component) for component in reviewed_components.values()]
        min_x = min((bounds["min_x"] for bounds in reviewed_bounds), default=0.0)
        max_y = max((bounds["max_y"] for bounds in reviewed_bounds), default=0.0)
        reviewed_net_points: dict[str, list[dict[str, float]]] = {}
        for component in reviewed_components.values():
            for pin_index, pin in enumerate(component.get("pins", [])):
                reviewed_net_points.setdefault(str(pin.get("net", "")), []).append(
                    _pin_position(component, pin, pin_index)
                )

        local_source_candidates: list[list[dict[str, Any]]] = []
        if routed is not None:
            actionable_issues = [
                issue
                for issue in routed["quality"].get("issues", [])
                if issue.get("category") in {
                    "component_overlap",
                    "wire_through_component",
                    "wire_crossing",
                    "label_overlap",
                    "corridor_congestion",
                }
            ]
            issue_component_ids = {
                str(component_id)
                for issue in actionable_issues
                for component_id in issue.get("component_ids", [])
            }
            issue_net_ids = {
                str(net_id)
                for issue in actionable_issues
                for net_id in issue.get("net_ids", [])
            }
            excluded = [
                component
                for component in routed_components
                if str(component.get("id", "")) not in reviewed_ids
            ]
            net_ids_by_name = {
                str(net.get("name", "")): str(net.get("id", ""))
                for net in module.get("nets", [])
            }
            direct_ids = {
                str(component.get("id", ""))
                for component in excluded
                if str(component.get("id", "")) in issue_component_ids
            }
            for component_type in ("V", "I"):
                ranked = sorted(
                    (
                        (
                            sum(
                                str(
                                    pin.get("net_id")
                                    or net_ids_by_name.get(str(pin.get("net", "")), "")
                                ) in issue_net_ids
                                for pin in component.get("pins", [])
                            ),
                            str(component.get("id", "")),
                        )
                        for component in excluded
                        if str(component.get("type", "")).upper() == component_type
                    ),
                    reverse=True,
                )
                if ranked and ranked[0][0] > 0:
                    direct_ids.add(ranked[0][1])
            offset_variants = (
                {"V": (0, -5), "I": (0, 8)},
                {"V": (-4, -5), "I": (0, 8)},
                {"V": (4, -5), "I": (0, 8)},
                {"V": (0, -5), "I": (0, 10)},
                {"V": (-4, -5), "I": (0, 10)},
                {"V": (4, -5), "I": (0, 10)},
                {"V": (0, -5), "I": (10, 0)},
                {"V": (-4, -5), "I": (10, 0)},
                {"V": (4, -5), "I": (10, 0)},
                {"V": (0, -5), "I": (-8, 8)},
            )
            for offsets in offset_variants:
                candidate = json.loads(json.dumps(routed_components))
                for component in candidate:
                    if str(component.get("id", "")) not in direct_ids:
                        continue
                    dx_grid, dy_grid = offsets.get(str(component.get("type", "")).upper(), (0, 0))
                    position = component.get("position") or {"x": 0, "y": 0}
                    component["position"] = {
                        "x": _snap(float(position.get("x", 0)) + dx_grid * GRID),
                        "y": _snap(float(position.get("y", 0)) + dy_grid * GRID),
                    }
                local_source_candidates.append(candidate)

        source_lane_candidates: list[list[dict[str, Any]]] = []
        for gap_grid in (6, 8, 10):
            candidate = json.loads(json.dumps(routed_components))
            voltage_index = 0
            current_index = 0
            other_index = 0
            for component in candidate:
                if str(component.get("id", "")) in reviewed_ids:
                    continue
                component_type = str(component.get("type", "")).upper()
                pins = component.get("pins", [])
                signal_pin_index = next(
                    (
                        index
                        for index, pin in enumerate(pins)
                        if str(pin.get("net", "")).lower() not in {"0", "gnd", "ground", "vss"}
                    ),
                    0,
                )
                signal_pin = pins[signal_pin_index] if pins else {"net": ""}
                targets = reviewed_net_points.get(str(signal_pin.get("net", "")), [])
                position = component.get("position") or {"x": 0, "y": 0}
                pin_point = (
                    _pin_position(component, signal_pin, signal_pin_index)
                    if pins else {"x": float(position.get("x", 0)), "y": float(position.get("y", 0))}
                )
                offset_x = float(pin_point["x"]) - float(position.get("x", 0))
                offset_y = float(pin_point["y"]) - float(position.get("y", 0))
                target_x = (
                    sum(float(point["x"]) for point in targets) / len(targets)
                    if targets else float(position.get("x", 0))
                )
                target_y = (
                    sum(float(point["y"]) for point in targets) / len(targets)
                    if targets else float(position.get("y", 0))
                )
                if component_type == "V":
                    component["position"] = {
                        "x": _snap(min_x - (voltage_index + 1) * gap_grid * GRID - offset_x),
                        "y": _snap(target_y - offset_y),
                    }
                    voltage_index += 1
                elif component_type == "I":
                    component["position"] = {
                        "x": _snap(target_x - offset_x),
                        "y": _snap(max_y + (current_index + 1) * gap_grid * GRID),
                    }
                    current_index += 1
                else:
                    component["position"] = {
                        "x": _snap(target_x - offset_x),
                        "y": _snap(max_y + (other_index + 1) * gap_grid * GRID),
                    }
                    other_index += 1
            source_lane_candidates.append(candidate)

        candidate_pool = (
            local_source_candidates
            if routed is not None
            else [*source_lane_candidates, *reversed(_layout_candidates(module, "simulation"))]
        )
        for full_candidate in candidate_pool:
            merged = [
                json.loads(json.dumps(reviewed_components.get(str(component.get("id", "")), component)))
                for component in full_candidate
            ]
            projection = _canonical_json(_module_layout_projection({"components": merged, "ports": []}))
            if projection in seen:
                continue
            seen.add(projection)
            try:
                evaluated = _evaluate_layout_candidate(
                    str(module.get("module_id", "module")),
                    module,
                    merged,
                    visible_connectivity_hash,
                    allow_global_fallback=True,
                )
            except ValueError:
                continue
            if best is None or evaluated["quality"]["lexicographic_cost"] < best["quality"]["lexicographic_cost"]:
                best = evaluated
            if visible_target_met(evaluated):
                best = evaluated
                break
        routed = best
    if routed is None:
        raise ValueError("could not route the complete source module while preserving the reviewed layout")
    routed_components = routed["components"]
    nets, wires = routed["nets"], routed["wires"]
    routed_by_id = {str(component.get("id", "")): component for component in routed_components}
    for component in module.get("components", []):
        routed_component = routed_by_id[str(component.get("id", ""))]
        component["position"] = json.loads(json.dumps(routed_component["position"]))
        component["rotation"] = int(routed_component.get("rotation", component.get("rotation", 0)))
    routed_ports = {str(port.get("id", "")): port for port in routed["ports"]}
    for port in module.get("ports", []):
        routed_port = routed_ports.get(str(port.get("id", "")))
        if routed_port and routed_port.get("position") is not None:
            port["position"] = json.loads(json.dumps(routed_port["position"]))
    _require_routed_connectivity(nets, wires)
    return {
        "components": module.get("components", []),
        "ports": module.get("ports", []),
        "wires": _materialize_routed_wires(nets, wires),
        "nets": module.get("nets", []),
        "annotations": module.get("annotations", []),
    }, routed["quality"]


def _module_layout_projection(module: dict[str, Any]) -> dict[str, Any]:
    return {
        "components": [{
            "id": component.get("id"),
            "position": component.get("position"),
            "rotation": component.get("rotation", 0),
            "layout_rank": component.get("layout_rank"),
            "layout_lane": component.get("layout_lane"),
            "pin_sides": {str(pin.get("id", "")): pin.get("side") for pin in component.get("pins", []) if pin.get("side") is not None},
        } for component in module.get("components", [])],
        "ports": [{"id": port.get("id"), "position": port.get("position")} for port in module.get("ports", [])],
        "wires": module.get("wires", []),
    }


def _layout_changed(source_module: dict[str, Any], module_schematic: dict[str, Any]) -> bool:
    return _canonical_json(_module_layout_projection(source_module)) != _canonical_json(_module_layout_projection(module_schematic))


def _seal_layout_state(value: dict[str, Any]) -> dict[str, Any]:
    state = json.loads(json.dumps(value))
    state.pop("state_hash", None)
    state["state_hash"] = _sha256_bytes(_canonical_json(state))
    return state


def _validate_layout_state(value: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("schema") != LAYOUT_REVIEW_STATE_SCHEMA:
        raise ValueError(f"layout state schema must be {LAYOUT_REVIEW_STATE_SCHEMA}")
    state_hash = value.get("state_hash")
    if not isinstance(state_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", state_hash):
        raise ValueError("layout state has no valid state_hash")
    unsealed = json.loads(json.dumps(value))
    unsealed.pop("state_hash", None)
    if _sha256_bytes(_canonical_json(unsealed)) != state_hash:
        raise ValueError("layout state hash mismatch")
    if not isinstance(value.get("candidate"), dict) or not isinstance(value.get("round"), int):
        raise ValueError("layout state is incomplete")
    return value


def _preview_ir(module_id: str, module_name: str, candidate: dict[str, Any]) -> dict[str, Any]:
    return {"pages": [{
        "id": module_id,
        "name": module_name,
        "components": candidate["components"],
        "ports": candidate["ports"],
        "nets": candidate["nets"],
        "wires": candidate["wires"],
    }]}


def _write_layout_stage(output_dir: Path, state: dict[str, Any], module_schematic: dict[str, Any], *, before_quality: dict[str, Any] | None = None, improved: bool, changed: bool, candidate_results: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    round_index = int(state["round"])
    suffix = "" if round_index == 0 else f"-round-{round_index}"
    state_path = output_dir / f"layout-state{suffix}.json"
    quality_path = output_dir / f"layout-quality{suffix}.json"
    svg_path = output_dir / f"preview{suffix}.svg"
    _write_json(state_path, state)
    _write_json(quality_path, state["candidate"]["quality"])
    _write_text(svg_path, _svg_preview(_preview_ir(state["module_id"], state["module_name"], state["candidate"])))
    quality = state["candidate"]["quality"]
    packet = {
        "ok": True,
        "module_id": state["module_id"],
        "source_revision": state["source_revision"],
        "connectivity_hash": state["connectivity_hash"],
        "round": round_index,
        "state_path": str(state_path),
        "svg_path": str(svg_path),
        "layout_quality_report_path": str(quality_path),
        "score": quality["readability_score"],
        "readability_score": quality["readability_score"],
        "lexicographic_cost": quality["lexicographic_cost"],
        "layout_quality": quality,
        "improved": improved,
        "changed": changed,
        "module_schematic": module_schematic,
    }
    if isinstance(state.get("visible_layout_quality"), dict):
        packet["visible_layout_quality"] = state["visible_layout_quality"]
    if isinstance(state.get("visible_connectivity_hash"), str):
        packet["visible_connectivity_hash"] = state["visible_connectivity_hash"]
    if before_quality is not None:
        packet.update({
            "before_score": before_quality["readability_score"],
            "before_readability_score": before_quality["readability_score"],
            "before_lexicographic_cost": before_quality["lexicographic_cost"],
        })
    if candidate_results is not None:
        packet["candidate_results"] = candidate_results
    return packet


def prepare_layout_review(
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]],
    *,
    module_id: str,
    view: str,
    document_hash: str,
    source_revision: int,
    output_dir: Path,
) -> dict[str, Any]:
    if source_revision != int(project.get("revision", -1)):
        raise ValueError(f"stale source revision: current {project.get('revision')}, requested {source_revision}")
    source_module = modules.get(module_id)
    if source_module is None:
        raise ValueError(f"module not found: {module_id}")
    source_connectivity_hash = connectivity_hash(project, {module_id: source_module}, module_id, view)
    projected_module = _project_module_view(source_module, view)
    winner = _best_layout_candidate(module_id, projected_module, view, source_connectivity_hash)
    try:
        current = _evaluate_layout_candidate(
            module_id,
            projected_module,
            [prepare_component(component) for component in projected_module.get("components", []) if _included_component(component, view)],
            source_connectivity_hash,
        )
        if source_module.get("wires"):
            try:
                stored_wires = json.loads(json.dumps(source_module["wires"]))
                net_names = {str(net.get("id", "")): str(net.get("name", "")) for net in current["nets"]}
                for wire in stored_wires:
                    if str(wire.get("net_id", "")) in net_names:
                        wire["net"] = net_names[str(wire["net_id"])]
                stored_ports = {str(port.get("id", "")): port.get("position") for port in current["ports"]}
                stored_quality = score_layout(
                    module_id,
                    current["components"],
                    current["nets"],
                    stored_wires,
                    stored_ports,
                    source_connectivity_hash,
                    projected_module.get("ports", []),
                )
                current = {**current, "wires": stored_wires, "quality": stored_quality}
            except ValueError:
                # Stored geometry from an excluded view or an older renderer is
                # not a trustworthy baseline; compare against the deterministic
                # route at the current positions instead.
                pass
        before_quality = current["quality"]
        improved = winner["quality"]["lexicographic_cost"] < before_quality["lexicographic_cost"]
    except ValueError:
        before_quality = None
        improved = True
    visible_connectivity_hash = connectivity_hash(project, {module_id: source_module}, module_id, "simulation")
    module_schematic, visible_layout_quality = _module_schematic_for_candidate(
        source_module,
        winner,
        visible_connectivity_hash,
    )
    projected_source_module = {**json.loads(json.dumps(source_module)), **json.loads(json.dumps(module_schematic))}
    if connectivity_hash(project, {module_id: projected_source_module}, module_id, view) != source_connectivity_hash:
        raise ValueError("deterministic layout candidate changed source connectivity")
    changed = improved and _layout_changed(source_module, module_schematic)
    state = _seal_layout_state({
        "schema": LAYOUT_REVIEW_STATE_SCHEMA,
        "module_id": module_id,
        "module_name": str(source_module.get("name", module_id)),
        "source_revision": source_revision,
        "source_module_revision": int(source_module.get("revision", 0)),
        "source_document_hash": document_hash,
        "connectivity_hash": source_connectivity_hash,
        "visible_connectivity_hash": visible_connectivity_hash,
        "view": view,
        "round": 0,
        "has_strict_improvement": improved,
        "candidate": winner,
        "visible_layout_quality": visible_layout_quality,
    })
    return _write_layout_stage(output_dir, state, module_schematic, before_quality=before_quality, improved=improved, changed=changed)


def _apply_layout_operations(candidate: dict[str, Any], operations: list[dict[str, Any]]) -> dict[str, Any]:
    result = json.loads(json.dumps(candidate))
    components = {str(component.get("id", "")): component for component in result["components"]}
    ports = {str(port.get("id", "")): port for port in result["ports"]}
    positions = [component.get("position") or {"x": 0, "y": 0} for component in components.values()]
    origin_x = _snap(min((float(position.get("x", 0)) for position in positions), default=0.0))
    ordered_y = sorted(float(position.get("y", 0)) for position in positions)
    origin_y = _snap(ordered_y[len(ordered_y) // 2] if ordered_y else 0.0)
    for operation in operations:
        kind = operation["op"]
        if kind == "move_component":
            component = components[operation["component_id"]]
            position = component.setdefault("position", {"x": 0, "y": 0})
            position["x"] = _snap(float(position.get("x", 0)) + operation["dx_grid"] * GRID)
            position["y"] = _snap(float(position.get("y", 0)) + operation["dy_grid"] * GRID)
        elif kind == "rotate_component":
            components[operation["component_id"]]["rotation"] = operation["rotation"]
        elif kind == "move_port":
            port = ports[operation["port_id"]]
            position = port.setdefault("position", {"x": 0, "y": 0})
            position["x"] = _snap(float(position.get("x", 0)) + operation["dx_grid"] * GRID)
            position["y"] = _snap(float(position.get("y", 0)) + operation["dy_grid"] * GRID)
        elif kind == "set_block_pin_side":
            component = components[operation["component_id"]]
            pin = next(pin for pin in component.get("pins", []) if str(pin.get("id", "")) == operation["pin_id"])
            pin["side"] = operation["side"]
        elif kind == "set_layout_lane":
            component = components[operation["component_id"]]
            component["layout_rank"] = operation["rank"]
            component["layout_lane"] = operation["lane"]
            component["position"] = {
                "x": origin_x + operation["rank"] * 8 * GRID,
                "y": origin_y + operation["lane"] * 6 * GRID,
            }
    return result


def evaluate_layout_patches(
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]],
    state: dict[str, Any],
    patch_set: dict[str, Any],
    *,
    module_id: str,
    document_hash: str,
    source_revision: int,
    output_dir: Path,
    view: str | None = None,
) -> dict[str, Any]:
    state = _validate_layout_state(state)
    if source_revision != int(project.get("revision", -1)) or source_revision != int(state.get("source_revision", -1)):
        raise ValueError("stale source revision for layout patch evaluation")
    if module_id != state.get("module_id") or module_id not in modules:
        raise ValueError("layout state module does not match the requested module")
    if document_hash != state.get("source_document_hash"):
        raise ValueError("source document changed after layout review preparation")
    if view is not None and view != state.get("view"):
        raise ValueError("layout review view does not match the prepared state")
    if int(state.get("round", -1)) >= 3:
        raise ValueError("layout review is limited to 3 evaluation rounds")
    source_module = modules[module_id]
    expected_hash = connectivity_hash(project, {module_id: source_module}, module_id, str(state["view"]))
    if expected_hash != state.get("connectivity_hash"):
        raise ValueError("source connectivity changed after layout review preparation")
    visible_connectivity_hash = connectivity_hash(project, {module_id: source_module}, module_id, "simulation")
    if visible_connectivity_hash != state.get("visible_connectivity_hash"):
        raise ValueError("visible source connectivity changed after layout review preparation")
    baseline = state["candidate"]
    component_ids = {str(component.get("id", "")) for component in baseline["components"]}
    baseline_port_ids = {str(port.get("id", "")) for port in baseline["ports"]}
    source_port_ids = {
        str(port.get("id", ""))
        for port in source_module.get("ports", [])
        if str(port.get("id", "")) in baseline_port_ids
    }
    normalized_candidates = validate_layout_patch_set(
        patch_set,
        expected_revision=source_revision,
        expected_connectivity_hash=expected_hash,
        component_ids=component_ids,
        port_ids=source_port_ids,
        component_defs=baseline["components"],
    )
    winner = baseline
    winner_index: int | None = None
    candidate_results: list[dict[str, Any]] = []
    for index, operations in enumerate(normalized_candidates):
        try:
            patched = _apply_layout_operations(baseline, operations)
            projected_module = _project_module_view(source_module, str(state["view"]))
            projected_module["ports"] = json.loads(json.dumps(patched["ports"]))
            evaluated = _evaluate_layout_candidate(module_id, projected_module, patched["components"], expected_hash)
            strictly_better = evaluated["quality"]["lexicographic_cost"] < winner["quality"]["lexicographic_cost"]
            candidate_results.append({
                "index": index,
                "accepted": True,
                "improved": strictly_better,
                "lexicographic_cost": evaluated["quality"]["lexicographic_cost"],
                "readability_score": evaluated["quality"]["readability_score"],
            })
            if strictly_better:
                winner = evaluated
                winner_index = index
        except (KeyError, StopIteration, ValueError) as error:
            candidate_results.append({"index": index, "accepted": False, "improved": False, "error": str(error)})
    improved = winner_index is not None
    module_schematic, visible_layout_quality = _module_schematic_for_candidate(
        source_module,
        winner,
        visible_connectivity_hash,
    )
    projected_source_module = {**json.loads(json.dumps(source_module)), **json.loads(json.dumps(module_schematic))}
    if connectivity_hash(project, {module_id: projected_source_module}, module_id, str(state["view"])) != expected_hash:
        raise ValueError("layout patch candidate changed source connectivity")
    has_strict_improvement = bool(state.get("has_strict_improvement")) or improved
    changed = has_strict_improvement and _layout_changed(source_module, module_schematic)
    next_state = _seal_layout_state({
        **{key: value for key, value in state.items() if key != "state_hash"},
        "round": int(state["round"]) + 1,
        "has_strict_improvement": has_strict_improvement,
        "candidate": winner,
        "visible_layout_quality": visible_layout_quality,
    })
    packet = _write_layout_stage(
        output_dir,
        next_state,
        module_schematic,
        before_quality=baseline["quality"],
        improved=improved,
        changed=changed,
        candidate_results=candidate_results,
    )
    packet["winner_candidate_index"] = winner_index
    return packet


def _load_symbol_map(path: str, pages: list[dict[str, Any]]) -> dict[str, Any]:
    return resolve_symbol_map(path, pages, TARGETS, SYMBOL_MAP_SCHEMA)


def _svg_preview(ir: dict[str, Any]) -> str:
    page = ir["pages"][0] if ir["pages"] else {"components": [], "wires": [], "ports": []}
    pin_points = [
        _pin_position(component, pin, index)
        for component in page["components"]
        for index, pin in enumerate(component.get("pins", []))
    ]
    port_points = [port["position"] for port in page["ports"] if isinstance(port.get("position"), dict)]
    points = [component.get("position", {}) for component in page["components"]] + pin_points + port_points + [point for wire in page["wires"] for point in wire.get("points", [])]
    min_x = min((float(point.get("x", 0)) for point in points), default=0) - 100
    min_y = min((float(point.get("y", 0)) for point in points), default=0) - 100
    max_x = max((float(point.get("x", 0)) for point in points), default=800) + 100
    max_y = max((float(point.get("y", 0)) for point in points), default=600) + 100
    lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{min_x} {min_y} {max_x-min_x} {max_y-min_y}">',
        '<rect x="-10000" y="-10000" width="20000" height="20000" fill="white"/>',
        '<g font-family="Segoe UI,Arial,sans-serif">',
        f'<text x="{min_x + 20}" y="{min_y + 32}" font-size="24" font-weight="700" fill="#172b4d">{html_lib.escape(str(page.get("name", page.get("id", "Schematic"))))}</text>',
    ]
    for wire in page["wires"]:
        points_text = " ".join(f'{point["x"]},{point["y"]}' for point in wire["points"])
        lines.append(f'<polyline points="{points_text}" fill="none" stroke="#188038" stroke-width="3" stroke-linejoin="round" data-net="{html_lib.escape(str(wire["net_id"]))}"/>')
    for net_id, x, y in sorted(_same_net_junction_keys(page["wires"])):
        lines.append(f'<circle cx="{x}" cy="{y}" r="6" fill="#188038" data-junction-net="{html_lib.escape(net_id)}"/>')
    for component in page["components"]:
        bounds = _component_bounds(component)
        position = component["position"]
        width = bounds["max_x"] - bounds["min_x"]
        height = bounds["max_y"] - bounds["min_y"]
        device_class = str((component.get("eda") or {}).get("device_class", component.get("type", "generic"))).lower()
        lines.append(f'<g data-component="{html_lib.escape(str(component["id"]))}">')
        lines.append(f'<rect x="{bounds["min_x"]}" y="{bounds["min_y"]}" width="{width}" height="{height}" rx="4" fill="#ffffff" fill-opacity="0.92" stroke="#a00020" stroke-width="2"/>')
        if device_class in {"mosfet", "bjt", "voltage_source", "current_source"}:
            radius = max(16.0, min(width, height) * 0.32)
            lines.append(f'<circle cx="{position["x"]}" cy="{position["y"]}" r="{radius}" fill="none" stroke="#a00020" stroke-width="3"/>')
            if device_class == "mosfet":
                lines.append(f'<path d="M {position["x"]-radius*0.45} {position["y"]-radius*0.65} V {position["y"]+radius*0.65} M {position["x"]+radius*0.25} {position["y"]-radius*0.65} V {position["y"]+radius*0.65}" fill="none" stroke="#a00020" stroke-width="3"/>')
            elif device_class == "bjt":
                lines.append(f'<path d="M {position["x"]-radius*0.3} {position["y"]-radius*0.65} V {position["y"]+radius*0.65} M {position["x"]-radius*0.3} {position["y"]-radius*0.3} L {position["x"]+radius*0.55} {position["y"]-radius*0.75} M {position["x"]-radius*0.3} {position["y"]+radius*0.3} L {position["x"]+radius*0.55} {position["y"]+radius*0.75}" fill="none" stroke="#a00020" stroke-width="3"/>')
            elif device_class == "current_source":
                lines.append(f'<path d="M {position["x"]} {position["y"]+radius*0.55} V {position["y"]-radius*0.45} M {position["x"]} {position["y"]-radius*0.55} l -7 10 m 7 -10 l 7 10" fill="none" stroke="#a00020" stroke-width="3"/>')
            else:
                lines.append(f'<text x="{position["x"]}" y="{position["y"]+7}" text-anchor="middle" font-size="22" fill="#a00020">V</text>')
        elif device_class == "resistor":
            left, right = bounds["min_x"] + 8, bounds["max_x"] - 8
            step = (right - left) / 8
            zigzag = [(left + step * index, position["y"] + (-10 if index % 2 else 10)) for index in range(9)]
            lines.append('<polyline points="' + ' '.join(f'{x},{y}' for x, y in zigzag) + '" fill="none" stroke="#a00020" stroke-width="3"/>')
        elif device_class == "capacitor":
            lines.append(f'<path d="M {position["x"]-8} {bounds["min_y"]+8} V {bounds["max_y"]-8} M {position["x"]+8} {bounds["min_y"]+8} V {bounds["max_y"]-8}" fill="none" stroke="#a00020" stroke-width="3"/>')
        lines.append(f'<text x="{bounds["max_x"]+10}" y="{position["y"]-4}" font-size="18" font-weight="600" fill="#1a0dab">{html_lib.escape(str(component["name"]))}</text>')
        lines.append(f'<text x="{bounds["max_x"]+10}" y="{position["y"]+18}" font-size="15" fill="#1a0dab">{html_lib.escape(str(component.get("value", "")))}</text>')
        for index, pin in enumerate(component.get("pins", [])):
            pin_point = _pin_position(component, pin, index)
            side = _pin_side(component, pin, index)
            anchor = "end" if side == "left" else "start"
            label_x = pin_point["x"] - 8 if side == "left" else pin_point["x"] + 8
            label_y = pin_point["y"] - 7 if side in {"top", "bottom"} else pin_point["y"] - 5
            if side in {"top", "bottom"}:
                anchor = "middle"
            lines.append(f'<circle cx="{pin_point["x"]}" cy="{pin_point["y"]}" r="4" fill="#8b949e"/>')
            lines.append(f'<text x="{label_x}" y="{label_y}" text-anchor="{anchor}" font-size="12" fill="#374151">{html_lib.escape(str(pin.get("name", pin.get("id", ""))))}</text>')
        lines.append('</g>')
    for port in page["ports"]:
        position = port.get("position")
        if not isinstance(position, dict):
            continue
        x, y = float(position["x"]), float(position["y"])
        direction = str(port.get("direction", "bidirectional"))
        points_text = f'{x},{y} {x+18},{y-12} {x+38},{y-12} {x+50},{y} {x+38},{y+12} {x+18},{y+12}'
        if direction == "output":
            points_text = f'{x},{y-12} {x+32},{y-12} {x+50},{y} {x+32},{y+12} {x},{y+12}'
        lines.append(f'<polygon points="{points_text}" fill="white" stroke="#a00020" stroke-width="2" data-port="{html_lib.escape(str(port.get("id", "")))}"/>')
        lines.append(f'<text x="{x+58}" y="{y+6}" font-size="17" font-weight="600" fill="#1a0dab">{html_lib.escape(str(port.get("name", port.get("id", ""))))}</text>')
    port_net_ids = {str(port.get("net_id", "")) for port in page["ports"]}
    for net in page.get("nets", []):
        if str(net.get("id", "")) in port_net_ids or not net.get("endpoints"):
            continue
        point = net["endpoints"][0]
        lines.append(f'<text x="{float(point["x"])+8}" y="{float(point["y"])-8}" font-size="14" fill="#0b6b34">{html_lib.escape(str(net.get("name", "")))}</text>')
    lines.extend(["</g>", "</svg>\n"])
    return "\n".join(lines)


def _sexpr_string(value: Any) -> str:
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"') + '"'


def _stable_uuid(*parts: Any) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "actoviq:" + ":".join(map(str, parts))))


def _kicad_symbol_graphics(component: dict[str, Any], indent: str) -> list[str]:
    eda = component.get("eda") or {}
    device_class = str(eda.get("device_class", component.get("type", "generic"))).lower()
    subtype = str(eda.get("subtype", "")).lower()
    stroke = "(stroke (width 0) (type default))"
    no_fill = "(fill (type none))"

    def polyline(points: list[tuple[float, float]]) -> str:
        coordinates = " ".join(f"(xy {x:.4f} {y:.4f})" for x, y in points)
        return f"{indent}(polyline (pts {coordinates}) {stroke} {no_fill})"

    if device_class == "resistor":
        return [polyline([(-3.81, 0), (-3.175, -1.27), (-2.54, 1.27), (-1.27, -1.27), (0, 1.27), (1.27, -1.27), (2.54, 1.27), (3.175, -1.27), (3.81, 0)])]
    if device_class == "capacitor":
        return [polyline([(-3.81, 0), (-0.635, 0)]), polyline([(-0.635, -2.54), (-0.635, 2.54)]), polyline([(0.635, -2.54), (0.635, 2.54)]), polyline([(0.635, 0), (3.81, 0)])]
    if device_class == "inductor":
        return [polyline([(-3.81, 0), (-3.175, 0), (-2.54, -1.27), (-1.27, 1.27), (0, -1.27), (1.27, 1.27), (2.54, -1.27), (3.175, 0), (3.81, 0)])]
    if device_class == "diode":
        return [polyline([(-3.81, 0), (-1.27, 0)]), polyline([(-1.27, -2.54), (-1.27, 2.54), (1.27, 0), (-1.27, -2.54)]), polyline([(1.27, -2.54), (1.27, 2.54)]), polyline([(1.27, 0), (3.81, 0)])]
    if device_class == "mosfet":
        arrow = [(0.4, 0), (1.6, -0.7), (1.6, 0.7), (0.4, 0)] if subtype == "pmos" else [(1.6, 0), (0.4, -0.7), (0.4, 0.7), (1.6, 0)]
        return [
            f"{indent}(circle (center 0 0) (radius 3.1750) {stroke} {no_fill})",
            polyline([(-1.27, -2.54), (-1.27, 2.54)]), polyline([(0.635, -2.54), (0.635, 2.54)]),
            polyline([(-3.175, 0), (-1.27, 0)]), polyline([(0.635, -2.54), (0, -3.175)]),
            polyline([(0.635, 2.54), (0, 3.175)]), polyline([(0.635, 0), (3.175, 0)]), polyline(arrow),
        ]
    if device_class == "bjt":
        arrow = [(1.0, 1.2), (2.3, 2.5), (1.1, 2.2)] if subtype != "pnp" else [(2.3, 2.5), (1.0, 1.2), (1.3, 2.4)]
        return [
            f"{indent}(circle (center 0 0) (radius 3.1750) {stroke} {no_fill})",
            polyline([(-0.635, -2.54), (-0.635, 2.54)]), polyline([(-3.175, 0), (-0.635, 0)]),
            polyline([(-0.635, -1.27), (1.9, -3.175)]), polyline([(-0.635, 1.27), (1.9, 3.175)]), polyline(arrow),
        ]
    if device_class in {"voltage_source", "current_source"}:
        graphics = [f"{indent}(circle (center 0 0) (radius 2.5400) {stroke} {no_fill})"]
        if device_class == "voltage_source":
            graphics.extend([polyline([(-1.4, -0.8), (-0.4, -0.8)]), polyline([(-0.9, -1.3), (-0.9, -0.3)]), polyline([(0.4, 0.8), (1.4, 0.8)])])
        else:
            graphics.extend([polyline([(0, 1.5), (0, -1.5)]), polyline([(0, -1.5), (-0.7, -0.5)]), polyline([(0, -1.5), (0.7, -0.5)])])
        return graphics
    width, height = _component_size({**component, "rotation": 0})
    half_width = max(2.54, width * MM_PER_UNIT / 2 - 2.54)
    half_height = max(1.27, height * MM_PER_UNIT / 2 - 1.27)
    return [f"{indent}(rectangle (start {-half_width:.4f} {-half_height:.4f}) (end {half_width:.4f} {half_height:.4f}) {stroke} (fill (type background)))"]


def _kicad_pin_electrical_type(component: dict[str, Any], pin: dict[str, Any]) -> str:
    explicit = str(pin.get("electrical_type", "")).lower()
    allowed = {"input", "output", "bidirectional", "tri_state", "passive", "power_in", "power_out", "open_collector", "open_emitter", "no_connect"}
    if explicit in allowed:
        return explicit
    return "passive"


def _kicad_symbol_name(page_id: str, component: dict[str, Any]) -> str:
    return _safe_name(f"{page_id}_{component['id']}")


def _kicad_binding_identity(binding: dict[str, Any]) -> tuple[str, str, str]:
    library = str(binding.get("library", "")).strip()
    cell = str(binding.get("cell", "")).strip()
    if not library or not cell:
        raise ValueError("KiCad symbol binding requires a non-empty library and cell")
    if ":" in library or ":" in cell or any(ord(character) < 32 for character in library + cell):
        raise ValueError(f"invalid KiCad library/cell identifier: {library}:{cell}")
    return library, cell, f"{library}:{cell}"


def _kicad_snap_internal(value: float) -> float:
    """Project an Vibe Analog coordinate onto KiCad's normal 50 mil grid."""

    connection_grid = GRID / 2
    return round(float(value) / connection_grid) * connection_grid


def _kicad_local_pin_position(component: dict[str, Any], pin: dict[str, Any], index: int) -> dict[str, float]:
    """Return the KiCad-grid projection of an editor symbol's local pin."""

    point = _pin_position(
        {**component, "position": {"x": 0, "y": 0}, "rotation": 0},
        pin,
        index,
    )
    return {
        "x": _kicad_snap_internal(point["x"]),
        "y": _kicad_snap_internal(point["y"]),
    }


def _kicad_symbol_signature(component: dict[str, Any], binding: dict[str, Any]) -> str:
    """Hash the definition fields that must agree for a shared lib_id."""
    pins: list[dict[str, Any]] = []
    for index, pin in enumerate(component.get("pins", [])):
        point = _kicad_local_pin_position(component, pin, index)
        side = _pin_side(component, pin, index)
        pins.append({
            "number": str(binding["pin_map"][str(pin["id"])]),
            "name": str((pin.get("eda") or {}).get("role") or pin.get("name") or pin["id"]).upper(),
            "electrical_type": _kicad_pin_electrical_type(component, pin),
            "x": round(point["x"] * MM_PER_UNIT, 4),
            "y": round(-point["y"] * MM_PER_UNIT, 4),
            "angle": {"left": 0, "right": 180, "top": 270, "bottom": 90}[side],
        })
    width, height = _component_size({**component, "rotation": 0})
    eda = component.get("eda") or {}
    payload = {
        "device_class": str(eda.get("device_class", component.get("type", "generic"))).lower(),
        "subtype": str(eda.get("subtype", "")).lower(),
        "width": width,
        "height": height,
        "pins": sorted(pins, key=lambda entry: entry["number"]),
    }
    return _sha256_bytes(_canonical_json(payload))


def _kicad_symbol_definition(component: dict[str, Any], binding: dict[str, Any], *, embedded: bool, indent: str) -> list[str]:
    library, cell, lib_id = _kicad_binding_identity(binding)
    symbol_name = lib_id if embedded else cell
    width, height = _component_size({**component, "rotation": 0})
    half_width = max(2.54, width * MM_PER_UNIT / 2 - 2.54)
    half_height = max(1.27, height * MM_PER_UNIT / 2 - 1.27)
    eda = component.get("eda") or {}
    reference = str(eda.get("refdes_prefix", component.get("type", "X")))[:2] or "X"
    physical = bool(eda.get("physical", str(component.get("type", "")).upper() in {"R", "C", "L", "D", "M", "Q"}))
    footprint = str(binding.get("footprint") or component.get("footprint") or eda.get("footprint") or "")
    hide_pin_names = " hide" if eda.get("device_class") in {"resistor", "capacitor", "inductor"} else ""
    lines = [
        f"{indent}(symbol {_sexpr_string(symbol_name)}",
        f"{indent}  (pin_names (offset 1.27){hide_pin_names})",
        f"{indent}  (exclude_from_sim no) (in_bom {'yes' if physical else 'no'}) (on_board {'yes' if physical else 'no'})",
        f"{indent}  (property \"Reference\" {_sexpr_string(reference)} (at 0 {-half_height-2.54:.4f} 0) (effects (font (size 1.27 1.27))))",
        f"{indent}  (property \"Value\" {_sexpr_string(component.get('value', ''))} (at 0 {half_height+2.54:.4f} 0) (effects (font (size 1.27 1.27))))",
        f"{indent}  (property \"Footprint\" {_sexpr_string(footprint)} (at 0 0 0) (effects (font (size 1.27 1.27)) hide))",
        f"{indent}  (property \"Datasheet\" \"~\" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))",
        f"{indent}  (property \"Description\" {_sexpr_string('Vibe Analog portable ' + str(eda.get('device_class', 'symbol')))} (at 0 0 0) (effects (font (size 1.27 1.27)) hide))",
        f"{indent}  (symbol {_sexpr_string(cell + '_0_1')}",
    ]
    lines.extend(_kicad_symbol_graphics(component, indent + "    "))
    lines.extend([f"{indent}  )", f"{indent}  (symbol {_sexpr_string(cell + '_1_1')}"])
    pin_map = binding["pin_map"]
    for index, pin in enumerate(component.get("pins", [])):
        point = _kicad_local_pin_position(component, pin, index)
        # Vibe Analog page coordinates grow downwards; KiCad symbol-library Y
        # coordinates grow upwards.  Reflect local Y before placement.
        x, y = point["x"] * MM_PER_UNIT, -point["y"] * MM_PER_UNIT
        side = _pin_side(component, pin, index)
        angle = {"left": 0, "right": 180, "top": 270, "bottom": 90}[side]
        target_pin = str(pin_map[str(pin["id"])])
        pin_name = str((pin.get("eda") or {}).get("role") or pin.get("name") or pin["id"]).upper()
        lines.append(
            f"{indent}    (pin {_kicad_pin_electrical_type(component, pin)} line (at {x:.4f} {y:.4f} {angle}) (length 2.54) "
            f"(name {_sexpr_string(pin_name)} (effects (font (size 1.27 1.27)))) "
            f"(number {_sexpr_string(target_pin)} (effects (font (size 1.27 1.27)))))"
        )
    lines.extend([f"{indent}  )", f"{indent})"])
    return lines


def _kicad_page_offset(page: dict[str, Any]) -> tuple[float, float]:
    """Keep every exported connection point inside the KiCad sheet canvas."""

    xs: list[float] = []
    ys: list[float] = []
    for component in page.get("components", []):
        bounds = _component_bounds(component)
        xs.extend((bounds["min_x"], bounds["max_x"]))
        ys.extend((bounds["min_y"], bounds["max_y"]))
    for port in page.get("ports", []):
        if isinstance(port.get("position"), dict):
            xs.append(float(port["position"]["x"]))
            ys.append(float(port["position"]["y"]))
    for wire in page.get("wires", []):
        for point in wire.get("points") or []:
            xs.append(float(point["x"]))
            ys.append(float(point["y"]))
    margin = 4 * GRID
    minimum_x = min(xs, default=margin)
    minimum_y = min(ys, default=margin)
    offset_x = max(0.0, math.ceil((margin - minimum_x) / GRID) * GRID)
    offset_y = max(0.0, math.ceil((margin - minimum_y) / GRID) * GRID)
    return offset_x, offset_y


def _kicad_page_paper(page: dict[str, Any], offset_x: float, offset_y: float) -> str:
    maximum_x = max(
        [float(point["x"]) for wire in page.get("wires", []) for point in wire.get("points", [])]
        + [float((port.get("position") or {}).get("x", 0)) for port in page.get("ports", [])]
        + [_component_bounds(component)["max_x"] for component in page.get("components", [])]
        + [0.0]
    )
    maximum_y = max(
        [float(point["y"]) for wire in page.get("wires", []) for point in wire.get("points", [])]
        + [float((port.get("position") or {}).get("y", 0)) for port in page.get("ports", [])]
        + [_component_bounds(component)["max_y"] for component in page.get("components", [])]
        + [0.0]
    )
    required_width = (maximum_x + offset_x + 4 * GRID) * MM_PER_UNIT
    required_height = (maximum_y + offset_y + 4 * GRID) * MM_PER_UNIT
    for name, width, height in (
        ("A4", 297.0, 210.0),
        ("A3", 420.0, 297.0),
        ("A2", 594.0, 420.0),
        ("A1", 841.0, 594.0),
        ("A0", 1189.0, 841.0),
    ):
        if required_width <= width and required_height <= height:
            return name
    raise ValueError(
        f"schematic page {page.get('id', '')} exceeds supported KiCad A0 sheet bounds "
        f"({required_width:.1f} mm x {required_height:.1f} mm)"
    )


_KICAD_TEXT_HEIGHT_UNITS = 15.0  # ~1.9 mm conservative block height for the 1.27 mm font
_KICAD_CHAR_WIDTH_UNITS = 10.0   # 1.27 mm per character, conservative


def _kicad_property_axis(component: dict[str, Any]) -> tuple[float, float, bool]:
    """Half extents (hx, hy) for property anchoring and whether pins run vertically."""

    eda = component.get("eda") if isinstance(component.get("eda"), dict) else {}
    eda_symbol = str(eda.get("symbol", "")).strip()
    if eda_symbol:
        library, separator, cell = eda_symbol.partition(":")
        if separator:
            try:
                symbol_pins = symbol_pin_positions(library.strip(), cell.strip())
            except ValueError:
                symbol_pins = {}
            if symbol_pins:
                rotation = int(round(float(component.get("rotation", 0)))) % 360
                offsets = [
                    _rotate_point(x_mm / MM_PER_UNIT, -y_mm / MM_PER_UNIT, rotation)
                    for x_mm, y_mm, _angle in symbol_pins.values()
                ]
                xs = [dx for dx, _dy in offsets]
                ys = [dy for _dx, dy in offsets]
                spread_x = max(xs) - min(xs)
                spread_y = max(ys) - min(ys)
                hx = max(abs(value) for value in xs) + GRID
                hy = max(abs(value) for value in ys) + GRID
                return hx, hy, spread_y > spread_x
    width, height = _component_size(component)
    return width / 2, height / 2, int(component.get("rotation", 0)) % 180 == 90


def _kicad_text_block(center_x: float, center_y: float, justify: str | None, width_units: float) -> dict[str, float]:
    if justify == "left":
        min_x, max_x = center_x, center_x + width_units
    elif justify == "right":
        min_x, max_x = center_x - width_units, center_x
    else:
        min_x, max_x = center_x - width_units / 2, center_x + width_units / 2
    half = _KICAD_TEXT_HEIGHT_UNITS / 2
    return {"min_x": min_x, "max_x": max_x, "min_y": center_y - half, "max_y": center_y + half}


def _kicad_property_layouts(components: list[dict[str, Any]]) -> dict[str, dict[str, dict[str, Any]]]:
    """Deterministic Reference/Value placements that avoid text collisions.

    Anchors start beside the effective body (real library symbol extents when
    the component carries ``eda.symbol``, generic glyph size otherwise) and
    off the pin axis, so net-label stubs on that axis stay clear of the text.
    Remaining collisions with already accepted text blocks are resolved by
    trying the opposite side, then extra outward offsets, in a fixed order.
    """

    layouts: dict[str, dict[str, dict[str, Any]]] = {}
    accepted: list[dict[str, float]] = []
    for component in sorted(components, key=lambda item: str(item.get("id", ""))):
        eda = component.get("eda") or {}
        refdes = str(eda.get("refdes", component.get("name", "")))
        value = str(component.get("value", ""))
        hx, hy, vertical = _kicad_property_axis(component)
        position = component.get("position") or {}
        cx = _kicad_snap_internal(float(position.get("x", 0)))
        cy = _kicad_snap_internal(float(position.get("y", 0)))
        placement: dict[str, dict[str, Any]] = {}
        for prop, text in (("reference", refdes), ("value", value)):
            width_units = max(6 if prop == "reference" else 8, len(text)) * _KICAD_CHAR_WIDTH_UNITS
            if vertical:
                near = [((-hx - 20, 0.0), "right"), ((hx + 20, 0.0), "left")]
                far = [((-hx - 40, 0.0), "right"), ((hx + 40, 0.0), "left")]
                cross = [((0.0, -hy - 20), None), ((0.0, hy + 20), None)]
            else:
                near = [((0.0, -hy - 20), None), ((0.0, hy + 20), None)]
                far = [((0.0, -hy - 40), None), ((0.0, hy + 40), None)]
                cross = [((-hx - 20, 0.0), "right"), ((hx + 20, 0.0), "left")]
            if prop == "reference":
                sequence = [near[0], near[1], far[0], far[1], cross[0], cross[1]]
            else:
                sequence = [near[1], near[0], far[1], far[0], cross[1], cross[0]]
            chosen = sequence[0]
            for rel, justify in sequence:
                block = _kicad_text_block(cx + rel[0], cy + rel[1], justify, width_units)
                if not any(_bounds_overlap(block, other) for other in accepted):
                    chosen = (rel, justify)
                    break
            rel, justify = chosen
            accepted.append(_kicad_text_block(cx + rel[0], cy + rel[1], justify, width_units))
            placement[prop] = {"rel": rel, "justify": justify}
        layouts[str(component.get("id", ""))] = placement
    return layouts


def _kicad_page_lines(project_name: str, page: dict[str, Any], all_components: list[dict[str, Any]], symbol_map: dict[str, Any], *, root_page: bool) -> list[str]:
    page_uuid = _stable_uuid(project_name, page["id"])
    offset_x, offset_y = _kicad_page_offset(page)
    paper = _kicad_page_paper(page, offset_x, offset_y)

    def at_mm(point: dict[str, Any]) -> tuple[float, float]:
        return (
            _kicad_snap_internal(float(point["x"]) + offset_x) * MM_PER_UNIT,
            _kicad_snap_internal(float(point["y"]) + offset_y) * MM_PER_UNIT,
        )

    lines = ["(kicad_sch (version 20231120) (generator actoviq)", f"  (uuid {page_uuid})", f"  (paper {_sexpr_string(paper)})", "  (lib_symbols"]
    embedded: set[str] = set()
    for entry in all_components:
        binding = binding_for(symbol_map, "kicad", entry["page_id"], entry)
        library, cell, lib_id = _kicad_binding_identity(binding)
        if lib_id in embedded:
            continue
        embedded.add(lib_id)
        if binding.get("library_symbol"):
            lines.extend(symbol_definition_lines(library, cell, name=lib_id, indent="    "))
        else:
            lines.extend(_kicad_symbol_definition(entry, binding, embedded=True, indent="    "))
    lines.append("  )")
    projected_wires: list[dict[str, Any]] = []
    for wire in page["wires"]:
        points: list[dict[str, float]] = []
        for point in wire.get("points") or []:
            projected = {
                "x": _kicad_snap_internal(float(point["x"])),
                "y": _kicad_snap_internal(float(point["y"])),
            }
            if not points or points[-1] != projected:
                points.append(projected)
        if len(points) >= 2:
            projected_wires.append({**wire, "points": points})
    for wire in projected_wires:
        points = wire["points"]
        for index in range(len(points) - 1):
            left, right = points[index], points[index + 1]
            left_x, left_y = at_mm(left)
            right_x, right_y = at_mm(right)
            if left_x == right_x and left_y == right_y:
                continue
            lines.append(f"  (wire (pts (xy {left_x:.4f} {left_y:.4f}) (xy {right_x:.4f} {right_y:.4f})) (stroke (width 0) (type default)) (uuid {_stable_uuid(page['id'], wire['id'], index)}))")
    for net_id, x, y in sorted(_same_net_junction_keys(projected_wires)):
        junction_x, junction_y = at_mm({"x": x, "y": y})
        lines.append(
            f"  (junction (at {junction_x:.4f} {junction_y:.4f}) (diameter 0) "
            f"(color 0 0 0 0) (uuid {_stable_uuid(page['id'], net_id, 'junction', x, y)}))"
        )
    port_nets = {str(port.get("net", "")) for port in page["ports"]}
    label_nets = {
        str(net.get("id", "")): net
        for net in page["nets"]
        if str(net.get("connection", "")) == "label"
    }
    for net in page["nets"]:
        if str(net.get("id", "")) in label_nets:
            continue
        if str(net.get("name", "")) in port_nets:
            continue
        if net["endpoints"]:
            point = net["endpoints"][0]
            point_x, point_y = at_mm(point)
            lines.append(f"  (global_label {_sexpr_string(net['name'])} (shape bidirectional) (at {point_x:.4f} {point_y:.4f} 0) (fields_autoplaced yes) (effects (font (size 1.27 1.27)) (justify left)) (uuid {_stable_uuid(page['id'], net['id'])}))")
    port_names = {str(port.get("id", "")): str(port.get("name", "")) for port in page["ports"]}
    # Label stubs survive wire materialization as pin/port-anchored two-point
    # wires; labels anchor at the materialized stub end so they always sit
    # exactly on an exported wire endpoint.
    label_stub_ends: dict[tuple[str, str], dict[str, Any]] = {}
    port_stub_ends: dict[str, dict[str, Any]] = {}
    for wire in page["wires"]:
        reference = wire.get("from") or {}
        points = wire.get("points") or []
        if not points:
            continue
        if reference.get("component_id") and reference.get("pin_id"):
            label_stub_ends[(str(reference["component_id"]), str(reference["pin_id"]))] = points[-1]
        elif reference.get("port_id"):
            port_stub_ends[str(reference["port_id"])] = points[-1]
    label_port_ids = {
        str(endpoint.get("port_id", ""))
        for net in label_nets.values()
        for endpoint in net.get("endpoints", [])
        if endpoint.get("kind") == "port"
    }
    for port in page["ports"]:
        position = port.get("position")
        if not position:
            continue
        shape = {"input": "input", "output": "output"}.get(port.get("direction"), "bidirectional")
        label_kind = "global_label" if root_page else "hierarchical_label"
        anchor = position
        if str(port.get("id", "")) in label_port_ids:
            anchor = port_stub_ends.get(str(port.get("id", "")), position)
        position_x, position_y = at_mm(anchor)
        lines.append(f"  ({label_kind} {_sexpr_string(port['name'])} (shape {shape}) (at {position_x:.4f} {position_y:.4f} 0) (fields_autoplaced yes) (effects (font (size 1.27 1.27)) (justify left)) (uuid {_stable_uuid(page['id'], 'port', port['id'])}))")
    for net_id in sorted(label_nets):
        net = label_nets[net_id]
        port_label_names = sorted({
            port_names.get(str(endpoint.get("port_id", "")), "")
            for endpoint in net.get("endpoints", [])
            if endpoint.get("kind") == "port"
        } - {""})
        # A port label must name the whole labelled group, so the pin stubs
        # adopt the port's name whenever the net has one.
        label_name = port_label_names[0] if port_label_names else str(net.get("name", net_id))
        for endpoint in net.get("endpoints", []):
            if endpoint.get("kind") != "pin":
                continue
            stub_end = label_stub_ends.get((str(endpoint.get("component_id", "")), str(endpoint.get("pin_id", ""))))
            if stub_end is None:
                continue
            label_x, label_y = at_mm(stub_end)
            egress = endpoint.get("_egress") or {}
            if float(egress.get("x", 0) or 0) > 0:
                angle, justify = 0, "left"
            elif float(egress.get("x", 0) or 0) < 0:
                angle, justify = 0, "right"
            elif float(egress.get("y", 0) or 0) > 0:
                angle, justify = 270, "left"
            else:
                angle, justify = 90, "left"
            lines.append(
                f"  (label {_sexpr_string(label_name)} (at {label_x:.4f} {label_y:.4f} {angle}) "
                f"(fields_autoplaced yes) (effects (font (size 1.27 1.27)) (justify {justify})) "
                f"(uuid {_stable_uuid(page['id'], net_id, 'label', endpoint.get('component_id', ''), endpoint.get('pin_id', ''))}))"
            )
    property_layouts = _kicad_property_layouts(page["components"])
    for component in page["components"]:
        position = component["position"]
        binding = binding_for(symbol_map, "kicad", page["id"], component)
        _, _, lib_id = _kicad_binding_identity(binding)
        eda = component.get("eda") or {}
        unit = int(eda.get("unit") or 1)
        physical = bool(eda.get("physical", str(component.get("type", "")).upper() in {"R", "C", "L", "D", "M", "Q"}))
        refdes = str(eda.get("refdes", component["name"]))
        kicad_rotation = (-int(component.get("rotation", 0))) % 360
        component_x = _kicad_snap_internal(float(position["x"]) + offset_x)
        component_y = _kicad_snap_internal(float(position["y"]) + offset_y)
        layout = property_layouts[str(component.get("id", ""))]

        def property_at(prop: str) -> tuple[tuple[float, float], str]:
            rel = layout[prop]["rel"]
            justify = layout[prop]["justify"]
            effects = f"(effects (font (size 1.27 1.27)){f' (justify {justify})' if justify else ''})"
            return ((component_x + rel[0]) * MM_PER_UNIT, (component_y + rel[1]) * MM_PER_UNIT), effects

        reference_at, reference_effects = property_at("reference")
        value_at, value_effects = property_at("value")
        lines.extend([
            f"  (symbol (lib_id {_sexpr_string(lib_id)}) (at {component_x*MM_PER_UNIT:.4f} {component_y*MM_PER_UNIT:.4f} {kicad_rotation}) (unit {unit}) (exclude_from_sim no) (in_bom {'yes' if physical else 'no'}) (on_board {'yes' if physical else 'no'}) (dnp no) (uuid {_stable_uuid(page['id'], component['id'])})",
            f"    (property \"Reference\" {_sexpr_string(refdes)} (at {reference_at[0]:.4f} {reference_at[1]:.4f} 0) {reference_effects})",
            f"    (property \"Value\" {_sexpr_string(component.get('value', ''))} (at {value_at[0]:.4f} {value_at[1]:.4f} 0) {value_effects})",
            f"    (property \"ACTOVIQ_ID\" {_sexpr_string(str(component.get('stable_id') or component['id']))} (at 0 0 0) (effects (font (size 1.27 1.27)) hide))",
            f"    (property \"ACTOVIQ_PAGE_ID\" {_sexpr_string(page['id'])} (at 0 0 0) (effects (font (size 1.27 1.27)) hide))",
            f"    (property \"ACTOVIQ_NAME\" {_sexpr_string(component['name'])} (at 0 0 0) (effects (font (size 1.27 1.27)) hide))",
            f"    (property \"ACTOVIQ_DEVICE_CLASS\" {_sexpr_string(eda.get('device_class', 'generic'))} (at 0 0 0) (effects (font (size 1.27 1.27)) hide))",
        ])
        if eda.get("lcsc_id"):
            lines.append(
                f"    (property \"LCSC\" {_sexpr_string(eda.get('lcsc_id'))} (at 0 0 0) (effects (font (size 1.27 1.27)) hide))"
            )
        if eda.get("mpn"):
            lines.append(
                f"    (property \"MPN\" {_sexpr_string(eda.get('mpn'))} (at 0 0 0) (effects (font (size 1.27 1.27)) hide))"
            )
        instance_footprint = str(eda.get("footprint") or component.get("footprint") or "").strip()
        if instance_footprint:
            lines.append(
                f"    (property \"Footprint\" {_sexpr_string(instance_footprint)} (at 0 0 0) (effects (font (size 1.27 1.27)) hide))"
            )
        for pin in component.get("pins", []):
            target_pin = str(binding["pin_map"][str(pin["id"])])
            lines.append(f"    (pin {_sexpr_string(target_pin)} (uuid {_stable_uuid(page['id'], component['id'], pin['id'])}))")
        lines.extend([
            "    (instances",
            f"      (project {_sexpr_string(project_name)} (path {_sexpr_string('/' + page_uuid)} (reference {_sexpr_string(refdes)}) (unit {unit})))",
            "    )",
            "  )",
        ])
    lines.extend([f"  (sheet_instances (path \"/\" (page \"1\")))", ")\n"])
    return lines


def _pad_sort_key(value: str) -> tuple[int, int, str]:
    return (0, int(value), "") if value.isdigit() else (1, 0, value)


def _kicad_footprint_references(all_components: list[dict[str, Any]], symbol_map: dict[str, Any]) -> dict[str, set[str]]:
    """Map each referenced footprint id to the symbol pin numbers used with it.

    Mirrors every place a Footprint property can enter the generated
    schematics: the instance property (``eda.footprint``/``footprint``), the
    generated symbol definition (``binding.footprint``), and the default
    Footprint property embedded with a real library symbol.
    """

    references: dict[str, set[str]] = {}
    for component in all_components:
        binding = binding_for(symbol_map, "kicad", component["page_id"], component)
        eda = component.get("eda") or {}
        candidates = {
            str(value).strip()
            for value in (binding.get("footprint"), component.get("footprint"), eda.get("footprint"))
            if str(value or "").strip()
        }
        if binding.get("library_symbol"):
            default = symbol_footprint(str(binding["library"]), str(binding["cell"]))
            if default:
                candidates.add(default)
        if not candidates:
            continue
        pin_numbers = {str(binding["pin_map"][str(pin["id"])]) for pin in component.get("pins", [])}
        for footprint_id in candidates:
            references.setdefault(footprint_id, set()).update(pin_numbers)
    return references


def _package_kicad_footprints(target: Path, all_components: list[dict[str, Any]], symbol_map: dict[str, Any]) -> list[Path]:
    """Copy referenced bundled footprints into the package.

    Writes ``footprints/<Lib>.pretty/<Name>.kicad_mod`` for every referenced
    footprint that ships in the bundled kicad-lib, a project-level
    ``fp-lib-table`` mapping each library nickname to its packaged ``.pretty``
    directory, and a deterministic ``footprint-report.json`` recording the
    pad coverage of every packaged footprint plus the ids that were skipped
    because they are not bundled.  A footprint whose pads do not cover the
    symbol pin numbers used with it aborts the export; extra pads are fine
    (for example the intentional 2-pin crystal on a 4-pad 3225 footprint).
    """

    references = _kicad_footprint_references(all_components, symbol_map)
    if not references:
        return []
    packaged: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    written: list[Path] = []
    libraries: set[str] = set()
    for footprint_id in sorted(references):
        library, _, name = footprint_id.partition(":")
        if not library or not name:
            raise ValueError(f"invalid KiCad footprint id {footprint_id!r}; expected 'Library:Name'")
        source = find_footprint_file(footprint_id)
        if source is None:
            # Not part of the bundled library: keep the Footprint property
            # and let the user's own KiCad libraries resolve it.
            skipped.append({"id": footprint_id, "reason": "footprint is not in the bundled kicad-lib"})
            continue
        pretty_dir = target / "footprints" / f"{library}.pretty"
        pretty_dir.mkdir(parents=True, exist_ok=True)
        destination = pretty_dir / f"{name}.kicad_mod"
        shutil.copyfile(source, destination)
        written.append(destination)
        libraries.add(library)
        pads = footprint_pad_numbers(source)
        symbol_pins = references[footprint_id]
        missing = sorted(symbol_pins - pads, key=_pad_sort_key)
        if missing:
            raise ValueError(
                f"KiCad footprint {footprint_id} is missing pads {missing} "
                f"required by the symbol pins {sorted(symbol_pins, key=_pad_sort_key)}"
            )
        packaged.append({
            "id": footprint_id,
            "path": f"footprints/{library}.pretty/{name}.kicad_mod",
            "pads": sorted(pads, key=_pad_sort_key),
            "symbol_pins": sorted(symbol_pins, key=_pad_sort_key),
        })
    table_lines = ["(fp_lib_table (version 7)"]
    for library in sorted(libraries):
        uri = f"${{KIPRJMOD}}/footprints/{library}.pretty"
        table_lines.append(
            f"  (lib (name {_sexpr_string(library)})(type \"KiCad\")(uri {_sexpr_string(uri)})(options \"\")(descr \"Vibe Analog bundled footprints\"))"
        )
    table_lines.append(")\n")
    fp_table = target / "fp-lib-table"
    _write_text(fp_table, "\n".join(table_lines))
    report = target / "footprint-report.json"
    _write_json(report, {"schema": "actoviq.kicad-footprint-report.v1", "packaged": packaged, "skipped": skipped})
    return [fp_table, report, *written]


def _verify_kicad_footprint_properties(target: Path, schematic_files: list[Path]) -> None:
    """Every non-empty Footprint property in the generated schematics must be
    either packaged in this export or recorded as skipped (not bundled)."""

    report_path = target / "footprint-report.json"
    if report_path.is_file():
        report = json.loads(report_path.read_text(encoding="utf-8"))
        accounted = {entry["id"] for entry in report["packaged"]} | {entry["id"] for entry in report["skipped"]}
    else:
        accounted = set()
    unresolved: set[tuple[str, str]] = set()
    for schematic in schematic_files:
        for match in re.finditer(r'\(property "Footprint" "((?:[^"\\]|\\.)*)"', schematic.read_text(encoding="utf-8")):
            footprint_id = match.group(1).replace('\\"', '"').replace("\\\\", "\\")
            if footprint_id and footprint_id not in accounted:
                unresolved.add((schematic.name, footprint_id))
    if unresolved:
        raise ValueError(f"KiCad schematics reference unpackaged footprints: {sorted(unresolved)}")


def _write_kicad(root: Path, project_name: str, ir: dict[str, Any], symbol_map: dict[str, Any]) -> list[Path]:
    target = root / "kicad"
    target.mkdir(parents=True, exist_ok=True)
    pro = target / f"{project_name}.kicad_pro"
    _write_json(pro, {"board": {}, "boards": [], "cvpcb": {}, "erc": {}, "libraries": {}, "meta": {"filename": pro.name, "version": 1}, "net_settings": {}, "pcbnew": {}, "schematic": {}, "text_variables": {}})
    all_components = [{**component, "page_id": page["id"]} for page in ir["pages"] for component in page["components"]]
    libraries: dict[str, dict[str, tuple[dict[str, Any], dict[str, Any]]]] = {}
    for component in all_components:
        binding = binding_for(symbol_map, "kicad", component["page_id"], component)
        library, cell, lib_id = _kicad_binding_identity(binding)
        existing = libraries.setdefault(library, {}).get(cell)
        if (
            existing
            and not binding.get("library_symbol")
            and not existing[1].get("library_symbol")
            and _kicad_symbol_signature(existing[0], existing[1]) != _kicad_symbol_signature(component, binding)
        ):
            raise ValueError(
                f"conflicting KiCad symbol definitions for {lib_id}; "
                "map components with different pin geometry to distinct cells"
            )
        libraries[library].setdefault(cell, (component, binding))
    symbol_files: list[Path] = []
    table_lines = ["(sym_lib_table", "  (version 7)"]
    filenames: dict[str, str] = {}
    for library, cells in sorted(libraries.items()):
        filename = _safe_name(library, "Vibe Analog_Standard") + ".kicad_sym"
        filename_key = filename.casefold()
        if filename_key in filenames and filenames[filename_key] != library:
            raise ValueError(
                f"KiCad library names {filenames[filename_key]!r} and {library!r} map to the same file {filename!r}"
            )
        filenames[filename_key] = library
        symbols = target / filename
        symbol_lines = ["(kicad_symbol_lib (version 20231120) (generator actoviq)"]
        for _, (component, binding) in sorted(cells.items()):
            if binding.get("library_symbol"):
                symbol_lines.extend(symbol_definition_lines(library, str(binding["cell"]), indent="  "))
            else:
                symbol_lines.extend(_kicad_symbol_definition(component, binding, embedded=False, indent="  "))
        symbol_lines.append(")\n")
        _write_text(symbols, "\n".join(symbol_lines))
        symbol_files.append(symbols)
        table_lines.append(f"  (lib (name {_sexpr_string(library)})(type \"KiCad\")(uri {_sexpr_string('${KIPRJMOD}/' + filename)})(options \"\")(descr \"Vibe Analog portable symbols\"))")
    table_lines.append(")\n")
    sym_table = target / "sym-lib-table"
    _write_text(sym_table, "\n".join(table_lines))
    schematic_files: list[Path] = []
    for page in ir["pages"]:
        page_name = project_name if len(ir["pages"]) == 1 else f"{project_name}-{_safe_name(page['id'])}"
        schematic = target / f"{page_name}.kicad_sch"
        _write_text(schematic, "\n".join(_kicad_page_lines(project_name, page, all_components, symbol_map, root_page=len(ir["pages"]) == 1)))
        schematic_files.append(schematic)
    if len(ir["pages"]) > 1:
        root_schematic = target / f"{project_name}.kicad_sch"
        root_uuid = _stable_uuid(project_name, "root")
        lines = ["(kicad_sch (version 20231120) (generator actoviq)", f"  (uuid {root_uuid})", "  (paper \"A4\")", "  (lib_symbols)"]
        root_labels: list[str] = []
        global_port_nets = {
            (record.get("module_id"), record.get("port_id")): record["net"]
            for record in ir["connectivity"]["records"]
            if record.get("port_id")
        }
        for page_index, page in enumerate(ir["pages"]):
            sheet_uuid = _stable_uuid(project_name, "sheet", page["id"])
            x, y = 25.4 + page_index * 63.5, 50.8
            width, height = 50.8, max(25.4, 7.62 + len(page["ports"]) * 5.08)
            lines.extend([
                f"  (sheet (at {x:.4f} {y:.4f}) (size {width:.4f} {height:.4f}) (fields_autoplaced yes) (stroke (width 0) (type default)) (fill (color 0 0 0 0.0000)) (uuid {sheet_uuid})",
                f"    (property \"Sheetname\" {_sexpr_string(page['name'])} (at {x:.4f} {y-1.27:.4f} 0) (effects (font (size 1.27 1.27)) (justify left bottom)))",
                f"    (property \"Sheetfile\" {_sexpr_string(project_name + '-' + _safe_name(page['id']) + '.kicad_sch')} (at {x:.4f} {y+height+1.27:.4f} 0) (effects (font (size 1.27 1.27)) (justify left top)))",
            ])
            for port_index, port in enumerate(page["ports"]):
                output = port.get("direction") == "output"
                pin_x = x + width if output else x
                pin_y = y + 5.08 + port_index * 5.08
                shape = {"input": "input", "output": "output"}.get(port.get("direction"), "bidirectional")
                # KiCad sheet pins extend from their anchor in the angle
                # direction and connect at the far tip: pins on the left edge
                # must face 180 and pins on the right edge must face 0,
                # otherwise the anchor sits at the box edge with the live tip
                # pointing into the sheet and nothing ever connects to it.
                angle = 0 if output else 180
                lines.append(f"    (pin {_sexpr_string(port['name'])} {shape} (at {pin_x:.4f} {pin_y:.4f} {angle}) (effects (font (size 1.27 1.27))) (uuid {_stable_uuid(page['id'], 'root-pin', port['id'])}))")
                global_net = global_port_nets.get((page["id"], port["id"]), f"{page['id']}:{port.get('net', '')}")
                # KiCad does not attach a label to a bare sheet pin, so bridge
                # the pin and its global label with a short wire stub that
                # leaves the sheet box (left on the left edge, right on the
                # right edge).
                label_x = pin_x + (5.08 if output else -5.08)
                justify = "left" if output else "right"
                root_labels.append(f"  (wire (pts (xy {pin_x:.4f} {pin_y:.4f}) (xy {label_x:.4f} {pin_y:.4f})) (stroke (width 0) (type default)) (uuid {_stable_uuid(page['id'], 'root-wire', port['id'])}))")
                root_labels.append(f"  (global_label {_sexpr_string(global_net)} (shape {shape}) (at {label_x:.4f} {pin_y:.4f} 0) (fields_autoplaced yes) (effects (font (size 1.27 1.27)) (justify {justify})) (uuid {_stable_uuid(page['id'], 'root-label', port['id'])}))")
            lines.extend(["    (instances", f"      (project {_sexpr_string(project_name)} (path {_sexpr_string('/' + sheet_uuid)} (page {_sexpr_string(str(page_index + 2))})))", "    )", "  )"])
        lines.extend(root_labels)
        lines.extend(["  (sheet_instances (path \"/\" (page \"1\")))", ")\n"])
        _write_text(root_schematic, "\n".join(lines))
        schematic_files.insert(0, root_schematic)
    footprint_files = _package_kicad_footprints(target, all_components, symbol_map)
    _verify_kicad_footprint_properties(target, schematic_files)
    _write_json(target / "connectivity.json", ir["connectivity"])
    return [pro, *symbol_files, sym_table, target / "connectivity.json", *footprint_files, *schematic_files]


def _write_altium(root: Path, project_name: str, ir: dict[str, Any], symbol_map: dict[str, Any]) -> list[Path]:
    target = root / "altium"
    target.mkdir(parents=True, exist_ok=True)
    for source in (root / "kicad").iterdir():
        if source.is_file():
            shutil.copy2(source, target / source.name)
    readme = target / "IMPORT_ALTIUM.md"
    _write_text(readme, f"# Import {project_name} into Altium Designer\n\nThis is a validated KiCad import source, not a native SchDoc. Use File > Import Wizard > KiCad Design Files, add `{project_name}.kicad_pro` and every `.kicad_sym` file in this folder, then save the converted project as PrjPcb/SchDoc. Compile the imported project and compare its netlist with `connectivity.json`. The embedded/source bindings are recorded under `symbol-map.resolved.json` as `source_kicad`; any Altium-specific target mapping is retained as `requested_altium` for a manual or future native conversion and does not rewrite the KiCad import package.\n")
    _write_json(target / "symbol-map.resolved.json", {
        "schema": "actoviq.altium-kicad-import-map.v1",
        "mapping_application": "kicad_import_source",
        "source_kicad": symbol_map["targets"]["kicad"],
        "requested_altium": symbol_map["targets"]["altium"],
    })
    _write_json(target / "connectivity.json", ir["connectivity"])
    return [*target.iterdir()]


def _edif_identifier(value: str) -> str:
    result = re.sub(r"[^A-Za-z0-9_]", "_", value)
    if not result or result[0].isdigit():
        result = "N_" + result
    return result


def _write_orcad(root: Path, project_name: str, ir: dict[str, Any], resolved_map: dict[str, Any]) -> list[Path]:
    target = root / "orcad"
    target.mkdir(parents=True, exist_ok=True)
    edif = target / f"{project_name}.edf"
    lines = [
        f"(edif {_edif_identifier(project_name)}", "  (edifVersion 2 0 0)", "  (edifLevel 0)",
        "  (keywordMap (keywordLevel 0))",
        "  (status (written (timeStamp 2000 1 1 0 0 0) (program \"Vibe Analog\")))",
    ]
    libraries: dict[str, dict[str, tuple[dict[str, Any], dict[str, Any]]]] = {}
    for page in ir["pages"]:
        for component in page["components"]:
            binding = binding_for(resolved_map, "orcad", page["id"], component)
            library, cell = str(binding["library"]), str(binding["cell"])
            existing = libraries.setdefault(library, {}).get(cell)
            if existing and _kicad_symbol_signature(existing[0], existing[1]) != _kicad_symbol_signature(component, binding):
                raise ValueError(
                    f"conflicting OrCAD symbol definitions for {library}:{cell}; "
                    "map components with different pin geometry to distinct cells"
                )
            libraries[library].setdefault(cell, (component, binding))
    for library, cells in sorted(libraries.items()):
        lines.append(f"  (library {_edif_identifier(library)} (edifLevel 0) (technology (numberDefinition (scale 1 1 (unit DISTANCE))))")
        for cell, (component, binding) in sorted(cells.items()):
            lines.append(f"    (cell {_edif_identifier(cell)} (cellType GENERIC) (view SYMBOL (viewType SYMBOL) (interface")
            for pin in component.get("pins", []):
                target_pin = _edif_identifier(str(binding["pin_map"][str(pin["id"])]))
                lines.append(f"      (port {target_pin} (direction INOUT))")
            lines.append("    ) (contents")
            width, height = _component_size({**component, "rotation": 0})
            lines.append(f"      (figure SYMBOL (rectangle (pt {int(-width/2)} {int(-height/2)}) (pt {int(width/2)} {int(height/2)})))")
            for index, pin in enumerate(component.get("pins", [])):
                target_pin = _edif_identifier(str(binding["pin_map"][str(pin["id"])]))
                point = _pin_position({**component, "position": {"x": 0, "y": 0}, "rotation": 0}, pin, index)
                lines.append(f"      (portImplementation {target_pin} (connectLocation (figure SYMBOL (dot (pt {int(point['x'])} {int(point['y'])})))))")
            lines.append("    )))")
        lines.append("  )")
    lines.append("  (library ACTOVIQ_DESIGN (edifLevel 0) (technology (numberDefinition (scale 1 1 (unit DISTANCE))))")
    for page in ir["pages"]:
        lines.append(f"    (cell {_edif_identifier(page['id'])} (cellType GENERIC) (view SCHEMATIC (viewType SCHEMATIC) (interface")
        for port in page["ports"]:
            direction = {"input": "INPUT", "output": "OUTPUT"}.get(port.get("direction"), "INOUT")
            lines.append(f"      (port {_edif_identifier(port['id'])} (direction {direction}))")
        lines.append("    ) (contents")
        for component in page["components"]:
            binding = binding_for(resolved_map, "orcad", page["id"], component)
            position = component.get("position") or {}
            orientation = f"R{int(component.get('rotation', 0)) % 360}"
            eda = component.get("eda") or {}
            lines.append(
                f"      (instance {_edif_identifier(component['id'])} (viewRef SYMBOL (cellRef {_edif_identifier(binding['cell'])} (libraryRef {_edif_identifier(binding['library'])}))) "
                f"(transform (origin (pt {int(position.get('x', 0))} {int(position.get('y', 0))})) (orientation {orientation})) "
                f"(property REFDES (string {_sexpr_string(eda.get('refdes', component['name']))})) "
                f"(property VALUE (string {_sexpr_string(component.get('value', ''))})) "
                f"(property DEVICE (string {_sexpr_string(binding['cell'])})) "
                f"(property ACTOVIQ_ID (string {_sexpr_string(str(component.get('stable_id') or component['id']))})) "
                f"(property ACTOVIQ_PAGE_ID (string {_sexpr_string(page['id'])})))"
            )
        for net in page["nets"]:
            net_wires = [wire for wire in page["wires"] if wire.get("net_id") == net["id"]]
            wire_points = ";".join(",".join(f"{point['x']}:{point['y']}" for point in wire.get("points", [])) for wire in net_wires)
            lines.append(f"      (net {_edif_identifier(net['id'])} (property ACTOVIQ_WIRE_POINTS (string {_sexpr_string(wire_points)})) (joined")
            for endpoint in net["endpoints"]:
                if endpoint.get("kind") == "pin":
                    component = next(entry for entry in page["components"] if entry["id"] == endpoint["component_id"])
                    binding = binding_for(resolved_map, "orcad", page["id"], component)
                    target_pin = binding["pin_map"][str(endpoint["pin_id"])]
                    lines.append(f"        (portRef {_edif_identifier(target_pin)} (instanceRef {_edif_identifier(endpoint['component_id'])}))")
                else:
                    lines.append(f"        (portRef {_edif_identifier(endpoint['port_id'])})")
            lines.append("      ))")
        lines.append("    )))")
    top_cell = _edif_identifier(project_name + "_TOP")
    lines.append(f"    (cell {top_cell} (cellType GENERIC) (view SCHEMATIC (viewType SCHEMATIC) (interface) (contents")
    for page in ir["pages"]:
        lines.append(f"      (instance {_edif_identifier('PAGE_' + page['id'])} (viewRef SCHEMATIC (cellRef {_edif_identifier(page['id'])} (libraryRef ACTOVIQ_DESIGN))))")
    port_records: dict[str, list[dict[str, str]]] = {}
    for record in ir["connectivity"]["records"]:
        if record.get("port_id"):
            port_records.setdefault(record["net"], []).append(record)
    for net_name, records in sorted(port_records.items()):
        if len(records) < 2:
            continue
        lines.append(f"      (net {_edif_identifier(net_name)} (joined")
        for record in records:
            lines.append(f"        (portRef {_edif_identifier(record['port_id'])} (instanceRef {_edif_identifier('PAGE_' + record['module_id'])}))")
        lines.append("      ))")
    lines.extend(["    )))", "  )", f"  (design {_edif_identifier(project_name)} (cellRef {top_cell} (libraryRef ACTOVIQ_DESIGN)))", ")\n"])
    _write_text(edif, "\n".join(lines))
    symbol_map = target / "symbol-map.json"
    _write_json(symbol_map, resolved_map["targets"]["orcad"])
    readme = target / "IMPORT_ORCAD.md"
    _write_text(readme, f"# Import {project_name} into OrCAD Capture\n\nImport `{edif.name}` with the EDIF 2.0 importer, then save the design as DSN/OPJ. Verify the net count against `connectivity.json`.\n")
    _write_json(target / "connectivity.json", ir["connectivity"])
    return [edif, symbol_map, readme, target / "connectivity.json"]


def _spice_lines(
    ir: dict[str, Any],
    cdl: bool = False,
    model_bindings: list[str] | None = None,
) -> list[str]:
    lines = [f"* Vibe Analog {'CDL' if cdl else 'SPICE'} export", f"* connectivity_hash={ir['connectivity']['hash']}"]
    if model_bindings:
        lines.extend(["* PDK/model bindings", *model_bindings])
    global_net_by_endpoint = {(record.get("module_id"), record.get("component_id"), record.get("pin_id")): record["net"] for record in ir["connectivity"]["records"] if record.get("component_id")}
    for page in ir["pages"]:
        for component in page["components"]:
            component_type = str(component.get("type", "X")).upper()
            if component_type == "GND":
                # Ground pseudo-components carry no SPICE/CDL card; their pin
                # already ties the ground net through the connectivity records.
                continue
            prefix = "X" if component_type == "BLOCK" else component_type
            name = str((component.get("eda") or {}).get("refdes") or component.get("name", component["id"]))
            if not name.upper().startswith(prefix):
                name = prefix + name
            nets = [global_net_by_endpoint.get((page["id"], component["id"], pin["id"]), f"{page['id']}:{pin.get('net', '')}") for pin in component.get("pins", [])]
            value = component.get("value", "GENERIC")
            if component_type == "BLOCK":
                value = _safe_name(value, "ACTOVIQ_BLOCK")
            lines.append(" ".join([_safe_name(name), *(_safe_name(net, "0") for net in nets), str(value)]))
    lines.append(".END")
    return lines


def _model_binding_lines(ir: dict[str, Any], project_root: Path | None = None) -> list[str]:
    lines: list[str] = []
    seen: set[str] = set()
    for page in ir["pages"]:
        spice = page.get("spice") if isinstance(page.get("spice"), dict) else {}
        candidates = list(spice.get("models") or [])
        if not candidates:
            candidates = [
                line.strip()
                for line in str(spice.get("source") or "").splitlines()
                if line.strip().casefold().startswith((".include", ".lib", ".model", ".param", ".func"))
            ]
        for candidate in candidates:
            text = str(candidate).strip()
            path_match = re.match(
                r"^(\s*\.(?:include|lib)\s+)(?:\"([^\"]+)\"|'([^']+)'|([^\s;]+))(.*)$",
                text,
                flags=re.IGNORECASE,
            )
            if path_match and project_root is not None:
                raw_path = next((value for value in path_match.groups()[1:4] if value is not None), "")
                expanded = Path(os.path.expandvars(os.path.expanduser(raw_path)))
                resolved = (expanded if expanded.is_absolute() else project_root / expanded).resolve()
                text = f'{path_match.group(1)}"{resolved.as_posix()}"{path_match.group(5)}'
            key = text.casefold()
            if not text or key in seen:
                continue
            seen.add(key)
            lines.append(text)
    return lines


def _skill_string(value: Any) -> str:
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"').replace("\r", "\\r").replace("\n", "\\n").replace("\t", "\\t") + '"'


def _virtuoso_fallback_binding(binding: dict[str, Any]) -> dict[str, Any]:
    pin_map = {str(source): str(target) for source, target in binding["pin_map"].items()}
    payload = {
        "library": str(binding["library"]),
        "cell": str(binding["cell"]),
        "view": str(binding.get("view", "symbol")),
        "pins": sorted(pin_map.values()),
    }
    digest = _sha256_bytes(_canonical_json(payload))[:8]
    return {
        "library": "ACTOVIQ",
        "library_variable": "actoviqLibrary",
        "cell": f"generic_{_safe_name(binding['cell'])}_{digest}",
        "view": "symbol",
        "pin_map": pin_map,
    }


def _write_virtuoso(
    root: Path,
    project_name: str,
    ir: dict[str, Any],
    resolved_map: dict[str, Any],
    project_root: Path | None = None,
) -> list[Path]:
    target = root / "virtuoso"
    target.mkdir(parents=True, exist_ok=True)
    model_lines = _model_binding_lines(ir, project_root)
    spice = target / f"{project_name}.spice"
    cdl = target / f"{project_name}.cdl"
    _write_text(spice, "\n".join(_spice_lines(ir, model_bindings=model_lines)) + "\n")
    _write_text(cdl, "\n".join(_spice_lines(ir, True, model_lines)) + "\n")
    device_map = target / "device-map.json"
    virtuoso_map = json.loads(json.dumps(resolved_map["targets"]["virtuoso"]))
    virtuoso_map["analog_ic_profile"] = ir.get("project", {}).get("analog_ic_profile")
    for page in ir["pages"]:
        for component in page["components"]:
            key = f"{page['id']}:{component['id']}"
            binding = binding_for(resolved_map, "virtuoso", page["id"], component)
            virtuoso_map["components"][key]["generic_fallback"] = _virtuoso_fallback_binding(binding)
    _write_json(device_map, virtuoso_map)
    extra_files: list[Path] = []
    analog_profile = ir.get("project", {}).get("analog_ic_profile")
    if isinstance(analog_profile, dict):
        profile_path = target / "analog-ic-profile.json"
        _write_json(profile_path, analog_profile)
        extra_files.append(profile_path)
    if model_lines:
        bindings_path = target / "model-bindings.spice"
        _write_text(bindings_path, "* PDK/model statements preserved from Vibe Analog module sources\n" + "\n".join(model_lines) + "\n")
        extra_files.append(bindings_path)
    source_root = target / "source-spice"
    source_pages: list[str] = []
    for page in ir["pages"]:
        page_spice = page.get("spice") if isinstance(page.get("spice"), dict) else {}
        spice_source = str(page_spice.get("source") or "").strip()
        if not spice_source:
            continue
        source_path = source_root / f"{_safe_name(page['id'])}.spice"
        _write_text(source_path, spice_source + "\n")
        extra_files.append(source_path)
        source_pages.append(str(page["id"]))
    handoff_manifest = target / "handoff-manifest.json"
    _write_json(handoff_manifest, {
        "schema": "actoviq.virtuoso-handoff.v1",
        "source": ir["source"],
        "connectivity_hash": ir["connectivity"]["hash"],
        "project_kind": ir.get("project", {}).get("project_kind", "simulation"),
        "analog_ic_profile_present": isinstance(analog_profile, dict),
        "model_binding_count": len(model_lines),
        "source_pages": source_pages,
    })
    extra_files.append(handoff_manifest)
    skill = target / "create_schematic.il"
    skill_lines = [
        "; Vibe Analog Virtuoso reconstruction script",
        "; Set actoviqLibrary before loading this file in CIW or batch mode.",
        'unless(boundp(\'actoviqLibrary) actoviqLibrary="ACTOVIQ")',
        "procedure(actoviqEnsureGenericSymbol(libName cellName pinNames)",
        "  let((cv net term fig x y)",
        '    cv=dbOpenCellViewByType(libName cellName "symbol" "" "a")',
        '    unless(cv~>shapes dbCreateRect(cv list("device" "drawing") list(-1:-1 1:1)))',
        "    x=-1.5 y=0.75",
        '    foreach(pinName pinNames unless(dbFindNetByName(cv pinName) net=dbCreateNet(cv pinName) term=dbCreateTerm(net pinName "inputOutput") fig=dbCreateRect(cv list("pin" "drawing") list(x:y x+0.2:y+0.2)) dbCreatePin(net fig) dbCreateLabel(cv list("pin" "label") x+0.25:y pinName "centerLeft" "R0" "roman" 0.2) y=y-0.5))',
        "    dbSave(cv)",
        "    cv",
        "  )",
        ")",
    ]
    for page in ir["pages"]:
        page_cell = _safe_name(page["id"])
        skill_lines.extend([
            f'; ACTOVIQ_PAGE {json.dumps({"page_id": page["id"], "cell": page_cell}, ensure_ascii=False, separators=(",", ":"))}',
            f'cv=dbOpenCellViewByType(actoviqLibrary {_skill_string(page_cell)} "schematic" "" "a")',
        ])
        net_variables: dict[str, str] = {}
        for net_index, net in enumerate(page["nets"]):
            variable = f"net{net_index}"
            net_variables[str(net["name"])] = variable
            skill_lines.append(f'{variable}=dbCreateNet(cv {_skill_string(_safe_name(net["name"]))})')
        for component_index, component in enumerate(page["components"]):
            binding = binding_for(resolved_map, "virtuoso", page["id"], component)
            library, cell, view = str(binding["library"]), str(binding["cell"]), str(binding.get("view", "symbol"))
            pin_names = [str(binding["pin_map"][str(pin["id"])]) for pin in component.get("pins", [])]
            quoted_pins = " ".join(_skill_string(name) for name in pin_names)
            fallback = _virtuoso_fallback_binding(binding)
            marker = {
                "page_id": str(page["id"]), "component_id": str(component["id"]),
                "refdes": str((component.get("eda") or {}).get("refdes", component["name"])),
                "library": library, "cell": cell, "view": view,
                "pin_map": {str(source): str(target) for source, target in binding["pin_map"].items()},
                "generic_fallback": fallback,
            }
            skill_lines.append(f'; ACTOVIQ_COMPONENT {json.dumps(marker, ensure_ascii=False, sort_keys=True, separators=(",", ":"))}')
            skill_lines.append(f'master=dbOpenCellViewByType({_skill_string(library)} {_skill_string(cell)} {_skill_string(view)} "" "r")')
            skill_lines.append(f'unless(master master=actoviqEnsureGenericSymbol(actoviqLibrary {_skill_string(fallback["cell"])} list({quoted_pins})))')
            position = component.get("position") or {}
            orientation = f"R{int(component.get('rotation', 0)) % 360}"
            refdes = str((component.get("eda") or {}).get("refdes", component["name"]))
            skill_lines.append(f'inst{component_index}=dbCreateInst(cv master {_skill_string(_safe_name(refdes))} list({float(position.get("x", 0))*MM_PER_UNIT:.4f}:{float(position.get("y", 0))*MM_PER_UNIT:.4f}) "{orientation}")')
            skill_lines.append(f'dbReplaceProp(inst{component_index} "ACTOVIQ_ID" "string" {_skill_string(str(component.get("stable_id") or component["id"]))})')
            skill_lines.append(f'dbReplaceProp(inst{component_index} "ACTOVIQ_PAGE_ID" "string" {_skill_string(page["id"])})')
            skill_lines.append(f'dbReplaceProp(inst{component_index} "ACTOVIQ_VALUE" "string" {_skill_string(component.get("value", ""))})')
            for pin_index, pin in enumerate(component.get("pins", [])):
                net_variable = net_variables.get(str(pin.get("net", "")))
                target_pin = str(binding["pin_map"][str(pin["id"])] )
                if net_variable:
                    skill_lines.append(f'dbCreateConnByName({net_variable} inst{component_index} {_skill_string(target_pin)})')
        for port in page["ports"]:
            net_variable = net_variables.get(str(port.get("net", "")))
            if net_variable:
                direction = {"input": "input", "output": "output"}.get(port.get("direction"), "inputOutput")
                skill_lines.append(f'dbCreateTerm({net_variable} {_skill_string(port["name"])} "{direction}")')
        for wire in page["wires"]:
            points = " ".join(f'{point["x"]*MM_PER_UNIT:.4f}:{point["y"]*MM_PER_UNIT:.4f}' for point in wire.get("points", []))
            if points:
                skill_lines.append(f'when(isCallable(\'schCreateWire) schCreateWire(cv "draw" "full" list({points}) 0.0 0.0 0.0))')
        skill_lines.extend(["dbSave(cv)", "dbClose(cv)"])

    top_cell = _safe_name(project_name + "_TOP")
    skill_lines.extend([
        f'; ACTOVIQ_TOP {json.dumps({"cell": top_cell}, ensure_ascii=False, separators=(",", ":"))}',
        f'topCv=dbOpenCellViewByType(actoviqLibrary {_skill_string(top_cell)} "schematic" "" "a")',
    ])
    records_by_port = {
        (str(record.get("module_id", "")), str(record.get("port_id", ""))): str(record["net"])
        for record in ir["connectivity"]["records"] if record.get("port_id")
    }
    top_net_variables: dict[str, str] = {}
    for net_index, net_name in enumerate(sorted(set(records_by_port.values()))):
        variable = f"topNet{net_index}"
        top_net_variables[net_name] = variable
        skill_lines.append(f'{variable}=dbCreateNet(topCv {_skill_string(_safe_name(net_name))})')
    for page_index, page in enumerate(ir["pages"]):
        page_cell = _safe_name(page["id"])
        port_names = [str(port["name"]) for port in page["ports"]]
        quoted_ports = " ".join(_skill_string(name) for name in port_names)
        skill_lines.append(f'pageMaster{page_index}=actoviqEnsureGenericSymbol(actoviqLibrary {_skill_string(page_cell)} list({quoted_ports}))')
        skill_lines.append(f'pageInst{page_index}=dbCreateInst(topCv pageMaster{page_index} {_skill_string("I_" + page_cell)} list({page_index * 5.0:.4f}:0.0000) "R0")')
        for port in page["ports"]:
            net_name = records_by_port.get((str(page["id"]), str(port["id"])))
            if net_name in top_net_variables:
                skill_lines.append(f'dbCreateConnByName({top_net_variables[net_name]} pageInst{page_index} {_skill_string(port["name"])})')
    skill_lines.extend(["dbSave(topCv)", "dbClose(topCv)"])
    skill_lines.append(f'printf("Vibe Analog: created {len(ir["pages"])} module schematic cell(s) and one top cell for {project_name}\\n")')
    _write_text(skill, "\n".join(skill_lines) + "\n")
    cds = target / "cds.lib.example"
    _write_text(cds, "DEFINE ACTOVIQ ./ACTOVIQ\n")
    readme = target / "IMPORT_VIRTUOSO.md"
    _write_text(readme, f"# Import {project_name} into Cadence Virtuoso\n\nImport `{spice.name}` or `{cdl.name}` with your licensed PDK/reference libraries and `device-map.json`. For analog-IC projects, review `analog-ic-profile.json`, `model-bindings.spice`, and `source-spice/`; the SPICE/CDL import is authoritative for device parameters such as W/L/M/NF. `create_schematic.il` is a connectivity/geometry bootstrap and does not reproduce ADE state, CDF callbacks, PCells, layout, or foundry models. Missing cells must be mapped through the target PDK or replaced by generic symbols with the same pins.\n")
    _write_json(target / "connectivity.json", ir["connectivity"])
    return [spice, cdl, device_map, skill, cds, readme, target / "connectivity.json", *extra_files]


def _balanced_sexpr(text: str) -> bool:
    depth = 0
    quoted = False
    escaped = False
    for character in text:
        if escaped:
            escaped = False
        elif character == "\\" and quoted:
            escaped = True
        elif character == '"':
            quoted = not quoted
        elif not quoted and character == "(":
            depth += 1
        elif not quoted and character == ")":
            depth -= 1
            if depth < 0:
                return False
    return depth == 0 and not quoted


def _validate_generated_target(
    target: str,
    export_root: Path,
    ir: dict[str, Any],
    symbol_map: dict[str, Any],
) -> str:
    target_root = export_root / target
    if target in {"kicad", "altium"}:
        schematics = list(target_root.glob("*.kicad_sch"))
        libraries = list(target_root.glob("*.kicad_sym"))
        if not schematics or not libraries or not all(_balanced_sexpr(path.read_text(encoding="utf-8")) for path in [*schematics, *libraries]):
            raise ValueError(f"generated {target} package failed S-expression validation")
        if any("Vibe Analog_Generic:" in path.read_text(encoding="utf-8") for path in schematics):
            raise ValueError(f"generated {target} package still contains legacy generic symbols")
        if target == "altium":
            validate_altium_import_package(target_root, export_root / "kicad", ir, symbol_map)
        else:
            validate_kicad_package(target_root, ir, symbol_map)
        return "syntax_validated" if target == "kicad" else "kicad_import_source"
    if target == "orcad":
        edif = next(target_root.glob("*.edf"))
        text = edif.read_text(encoding="utf-8")
        required = ("(design ", "(figure ", "(property REFDES", "(property VALUE")
        if not _balanced_sexpr(text) or any(token not in text for token in required):
            raise ValueError("generated OrCAD EDIF failed structural validation")
        validate_orcad_edif(edif, ir, symbol_map)
        return "syntax_validated"
    required_files = [*target_root.glob("*.spice"), *target_root.glob("*.cdl"), target_root / "create_schematic.il", target_root / "device-map.json"]
    if any(not path.is_file() or path.stat().st_size == 0 for path in required_files):
        raise ValueError("generated Virtuoso package is incomplete")
    validate_virtuoso_package(target_root, ir, symbol_map)
    return "generated_unverified"


def _native_status(
    target: str,
    policy: str,
    export_root: Path,
    project_name: str,
    ir: dict[str, Any],
    symbol_map: dict[str, Any],
) -> tuple[str, list[str], list[Path], dict[str, Any]]:
    executable = {
        "kicad": find_kicad_cli(),
        "altium": os.environ.get("ALTIUM_BIN"),
        "orcad": os.environ.get("ORCAD_CAPTURE_BIN"),
        "virtuoso": os.environ.get("VIRTUOSO_BIN"),
    }[target]
    if policy == "never":
        return "import_ready", [], [], {}
    if target == "kicad" and executable:
        schematic = export_root / "kicad" / f"{project_name}.kicad_sch"
        erc_report = export_root / "reports" / "kicad-erc.json"
        netlist = export_root / "reports" / "kicad-netlist.xml"
        connectivity_report = export_root / "reports" / "kicad-connectivity-roundtrip.json"
        erc_report.parent.mkdir(parents=True, exist_ok=True)
        try:
            erc_completed = subprocess.run(
                [str(executable), "sch", "erc", "--format", "json", "--output", str(erc_report), str(schematic)],
                cwd=schematic.parent, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90, check=False,
            )
            netlist_completed = subprocess.run(
                [str(executable), "sch", "export", "netlist", "--format", "kicadxml", "--output", str(netlist), str(schematic)],
                cwd=schematic.parent, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90, check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            failure = str(error)
        else:
            failures = [
                (completed.stderr or completed.stdout or "unknown kicad-cli error").strip()
                for completed in (erc_completed, netlist_completed)
                if completed.returncode != 0
            ]
            failure = "\n".join(failures)
            if not failures and erc_report.is_file() and netlist.is_file():
                try:
                    validation = validate_kicad_xml_connectivity(netlist, ir, symbol_map)
                    _write_json(connectivity_report, validation)
                except (OSError, ValueError, ET.ParseError, json.JSONDecodeError) as error:
                    message = f"KiCad vendor connectivity round-trip failed: {error}"
                    native_files = [path for path in (erc_report, netlist, connectivity_report) if path.is_file()]
                    return ("failed" if policy == "required" else "warning"), [message], native_files, {
                        "connectivity_roundtrip": "failed",
                    }
                if not validation["passed"]:
                    message = (
                        "KiCad vendor connectivity round-trip failed: "
                        f"missing={validation['missing_endpoints']}, "
                        f"unexpected={validation['unexpected_endpoints']}"
                    )
                    native_files = [path for path in (erc_report, netlist, connectivity_report) if path.is_file()]
                    # auto/never keep generated packages; required marks failed for export_eda.
                    return ("failed" if policy == "required" else "warning"), [message], native_files, {
                        "connectivity_roundtrip": "failed",
                        "vendor_connectivity_hash": validation.get("actual_hash"),
                    }
                erc_data = json.loads(erc_report.read_text(encoding="utf-8"))
                violations = [
                    violation
                    for sheet in erc_data.get("sheets", [])
                    for violation in sheet.get("violations", [])
                ]
                error_count = sum(violation.get("severity") == "error" for violation in violations)
                warning_count = sum(violation.get("severity") == "warning" for violation in violations)
                native_warnings = []
                if violations:
                    native_warnings.append(
                        f"KiCad connectivity round-trip passed, but vendor ERC reported "
                        f"{error_count} error(s) and {warning_count} warning(s); see reports/kicad-erc.json."
                    )
                for preferences in schematic.parent.glob("*.kicad_prl"):
                    preferences.unlink(missing_ok=True)
                return ("warning" if violations else "native"), native_warnings, [erc_report, netlist, connectivity_report], {
                    "connectivity_roundtrip": "passed",
                    "vendor_connectivity_hash": validation["actual_hash"],
                    "vendor_erc": {"errors": error_count, "warnings": warning_count},
                }
        message = f"kicad-cli could not validate the package: {failure}"
        return ("failed" if policy == "required" else "warning"), [message], [], {}
    if policy == "required":
        reason = "is not configured" if not executable else "has no unattended converter implemented"
        return "failed", [f"Native {target} validation was required but {reason}."], [], {}
    if executable:
        return "warning", [f"Native {target} tool was detected, but unattended import/resave is not implemented; the validated import package was preserved."], [], {}
    return "import_ready", [f"Native {target} tool was not detected; the validated import package is ready for manual import."], [], {}


def export_eda(root: Path, project: dict[str, Any], modules: dict[str, dict[str, Any]], erc: dict[str, Any], document_hash: str, *, scope: str, module_id: str | None, targets: list[str], view: str, mapping_file: str, native_convert: str, strict_layout: bool, source_revision: int | None, output_dir: str | None = None) -> dict[str, Any]:
    if source_revision is not None and int(source_revision) != int(project["revision"]):
        raise ValueError(f"stale source revision: requested {source_revision}, current {project['revision']}")
    if erc.get("blocking"):
        raise ValueError(f"blocking ERC prevents export ({erc.get('summary', {}).get('errors', 0)} errors)")
    if scope == "module" and not module_id:
        raise ValueError("scope=module requires --module-id")
    unknown_targets = sorted(set(targets) - set(TARGETS))
    if unknown_targets:
        raise ValueError(f"unsupported EDA targets: {', '.join(unknown_targets)}")
    ir, quality = build_eda_ir(project, modules, scope=scope, module_id=module_id, view=view, document_hash=document_hash)
    if ir["connectivity"]["hash"] != connectivity_hash(project, modules, module_id if scope == "module" else None, view):
        raise ValueError("connectivity hash changed during layout projection")
    if strict_layout and quality["readability_score"] < 90:
        raise ValueError(f"layout readability score {quality['readability_score']} is below strict threshold 90")
    symbol_map = _load_symbol_map(mapping_file, ir["pages"])
    export_id = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{document_hash[:8]}"
    if output_dir and str(output_dir).strip():
        parent = Path(output_dir).expanduser().resolve()
        if parent.exists() and not parent.is_dir():
            raise ValueError(f"output directory is not a folder: {parent}")
        parent.mkdir(parents=True, exist_ok=True)
        export_root = parent / export_id
    else:
        export_root = root / "build" / "exports" / export_id
    project_name = _safe_name(project.get("name", project["project_id"]))
    _write_json(export_root / "ir" / "project.eda.json", ir)
    _write_json(export_root / "ir" / "symbol-map.resolved.json", symbol_map)
    _write_json(export_root / "common" / "connectivity.json", ir["connectivity"])
    _write_text(export_root / "common" / "preview.svg", _svg_preview(ir))
    _write_text(export_root / "common" / "design.spice", "\n".join(_spice_lines(ir)) + "\n")
    _write_text(export_root / "common" / "design.cdl", "\n".join(_spice_lines(ir, True)) + "\n")
    _write_json(export_root / "reports" / "layout-quality.json", quality)
    statuses: dict[str, Any] = {}
    warnings: list[dict[str, str]] = []
    if quality["readability_score"] < 90:
        warnings.append({"target": "all", "code": "layout_below_threshold", "message": f"Layout readability score is {quality['readability_score']} (< 90)."})
    writers = {"kicad": _write_kicad, "altium": _write_altium, "orcad": _write_orcad, "virtuoso": _write_virtuoso}
    ordered_targets = [target for target in TARGETS if target in targets]
    for target in ordered_targets:
        if target == "altium" and not (export_root / "kicad").exists():
            _write_kicad(export_root, project_name, ir, symbol_map)
        files = (
            _write_virtuoso(export_root, project_name, ir, symbol_map, root)
            if target == "virtuoso"
            else writers[target](export_root, project_name, ir, symbol_map)
        )
        structural_status = _validate_generated_target(target, export_root, ir, symbol_map)
        status, target_warnings, native_files, native_details = _native_status(
            target, native_convert, export_root, project_name, ir, symbol_map
        )
        files.extend(native_files)
        warnings.extend({"target": target, "code": "native_conversion", "message": message} for message in target_warnings)
        statuses[target] = {
            "status": status,
            "connectivity_hash": ir["connectivity"]["hash"],
            "detail": {"structural_status": structural_status, **native_details},
            "files": [str(path.relative_to(export_root)).replace("\\", "/") for path in files if path.is_file()],
        }
    _write_json(export_root / "reports" / "export-warnings.json", {"warnings": warnings})
    file_hashes = {}
    for path in sorted(export_root.rglob("*")):
        if path.is_file() and path.name != "manifest.json":
            file_hashes[str(path.relative_to(export_root)).replace("\\", "/")] = _sha256_bytes(path.read_bytes())
    manifest = {
        "schema": MANIFEST_SCHEMA, "export_id": export_id, "created_at": _utc_now(),
        "source": {"project_id": project["project_id"], "revision": project["revision"], "document_hash": document_hash, "connectivity_hash": ir["connectivity"]["hash"], "scope": scope, "module_id": module_id, "view": view},
        "coordinate_transform": {
            "internal_grid": GRID,
            "mm_per_internal_unit": MM_PER_UNIT,
            "mm_per_grid": GRID * MM_PER_UNIT,
            "kicad_pages": {
                str(page.get("id", "")): {
                    "offset_internal": {
                        "x": _kicad_page_offset(page)[0],
                        "y": _kicad_page_offset(page)[1],
                    },
                    "paper": _kicad_page_paper(page, *_kicad_page_offset(page)),
                }
                for page in ir["pages"]
            },
        },
        "layout": {"readability_score": quality["readability_score"], "strict": strict_layout},
        "targets": statuses, "warnings": len(warnings), "files": file_hashes,
    }
    _write_json(export_root / "manifest.json", manifest)
    if native_convert == "required" and any(value["status"] == "failed" for value in statuses.values()):
        raise ValueError(f"one or more required native conversions failed; report: {export_root / 'manifest.json'}")
    return {"ok": True, "export_id": export_id, "export_root": str(export_root.resolve()), "manifest": manifest, "layout_quality": quality, "targets": statuses}
