#!/usr/bin/env python3
"""Deterministic project editor/compiler for the Vibe Analog schematic canvas."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import re
import shlex
import shutil
import statistics
import struct
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from workspace_paths import (
    get_active_workspace,
    list_workspaces,
    resolve_projects_root,
    select_workspace,
)
from eda_export import (
    _evaluate_layout_candidate,
    connectivity_hash,
    evaluate_layout_patches,
    export_eda,
    prepare_layout_review,
)
from eda_bridge import (
    bridge_status,
    link_bridge,
    list_bridges,
    pull_bridge,
    push_bridge,
    unlink_bridge,
)
from reference_assets import (
    apply_placements_to_components,
    catalog_summary_for_agent,
    import_circuit_reference,
    import_visual_reference,
    list_catalog,
    load_asset,
    prepare_layout_from_reference,
    promote_visual_to_layout,
)
from project_kinds import (
    DEFAULT_PROJECT_KIND,
    allowed_component_types,
    ensure_project_kind,
    kind_summary,
    normalize_project_kind,
    requires_simulation,
    supports_analog_ic_profile,
    supports_eda_bridge,
    supports_lcsc_binding,
    supports_virtuoso_export,
)
from analog_ic import (
    audit_project as audit_analog_ic_project,
    rewrite_model_paths as rewrite_analog_ic_model_paths,
    validate_profile as validate_analog_ic_profile,
)
from pdk_registry import (
    install_open_pdk,
    load_registry as load_pdk_registry,
    open_pdk_catalog,
    register_installation as register_pdk_installation,
    scan_installation as scan_pdk_installation,
)
from xschem_bridge import (
    headless_validate as validate_xschem_headless,
    link_existing as link_existing_xschem,
    make_binding as make_xschem_binding,
    pull as pull_xschem,
    push as push_xschem,
    validate_binding as validate_xschem_binding,
)
from open_sim_providers import (
    OpenVafProvider,
    XyceProvider,
    compare_simulation_metrics,
    inject_ngspice_osdi,
)
from physical_verification import KLayoutProvider, MagicProvider, NetgenProvider
from execution_profiles import assert_profile_path, resolve_simulation_profile, simulation_profile_id
from verification_contracts import validate_simulation_run, validate_verification_run
from hdl_flow import (
    IcarusProvider,
    OpenRoadProvider,
    YosysProvider,
    load_hdl_manifest,
    run_gate_regression,
    verify_mixed_signal_contract,
)
from stable_ids import ensure_module_stable_ids, ensure_project_stable_ids
from validate_netlist_primitives import validate_netlist_text
from module_hierarchy import (
    connectivity_payload,
    detect_module_cycles,
    emit_x_instance_line,
    formal_subckt_port_node,
    ordered_connectivity_hash,
    safe_format_interpolate,
    spice_name_for_subckt,
    subckt_port_node_map,
)


PROJECT_SCHEMA = "actoviq.project.v2"
MODULE_SCHEMA = "actoviq.module.v2"
LEGACY_PROJECT_SCHEMAS = {"actoviq.project.v1", PROJECT_SCHEMA}
LEGACY_MODULE_SCHEMAS = {"actoviq.module.v1", MODULE_SCHEMA}
COMMAND_SCHEMA = "actoviq.command.v1"
PENDING_COMMAND_SCHEMA = "actoviq.pending-command.v1"
ERC_SCHEMA = "actoviq.erc.v1"
AGENT_PROTOCOL_VERSION = "actoviq.project-agent.v2"
SCHEMATIC_OVERRIDES_SCHEMA = "actoviq.schematic-overrides.v1"
SCHEMATIC_RENDER_MAP_SCHEMA = "actoviq.schematic-render-map.v1"
DEFAULT_MODULE_SIZE = {"width": 360.0, "height": 280.0}
DEFAULT_MODULE_POSITION = {"x": 100.0, "y": 100.0}
# Match renderer Arrange modules grid so auto-placed cards stay readable.
MODULE_LAYOUT_ORIGIN_X = 100.0
MODULE_LAYOUT_ORIGIN_Y = 110.0
MODULE_LAYOUT_DX = 400.0
MODULE_LAYOUT_DY = 340.0
MODULE_LAYOUT_COLUMNS = 3
MODULE_LAYOUT_MARGIN = 24.0
ALLOWED_COMPONENT_TYPES = allowed_component_types("analog_ic")  # union used for CLI help / broad checks
BLOCK_PIN_SIDES = {"left", "right", "top", "bottom"}
EDITABLE_PIN_NAMES = {
    "R": [("a", "1"), ("b", "2")],
    "C": [("a", "1"), ("b", "2")],
    "L": [("a", "1"), ("b", "2")],
    "D": [("a", "A"), ("b", "K")],
    "V": [("p", "+"), ("n", "-")],
    "I": [("p", "+"), ("n", "-")],
    "E": [("p", "OUT+"), ("n", "OUT-"), ("cp", "+"), ("cn", "-")],
    "F": [("p", "OUT+"), ("n", "OUT-")],
    "G": [("p", "OUT+"), ("n", "OUT-"), ("cp", "+"), ("cn", "-")],
    "H": [("p", "OUT+"), ("n", "OUT-")],
    "B": [("p", "+"), ("n", "-")],
    "Q": [("c", "C"), ("b", "B"), ("e", "E")],
    "M": [("d", "D"), ("g", "G"), ("s", "S"), ("b", "B")],
}
EDITABLE_NODE_COUNTS = {
    "R": 2,
    "C": 2,
    "L": 2,
    "D": 2,
    "V": 2,
    "I": 2,
    "E": 4,
    "F": 2,
    "G": 4,
    "H": 2,
    "B": 2,
    "Q": 3,
    "M": 4,
}
# Soft modularity heuristics for desktop readability (non-blocking ERC).
OVERSIZED_MODULE_COMPONENT_LIMIT = 16
MONOLITHIC_COMPLEX_COMPONENT_LIMIT = 8
ACTIVE_COMPONENT_TYPES = frozenset({"V", "I", "M", "Q", "D", "E", "F", "G", "H", "B"})
EDITABLE_TESTBENCH_PREFIXES = ("vtest_", "rload_")

# SPICE control/analysis/measurement directives that a notebook module may
# declare. compile_project hoists these to the top-level system deck (instead of
# treating them as device lines) so DC/transient/active designs can drive the
# system-level simulation, not just the auto-generated AC test bench.
ANALYSIS_DIRECTIVE_PREFIXES = (
    ".ac", ".dc", ".tran", ".op", ".sp", ".noise", ".pz", ".disto",
    ".sens", ".tf", ".four", ".meas", ".measure", ".print", ".plot",
    ".probe", ".save", ".ic", ".nodeset", ".options", ".option",
    ".temp", ".control", ".endc", ".actoviq",
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")[:48]
    return slug or "circuit-project"


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def replace_with_retry(temp_path: Path, target_path: Path) -> None:
    for attempt in range(20):
        try:
            os.replace(temp_path, target_path)
            return
        except PermissionError:
            if attempt == 19:
                raise
            time.sleep(0.02 * (attempt + 1))


def atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    content = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
        delete=False,
    ) as handle:
        handle.write(content)
        temp_path = Path(handle.name)
    replace_with_retry(temp_path, path)


def atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False
    ) as handle:
        handle.write(content)
        temp_path = Path(handle.name)
    replace_with_retry(temp_path, path)


def project_path(root: Path) -> Path:
    return root / "project.circuit.json"


def module_path(root: Path, module_id: str) -> Path:
    return root / "modules" / module_id / "module.circuit.json"


def schematic_overrides_path(root: Path, module_id: str) -> Path:
    return root / "modules" / module_id / "schematic.overrides.json"


def ensure_inside(root: Path, candidate: Path) -> None:
    try:
        candidate.resolve().relative_to(root.resolve())
    except ValueError as exc:
        raise ValueError(f"path escapes project root: {candidate}") from exc


def validate_project(project: dict[str, Any]) -> None:
    if project.get("schema") not in LEGACY_PROJECT_SCHEMAS:
        raise ValueError(f"project schema must be one of {sorted(LEGACY_PROJECT_SCHEMAS)}")
    if not isinstance(project.get("project_id"), str) or not project["project_id"]:
        raise ValueError("project_id is required")
    if not isinstance(project.get("revision"), int) or project["revision"] < 0:
        raise ValueError("project revision must be a non-negative integer")
    kind = ensure_project_kind(project)
    analog_profile = project.get("analog_ic_profile")
    if analog_profile is not None:
        if not supports_analog_ic_profile(kind):
            raise ValueError("analog_ic_profile requires project_kind=analog_ic or mixed_signal_ic")
        profile_errors = validate_analog_ic_profile(analog_profile)
        if profile_errors:
            raise ValueError(profile_errors[0]["message"])
    modules = project.get("modules")
    if not isinstance(modules, list):
        raise ValueError("project modules must be an array")
    module_ids = [entry.get("id") for entry in modules if isinstance(entry, dict)]
    if len(module_ids) != len(set(module_ids)) or any(not value for value in module_ids):
        raise ValueError("module ids must be present and unique")

    port_keys: set[tuple[str, str]] = set()
    for module in modules:
        for port in module.get("ports", []):
            key = (module["id"], port.get("id"))
            if not key[1] or key in port_keys:
                raise ValueError("module port ids must be present and unique")
            port_keys.add(key)
    connection_ids: set[str] = set()
    for connection in project.get("connections", []):
        connection_id = connection.get("id")
        if not connection_id or connection_id in connection_ids:
            raise ValueError("connection ids must be present and unique")
        connection_ids.add(connection_id)
        for endpoint_name in ("from", "to"):
            endpoint = connection.get(endpoint_name, {})
            key = (endpoint.get("module_id"), endpoint.get("port_id"))
            if key not in port_keys:
                raise ValueError(f"connection references unknown port: {key}")


def validate_module(module: dict[str, Any], project_kind: str | None = None) -> None:
    if module.get("schema") not in LEGACY_MODULE_SCHEMAS:
        raise ValueError(f"module schema must be one of {sorted(LEGACY_MODULE_SCHEMAS)}")
    if not isinstance(module.get("module_id"), str) or not module["module_id"]:
        raise ValueError("module_id is required")
    kind = normalize_project_kind(project_kind or DEFAULT_PROJECT_KIND)
    allowed_types = allowed_component_types(kind)
    nets = module.get("nets", [])
    if not isinstance(nets, list):
        raise ValueError("module nets must be an array")
    net_names_by_id: dict[str, set[str]] = {}
    used_net_names: dict[str, str] = {}
    for net in nets:
        if not isinstance(net, dict):
            raise ValueError("module nets must contain objects")
        net_id = net.get("id")
        net_name = net.get("name")
        if not isinstance(net_id, str) or not net_id or net_id in net_names_by_id:
            raise ValueError("net ids must be present and unique")
        if not isinstance(net_name, str) or not net_name:
            raise ValueError(f"net {net_id} must have a name")
        aliases = net.get("aliases", [])
        if not isinstance(aliases, list) or any(not isinstance(alias, str) or not alias for alias in aliases):
            raise ValueError(f"net {net_id} aliases must be non-empty strings")
        names = {net_name, *aliases}
        for name in names:
            previous = used_net_names.get(name)
            if previous is not None and previous != net_id:
                raise ValueError(f"net name or alias {name} belongs to multiple nets")
            used_net_names[name] = net_id
        net_names_by_id[net_id] = names

    def validate_net_reference(owner: str, net_name: Any, net_id: Any, *, required: bool = False) -> None:
        if not isinstance(net_name, str) or not net_name:
            raise ValueError(f"{owner} has no net")
        if net_id is None and not required:
            return
        if not isinstance(net_id, str) or not net_id:
            raise ValueError(f"{owner} has no net_id")
        names = net_names_by_id.get(net_id)
        if names is None:
            raise ValueError(f"{owner} references unknown net_id: {net_id}")
        if net_name not in names:
            raise ValueError(f"{owner} net/name mismatch: {net_name} is not {net_id}")

    component_ids: set[str] = set()
    pin_keys: set[tuple[str, str]] = set()
    pin_networks: dict[tuple[str, str], tuple[str, str | None]] = {}
    for component in module.get("components", []):
        component_id = component.get("id")
        component_type = component.get("type")
        if not component_id or component_id in component_ids:
            raise ValueError("component ids must be present and unique")
        if component_type not in allowed_types:
            raise ValueError(
                f"unsupported component type for project_kind={kind}: {component_type} "
                f"(allowed: {', '.join(sorted(allowed_types))})"
            )
        component_ids.add(component_id)
        pins = component.get("pins", [])
        if not isinstance(pins, list) or not pins:
            raise ValueError(f"component {component_id} must have at least one pin")
        for pin in pins:
            pin_id = pin.get("id")
            key = (component_id, pin_id)
            if not pin_id or key in pin_keys:
                raise ValueError("component pin ids must be present and unique")
            if not isinstance(pin.get("net"), str) or not pin["net"]:
                raise ValueError(f"pin {component_id}.{pin_id} has no net")
            validate_net_reference(
                f"pin {component_id}.{pin_id}",
                pin.get("net"),
                pin.get("net_id"),
            )
            side = pin.get("side")
            if side is not None and side not in BLOCK_PIN_SIDES:
                raise ValueError(f"pin {component_id}.{pin_id} has invalid side: {side}")
            pin_keys.add(key)
            pin_networks[key] = (str(pin["net"]), pin.get("net_id"))
        if component_type == "BLOCK":
            block = component.get("block", {})
            if not isinstance(block, dict):
                raise ValueError(f"block geometry for {component_id} must be an object")
            for dimension in ("width", "height"):
                value = block.get(dimension)
                if value is not None and (not isinstance(value, (int, float)) or value < 40 or value > 1000):
                    raise ValueError(f"block {component_id} {dimension} is outside 40..1000")
    port_ids = [port.get("id") for port in module.get("ports", [])]
    if len(port_ids) != len(set(port_ids)) or any(not value for value in port_ids):
        raise ValueError("module port ids must be present and unique")
    port_networks: dict[str, tuple[str, str | None]] = {}
    for port in module.get("ports", []):
        port_id = str(port["id"])
        validate_net_reference(f"port {port_id}", port.get("net"), port.get("net_id"))
        port_networks[port_id] = (str(port["net"]), port.get("net_id"))

    wires = module.get("wires", [])
    if not isinstance(wires, list):
        raise ValueError("module wires must be an array")
    wire_ids: set[str] = set()
    junctions: dict[str, tuple[float, float, str]] = {}
    wire_segments: list[tuple[tuple[float, float], tuple[float, float], str, str]] = []

    def coordinate(value: Any, owner: str) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            raise ValueError(f"{owner} must be a finite number")
        return float(value)

    def endpoint_network(endpoint: Any, owner: str, wire_net: str, wire_net_id: str) -> tuple[float, float]:
        if not isinstance(endpoint, dict):
            raise ValueError(f"{owner} must be an endpoint object")
        x = coordinate(endpoint.get("x"), f"{owner}.x")
        y = coordinate(endpoint.get("y"), f"{owner}.y")
        component_id = endpoint.get("component_id")
        pin_id = endpoint.get("pin_id")
        port_id = endpoint.get("port_id")
        junction_id = endpoint.get("junction_id")
        has_pin_fields = component_id is not None or pin_id is not None
        identities = int(has_pin_fields) + int(port_id is not None) + int(junction_id is not None)
        if identities != 1:
            raise ValueError(f"{owner} must identify exactly one component pin, port, or junction_id")

        endpoint_net: str
        endpoint_net_id: str | None
        if has_pin_fields:
            if not isinstance(component_id, str) or not component_id:
                raise ValueError(f"{owner} references an invalid component")
            if component_id not in component_ids:
                raise ValueError(f"{owner} references unknown component: {component_id}")
            if not isinstance(pin_id, str) or not pin_id:
                raise ValueError(f"{owner} references an invalid pin")
            network = pin_networks.get((component_id, pin_id))
            if network is None:
                raise ValueError(f"{owner} references unknown pin: {component_id}.{pin_id}")
            endpoint_net, endpoint_net_id = network
        elif port_id is not None:
            if not isinstance(port_id, str) or not port_id or port_id not in port_networks:
                raise ValueError(f"{owner} references unknown port: {port_id}")
            endpoint_net, endpoint_net_id = port_networks[port_id]
        else:
            if not isinstance(junction_id, str) or not junction_id:
                raise ValueError(f"{owner} has an invalid junction_id")
            previous = junctions.get(junction_id)
            if previous is not None:
                previous_x, previous_y, previous_net_id = previous
                if x != previous_x or y != previous_y:
                    raise ValueError(f"junction {junction_id} is used at multiple coordinates")
                if wire_net_id != previous_net_id:
                    raise ValueError(f"junction {junction_id} is used by inconsistent networks")
            else:
                junctions[junction_id] = (x, y, wire_net_id)
            endpoint_net, endpoint_net_id = wire_net, wire_net_id

        if endpoint_net_id is not None and endpoint_net_id != wire_net_id:
            raise ValueError(f"{owner} network does not match wire network {wire_net_id}")
        endpoint_names = net_names_by_id.get(wire_net_id, set())
        if endpoint_net not in endpoint_names or wire_net not in endpoint_names:
            raise ValueError(f"{owner} network does not match wire net/name")
        return x, y

    for wire in wires:
        if not isinstance(wire, dict):
            raise ValueError("module wires must contain objects")
        wire_id = wire.get("id")
        if not isinstance(wire_id, str) or not wire_id or wire_id in wire_ids:
            raise ValueError("wire ids must be present and unique")
        wire_ids.add(wire_id)
        wire_net = wire.get("net")
        wire_net_id = wire.get("net_id")
        validate_net_reference(f"wire {wire_id}", wire_net, wire_net_id, required=True)
        points = wire.get("points")
        if not isinstance(points, list) or len(points) < 2:
            raise ValueError(f"wire {wire_id} must have at least two points")
        normalized_points: list[tuple[float, float]] = []
        for index, point in enumerate(points):
            if not isinstance(point, dict):
                raise ValueError(f"wire {wire_id} point {index} must be an object")
            normalized_points.append((
                coordinate(point.get("x"), f"wire {wire_id} point {index}.x"),
                coordinate(point.get("y"), f"wire {wire_id} point {index}.y"),
            ))
        for index, (start, end) in enumerate(zip(normalized_points, normalized_points[1:])):
            if start == end:
                raise ValueError(f"wire {wire_id} has a zero-length segment at {index}")
            if start[0] != end[0] and start[1] != end[1]:
                raise ValueError(f"wire {wire_id} has a non-orthogonal segment at {index}")
            wire_segments.append((start, end, str(wire_id), str(wire_net_id)))
        start_endpoint = endpoint_network(wire.get("from"), f"wire {wire_id}.from", str(wire_net), str(wire_net_id))
        end_endpoint = endpoint_network(wire.get("to"), f"wire {wire_id}.to", str(wire_net), str(wire_net_id))
        if normalized_points[0] != start_endpoint:
            raise ValueError(f"wire {wire_id} first point does not match from endpoint")
        if normalized_points[-1] != end_endpoint:
            raise ValueError(f"wire {wire_id} last point does not match to endpoint")

    def different_net_contact(
        left: tuple[tuple[float, float], tuple[float, float], str, str],
        right: tuple[tuple[float, float], tuple[float, float], str, str],
    ) -> str | None:
        (a, b, _, left_net), (c, d, _, right_net) = left, right
        if left_net == right_net:
            return None
        left_vertical = a[0] == b[0]
        right_vertical = c[0] == d[0]
        if left_vertical == right_vertical:
            same_axis = a[0] == c[0] if left_vertical else a[1] == c[1]
            if not same_axis:
                return None
            left_interval = sorted((a[1], b[1])) if left_vertical else sorted((a[0], b[0]))
            right_interval = sorted((c[1], d[1])) if right_vertical else sorted((c[0], d[0]))
            lower = max(left_interval[0], right_interval[0])
            upper = min(left_interval[1], right_interval[1])
            if lower > upper:
                return None
            return "collinear overlap" if lower < upper else "shared endpoint"
        vertical_start, vertical_end, horizontal_start, horizontal_end = (a, b, c, d) if left_vertical else (c, d, a, b)
        x, y = vertical_start[0], horizontal_start[1]
        vertical_range = sorted((vertical_start[1], vertical_end[1]))
        horizontal_range = sorted((horizontal_start[0], horizontal_end[0]))
        if not (vertical_range[0] <= y <= vertical_range[1] and horizontal_range[0] <= x <= horizontal_range[1]):
            return None
        if vertical_range[0] < y < vertical_range[1] and horizontal_range[0] < x < horizontal_range[1]:
            return None
        return "endpoint on foreign segment"

    for index, left in enumerate(wire_segments):
        for right in wire_segments[index + 1:]:
            contact = different_net_contact(left, right)
            if contact:
                raise ValueError(
                    f"wires {left[2]} and {right[2]} form a different-net {contact} "
                    f"between {left[3]} and {right[3]}"
                )


def stable_net_token(value: str) -> str:
    token = re.sub(r"[^A-Za-z0-9_]+", "_", value).strip("_") or "net"
    return f"net_{token}"


def upgrade_module_document(
    module: dict[str, Any],
    *,
    repair_legacy_wire_endpoints: bool = False,
    repair_invalid_net_ids: bool = False,
) -> dict[str, Any]:
    existing = {
        str(net.get("id")): dict(net)
        for net in module.get("nets", [])
        if isinstance(net, dict) and net.get("id") and net.get("name")
    }
    by_name: dict[str, str] = {}
    for net_id, net in existing.items():
        by_name[str(net["name"])] = net_id
        for alias in net.get("aliases", []):
            by_name[str(alias)] = net_id

    def ensure_net(name: str, current_id: Any = None, kind: str = "signal") -> str:
        if current_id:
            normalized_id = str(current_id)
            if normalized_id in existing:
                return normalized_id
            if not repair_invalid_net_ids:
                return normalized_id
        if name in by_name:
            return by_name[name]
        base = stable_net_token(name)
        net_id = base
        suffix = 2
        while net_id in existing:
            net_id = f"{base}_{suffix}"
            suffix += 1
        existing[net_id] = {
            "id": net_id,
            "name": name,
            "kind": "ground" if name == "0" else kind,
            "aliases": [],
        }
        by_name[name] = net_id
        return net_id

    for component in module.get("components", []):
        for pin in component.get("pins", []):
            pin["net_id"] = ensure_net(str(pin.get("net", "")), pin.get("net_id"))
    for port in module.get("ports", []):
        net_id = ensure_net(str(port.get("net", "")), port.get("net_id"), str(port.get("signal_type", "signal")))
        port["net_id"] = net_id
        if existing[net_id].get("kind") in (None, "signal"):
            existing[net_id]["kind"] = port.get("signal_type", "signal")
    for wire in module.get("wires", []):
        wire["net_id"] = ensure_net(str(wire.get("net") or f"n_{wire.get('id', 'wire')}"), wire.get("net_id"))
        if not repair_legacy_wire_endpoints:
            continue
        for endpoint_name in ("from", "to"):
            endpoint = wire.get(endpoint_name)
            if not isinstance(endpoint, dict):
                continue
            if any(endpoint.get(key) for key in ("component_id", "pin_id", "port_id", "junction_id")):
                continue
            x = endpoint.get("x")
            y = endpoint.get("y")
            if isinstance(x, bool) or isinstance(y, bool) or not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
                continue
            payload = "|".join((
                str(wire["net_id"]),
                format(float(x), ".12g"),
                format(float(y), ".12g"),
            ))
            endpoint["junction_id"] = f"j_{hashlib.sha256(payload.encode('utf-8')).hexdigest()[:16]}"
    module["schema"] = MODULE_SCHEMA
    module["nets"] = list(existing.values())
    return module


def default_schematic_overrides(project: dict[str, Any], module_id: str) -> dict[str, Any]:
    return {
        "schema": SCHEMATIC_OVERRIDES_SCHEMA,
        "project_id": project["project_id"],
        "module_id": module_id,
        "updated_at": utc_now(),
        "items": {},
    }


def read_schematic_overrides(root: Path, project: dict[str, Any], module_id: str) -> dict[str, Any]:
    path = schematic_overrides_path(root, module_id)
    if not path.exists():
        return default_schematic_overrides(project, module_id)
    overrides = read_json(path)
    if overrides.get("schema") != SCHEMATIC_OVERRIDES_SCHEMA:
        raise ValueError(f"schematic overrides schema must be {SCHEMATIC_OVERRIDES_SCHEMA}")
    if overrides.get("module_id") != module_id:
        raise ValueError(f"schematic overrides module mismatch: {module_id}")
    if not isinstance(overrides.get("items"), dict):
        raise ValueError("schematic overrides items must be an object")
    return overrides


def normalize_schematic_overrides(
    project: dict[str, Any],
    module_id: str,
    value: dict[str, Any],
) -> dict[str, Any]:
    if value.get("schema") != SCHEMATIC_OVERRIDES_SCHEMA:
        raise ValueError(f"schematic overrides schema must be {SCHEMATIC_OVERRIDES_SCHEMA}")
    source_module_id = str(value.get("module_id") or "")
    if source_module_id and source_module_id != module_id:
        raise ValueError(
            f"schematic overrides module mismatch: expected {module_id}, got {source_module_id}"
        )
    raw_items = value.get("items")
    if not isinstance(raw_items, dict):
        raise ValueError("schematic overrides items must be an object")
    items: dict[str, dict[str, Any]] = {}
    for raw_id, raw_item in raw_items.items():
        item_id = normalize_schematic_item_id(raw_id)
        if not isinstance(raw_item, dict):
            raise ValueError(f"schematic override {item_id} must be an object")
        items[item_id] = {
            "x": schematic_position(raw_item.get("x"), f"{item_id}.x"),
            "y": schematic_position(raw_item.get("y"), f"{item_id}.y"),
            "locked": bool(raw_item.get("locked", True)),
        }
    return {
        "schema": SCHEMATIC_OVERRIDES_SCHEMA,
        "project_id": project["project_id"],
        "module_id": module_id,
        "updated_at": utc_now(),
        "items": items,
    }


def schematic_overrides_migration_report(
    root: Path,
    project: dict[str, Any],
    module: dict[str, Any],
    overrides: dict[str, Any],
) -> dict[str, Any]:
    module_id = str(module["module_id"])
    component_keys: dict[str, str] = {}
    for component in module.get("components", []) or []:
        component_id = str(component.get("id") or "")
        for candidate in (
            component_id,
            str(component.get("name") or ""),
            compiled_component_name(module_id, component),
        ):
            if candidate:
                component_keys[candidate.casefold()] = component_id
    mapped: list[dict[str, Any]] = []
    unmapped: list[dict[str, Any]] = []
    for item_id, position in sorted((overrides.get("items") or {}).items()):
        component_id = component_keys.get(str(item_id).casefold())
        item = {
            "item_id": item_id,
            "position": {
                "x": float(position["x"]),
                "y": float(position["y"]),
            },
        }
        if component_id:
            mapped.append({
                **item,
                "component_id": component_id,
                "automatic_apply": False,
                "reason": "netlistsvg and editable-model coordinates require visual review",
            })
        else:
            unmapped.append({
                **item,
                "reason": "no canonical module component matches this legacy renderer id",
            })
    item_count = len(mapped) + len(unmapped)
    status = (
        "no_overrides"
        if item_count == 0
        else "review_required"
        if unmapped or mapped
        else "fully_mappable"
    )
    report = {
        "schema": "actoviq.schematic-overrides-migration-report.v1",
        "project_id": project["project_id"],
        "module_id": module_id,
        "module_revision": int(module.get("revision") or 0),
        "connectivity_hash": ordered_connectivity_hash(module),
        "status": status,
        "canonical_source": f"modules/{module_id}/module.circuit.json",
        "compatibility_source": f"modules/{module_id}/schematic.overrides.json",
        "compatibility_only": True,
        "module_was_modified": False,
        "summary": {
            "override_count": item_count,
            "mapped_count": len(mapped),
            "unmapped_count": len(unmapped),
        },
        "mapped": mapped,
        "unmapped": unmapped,
        "recommendation": (
            "Reposition mapped components in Editable model, verify connectivity, then remove "
            "the compatibility overrides after visual review."
        ),
    }
    report_path = root / "build" / "modules" / module_id / "schematic-overrides-migration-report.json"
    atomic_write_json(report_path, report)
    return {**report, "report_path": str(report_path)}


def export_schematic_overrides(root: Path, module_id: str, output_path: Path) -> dict[str, Any]:
    project, modules = load_project(root)
    if module_id not in modules:
        raise ValueError(f"unknown module: {module_id}")
    overrides = read_schematic_overrides(root, project, module_id)
    atomic_write_json(output_path.resolve(), overrides)
    report = schematic_overrides_migration_report(root, project, modules[module_id], overrides)
    return {
        "ok": True,
        "output_path": str(output_path.resolve()),
        "override_count": len(overrides["items"]),
        "migration_report": report,
    }


def import_schematic_overrides(root: Path, module_id: str, input_path: Path) -> dict[str, Any]:
    project, modules = load_project(root)
    if module_id not in modules:
        raise ValueError(f"unknown module: {module_id}")
    overrides = normalize_schematic_overrides(project, module_id, read_json(input_path.resolve()))
    atomic_write_json(schematic_overrides_path(root, module_id), overrides)
    report = schematic_overrides_migration_report(root, project, modules[module_id], overrides)
    return {
        "ok": True,
        "input_path": str(input_path.resolve()),
        "override_count": len(overrides["items"]),
        "migration_report": report,
    }


def normalize_schematic_item_id(value: Any) -> str:
    item_id = str(value or "").strip()
    if not re.match(r"^[A-Za-z0-9_.$:-]+$", item_id):
        raise ValueError(f"invalid schematic item id: {item_id}")
    return item_id


def schematic_position(value: Any, name: str) -> float:
    number = float(value)
    if number < -10000 or number > 10000:
        raise ValueError(f"{name} is outside the editable schematic range")
    return round(number, 3)


def load_project(root: Path) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    project = read_json(project_path(root))
    migrated_kind = "project_kind" not in project
    ensure_project_kind(project)
    validate_project(project)
    kind = project["project_kind"]
    modules: dict[str, dict[str, Any]] = {}
    migrated_stable = False
    for module_ref in project["modules"]:
        path = module_path(root, module_ref["id"])
        ensure_inside(root, path)
        source_module = read_json(path)
        if source_module.get("schema") not in LEGACY_MODULE_SCHEMAS:
            raise ValueError(f"module schema must be one of {sorted(LEGACY_MODULE_SCHEMAS)}")
        module = upgrade_module_document(
            source_module,
            repair_legacy_wire_endpoints=True,
            repair_invalid_net_ids=True,
        )
        before = json.dumps(module, sort_keys=True, ensure_ascii=False)
        ensure_module_stable_ids(module)
        if json.dumps(module, sort_keys=True, ensure_ascii=False) != before:
            migrated_stable = True
            atomic_write_json(path, module)
        validate_module(module, kind)
        if module["module_id"] != module_ref["id"]:
            raise ValueError(f"module id mismatch: {module_ref['id']}")
        modules[module_ref["id"]] = module
        module_ref["ports"] = modules[module_ref["id"]].get("ports", [])
    project["schema"] = PROJECT_SCHEMA
    ensure_project_stable_ids(project, modules)
    if migrated_kind or migrated_stable or not project.get("stable_id"):
        atomic_write_json(project_path(root), project)
    return project, modules


def make_port(port_id: str, name: str, direction: str, signal_type: str, net: str) -> dict[str, Any]:
    return {
        "id": port_id,
        "name": name,
        "direction": direction,
        "signal_type": signal_type,
        "net": net,
    }


def make_component(
    component_id: str,
    component_type: str,
    name: str,
    value: str,
    x: int,
    y: int,
    pins: list[tuple[str, str, str]],
) -> dict[str, Any]:
    return {
        "id": component_id,
        "type": component_type,
        "name": name,
        "value": value,
        "position": {"x": x, "y": y},
        "rotation": 0,
        "pins": [{"id": pin_id, "name": pin_name, "net": net} for pin_id, pin_name, net in pins],
    }


def demo_modules() -> list[tuple[dict[str, Any], dict[str, Any]]]:
    power_ports = [
        make_port("signal_out", "Signal", "output", "analog", "signal"),
        make_port("vdd", "VDD", "output", "power", "vdd"),
        make_port("gnd", "GND", "bidirectional", "ground", "0"),
    ]
    power = {
        "schema": MODULE_SCHEMA,
        "module_id": "power",
        "name": "Power and stimulus",
        "revision": 0,
        "ports": power_ports,
        "components": [
            make_component("v_signal", "V", "Vsignal", "DC 0 AC 1", 120, 120, [
                ("p", "+", "signal"), ("n", "-", "0"),
            ]),
            make_component("v_supply", "V", "VDD", "DC 5", 120, 260, [
                ("p", "+", "vdd"), ("n", "-", "0"),
            ]),
        ],
        "wires": [],
        "annotations": [],
    }
    power_ref = {
        "id": "power",
        "name": power["name"],
        "kind": "power",
        "function": "Provides the AC stimulus and the shared 5 V supply for the signal chain.",
        "parameters": {
            "Supply": "5 V",
            "Stimulus": "AC 1 V",
        },
        "notes": "",
        "preview_enabled": True,
        "source": "modules/power/module.circuit.json",
        "position": {"x": 100, "y": 120},
        "size": {"width": 320, "height": 250},
        "ports": power_ports,
    }

    amplifier_ports = [
        make_port("input", "IN", "input", "analog", "in"),
        make_port("vdd", "VDD", "input", "power", "vdd"),
        make_port("output", "OUT", "output", "analog", "out"),
        make_port("gnd", "GND", "bidirectional", "ground", "0"),
    ]
    amplifier = {
        "schema": MODULE_SCHEMA,
        "module_id": "amplifier",
        "name": "Passive gain stage",
        "revision": 0,
        "ports": amplifier_ports,
        "components": [
            make_component("r_series", "R", "Rseries", "1k", 60, 120, [
                ("a", "1", "in"), ("b", "2", "out"),
            ]),
            make_component("r_bias", "R", "Rbias", "10k", 210, 220, [
                ("a", "1", "out"), ("b", "2", "0"),
            ]),
        ],
        "wires": [],
        "annotations": [],
    }
    amplifier_ref = {
        "id": "amplifier",
        "name": amplifier["name"],
        "kind": "amplifier",
        "function": "Sets the inter-stage impedance and provides passive signal conditioning.",
        "parameters": {
            "Series resistance": "1 kohm",
            "Bias resistance": "10 kohm",
        },
        "notes": "",
        "preview_enabled": False,
        "source": "modules/amplifier/module.circuit.json",
        "position": {"x": 500, "y": 300},
        "size": {"width": 320, "height": 250},
        "ports": amplifier_ports,
    }

    filter_ports = [
        make_port("input", "IN", "input", "analog", "in"),
        make_port("vdd", "VDD", "input", "power", "vdd"),
        make_port("output", "OUT", "output", "analog", "out"),
        make_port("gnd", "GND", "bidirectional", "ground", "0"),
    ]
    filter_module = {
        "schema": MODULE_SCHEMA,
        "module_id": "filter",
        "name": "RC low-pass filter",
        "revision": 0,
        "ports": filter_ports,
        "components": [
            make_component("r_filter", "R", "Rfilter", "10k", 60, 120, [
                ("a", "1", "in"), ("b", "2", "out"),
            ]),
            make_component("c_filter", "C", "Cfilter", "15.9n", 210, 220, [
                ("a", "1", "out"), ("b", "2", "0"),
            ]),
        ],
        "wires": [],
        "annotations": [],
    }
    filter_ref = {
        "id": "filter",
        "name": filter_module["name"],
        "kind": "filter",
        "function": "Attenuates high-frequency content with a first-order RC low-pass response.",
        "parameters": {
            "Resistance": "10 kohm",
            "Capacitance": "15.9 nF",
            "Target cutoff": "about 1 kHz",
        },
        "notes": "",
        "preview_enabled": True,
        "source": "modules/filter/module.circuit.json",
        "position": {"x": 900, "y": 120},
        "size": {"width": 320, "height": 250},
        "ports": filter_ports,
    }
    return [(power_ref, power), (amplifier_ref, amplifier), (filter_ref, filter_module)]


def initialize_project(
    projects_root: Path,
    name: str,
    project_id: str | None,
    demo: bool,
    project_kind: str = DEFAULT_PROJECT_KIND,
) -> Path:
    base_id = slugify(project_id or name)
    kind = normalize_project_kind(project_kind)
    selected_id = base_id
    suffix = 2
    while (projects_root / selected_id).exists():
        selected_id = f"{base_id}-{suffix}"
        suffix += 1
    root = projects_root / selected_id
    (root / "modules").mkdir(parents=True, exist_ok=False)
    for directory in ("commands/pending", "commands/applied", "commands/rejected", "revisions", "build", "logs"):
        (root / directory).mkdir(parents=True, exist_ok=True)

    module_pairs = demo_modules() if demo else []
    now = utc_now()
    project = {
        "schema": PROJECT_SCHEMA,
        "project_id": selected_id,
        "name": name.strip() or selected_id,
        "project_kind": kind,
        "revision": 0,
        "created_at": now,
        "updated_at": now,
        "modules": [pair[0] for pair in module_pairs],
        "connections": [],
        "analyses": {
            "ac": {"enabled": True, "start_hz": 10, "stop_hz": 1_000_000, "points_per_decade": 20},
        },
    }
    if demo:
        project["connections"] = [
            {
                "id": "signal-to-amplifier",
                "from": {"module_id": "power", "port_id": "signal_out"},
                "to": {"module_id": "amplifier", "port_id": "input"},
                "network": "SIGNAL",
            },
            {
                "id": "amplifier-to-filter",
                "from": {"module_id": "amplifier", "port_id": "output"},
                "to": {"module_id": "filter", "port_id": "input"},
                "network": "AMP_OUT",
            },
            {
                "id": "vdd-power-amplifier",
                "from": {"module_id": "power", "port_id": "vdd"},
                "to": {"module_id": "amplifier", "port_id": "vdd"},
                "network": "VDD",
            },
            {
                "id": "vdd-power-filter",
                "from": {"module_id": "power", "port_id": "vdd"},
                "to": {"module_id": "filter", "port_id": "vdd"},
                "network": "VDD",
            },
            {
                "id": "ground-power-amplifier",
                "from": {"module_id": "power", "port_id": "gnd"},
                "to": {"module_id": "amplifier", "port_id": "gnd"},
                "network": "GND",
            },
            {
                "id": "ground-power-filter",
                "from": {"module_id": "power", "port_id": "gnd"},
                "to": {"module_id": "filter", "port_id": "gnd"},
                "network": "GND",
            },
        ]
    modules_by_id = {module["module_id"]: module for _, module in module_pairs}
    for module in modules_by_id.values():
        ensure_module_stable_ids(module)
    ensure_project_stable_ids(project, modules_by_id)
    validate_project(project)
    atomic_write_json(project_path(root), project)
    atomic_write_json(root / "project.settings.json", {"schema": "actoviq.project-settings.v1"})
    for module_ref, module in module_pairs:
        validate_module(module, kind)
        atomic_write_json(module_path(root, module_ref["id"]), module)
    return root


def snapshot_revision(root: Path, project: dict[str, Any], modules: dict[str, dict[str, Any]], command: dict[str, Any]) -> Path:
    next_revision = project["revision"] + 1
    revision_root = root / "revisions" / f"{next_revision:06d}"
    snapshot_root = revision_root / "snapshot"
    atomic_write_json(snapshot_root / "project.circuit.json", project)
    for module_id, module in modules.items():
        atomic_write_json(snapshot_root / "modules" / module_id / "module.circuit.json", module)
        notebook_path = root / "modules" / module_id / "netlist-notebook.md"
        if notebook_path.exists():
            atomic_write_text(
                snapshot_root / "modules" / module_id / "netlist-notebook.md",
                notebook_path.read_text(encoding="utf-8"),
            )
        overrides_path = schematic_overrides_path(root, module_id)
        if overrides_path.exists():
            atomic_write_json(
                snapshot_root / "modules" / module_id / "schematic.overrides.json",
                read_json(overrides_path),
            )
    atomic_write_json(revision_root / "command.json", command)
    # M2-05: derive an operation summary and affected-entity list from the
    # command so revision history can show what each revision changed without
    # callers parsing the full command. Works for both v1 and v2 commands.
    operations = command.get("operations", [])
    operation_summary: dict[str, int] = {}
    affected_entities: list[str] = []
    for op in operations:
        op_name = op.get("op", "unknown")
        operation_summary[op_name] = operation_summary.get(op_name, 0) + 1
        for key in ("component_id", "wire_id", "module_id", "junction_id"):
            value = op.get(key)
            if isinstance(value, str):
                affected_entities.append(value)
        for key in ("entity_ids", "wire_ids"):
            for value in op.get(key, []) or []:
                if isinstance(value, str):
                    affected_entities.append(value)
        component = op.get("component")
        if isinstance(component, dict) and isinstance(component.get("id"), str):
            affected_entities.append(component["id"])
    atomic_write_json(revision_root / "metadata.json", {
        "schema": "actoviq.revision.v1",
        "revision": next_revision,
        "base_revision": project["revision"],
        "actor": command.get("actor", "unknown"),
        "message": command.get("message", ""),
        "created_at": utc_now(),
        "operation_summary": operation_summary,
        "affected_entities": sorted(set(affected_entities)),
        "command_schema": command.get("schema", "actoviq.command.v1"),
    })
    return revision_root


def write_revision_result(
    revision_root: Path,
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]],
    notebook_writes: dict[str, str | None] | None = None,
) -> None:
    result_root = revision_root / "result"
    atomic_write_json(result_root / "project.circuit.json", project)
    digest = hashlib.sha256(json.dumps(project, ensure_ascii=False, sort_keys=True).encode("utf-8"))
    project_root = revision_root.parent.parent
    for module_id, module in sorted(modules.items()):
        atomic_write_json(result_root / "modules" / module_id / "module.circuit.json", module)
        digest.update(json.dumps(module, ensure_ascii=False, sort_keys=True).encode("utf-8"))
        notebook = (notebook_writes or {}).get(module_id)
        if module_id not in (notebook_writes or {}):
            current_notebook = project_root / "modules" / module_id / "netlist-notebook.md"
            if current_notebook.exists():
                notebook = current_notebook.read_text(encoding="utf-8")
        if notebook is not None:
            atomic_write_text(result_root / "modules" / module_id / "netlist-notebook.md", notebook)
            digest.update(notebook.encode("utf-8"))
        current_overrides = schematic_overrides_path(project_root, module_id)
        if current_overrides.exists():
            overrides = read_json(current_overrides)
            atomic_write_json(result_root / "modules" / module_id / "schematic.overrides.json", overrides)
            digest.update(json.dumps(overrides, ensure_ascii=False, sort_keys=True).encode("utf-8"))
    metadata_path = revision_root / "metadata.json"
    metadata = read_json(metadata_path)
    metadata["schema"] = "actoviq.revision.v2"
    metadata["document_hash"] = digest.hexdigest()
    metadata["result_snapshot"] = "result/"
    atomic_write_json(metadata_path, metadata)


def project_document_hash(project: dict[str, Any], modules: dict[str, dict[str, Any]]) -> str:
    digest = hashlib.sha256(json.dumps(project, ensure_ascii=False, sort_keys=True).encode("utf-8"))
    for module_id, module in sorted(modules.items()):
        digest.update(module_id.encode("utf-8"))
        digest.update(json.dumps(module, ensure_ascii=False, sort_keys=True).encode("utf-8"))
    return digest.hexdigest()


def erc_diagnostic(
    diagnostics: list[dict[str, Any]],
    severity: str,
    code: str,
    message: str,
    **location: Any,
) -> None:
    target = ".".join(
        str(location[key]) for key in ("module_id", "component_id", "pin_id", "port_id")
        if location.get(key)
    ) or "project"
    diagnostics.append({
        "id": f"{code}:{target}",
        "severity": severity,
        "code": code,
        "message": message,
        **{key: value for key, value in location.items() if value is not None},
    })


def component_model_name(component: dict[str, Any]) -> str:
    component_type = str(component.get("type", "")).upper()
    raw = str((component.get("spice") or {}).get("raw", "")).strip()
    tokens = raw.split()
    token_index = {"D": 3, "Q": 4, "M": 5}.get(component_type)
    if token_index is not None and len(tokens) > token_index:
        return tokens[token_index]
    value = str(component.get("value", "")).strip()
    return value.split()[0] if value else ""


def module_spice_text(module: dict[str, Any], *, device_catalog: dict[str, Any] | None = None) -> str:
    spice = module.get("spice") or {}
    source = str(spice.get("source", "")).strip()
    if source:
        return source
    lines: list[str] = []
    for component in module.get("components", []):
        if component.get("type") in {"BLOCK", "GND", "MODULE"}:
            continue
        line = emit_leaf_component_line(component, device_catalog=device_catalog)
        if line:
            lines.append(line)
    lines.extend(str(line) for line in spice.get("models", []))
    lines.extend(str(line) for line in spice.get("directives", []))
    lines.extend(str(line) for line in spice.get("opaque", []))
    return "\n".join(lines)


def project_composition(project: dict[str, Any]) -> dict[str, Any]:
    composition = project.get("composition") if isinstance(project.get("composition"), dict) else {}
    mode = str(composition.get("mode") or "flat").strip().casefold()
    if mode not in {"flat", "hierarchical"}:
        mode = "flat"
    top = str(composition.get("top_module_id") or "").strip()
    return {"mode": mode, "top_module_id": top or None}


def resolve_project_device_catalog(project: dict[str, Any]) -> dict[str, Any] | None:
    profile = project.get("analog_ic_profile") if isinstance(project.get("analog_ic_profile"), dict) else {}
    binding = profile.get("pdk_binding") if isinstance(profile.get("pdk_binding"), dict) else {}
    logical_id = str(binding.get("logical_id") or binding.get("pdk_ref") or "").strip()
    if not logical_id:
        return None
    try:
        registry = load_pdk_registry()
    except Exception:
        return None
    for installation in registry.get("installations", []) or []:
        if str(installation.get("logical_id") or "") == logical_id:
            catalog = installation.get("device_catalog")
            return catalog if isinstance(catalog, dict) else None
    return None


def _parse_spice_scalar(value: Any) -> float | None:
    match = re.fullmatch(
        r"\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*([a-zA-Z]+)?\s*",
        str(value if value is not None else ""),
        flags=re.IGNORECASE,
    )
    if not match:
        return None
    scales = {
        "": 1.0,
        "f": 1e-15,
        "p": 1e-12,
        "n": 1e-9,
        "u": 1e-6,
        "m": 1e-3,
        "k": 1e3,
        "meg": 1e6,
        "g": 1e9,
        "t": 1e12,
    }
    suffix = str(match.group(2) or "").casefold()
    if suffix not in scales:
        return None
    return float(match.group(1)) * scales[suffix]


def _pin_net_lookup(component: dict[str, Any]) -> dict[str, str]:
    lookup: dict[str, str] = {}
    for pin in component.get("pins", []) or []:
        pin_id = str(pin.get("id") or "").strip()
        pin_name = str(pin.get("name") or "").strip()
        net = str(pin.get("net") or "").strip()
        if pin_id:
            lookup[pin_id] = net
            lookup[pin_id.casefold()] = net
        if pin_name:
            lookup[pin_name] = net
            lookup[pin_name.casefold()] = net
    return lookup


def emit_leaf_component_line(
    component: dict[str, Any],
    *,
    device_catalog: dict[str, Any] | None = None,
    node_map: dict[str, str] | None = None,
    compiled_name: str | None = None,
    compiled_value: str | None = None,
) -> str:
    """Emit one primitive SPICE line, optionally via controlled catalog format."""
    component_type = str(component.get("type") or "").upper()
    if component_type in {"BLOCK", "GND", "MODULE"}:
        return ""
    name = compiled_name or str(component.get("name") or component.get("id") or "X")
    value = compiled_value if compiled_value is not None else str(component.get("value") or "")
    pin_lookup = _pin_net_lookup(component)

    def mapped_net(raw: str) -> str:
        raw = str(raw or "")
        if node_map is None:
            return raw
        if raw in node_map:
            return node_map[raw]
        folded = raw.casefold()
        for key, mapped in node_map.items():
            if str(key).casefold() == folded:
                return mapped
        return raw

    catalog_devices = {
        str(device.get("device_id") or "").casefold(): device
        for device in (device_catalog or {}).get("devices", []) or []
    }
    parameters = component.get("parameters") if isinstance(component.get("parameters"), dict) else {}
    device_key = str(parameters.get("device_id") or "").strip() or component_type
    device = catalog_devices.get(device_key.casefold())
    if device is None and device_key.casefold() != component_type.casefold():
        device = catalog_devices.get(component_type.casefold())
    spice_meta = (device or {}).get("spice") if isinstance(device, dict) else None
    if isinstance(spice_meta, dict) and spice_meta.get("format") and spice_meta.get("pin_order"):
        values: dict[str, str] = {
            "name": name,
            "model": str(
                parameters.get("model")
                or spice_meta.get("model")
                or (value.split()[0] if value else component_type)
            ),
        }
        # Prefer structured parameters, then parse key=value tokens from value.
        for key in ("w", "l", "m", "nf"):
            if parameters.get(key):
                values[key] = str(parameters[key]).strip()
                values[key.upper()] = values[key]
        for token in value.replace(",", " ").split():
            if "=" in token:
                key, raw_value = token.split("=", 1)
                folded = key.strip().casefold()
                if folded not in values:
                    values[folded] = raw_value.strip()
                    values[key.strip()] = raw_value.strip()
        for pin_name in spice_meta.get("pin_order", []):
            key = str(pin_name)
            net = pin_lookup.get(key) or pin_lookup.get(key.casefold()) or "0"
            values[key] = mapped_net(net)
            values[key.casefold()] = values[key]
        if "model" not in values or not values["model"]:
            values["model"] = str(spice_meta.get("model") or "model")
        return safe_format_interpolate(str(spice_meta["format"]), values)

    nodes = [mapped_net(str(pin.get("net") or "")) for pin in component.get("pins", []) or []]
    return " ".join([name, *nodes, value]).strip()


def collect_module_models(module: dict[str, Any]) -> list[str]:
    spice = module.get("spice") if isinstance(module.get("spice"), dict) else {}
    models = [str(line).strip() for line in spice.get("models", []) or [] if str(line).strip()]
    return models


def emit_module_subckt(
    module_id: str,
    module: dict[str, Any],
    modules: dict[str, dict[str, Any]],
    *,
    device_catalog: dict[str, Any] | None = None,
    emitted: set[str] | None = None,
    unknown_policy: str = "error",
) -> list[str]:
    """Emit .subckt definitions depth-first; each module id emitted once."""
    emitted = emitted if emitted is not None else set()
    subckt_name = spice_name_for_subckt(module_id)
    if subckt_name in emitted:
        return []
    # Emit children first.
    lines: list[str] = []
    for component in module.get("components", []) or []:
        if str(component.get("type") or "").upper() != "MODULE":
            continue
        child_id = str((component.get("module_ref") or {}).get("module_id") or "").strip()
        if not child_id:
            raise ValueError(f"MODULE instance {component.get('id')} missing module_ref.module_id")
        if child_id not in modules:
            raise ValueError(f"MODULE instance references unknown module: {child_id}")
        lines.extend(
            emit_module_subckt(
                child_id,
                modules[child_id],
                modules,
                device_catalog=device_catalog,
                emitted=emitted,
                unknown_policy=unknown_policy,
            )
        )

    cycle = detect_module_cycles(modules, start_module_id=module_id)
    if cycle:
        raise ValueError(f"MODULE hierarchy cycle detected: {' -> '.join(cycle)}")

    emitted.add(subckt_name)
    ports = module.get("ports", []) or []
    port_names = [formal_subckt_port_node(port) for port in ports]
    node_map = subckt_port_node_map(ports)
    param_defs = module.get("parameter_defs", []) or []
    param_tokens = []
    for item in param_defs:
        key = str(item.get("id") or "").strip()
        default = str(item.get("default") or "").strip()
        if key and default:
            param_tokens.append(f"{key}={default}")
    header = f".subckt {subckt_name} {' '.join(port_names)}".rstrip()
    if param_tokens:
        header = f"{header} {' '.join(param_tokens)}"
    body: list[str] = [header]
    for component in module.get("components", []) or []:
        component_type = str(component.get("type") or "").upper()
        if component_type == "GND":
            continue
        if component_type == "BLOCK":
            body.append(
                f"* BLOCK {component.get('name')}: {component.get('value', '')}"
            )
            continue
        if component_type == "MODULE":
            child_id = str((component.get("module_ref") or {}).get("module_id") or "").strip()
            child = modules[child_id]
            body.append(
                emit_x_instance_line(
                    component,
                    child,
                    node_map=node_map or None,
                    unknown_policy=unknown_policy,
                )
            )
            continue
        line = emit_leaf_component_line(
            component,
            device_catalog=device_catalog,
            node_map=node_map or None,
        )
        if line:
            body.append(line)
    spice = module.get("spice") if isinstance(module.get("spice"), dict) else {}
    for raw in spice.get("opaque", []) or []:
        stripped = str(raw).strip()
        if stripped:
            body.append(stripped)
    body.append(f".ends {subckt_name}")
    lines.extend(body)
    return lines


def compile_hierarchical_project(
    root: Path,
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]],
    *,
    device_catalog: dict[str, Any] | None = None,
) -> dict[str, Any]:
    composition = project_composition(project)
    top_id = composition.get("top_module_id") or (project.get("modules") or [{}])[0].get("id")
    if not top_id or top_id not in modules:
        raise ValueError("hierarchical composition requires a valid top_module_id")
    cycle = detect_module_cycles(modules, start_module_id=str(top_id))
    if cycle:
        raise ValueError(f"MODULE hierarchy cycle detected: {' -> '.join(cycle)}")

    erc = write_erc_result(root, project, modules)
    top = modules[str(top_id)]
    lines = [
        f"* {project['name']}",
        "* Generated hierarchical netlist (.subckt/X) by circuit_project.py",
    ]
    model_lines: list[str] = []
    for module in modules.values():
        for model in collect_module_models(module):
            if model not in model_lines:
                model_lines.append(model)
    if model_lines:
        lines.append("* Device models")
        lines.extend(model_lines)

    lines.extend(
        emit_module_subckt(
            str(top_id),
            top,
            modules,
            device_catalog=device_catalog,
            unknown_policy="error",
        )
    )

    # Top-level testbench wrapper: instantiate the top subckt once.
    port_nodes = [
        sanitize_node(str(port.get("net") or port.get("name") or port.get("id")))
        for port in top.get("ports", []) or []
    ]
    top_name = spice_name_for_subckt(str(top_id))
    driven: set[str] = set()
    for port in top.get("ports", []) or []:
        node = sanitize_node(str(port.get("net") or port.get("name") or port.get("id")))
        if port.get("signal_type") == "analog" and port.get("direction") == "input" and node not in driven:
            lines.append(f"Vtest_{sanitize_node(port.get('id'))} {node} 0 DC 0 AC 1")
            driven.add(node)
        elif port.get("signal_type") == "power" and port.get("direction") == "input" and node not in driven:
            lines.append(f"Vtest_{sanitize_node(port.get('id'))} {node} 0 DC 5")
            driven.add(node)
        if port.get("signal_type") == "analog" and port.get("direction") == "output":
            lines.append(f"Rload_{sanitize_node(port.get('id'))} {node} 0 1meg")
    lines.append(f"Xtop {' '.join(port_nodes)} {top_name}".strip())
    # Hoist top-deck analysis / measurement directives. Hierarchical system nets
    # are the top-module port nodes + Vtest_* stimulus; rewrite local names the
    # same way flat compile_project does before appending.
    top_node_names: dict[str, str] = {}
    for port in top.get("ports", []) or []:
        external = sanitize_node(str(port.get("net") or port.get("name") or port.get("id")))
        formal = formal_subckt_port_node(port)
        for raw in (port.get("net"), port.get("name"), port.get("id"), formal, external):
            text = str(raw or "").strip()
            if text:
                top_node_names[text.casefold()] = external
        if (
            str(port.get("signal_type") or "").casefold() == "ground"
            or str(port.get("net") or "").casefold() in {"0", "gnd", "gnd!"}
        ):
            for alias in ("0", "gnd", "GND", "gnd!"):
                top_node_names.setdefault(alias.casefold(), external)
    top_instance_names: dict[str, str] = {}
    for port in top.get("ports", []) or []:
        port_id = sanitize_node(port.get("id"))
        node = sanitize_node(str(port.get("net") or port.get("name") or port.get("id")))
        is_input = str(port.get("direction") or "").casefold() == "input"
        signal = str(port.get("signal_type") or "").casefold()
        if is_input and signal in {"analog", "power"} and node:
            stim = f"Vtest_{port_id}"
            top_instance_names[stim.casefold()] = stim
            for raw in (port.get("name"), port.get("id"), port.get("net")):
                text = str(raw or "").strip()
                if text:
                    top_instance_names.setdefault(text.casefold(), stim)
    directive_lines: list[str] = []
    for module_id, module in modules.items():
        spice = module.get("spice") if isinstance(module.get("spice"), dict) else {}
        # Only the top module's nets are visible on the hierarchical system deck.
        # Child-module .meas/.print would reference internal subckt nets.
        if str(module_id) != str(top_id):
            continue
        for raw in spice.get("directives", []) or []:
            stripped = str(raw).strip()
            if not stripped or stripped.lower() == ".end":
                continue
            rewritten = rewrite_analysis_directive(stripped, top_instance_names, top_node_names)
            if rewritten not in directive_lines and rewritten not in lines:
                directive_lines.append(rewritten)
    ac = project.get("analyses", {}).get("ac", {}) if isinstance(project.get("analyses"), dict) else {}
    has_ac = any(
        (parts := stripped.lower().split()) and parts[0] == ".ac"
        for stripped in directive_lines
    )
    if ac.get("enabled", True) and not has_ac:
        points = int(ac.get("points_per_decade", 20))
        start = float(ac.get("start_hz", 10))
        stop = float(ac.get("stop_hz", 1_000_000))
        lines.append(f".ac dec {points} {start:g} {stop:g}")
    lines.extend(directive_lines)
    lines.append(".end")

    build_root = root / "build" / "system"
    build_root.mkdir(parents=True, exist_ok=True)
    netlist_text = "\n".join(lines) + "\n"
    netlist_path = build_root / "design.final.cir"
    netlist_path.write_text(netlist_text, encoding="utf-8")
    source_map = {
        "composition_mode": "hierarchical",
        "top_module_id": str(top_id),
        "connectivity_hash": ordered_connectivity_hash(top),
    }
    atomic_write_json(build_root / "source-map.json", source_map)
    for module_id, module in modules.items():
        module_root = root / "build" / "modules" / module_id
        module_root.mkdir(parents=True, exist_ok=True)
        atomic_write_json(module_root / "connectivity.json", connectivity_payload(module))
        hier_lines = [
            f"* hierarchical view for {module_id}",
            *emit_module_subckt(
                module_id,
                module,
                modules,
                device_catalog=device_catalog,
                unknown_policy="error",
            ),
            ".end",
        ]
        (module_root / "design.hier.cir").write_text("\n".join(hier_lines) + "\n", encoding="utf-8")

    manifest = {
        "schema": "actoviq.build.v1",
        "project_id": project["project_id"],
        "revision": project["revision"],
        "source_revision": project["revision"],
        "document_hash": project_document_hash(project, modules),
        "built_at": utc_now(),
        "status": "compiling",
        "composition_mode": "hierarchical",
        "netlist": "system/design.final.cir",
        "source_map": "system/source-map.json",
        "erc": "erc.json",
        "erc_status": erc["status"],
        "erc_summary": erc["summary"],
        "modules": {},
    }
    atomic_write_json(root / "build" / "build-manifest.json", manifest)
    write_project_report(root, project, modules, netlist_text, None)
    module_results = []
    for module_ref in project["modules"]:
        module_results.append(compile_module(root, module_ref["id"]))
    final_manifest = {
        **manifest,
        "built_at": utc_now(),
        "status": "compiled",
        "modules": {
            result["module_id"]: {
                "status": "compiled",
                "revision": result["revision"],
                "netlist": f"modules/{result['module_id']}/design.cir",
                "schematic": (
                    f"modules/{result['module_id']}/schematic.svg"
                    if result.get("schematic_path")
                    else None
                ),
                "hierarchical_netlist": f"modules/{result['module_id']}/design.hier.cir",
                "schematic_document": (
                    f"modules/{result['module_id']}/schematic-document.json"
                    if result.get("schematic_document_path")
                    else None
                ),
                "render_map": f"modules/{result['module_id']}/schematic-render-map.json",
            }
            for result in module_results
        },
    }
    atomic_write_json(root / "build" / "build-manifest.json", final_manifest)
    return {
        "ok": True,
        "composition_mode": "hierarchical",
        "netlist": str(netlist_path),
        "manifest": final_manifest,
        "erc": erc,
    }


def editable_component_count(module: dict[str, Any]) -> int:
    return sum(
        1
        for component in module.get("components", []) or []
        if str(component.get("type", "")).upper() not in {"BLOCK", "GND", "MODULE"}
    )


def module_has_active_devices(module: dict[str, Any]) -> bool:
    return any(
        str(component.get("type", "")).upper() in ACTIVE_COMPONENT_TYPES
        for component in module.get("components", []) or []
        if str(component.get("type", "")).upper() not in {"BLOCK", "MODULE"}
    )


def modularity_summary(
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    module_counts: list[dict[str, Any]] = []
    oversized: list[dict[str, Any]] = []
    substantial: list[dict[str, Any]] = []
    for module_ref in project.get("modules", []):
        module_id = str(module_ref.get("id", ""))
        module = modules.get(module_id) or {}
        count = editable_component_count(module)
        entry = {
            "module_id": module_id,
            "component_count": count,
            "has_active_devices": module_has_active_devices(module),
        }
        module_counts.append(entry)
        if count > OVERSIZED_MODULE_COMPONENT_LIMIT:
            oversized.append(entry)
        if count > MONOLITHIC_COMPLEX_COMPONENT_LIMIT and entry["has_active_devices"]:
            substantial.append(entry)
    guidance = (
        "Prefer functional modules (stimuli / stage cores / encode-load) with connect_ports; "
        "keep each module near 16 editable devices or fewer."
    )
    if oversized:
        guidance = (
            "Split oversized modules by electrical responsibility before relying on auto-layout; "
            "see modular-project-design.md."
        )
    elif len(substantial) == 1 and len(project.get("modules", [])) == 1:
        guidance = (
            "This design is still a single substantial module; split stimuli and functional stages "
            "unless it is a trivial ≤8-device path."
        )
    return {
        "module_count": len(project.get("modules", []) or []),
        "oversized_limit": OVERSIZED_MODULE_COMPONENT_LIMIT,
        "monolithic_complex_limit": MONOLITHIC_COMPLEX_COMPONENT_LIMIT,
        "modules": module_counts,
        "oversized_modules": oversized,
        "guidance": guidance,
    }


def evaluate_erc(
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    diagnostics: list[dict[str, Any]] = []
    any_components = any(module.get("components") for module in modules.values())
    has_ground = False
    endpoint_adjacency: dict[str, set[str]] = {}
    port_lookup: dict[str, dict[str, Any]] = {}
    device_catalog = resolve_project_device_catalog(project)
    catalog_devices = {
        str(device.get("device_id") or "").casefold(): device
        for device in (device_catalog or {}).get("devices", []) or []
        if isinstance(device, dict)
    }
    analog_profile = project.get("analog_ic_profile")
    analog_profile = analog_profile if isinstance(analog_profile, dict) else {}
    pdk_binding = analog_profile.get("pdk_binding")
    pdk_binding = pdk_binding if isinstance(pdk_binding, dict) else {}
    pdk_ref = str(pdk_binding.get("pdk_ref") or pdk_binding.get("logical_id") or "").strip()

    for module_ref in project.get("modules", []):
        module_id = str(module_ref.get("id", ""))
        for port in module_ref.get("ports", []):
            endpoint = f"{module_id}:{port.get('id', '')}"
            port_lookup[endpoint] = port
            endpoint_adjacency.setdefault(endpoint, set())
            if port.get("signal_type") == "ground" or str(port.get("net", "")).lower() in {"0", "gnd"}:
                has_ground = True
    for connection in project.get("connections", []):
        left = connection.get("from", {})
        right = connection.get("to", {})
        left_key = f"{left.get('module_id', '')}:{left.get('port_id', '')}"
        right_key = f"{right.get('module_id', '')}:{right.get('port_id', '')}"
        endpoint_adjacency.setdefault(left_key, set()).add(right_key)
        endpoint_adjacency.setdefault(right_key, set()).add(left_key)

    output_endpoints = {
        endpoint for endpoint, port in port_lookup.items()
        if port.get("direction") in {"output", "bidirectional"}
    }

    substantial_modules: list[str] = []
    for module_id, module in modules.items():
        component_count = editable_component_count(module)
        if component_count > OVERSIZED_MODULE_COMPONENT_LIMIT:
            erc_diagnostic(
                diagnostics,
                "warning",
                "oversized_module",
                (
                    f"Module {module_id} has {component_count} editable devices "
                    f"(limit {OVERSIZED_MODULE_COMPONENT_LIMIT}); split by electrical responsibility."
                ),
                module_id=module_id,
            )
        if component_count > MONOLITHIC_COMPLEX_COMPONENT_LIMIT and module_has_active_devices(module):
            substantial_modules.append(module_id)

        net_usage: dict[str, list[dict[str, str]]] = {}
        local_driven_nets: set[str] = set()
        net_names: dict[str, str] = {}
        critical_candidates: list[tuple[dict[str, Any], dict[str, Any], str, str]] = []
        no_connect_pins: list[tuple[dict[str, Any], dict[str, Any]]] = []
        for net in module.get("nets", []):
            net_id = str(net.get("id", ""))
            net_name = str(net.get("name", ""))
            net_names[net_id] = net_name
            if net_name.lower() in {"0", "gnd"} or net.get("kind") == "ground":
                has_ground = True
            if net.get("conflict"):
                erc_diagnostic(
                    diagnostics,
                    "error",
                    "conflicting_net_labels",
                    f"Net {net_name or net_id} has conflicting labels: {', '.join(net.get('aliases') or [])}.",
                    module_id=module_id,
                    net_id=net_id,
                )
        for port in module.get("ports", []):
            net_id = str(port.get("net_id") or stable_net_token(str(port.get("net", ""))))
            net_usage.setdefault(net_id, []).append({"kind": "port", "id": str(port.get("id", ""))})
            net_names.setdefault(net_id, str(port.get("net", "")))
            if port.get("signal_type") == "ground" or str(port.get("net", "")).lower() in {"0", "gnd"}:
                has_ground = True
        for component in module.get("components", []):
            component_id = str(component.get("id", ""))
            component_type = str(component.get("type", "")).upper()
            for index, pin in enumerate(component.get("pins", [])):
                if pin.get("no_connect"):
                    no_connect_pins.append((component, pin))
                    continue
                net_id = str(pin.get("net_id") or stable_net_token(str(pin.get("net", ""))))
                net_usage.setdefault(net_id, []).append({
                    "kind": "pin",
                    "id": f"{component_id}.{pin.get('id', '')}",
                })
                net_names.setdefault(net_id, str(pin.get("net", "")))
                if str(pin.get("net", "")).lower() in {"0", "gnd"}:
                    has_ground = True
                if component_type in {"V", "I"} and index == 0:
                    local_driven_nets.add(net_id)

            critical_pins = {
                "M": {"g": "error", "d": "warning", "s": "warning", "b": "warning"},
                "Q": {"b": "error", "c": "warning", "e": "warning"},
            }.get(component_type, {})
            for pin in component.get("pins", []):
                if pin.get("no_connect"):
                    continue
                pin_id = str(pin.get("id", "")).lower()
                severity = critical_pins.get(pin_id)
                net_id = str(pin.get("net_id") or stable_net_token(str(pin.get("net", ""))))
                if severity:
                    critical_candidates.append((component, pin, net_id, severity))

            if component_type == "M" and pdk_ref and pdk_ref.casefold() != "unbound":
                parameters = component.get("parameters")
                parameters = parameters if isinstance(parameters, dict) else {}
                device_id = str(parameters.get("device_id") or "").strip()
                device = catalog_devices.get(device_id.casefold()) if device_id else None
                if not device_catalog:
                    erc_diagnostic(
                        diagnostics,
                        "error",
                        "pdk_catalog_unavailable",
                        f"Bound PDK {pdk_ref} has no available device catalog.",
                        module_id=module_id,
                        component_id=component_id,
                    )
                elif not device:
                    erc_diagnostic(
                        diagnostics,
                        "error",
                        "pdk_device_missing",
                        f"Device {device_id or '(unset)'} is not present in PDK {pdk_ref}.",
                        module_id=module_id,
                        component_id=component_id,
                    )
                else:
                    spice_meta = device.get("spice")
                    spice_meta = spice_meta if isinstance(spice_meta, dict) else {}
                    if not (spice_meta.get("pin_order") or device.get("pins")):
                        erc_diagnostic(
                            diagnostics,
                            "error",
                            "pdk_pin_order_missing",
                            f"Device {device_id} has no verified pin order.",
                            module_id=module_id,
                            component_id=component_id,
                        )
                    if not str(parameters.get("model") or spice_meta.get("model") or "").strip():
                        erc_diagnostic(
                            diagnostics,
                            "error",
                            "pdk_model_missing",
                            f"Device {device_id} has no SPICE model.",
                            module_id=module_id,
                            component_id=component_id,
                        )
                    if not str(parameters.get("corner") or pdk_binding.get("default_corner") or "").strip():
                        erc_diagnostic(
                            diagnostics,
                            "warning",
                            "pdk_corner_missing",
                            f"Device {device_id} has no selected PDK corner.",
                            module_id=module_id,
                            component_id=component_id,
                        )
                    device_parameters = device.get("parameters")
                    device_parameters = device_parameters if isinstance(device_parameters, dict) else {}
                    for field, raw_constraint in device_parameters.items():
                        definition = raw_constraint if isinstance(raw_constraint, dict) else {}
                        raw_value = str(parameters.get(field) or "").strip()
                        if not raw_value:
                            if definition.get("required"):
                                erc_diagnostic(
                                    diagnostics,
                                    "error",
                                    "pdk_parameter_required",
                                    f"{field.upper()} is required by device {device_id}.",
                                    module_id=module_id,
                                    component_id=component_id,
                                )
                            continue
                        parsed = _parse_spice_scalar(raw_value)
                        if parsed is None:
                            erc_diagnostic(
                                diagnostics,
                                "error",
                                "pdk_parameter_invalid",
                                f"{field.upper()} is not a valid SPICE number.",
                                module_id=module_id,
                                component_id=component_id,
                            )
                            continue
                        if definition.get("integer") and not parsed.is_integer():
                            erc_diagnostic(
                                diagnostics,
                                "error",
                                "pdk_parameter_integer",
                                f"{field.upper()} must be an integer.",
                                module_id=module_id,
                                component_id=component_id,
                            )
                        minimum = _parse_spice_scalar(definition.get("minimum"))
                        maximum = _parse_spice_scalar(definition.get("maximum"))
                        if (
                            minimum is not None
                            and (
                                parsed <= minimum
                                if definition.get("exclusive_minimum")
                                else parsed < minimum
                            )
                        ):
                            erc_diagnostic(
                                diagnostics,
                                "error",
                                "pdk_parameter_range",
                                f"{field.upper()} is below the device minimum {definition.get('minimum')}.",
                                module_id=module_id,
                                component_id=component_id,
                            )
                        if (
                            maximum is not None
                            and (
                                parsed >= maximum
                                if definition.get("exclusive_maximum")
                                else parsed > maximum
                            )
                        ):
                            erc_diagnostic(
                                diagnostics,
                                "error",
                                "pdk_parameter_range",
                                f"{field.upper()} exceeds the device maximum {definition.get('maximum')}.",
                                module_id=module_id,
                                component_id=component_id,
                            )

            if component_type == "BLOCK":
                block_spice = component.get("spice") or {}
                if not block_spice.get("raw") or not block_spice.get("simulated"):
                    erc_diagnostic(
                        diagnostics,
                        "warning",
                        "block_not_simulated",
                        f"Block {component.get('name', component_id)} is schematic-only and does not participate in simulation.",
                        module_id=module_id,
                        component_id=component_id,
                    )
            elif component_type == "MODULE":
                module_ref = component.get("module_ref") or {}
                child_id = str(module_ref.get("module_id") or component.get("value") or "")
                child = modules.get(child_id)
                if not child:
                    erc_diagnostic(
                        diagnostics,
                        "error",
                        "child_module_missing",
                        f"Module instance {component.get('name', component_id)} references unavailable child {child_id}.",
                        module_id=module_id,
                        component_id=component_id,
                    )
                else:
                    bound_revision = module_ref.get("revision")
                    current_revision = child.get("revision")
                    if bound_revision != current_revision:
                        erc_diagnostic(
                            diagnostics,
                            "warning",
                            "module_revision_mismatch",
                            (
                                f"Module instance {component.get('name', component_id)} binds "
                                f"{child_id} revision {bound_revision}, current revision is {current_revision}."
                            ),
                            module_id=module_id,
                            component_id=component_id,
                        )
                    instance_pin_ids = {
                        str(pin.get("id") or "") for pin in component.get("pins", [])
                    }
                    child_port_ids = {
                        str(port.get("id") or "") for port in child.get("ports", [])
                    }
                    for port_id in sorted(child_port_ids - instance_pin_ids):
                        erc_diagnostic(
                            diagnostics,
                            "error",
                            "module_port_missing",
                            (
                                f"Module instance {component.get('name', component_id)} "
                                f"is missing child port {port_id}."
                            ),
                            module_id=module_id,
                            component_id=component_id,
                            pin_id=port_id,
                        )
                    for pin_id in sorted(instance_pin_ids - child_port_ids):
                        erc_diagnostic(
                            diagnostics,
                            "warning",
                            "module_pin_extra",
                            (
                                f"Module instance {component.get('name', component_id)} "
                                f"has stale pin {pin_id}."
                            ),
                            module_id=module_id,
                            component_id=component_id,
                            pin_id=pin_id,
                        )

        wired_pins = {
            (str(endpoint.get("component_id", "")), str(endpoint.get("pin_id", "")))
            for wire in module.get("wires", [])
            for endpoint in (wire.get("from", {}), wire.get("to", {}))
            if endpoint.get("component_id") and endpoint.get("pin_id")
        }
        for component, pin in no_connect_pins:
            component_id = str(component.get("id", ""))
            pin_id = str(pin.get("id", ""))
            if (component_id, pin_id) in wired_pins:
                erc_diagnostic(
                    diagnostics,
                    "error",
                    "connected_no_connect",
                    (
                        f"{component.get('name', component_id)} pin "
                        f"{pin.get('name', pin_id)} is marked no-connect but has a wire."
                    ),
                    module_id=module_id,
                    component_id=component_id,
                    pin_id=pin_id,
                )

        for component, pin, net_id, severity in critical_candidates:
            if len(net_usage.get(net_id, [])) <= 1:
                erc_diagnostic(
                    diagnostics,
                    severity,
                    "floating_critical_pin",
                    f"{component.get('name', component.get('id'))} pin {pin.get('name', pin.get('id'))} is not connected.",
                    module_id=module_id,
                    component_id=component.get("id"),
                    pin_id=pin.get("id"),
                    net_id=net_id,
                )

        model_names = {
            match.group(1).lower()
            for line in (module.get("spice") or {}).get("models", [])
            if (match := re.match(r"(?i)^\s*\.model\s+(\S+)", str(line)))
        }
        # PCB schematics are not simulated; a missing SPICE model for a LED or
        # transistor is a note for the designer, not a blocking error.
        model_severity = (
            "error"
            if requires_simulation(normalize_project_kind(project.get("project_kind")))
            else "warning"
        )
        for component in module.get("components", []):
            component_type = str(component.get("type", "")).upper()
            if component_type not in {"D", "Q", "M"}:
                continue
            model_name = component_model_name(component)
            if not model_name or "=" in model_name or model_name.lower() not in model_names:
                erc_diagnostic(
                    diagnostics,
                    model_severity,
                    "missing_device_model",
                    f"{component.get('name', component.get('id'))} references model {model_name or '(missing)'}, but no matching .model is preserved.",
                    module_id=module_id,
                    component_id=component.get("id"),
                    model=model_name or None,
                )

        for port in module.get("ports", []):
            if port.get("direction") != "input" or port.get("signal_type") == "ground":
                continue
            net_id = str(port.get("net_id") or stable_net_token(str(port.get("net", ""))))
            if net_id in local_driven_nets:
                continue
            endpoint = f"{module_id}:{port.get('id', '')}"
            visited = {endpoint}
            pending = [endpoint]
            externally_driven = False
            while pending:
                current = pending.pop()
                if current != endpoint and current in output_endpoints:
                    externally_driven = True
                    break
                for neighbor in endpoint_adjacency.get(current, set()):
                    if neighbor not in visited:
                        visited.add(neighbor)
                        pending.append(neighbor)
            if not externally_driven:
                erc_diagnostic(
                    diagnostics,
                    "warning",
                    "undriven_input",
                    f"Input {port.get('name', port.get('id'))} has no local source or connected output driver.",
                    module_id=module_id,
                    port_id=port.get("id"),
                    net_id=net_id,
                )

    if (
        len(project.get("modules", []) or []) == 1
        and len(substantial_modules) == 1
    ):
        only_id = substantial_modules[0]
        count = editable_component_count(modules.get(only_id) or {})
        erc_diagnostic(
            diagnostics,
            "warning",
            "monolithic_complex_design",
            (
                f"Project has a single substantial module {only_id} with {count} devices; "
                "prefer stimuli + functional stage modules unless this is a trivial path."
            ),
            module_id=only_id,
                )

    if any_components and not has_ground:
        erc_diagnostic(
            diagnostics,
            "error",
            "missing_ground",
            "The circuit has components but no explicit SPICE ground node 0.",
        )

    spice_text = "\n".join(module_spice_text(module) for module in modules.values())
    directives = [
        line.strip() for line in spice_text.splitlines()
        if line.strip().startswith(".")
    ]
    source_names = {
        tokens[0].lower()
        for raw in spice_text.splitlines()
        if (tokens := raw.strip().split()) and tokens[0][:1].upper() in {"V", "I"}
    }
    for directive in directives:
        lowered = directive.lower()
        if lowered.startswith(".ac") and not re.search(
            r"(?im)^\s*[vi]\S+\s+\S+\s+\S+.*\bac(?:\s+|=)(?!0(?:\.0*)?(?:\s|$))",
            spice_text,
        ):
            erc_diagnostic(
                diagnostics,
                "error",
                "missing_ac_excitation",
                "AC analysis is configured, but no independent source has a non-zero AC value.",
            )
        elif lowered.startswith(".dc"):
            tokens = directive.split()
            # ngspice allows sweeping independent sources or special vars (TEMP, ...).
            special_dc = {"temp", "res", "rtemp"}
            if len(tokens) > 1 and tokens[1].lower() not in source_names and tokens[1].lower() not in special_dc:
                erc_diagnostic(
                    diagnostics,
                    "error",
                    "invalid_dc_source",
                    f"DC sweep references missing source {tokens[1]}.",
                )
        elif lowered.startswith(".tran") and not re.search(
            r"(?i)\b(?:pulse|sin|pwl|exp|sffm)\s*\(", spice_text
        ):
            erc_diagnostic(
                diagnostics,
                "warning",
                "missing_transient_excitation",
                "Transient analysis has no time-varying independent source.",
            )
        elif lowered.startswith(".sp") and not has_sparameter_ports(spice_text):
            erc_diagnostic(
                diagnostics,
                "error",
                "missing_sparameter_ports",
                "S-parameter analysis requires consecutive VSRC portnum ports with Z0.",
            )

    severity_order = {"error": 0, "warning": 1, "info": 2}
    diagnostics.sort(key=lambda item: (severity_order.get(item["severity"], 9), item["id"]))
    errors = sum(item["severity"] == "error" for item in diagnostics)
    warnings = sum(item["severity"] == "warning" for item in diagnostics)
    infos = sum(item["severity"] == "info" for item in diagnostics)
    return {
        "schema": ERC_SCHEMA,
        "source_revision": project["revision"],
        "document_hash": project_document_hash(project, modules),
        "status": "error" if errors else "warning" if warnings else "clean",
        "blocking": errors > 0,
        "summary": {"errors": errors, "warnings": warnings, "infos": infos},
        "diagnostics": diagnostics,
        "checked_at": utc_now(),
    }


def write_erc_result(
    root: Path,
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    result = evaluate_erc(project, modules)
    atomic_write_json(root / "build" / "erc.json", result)
    return result


def find_module_ref(project: dict[str, Any], module_id: str) -> dict[str, Any]:
    for module in project["modules"]:
        if module["id"] == module_id:
            return module
    raise ValueError(f"unknown module: {module_id}")


def set_connection_group_network(
    project: dict[str, Any],
    connection_id: str,
    network: str,
) -> None:
    label = network.strip()
    if not label:
        raise ValueError("system network name cannot be empty")
    connections = project.get("connections", [])
    target = next(
        (connection for connection in connections if connection.get("id") == connection_id),
        None,
    )
    if target is None:
        raise ValueError(f"unknown connection: {connection_id}")

    endpoints = {
        (target["from"]["module_id"], target["from"]["port_id"]),
        (target["to"]["module_id"], target["to"]["port_id"]),
    }
    connected: list[dict[str, Any]] = []
    changed = True
    while changed:
        changed = False
        for connection in connections:
            pair = {
                (connection["from"]["module_id"], connection["from"]["port_id"]),
                (connection["to"]["module_id"], connection["to"]["port_id"]),
            }
            if connection in connected or endpoints.isdisjoint(pair):
                continue
            connected.append(connection)
            endpoints.update(pair)
            changed = True
    for connection in connected:
        connection["network"] = label


def find_component(module: dict[str, Any], component_id: str) -> dict[str, Any]:
    for component in module["components"]:
        if component["id"] == component_id:
            return component
    raise ValueError(f"unknown component: {module['module_id']}.{component_id}")


def coerce_netlist_notebook_text(value: Any, *, operation: dict[str, Any] | None = None) -> str:
    """Accept common LLM shapes for netlist_notebook and return plain text."""
    if value is None and operation is not None:
        for alias in ("netlist_notebook", "notebook", "netlist", "spice", "source", "markdown"):
            if alias in operation and operation.get(alias) is not None and alias != "netlist_notebook":
                value = operation.get(alias)
                break
            if alias == "netlist_notebook" and operation.get(alias) is not None:
                value = operation.get(alias)
                break
    if isinstance(value, str):
        return value
    if value is None:
        raise ValueError(
            "upsert_module_netlist netlist_notebook must be text "
            f"(got missing/null; keys={sorted((operation or {}).keys())})"
        )
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                chunk = item.get("content") or item.get("text") or item.get("source") or item.get("line")
                if isinstance(chunk, str):
                    parts.append(chunk)
                else:
                    parts.append(json.dumps(item, ensure_ascii=False))
            else:
                parts.append(str(item))
        text = "\n".join(parts)
        if not text.strip():
            raise ValueError("upsert_module_netlist netlist_notebook must be non-empty text (got empty list)")
        return text
    if isinstance(value, dict):
        for key in ("netlist_notebook", "content", "text", "source", "markdown", "spice", "netlist", "notebook"):
            nested = value.get(key)
            if isinstance(nested, str) and nested.strip():
                return nested
            if isinstance(nested, list):
                return coerce_netlist_notebook_text(nested)
        lines = value.get("lines")
        if isinstance(lines, list):
            return coerce_netlist_notebook_text(lines)
        raise ValueError(
            "upsert_module_netlist netlist_notebook must be text "
            f"(got object keys={sorted(value.keys())})"
        )
    raise ValueError(
        "upsert_module_netlist netlist_notebook must be text "
        f"(got {type(value).__name__})"
    )


def module_from_netlist_notebook(
    module_id: str,
    notebook: str,
    current: dict[str, Any],
    project_kind: str | None = None,
) -> dict[str, Any]:
    netlist_text = extract_notebook_netlist(notebook)
    kind = project_kind or DEFAULT_PROJECT_KIND
    if kind == "simulation":
        netlist_text = unwrap_simulation_subckt_wrapper(netlist_text)
        netlist_text = strip_control_blocks(netlist_text)
    netlist_validation = validate_netlist_text(
        netlist_text,
        kind,
        source=f"module:{module_id}",
    )
    if not netlist_validation["ok"]:
        first = netlist_validation["violations"][0]
        raise ValueError(
            f"netlist is not valid for project_kind={netlist_validation['project_kind']}: "
            f"line {first['line']}: {first['message']}"
        )
    parsed_components = parse_editable_netlist_components(module_id, netlist_text, current)
    parsed_ids = {str(component.get("id")) for component in parsed_components}
    schematic_blocks = [
        component for component in current.get("components", [])
        if component.get("type") == "BLOCK" and str(component.get("id")) not in parsed_ids
    ]
    components = [*parsed_components, *schematic_blocks]
    if not components:
        raise ValueError("netlist contains no editable or preserved components")
    ports = infer_editable_ports(list(current.get("ports", [])), components)
    next_module = upgrade_module_document({
        **current,
        "schema": MODULE_SCHEMA,
        "module_id": module_id,
        "components": components,
        "ports": ports,
        "spice": parse_spice_source(module_id, netlist_text, components),
    })
    ensure_module_stable_ids(next_module)
    validate_module(next_module, project_kind or DEFAULT_PROJECT_KIND)
    return next_module


def _module_rect(position: dict[str, Any] | None, size: dict[str, Any] | None) -> tuple[float, float, float, float]:
    pos = position if isinstance(position, dict) else {}
    sz = size if isinstance(size, dict) else {}
    x = float(pos.get("x", DEFAULT_MODULE_POSITION["x"]))
    y = float(pos.get("y", DEFAULT_MODULE_POSITION["y"]))
    width = float(sz.get("width", DEFAULT_MODULE_SIZE["width"]))
    height = float(sz.get("height", DEFAULT_MODULE_SIZE["height"]))
    if width <= 0:
        width = DEFAULT_MODULE_SIZE["width"]
    if height <= 0:
        height = DEFAULT_MODULE_SIZE["height"]
    return x, y, width, height


def _rects_overlap(
    left: tuple[float, float, float, float],
    right: tuple[float, float, float, float],
    margin: float = MODULE_LAYOUT_MARGIN,
) -> bool:
    ax, ay, aw, ah = left
    bx, by, bw, bh = right
    return not (
        ax + aw + margin <= bx
        or bx + bw + margin <= ax
        or ay + ah + margin <= by
        or by + bh + margin <= ay
    )


def _occupied_module_rects(project: dict[str, Any], exclude_module_id: str | None = None) -> list[tuple[float, float, float, float]]:
    rects: list[tuple[float, float, float, float]] = []
    for entry in project.get("modules", []):
        if not isinstance(entry, dict):
            continue
        module_id = str(entry.get("id") or "")
        if exclude_module_id and module_id == exclude_module_id:
            continue
        rects.append(_module_rect(entry.get("position"), entry.get("size")))
    return rects


def _grid_slot_position(index: int) -> dict[str, float]:
    col = index % MODULE_LAYOUT_COLUMNS
    row = index // MODULE_LAYOUT_COLUMNS
    return {
        "x": MODULE_LAYOUT_ORIGIN_X + col * MODULE_LAYOUT_DX,
        "y": MODULE_LAYOUT_ORIGIN_Y + row * MODULE_LAYOUT_DY,
    }


def resolve_module_canvas_position(
    project: dict[str, Any],
    *,
    module_id: str,
    preferred: dict[str, Any] | None = None,
    size: dict[str, Any] | None = None,
    previous: dict[str, Any] | None = None,
) -> dict[str, float]:
    """Pick a canvas position that does not overlap other module cards.

    - Keep an existing module's previous position when the op does not move it
      and it still does not collide.
    - Honor an explicit non-overlapping preferred position from the agent.
    - Otherwise allocate the next free Arrange-modules grid slot.
    """
    module_size = dict(size or DEFAULT_MODULE_SIZE)
    occupied = _occupied_module_rects(project, exclude_module_id=module_id)

    candidates: list[dict[str, float]] = []
    if isinstance(preferred, dict) and "x" in preferred and "y" in preferred:
        candidates.append({"x": float(preferred["x"]), "y": float(preferred["y"])})
    if isinstance(previous, dict) and "x" in previous and "y" in previous:
        candidates.append({"x": float(previous["x"]), "y": float(previous["y"])})

    for candidate in candidates:
        rect = _module_rect(candidate, module_size)
        if not any(_rects_overlap(rect, other) for other in occupied):
            return candidate

    start_index = len(occupied)
    for index in range(start_index, start_index + 64):
        candidate = _grid_slot_position(index)
        rect = _module_rect(candidate, module_size)
        if not any(_rects_overlap(rect, other) for other in occupied):
            return candidate

    # Extremely dense boards: fall back to a far-right column.
    return {
        "x": MODULE_LAYOUT_ORIGIN_X + MODULE_LAYOUT_COLUMNS * MODULE_LAYOUT_DX,
        "y": MODULE_LAYOUT_ORIGIN_Y + start_index * MODULE_LAYOUT_DY,
    }


# Ops that LLMs often nest as {"upsert_module": {...}} instead of {"op":"upsert_module", ...}.
NESTED_OPERATION_NAMES = frozenset({
    "restore_revision",
    "upsert_module",
    "remove_module",
    "add_component",
    "place_library_component",
    "remove_component",
    "add_port",
    "move_module",
    "resize_module",
    "set_module_note",
    "set_module_preview",
    "set_module_metadata",
    "set_project_kind",
    "set_analog_ic_profile",
    "set_schematic_peer",
    "set_component_value",
    "move_component",
    "upsert_module_netlist",
    "set_module_schematic",
    "set_module_netlist",
    "bind_lcsc_part",
    "move_schematic_item",
    "reset_schematic_item",
    "connect_ports",
    "set_connection_network",
    "connect_pins",
})


def normalize_operation(operation: Any) -> dict[str, Any]:
    """Accept flat {op,...} and common LLM nestings; return a flat operation dict."""
    if not isinstance(operation, dict):
        raise ValueError("operation must be an object")
    op = operation.get("op")
    if isinstance(op, str) and op.strip():
        return operation
    # {"operation": "upsert_module", "module_id": ...}
    alt = operation.get("operation")
    if isinstance(alt, str) and alt.strip():
        rest = {key: value for key, value in operation.items() if key != "operation"}
        return {"op": alt.strip(), **rest}
    # {"upsert_module": {"module_id": ...}} or {"upsert_module_netlist": {...}}
    nested_keys = [
        key for key, value in operation.items()
        if key in NESTED_OPERATION_NAMES and isinstance(value, dict)
    ]
    if len(nested_keys) == 1:
        key = nested_keys[0]
        return {"op": key, **operation[key]}
    if len(nested_keys) > 1:
        raise ValueError(
            "operation object nests multiple ops "
            f"{nested_keys}; use one flat {{op, ...}} object per array entry"
        )
    return operation


# ---------------------------------------------------------------------------
# KiCad library placement (place_library_component)
# ---------------------------------------------------------------------------

_KICAD_LIBRARY_INDEX: dict[str, Any] | None = None


def kicad_library_index() -> dict[str, Any]:
    """Lazy process-wide index over the bundled KiCad library subset."""
    global _KICAD_LIBRARY_INDEX
    if _KICAD_LIBRARY_INDEX is None:
        from kicad_library import load_index, resolve_lib_root

        _KICAD_LIBRARY_INDEX = load_index(resolve_lib_root())
    return _KICAD_LIBRARY_INDEX


# Sensible SMD defaults for basic Device:* symbols whose KiCad
# default_footprint is intentionally blank. Only used when the footprint
# actually exists in the bundled index.
LIBRARY_FALLBACK_FOOTPRINTS = {
    "Device:R": "Resistor_SMD:R_0603_1608Metric",
    "Device:C": "Capacitor_SMD:C_0603_1608Metric",
    "Device:LED": "LED_SMD:LED_0805_2012Metric",
}

# KiCad symbols that map onto native SPICE primitives instead of BLOCK boxes,
# so passives render with their classic glyphs and flow through the existing
# primitive ERC/compile paths.  Everything else stays a BLOCK.
LIBRARY_PRIMITIVE_TYPES = {
    "Device:R": "R",
    "Device:C": "C",
    "Device:LED": "D",
}

# pin_nets is keyed by KiCad package pin number; native primitives keep the
# netlist pin idiom (EDITABLE_PIN_NAMES).  KiCad Device diodes/LEDs number the
# cathode as pin 1 and the anode as pin 2, so D swaps the a/b roles.
LIBRARY_PRIMITIVE_PIN_ROLES = {
    "R": {"1": "a", "2": "b"},
    "C": {"1": "a", "2": "b"},
    "D": {"1": "b", "2": "a"},
}


def resolve_library_footprint(
    index: dict[str, Any],
    symbol_entry: dict[str, Any] | None,
    explicit: str = "",
) -> str:
    """Resolve the final footprint for a library placement.

    An explicit footprint must exist in the bundled index; otherwise fall
    back to the symbol's default_footprint, then to LIBRARY_FALLBACK_FOOTPRINTS.
    Returns "" when nothing can be resolved.
    """
    from kicad_library import get_footprint

    if explicit:
        if get_footprint(index, explicit) is None:
            raise ValueError(f"unknown library footprint: {explicit}")
        return explicit
    default_footprint = str((symbol_entry or {}).get("default_footprint") or "").strip()
    if default_footprint:
        return default_footprint
    fallback = LIBRARY_FALLBACK_FOOTPRINTS.get(str((symbol_entry or {}).get("id") or ""), "")
    if fallback and get_footprint(index, fallback) is not None:
        return fallback
    return ""


# KiCad pin orientation (direction the lead points into the symbol body)
# mapped onto the BLOCK side the pin belongs to.
_KICAD_PIN_SIDE = {"R": "left", "L": "right", "U": "bottom", "D": "top"}


def _pin_number_sort_key(number: str) -> tuple[int, Any]:
    return (0, int(number)) if number.isdigit() else (1, number)


def library_block_layout(
    symbol_pins: list[dict[str, Any]],
) -> tuple[dict[str, dict[str, Any]], dict[str, int]]:
    """Distribute KiCad symbol pins over BLOCK sides and derive body geometry.

    Returns ({pin_number: {"side", "order"}}, {"width", "height"}).  Order 0
    renders at the top (left/right sides) or left (top/bottom sides), matching
    the schematic document's block layout, so the block roughly mirrors the
    KiCad symbol shape.
    """
    side_by_number: dict[str, str] = {}
    for pin in symbol_pins:
        number = str(pin.get("number", ""))
        side = _KICAD_PIN_SIDE.get(str(pin.get("orientation", "")).upper())
        if side is None:
            side = "left" if float(pin.get("x", 0.0) or 0.0) < 0 else "right"
        side_by_number[number] = side
    layout: dict[str, dict[str, Any]] = {}
    counts = {"left": 0, "right": 0, "top": 0, "bottom": 0}
    for side in ("left", "right", "top", "bottom"):
        members = [pin for pin in symbol_pins if side_by_number[str(pin.get("number", ""))] == side]
        counts[side] = len(members)
        if side in ("left", "right"):
            # KiCad y grows upward; order 0 is the topmost slot.
            members.sort(key=lambda pin: (-float(pin.get("y", 0.0) or 0.0), _pin_number_sort_key(str(pin.get("number", "")))))
        else:
            members.sort(key=lambda pin: (float(pin.get("x", 0.0) or 0.0), _pin_number_sort_key(str(pin.get("number", "")))))
        for order, pin in enumerate(members):
            layout[str(pin.get("number", ""))] = {"side": side, "order": order}
    horizontal = max(counts["top"], counts["bottom"])
    vertical = max(counts["left"], counts["right"])
    block = {
        "width": max(160, min(460, ((horizontal * 40 + 60 + 19) // 20) * 20)),
        "height": max(120, min(460, ((vertical * 28 + 44 + 19) // 20) * 20)),
    }
    return layout, block


def place_library_component(
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]],
    operation: dict[str, Any],
) -> str:
    """Create or update a BLOCK component from the bundled KiCad library."""
    module_id = str(operation.get("module_id") or "").strip()
    module = modules.get(module_id)
    if module is None:
        raise ValueError(f"unknown module: {module_id}")
    kind = normalize_project_kind(project.get("project_kind") or DEFAULT_PROJECT_KIND)
    if kind != "pcb_schematic":
        raise ValueError(
            f"place_library_component requires project_kind=pcb_schematic (got {kind})"
        )
    name = str(operation.get("name") or "").strip()
    if not name:
        raise ValueError("place_library_component requires a component name")
    value = str(operation.get("value") or "").strip()
    symbol_id = str(operation.get("symbol") or "").strip()
    if not symbol_id:
        raise ValueError("place_library_component requires a symbol (Lib:Name)")
    from kicad_library import get_symbol

    index = kicad_library_index()
    symbol_entry = get_symbol(index, symbol_id)
    if symbol_entry is None:
        raise ValueError(f"unknown library symbol: {symbol_id}")
    symbol_pins = symbol_entry.get("pins") or []
    if not symbol_pins:
        raise ValueError(f"library symbol has no pins: {symbol_id}")
    expected_numbers = [str(pin.get("number", "")) for pin in symbol_pins]
    pin_nets = operation.get("pin_nets")
    if not isinstance(pin_nets, dict):
        raise ValueError("place_library_component requires pin_nets (object keyed by pin number)")
    given = {str(key): str(net).strip() for key, net in pin_nets.items()}
    expected_set = set(expected_numbers)
    missing = [number for number in expected_numbers if number not in given]
    unknown = sorted(set(given) - expected_set, key=_pin_number_sort_key)
    if missing or unknown:
        details = []
        if missing:
            details.append("missing pins: " + ", ".join(missing))
        if unknown:
            details.append("unknown pins: " + ", ".join(unknown))
        raise ValueError(
            f"pin_nets must cover exactly the {len(expected_numbers)} pins of "
            f"{symbol_id} ({'; '.join(details)})"
        )
    empty = sorted((number for number, net in given.items() if not net), key=_pin_number_sort_key)
    if empty:
        raise ValueError(f"pin_nets has empty net names for pins: {', '.join(empty)}")
    footprint = resolve_library_footprint(
        index, symbol_entry, str(operation.get("footprint") or "").strip()
    )
    if not footprint:
        raise ValueError(
            f"no footprint available for {symbol_id}; pass an explicit footprint "
            "from the bundled library"
        )
    component_type = LIBRARY_PRIMITIVE_TYPES.get(symbol_id, "BLOCK")
    if component_type == "BLOCK":
        layout, block = library_block_layout(symbol_pins)
        pins = []
        for pin in symbol_pins:
            number = str(pin.get("number", ""))
            pin_name = str(pin.get("name", "")).strip()
            pins.append({
                "id": number,
                "name": pin_name if pin_name not in {"", "~"} else number,
                "net": given[number],
                "side": layout[number]["side"],
                "order": layout[number]["order"],
            })
    else:
        block = None
        # Native primitive: keep the netlist pin idiom (a/b with the display
        # names from EDITABLE_PIN_NAMES) so renderers, ERC, and compile treat
        # the part exactly like a netlist-created R/C/D.
        number_by_pin_id = {
            pin_id: number for number, pin_id in LIBRARY_PRIMITIVE_PIN_ROLES[component_type].items()
        }
        pins = [
            {
                "id": pin_id,
                "name": display_name,
                "net": given[number_by_pin_id[pin_id]],
            }
            for pin_id, display_name in EDITABLE_PIN_NAMES[component_type]
        ]
    position = operation.get("position")
    if isinstance(position, dict) and "x" in position and "y" in position:
        position = {"x": float(position["x"]), "y": float(position["y"])}
    else:
        position = None
    eda_fields = {"symbol": symbol_id, "footprint": footprint, "refdes": name, "library": "kicad"}
    slug_base = re.sub(r"[^a-z0-9_]+", "_", name.lower()).strip("_")
    components = module.setdefault("components", [])
    existing = next(
        (
            component
            for component in components
            if str(component.get("name", "")).casefold() == name.casefold()
            or (slug_base and str(component.get("id", "")) == slug_base)
        ),
        None,
    )
    if existing is None:
        used_ids = {str(component.get("id", "")) for component in components}
        slot = len(components)
        if position is None:
            # The BLOCK and primitive auto-grids use different origins and
            # spacings, so their slots can coincide (and any grid slot can
            # collide with an explicitly positioned part).  Advance to the
            # first slot that keeps clearance from everything already placed.
            occupied = [
                (float(placed["position"]["x"]), float(placed["position"]["y"]))
                for placed in components
                if isinstance(placed.get("position"), dict)
                and isinstance(placed["position"].get("x"), (int, float))
                and isinstance(placed["position"].get("y"), (int, float))
            ]
            while True:
                candidate = (
                    {
                        "x": 160.0 + (slot % 3) * 260.0,
                        "y": 160.0 + (slot // 3) * 260.0,
                    }
                    if block is not None
                    else {
                        # Same auto-grid as parse_editable_netlist_components.
                        "x": 140.0 + (slot % 4) * 180.0,
                        "y": 120.0 + (slot // 4) * 140.0,
                    }
                )
                if all(
                    abs(candidate["x"] - occupied_x) >= 80.0 or abs(candidate["y"] - occupied_y) >= 80.0
                    for occupied_x, occupied_y in occupied
                ):
                    position = candidate
                    break
                slot += 1
        component = {
            "id": editable_component_id(name, used_ids),
            "type": component_type,
            "name": name,
            "value": value,
            "position": position,
            # parse_editable_netlist_components default for R/C/D.
            "rotation": 0,
            "pins": pins,
            "eda": eda_fields,
        }
        if block is not None:
            component["block"] = block
        components.append(component)
    else:
        existing["type"] = component_type
        existing["name"] = name
        existing["value"] = value
        if block is not None:
            existing["block"] = block
        else:
            existing.pop("block", None)
        existing["pins"] = pins
        previous_eda = existing.get("eda") if isinstance(existing.get("eda"), dict) else {}
        existing["eda"] = {**previous_eda, **eda_fields}
        if position is not None:
            existing["position"] = position
    return module_id


def apply_operation(
    root: Path,
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]],
    operation: dict[str, Any],
    changed_modules: set[str],
    schematic_override_writes: dict[str, dict[str, Any]],
    notebook_writes: dict[str, str | None],
) -> None:
    operation = normalize_operation(operation)
    op = operation.get("op")
    if op == "restore_revision":
        target_revision = int(operation.get("revision", -1))
        result_root = root / "revisions" / f"{target_revision:06d}" / "result"
        restored_project_path = result_root / "project.circuit.json"
        if target_revision < 1 or not restored_project_path.exists():
            raise ValueError(f"revision {target_revision} does not have a restorable result snapshot")
        current_project_id = project["project_id"]
        current_revision = project["revision"]
        current_created_at = project.get("created_at")
        current_module_revisions = {
            module_id: int(module.get("revision", 0))
            for module_id, module in modules.items()
        }
        restored_project = read_json(restored_project_path)
        restored_modules: dict[str, dict[str, Any]] = {}
        for module_ref in restored_project.get("modules", []):
            module_id = str(module_ref.get("id", ""))
            restored_module_path = result_root / "modules" / module_id / "module.circuit.json"
            if not module_id or not restored_module_path.exists():
                raise ValueError(f"revision {target_revision} is missing module {module_id or '<unknown>'}")
            restored_module = read_json(restored_module_path)
            restored_module["revision"] = current_module_revisions.get(
                module_id,
                int(restored_module.get("revision", 0)),
            )
            restored_modules[module_id] = restored_module
            restored_notebook = result_root / "modules" / module_id / "netlist-notebook.md"
            if restored_notebook.exists():
                notebook_writes[module_id] = restored_notebook.read_text(encoding="utf-8")
            else:
                notebook_writes[module_id] = None
            restored_overrides = result_root / "modules" / module_id / "schematic.overrides.json"
            if restored_overrides.exists():
                schematic_override_writes[module_id] = read_json(restored_overrides)
            else:
                schematic_override_writes[module_id] = {
                    "schema": SCHEMATIC_OVERRIDES_SCHEMA,
                    "project_id": current_project_id,
                    "module_id": module_id,
                    "updated_at": utc_now(),
                    "items": {},
                }
        project.clear()
        project.update(restored_project)
        project["project_id"] = current_project_id
        project["revision"] = current_revision
        if current_created_at:
            project["created_at"] = current_created_at
        modules.clear()
        modules.update(restored_modules)
        changed_modules.update(restored_modules)
        return
    module_id_for_guard = str(operation.get("module_id") or "").strip()
    externally_locked_ops = {
        "add_component",
        "place_library_component",
        "remove_component",
        "add_port",
        "set_component_value",
        "move_component",
        "upsert_module_netlist",
        "set_module_schematic",
        "set_module_netlist",
        "move_schematic_item",
        "reset_schematic_item",
        "connect_pins",
    }
    if module_id_for_guard and op in externally_locked_ops:
        locked_module = modules.get(module_id_for_guard)
        peer = locked_module.get("schematic_peer") if isinstance(locked_module, dict) else None
        if (
            isinstance(peer, dict)
            and peer.get("mode") == "external"
            and operation.get("source") != "xschem"
        ):
            raise ValueError(
                f"module {module_id_for_guard} is read-only because Xschem is authoritative"
            )
    if op == "upsert_module":
        module_ref = dict(operation["module_ref"])
        module = operation["module"]
        module_id = module_ref["id"]
        if module.get("module_id") != module_id:
            raise ValueError("upsert_module ids do not match")
        validate_module(module, project.get("project_kind"))
        previous_ref = next(
            (entry for entry in project.get("modules", []) if entry.get("id") == module_id),
            None,
        )
        module_size = dict(module_ref.get("size") or (previous_ref or {}).get("size") or DEFAULT_MODULE_SIZE)
        preferred = module_ref.get("position") if isinstance(module_ref.get("position"), dict) else None
        previous = (previous_ref or {}).get("position") if isinstance(previous_ref, dict) else None
        module_ref["size"] = module_size
        module_ref["position"] = resolve_module_canvas_position(
            project,
            module_id=str(module_id),
            preferred=preferred,
            size=module_size,
            previous=previous if isinstance(previous, dict) else None,
        )
        project["modules"] = [
            entry for entry in project["modules"] if entry.get("id") != module_id
        ]
        project["modules"].append(module_ref)
        ensure_module_stable_ids(module)
        modules[module_id] = module
        changed_modules.add(module_id)
        return
    if op == "remove_module":
        module_id = operation["module_id"]
        find_module_ref(project, module_id)
        project["modules"] = [
            entry for entry in project["modules"] if entry.get("id") != module_id
        ]
        project["connections"] = [
            connection for connection in project.get("connections", [])
            if connection["from"]["module_id"] != module_id
            and connection["to"]["module_id"] != module_id
        ]
        modules.pop(module_id, None)
        return
    if op == "add_component":
        module_id = operation["module_id"]
        module = modules[module_id]
        component = operation["component"]
        if any(entry.get("id") == component.get("id") for entry in module["components"]):
            raise ValueError(f"component already exists: {component.get('id')}")
        module["components"].append(component)
        changed_modules.add(module_id)
        return
    if op == "place_library_component":
        changed_modules.add(place_library_component(project, modules, operation))
        return
    if op == "remove_component":
        module_id = operation["module_id"]
        module = modules[module_id]
        component_id = operation["component_id"]
        before = len(module["components"])
        module["components"] = [
            component for component in module["components"]
            if component.get("id") != component_id
        ]
        if len(module["components"]) == before:
            raise ValueError(f"unknown component: {module_id}.{component_id}")
        changed_modules.add(module_id)
        return
    if op == "add_port":
        module_id = str(operation.get("module_id") or "").strip()
        if not module_id:
            module_ids = list(modules.keys())
            if len(module_ids) == 1:
                module_id = module_ids[0]
            else:
                raise ValueError("add_port requires module_id")
        module = modules[module_id]
        port = operation.get("port")
        if not isinstance(port, dict):
            port_id = str(operation.get("port_id") or operation.get("id") or "").strip()
            if not port_id:
                raise ValueError("add_port requires port or port_id")
            port = {
                "id": port_id,
                "name": str(operation.get("name") or port_id),
                "direction": str(operation.get("direction") or "bidirectional"),
                "signal_type": str(operation.get("signal_type") or "analog"),
                "net": str(operation.get("net") or port_id),
            }
        if any(entry.get("id") == port.get("id") for entry in module.get("ports", [])):
            raise ValueError(f"port already exists: {module_id}.{port.get('id')}")
        module.setdefault("ports", []).append(port)
        # module_ref["ports"] may be the same list object as module["ports"]
        # after upsert_module_netlist; sync by assignment to avoid duplicate ids.
        find_module_ref(project, module_id)["ports"] = list(module.get("ports", []))
        changed_modules.add(module_id)
        return
    if op == "move_module":
        module_ref = find_module_ref(project, operation["module_id"])
        module_ref["position"] = {"x": float(operation["x"]), "y": float(operation["y"])}
        return
    if op == "resize_module":
        module_ref = find_module_ref(project, operation["module_id"])
        width = float(operation["width"])
        height = float(operation["height"])
        if width <= 0 or height <= 0:
            raise ValueError("module size must be positive")
        module_ref["size"] = {"width": width, "height": height}
        return
    if op == "set_module_note":
        module_ref = find_module_ref(project, operation["module_id"])
        module_ref["notes"] = str(operation.get("notes", ""))
        return
    if op == "set_module_preview":
        module_ref = find_module_ref(project, operation["module_id"])
        module_ref["preview_enabled"] = bool(operation.get("enabled", True))
        return
    if op == "set_module_metadata":
        module_id = operation["module_id"]
        module_ref = find_module_ref(project, module_id)
        if "name" in operation:
            name = str(operation["name"]).strip()
            if not name:
                raise ValueError("module name cannot be empty")
            module_ref["name"] = name
            modules[module_id]["name"] = name
            changed_modules.add(module_id)
        if "kind" in operation:
            kind = str(operation["kind"]).strip()
            if not kind:
                raise ValueError("module kind cannot be empty")
            module_ref["kind"] = kind
        if "function" in operation:
            module_ref["function"] = str(operation["function"]).strip()
        if "parameters" in operation:
            parameters = operation["parameters"]
            if not isinstance(parameters, dict):
                raise ValueError("module parameters must be an object")
            module_ref["parameters"] = {
                str(key): str(value) for key, value in parameters.items()
            }
        return
    if op == "set_project_kind":
        next_kind = normalize_project_kind(operation.get("project_kind"))
        previous_kind = ensure_project_kind(project)
        if next_kind == previous_kind:
            return
        for module_id, module in modules.items():
            try:
                validate_module(module, next_kind)
            except ValueError as error:
                raise ValueError(
                    f"cannot change project_kind to {next_kind}: module {module_id}: {error}"
                ) from error
        project["project_kind"] = next_kind
        if not supports_analog_ic_profile(next_kind) and project.get("analog_ic_profile") is not None:
            project.pop("analog_ic_profile", None)
        validate_project(project)
        return
    if op == "set_analog_ic_profile":
        if not supports_analog_ic_profile(project.get("project_kind")):
            raise ValueError("set_analog_ic_profile requires project_kind=analog_ic or mixed_signal_ic")
        profile = operation.get("profile")
        profile_errors = validate_analog_ic_profile(profile)
        if profile_errors:
            raise ValueError(profile_errors[0]["message"])
        project["analog_ic_profile"] = json.loads(json.dumps(profile))
        return
    if op == "set_schematic_peer":
        module_id = str(operation.get("module_id") or "")
        module = modules.get(module_id)
        if module is None:
            raise ValueError(f"unknown module: {module_id}")
        module["schematic_peer"] = validate_xschem_binding(operation.get("binding"))
        changed_modules.add(module_id)
        return
    if op == "set_component_value":
        module_id = operation["module_id"]
        component = find_component(modules[module_id], operation["component_id"])
        value = str(operation["value"]).strip()
        if not value:
            raise ValueError("component value cannot be empty")
        component["value"] = value
        changed_modules.add(module_id)
        return
    if op == "move_component":
        module_id = operation["module_id"]
        component = find_component(modules[module_id], operation["component_id"])
        component["position"] = {"x": float(operation["x"]), "y": float(operation["y"])}
        changed_modules.add(module_id)
        return
    if op == "upsert_module_netlist":
        module_id = str(operation.get("module_id", "")).strip()
        if not module_id or not re.fullmatch(r"[A-Za-z0-9_.-]+", module_id):
            raise ValueError("upsert_module_netlist requires a stable module_id")
        notebook = coerce_netlist_notebook_text(operation.get("netlist_notebook"), operation=operation)
        existing = modules.get(module_id, {
            "schema": MODULE_SCHEMA,
            "module_id": module_id,
            "name": str(operation.get("name") or module_id),
            "revision": 0,
            "ports": [],
            "components": [],
            "nets": [],
            "wires": [],
            "annotations": [],
        })
        existing = {
            **existing,
            "name": str(operation.get("name") or existing.get("name") or module_id).strip(),
        }
        next_module = module_from_netlist_notebook(
            module_id,
            notebook,
            existing,
            project.get("project_kind"),
        )
        modules[module_id] = next_module
        previous_ref = next(
            (entry for entry in project.get("modules", []) if entry.get("id") == module_id),
            None,
        )
        preferred = operation.get("position") if isinstance(operation.get("position"), dict) else None
        previous = (previous_ref or {}).get("position") if isinstance(previous_ref, dict) else None
        # Updating a notebook without an explicit move should keep the prior card seat when free.
        if preferred is None and previous_ref is not None:
            preferred = previous if isinstance(previous, dict) else None
        module_size = dict(operation.get("size") or (previous_ref or {}).get("size") or DEFAULT_MODULE_SIZE)
        module_ref = {
            **(previous_ref or {}),
            "id": module_id,
            "name": next_module["name"],
            "kind": str(operation.get("kind") or (previous_ref or {}).get("kind") or "circuit"),
            "function": str(operation.get("function") or (previous_ref or {}).get("function") or ""),
            "parameters": dict(operation.get("parameters") or (previous_ref or {}).get("parameters") or {}),
            "notes": str(operation.get("notes") or (previous_ref or {}).get("notes") or ""),
            "preview_enabled": bool(operation.get("preview_enabled", (previous_ref or {}).get("preview_enabled", True))),
            "source": f"modules/{module_id}/module.circuit.json",
            "size": module_size,
            "position": resolve_module_canvas_position(
                project,
                module_id=module_id,
                preferred=preferred if isinstance(preferred, dict) else None,
                size=module_size,
                previous=previous if isinstance(previous, dict) else None,
            ),
            "ports": next_module["ports"],
        }
        project["modules"] = [
            entry for entry in project.get("modules", []) if entry.get("id") != module_id
        ]
        project["modules"].append(module_ref)
        notebook_writes[module_id] = notebook
        changed_modules.add(module_id)
        return
    if op == "set_module_schematic":
        module_id = operation["module_id"]
        module = modules[module_id]
        expected_connectivity_hash = operation.get("expected_connectivity_hash")
        connectivity_view = str(operation.get("connectivity_view", "design"))
        if expected_connectivity_hash is not None:
            if not isinstance(expected_connectivity_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_connectivity_hash):
                raise ValueError("set_module_schematic expected_connectivity_hash must be a SHA-256 hex digest")
            if connectivity_view not in {"design", "simulation"}:
                raise ValueError("set_module_schematic connectivity_view must be design or simulation")
            current_connectivity_hash = connectivity_hash(
                project,
                {module_id: module},
                module_id,
                connectivity_view,
            )
            if current_connectivity_hash != expected_connectivity_hash:
                raise ValueError("set_module_schematic source connectivity does not match the guarded layout hash")
        components = operation.get("components")
        ports = operation.get("ports")
        wires = operation.get("wires", [])
        nets = operation.get("nets", module.get("nets", []))
        annotations = operation.get("annotations", module.get("annotations", []))
        notebook = operation.get("netlist_notebook")
        if not isinstance(components, list):
            raise ValueError("set_module_schematic components must be an array")
        if not isinstance(ports, list):
            raise ValueError("set_module_schematic ports must be an array")
        if not isinstance(wires, list):
            raise ValueError("set_module_schematic wires must be an array")
        if not isinstance(nets, list):
            raise ValueError("set_module_schematic nets must be an array")
        if not isinstance(annotations, list):
            raise ValueError("set_module_schematic annotations must be an array")
        previous_ports = list(module.get("ports", []))
        next_module = {
            **module,
            "components": components,
            "ports": ports,
            "wires": wires,
            "nets": nets,
            "annotations": annotations,
        }
        if notebook is not None:
            notebook = coerce_netlist_notebook_text(notebook)
            netlist_text = extract_notebook_netlist(notebook)
            netlist_validation = validate_netlist_text(
                netlist_text,
                project.get("project_kind") or DEFAULT_PROJECT_KIND,
                source=f"module:{module_id}",
            )
            if not netlist_validation["ok"]:
                first = netlist_validation["violations"][0]
                raise ValueError(
                    f"netlist is not valid for project_kind={netlist_validation['project_kind']}: "
                    f"line {first['line']}: {first['message']}"
                )
            next_module["spice"] = parse_spice_source(module_id, netlist_text, components)
            notebook_writes[module_id] = notebook
        next_module = upgrade_module_document(next_module)
        ensure_module_stable_ids(next_module)
        validate_module(next_module, project.get("project_kind"))
        if expected_connectivity_hash is not None:
            next_connectivity_hash = connectivity_hash(
                project,
                {module_id: next_module},
                module_id,
                connectivity_view,
            )
            if next_connectivity_hash != expected_connectivity_hash:
                raise ValueError("set_module_schematic layout update would change authoritative connectivity")
        module["components"] = next_module["components"]
        module["ports"] = next_module["ports"]
        module["wires"] = next_module.get("wires", [])
        module["nets"] = next_module.get("nets", [])
        module["annotations"] = next_module.get("annotations", [])
        module["schema"] = next_module["schema"]
        if "spice" in next_module:
            module["spice"] = next_module["spice"]
        find_module_ref(project, module_id)["ports"] = next_module["ports"]
        rewrite_module_port_connections(project, module_id, previous_ports, next_module["ports"])
        changed_modules.add(module_id)
        return
    if op == "set_module_netlist":
        module_id = str(operation["module_id"])
        module = modules[module_id]
        previous_ports = list(module.get("ports", []))
        notebook = coerce_netlist_notebook_text(operation.get("netlist_notebook"))
        next_module = module_from_netlist_notebook(
            module_id,
            notebook,
            module,
            project.get("project_kind"),
        )
        modules[module_id] = next_module
        find_module_ref(project, module_id)["ports"] = next_module["ports"]
        rewrite_module_port_connections(project, module_id, previous_ports, next_module["ports"])
        notebook_writes[module_id] = notebook
        changed_modules.add(module_id)
        return
    if op == "bind_lcsc_part":
        from lcsc_search import bind_part_to_component, get_part

        if not supports_lcsc_binding(project.get("project_kind", DEFAULT_PROJECT_KIND)):
            raise ValueError("LCSC binding requires project_kind=pcb_schematic")
        module_id = str(operation["module_id"])
        component_id = str(operation["component_id"])
        module = modules[module_id]
        component = next((entry for entry in module.get("components", []) if entry.get("id") == component_id), None)
        if component is None:
            raise ValueError(f"unknown component: {component_id}")
        part = operation.get("part")
        if not isinstance(part, dict):
            lcsc_id = str(operation.get("lcsc_id") or "").strip()
            if not lcsc_id:
                raise ValueError("bind_lcsc_part requires part or lcsc_id")
            looked_up = get_part(
                lcsc_id,
                api_key=os.environ.get("ACTOVIQ_LCSC_API_KEY", ""),
                api_secret=os.environ.get("ACTOVIQ_LCSC_API_SECRET", ""),
                use_fallback=bool(operation.get("use_fallback", False)),
            )
            if not looked_up.get("ok"):
                raise ValueError(looked_up.get("error") or f"LCSC part not found: {lcsc_id}")
            part = looked_up["part"]
        bind_part_to_component(component, part)
        ensure_module_stable_ids(module)
        changed_modules.add(module_id)
        return
    if op == "move_schematic_item":
        module_id = str(operation["module_id"])
        find_module_ref(project, module_id)
        if module_id not in modules:
            raise ValueError(f"unknown module: {module_id}")
        item_id = normalize_schematic_item_id(operation.get("item_id"))
        overrides = schematic_override_writes.get(module_id)
        if overrides is None:
            overrides = read_schematic_overrides(root, project, module_id)
        items = dict(overrides.get("items") or {})
        items[item_id] = {
            "x": schematic_position(operation.get("x"), "x"),
            "y": schematic_position(operation.get("y"), "y"),
            "locked": bool(operation.get("locked", True)),
        }
        overrides.update({
            "schema": SCHEMATIC_OVERRIDES_SCHEMA,
            "project_id": project["project_id"],
            "module_id": module_id,
            "updated_at": utc_now(),
            "items": items,
        })
        schematic_override_writes[module_id] = overrides
        changed_modules.add(module_id)
        return
    if op == "reset_schematic_item":
        module_id = str(operation["module_id"])
        find_module_ref(project, module_id)
        if module_id not in modules:
            raise ValueError(f"unknown module: {module_id}")
        item_id = normalize_schematic_item_id(operation.get("item_id"))
        overrides = schematic_override_writes.get(module_id)
        if overrides is None:
            overrides = read_schematic_overrides(root, project, module_id)
        items = dict(overrides.get("items") or {})
        items.pop(item_id, None)
        overrides.update({
            "schema": SCHEMATIC_OVERRIDES_SCHEMA,
            "project_id": project["project_id"],
            "module_id": module_id,
            "updated_at": utc_now(),
            "items": items,
        })
        schematic_override_writes[module_id] = overrides
        changed_modules.add(module_id)
        return
    if op == "connect_ports":
        source = operation.get("from")
        target = operation.get("to")
        if not isinstance(source, dict):
            if operation.get("from_module") and operation.get("from_port"):
                source = {
                    "module_id": str(operation["from_module"]),
                    "port_id": str(operation["from_port"]),
                }
        if not isinstance(target, dict):
            if operation.get("to_module") and operation.get("to_port"):
                target = {
                    "module_id": str(operation["to_module"]),
                    "port_id": str(operation["to_port"]),
                }
            elif isinstance(source, dict) and operation.get("to_port") and not operation.get("to_module"):
                # Same-module shorthand occasionally emitted by LLMs.
                target = {
                    "module_id": str(source["module_id"]),
                    "port_id": str(operation["to_port"]),
                }
        ports = operation.get("ports")
        if (not isinstance(source, dict) or not isinstance(target, dict)) and isinstance(ports, list):
            endpoints: list[dict[str, str]] = []
            for entry in ports:
                if not isinstance(entry, dict):
                    continue
                mid = str(entry.get("module_id") or "").strip()
                pid = str(entry.get("port_id") or entry.get("id") or "").strip()
                if mid and pid:
                    endpoints.append({"module_id": mid, "port_id": pid})
            if len(endpoints) < 2:
                raise ValueError("connect_ports requires from/to or at least two ports")
            # Star-connect around the first endpoint; recurse via repeated ops.
            network = str(operation.get("network") or operation.get("net") or "").strip()
            for endpoint in endpoints[1:]:
                apply_operation(
                    root,
                    project,
                    modules,
                    {
                        "op": "connect_ports",
                        "from": endpoints[0],
                        "to": endpoint,
                        **({"network": network} if network else {}),
                    },
                    changed_modules,
                    schematic_override_writes,
                    notebook_writes,
                )
            return
        if not isinstance(source, dict) or not isinstance(target, dict):
            raise ValueError("connect_ports requires from and to endpoints")
        find_module_ref(project, source["module_id"])
        find_module_ref(project, target["module_id"])
        endpoint_pair = {
            (source["module_id"], source["port_id"]),
            (target["module_id"], target["port_id"]),
        }
        existing = next(
            (
                connection for connection in project.get("connections", [])
                if {
                    (connection["from"]["module_id"], connection["from"]["port_id"]),
                    (connection["to"]["module_id"], connection["to"]["port_id"]),
                } == endpoint_pair
            ),
            None,
        )
        connection_id = (
            operation.get("connection_id")
            or (existing.get("id") if existing else None)
            or f"{source['module_id']}-{source['port_id']}-to-{target['module_id']}-{target['port_id']}"
        )
        project["connections"] = [
            connection for connection in project.get("connections", [])
            if connection.get("id") != connection_id
        ]
        connection = {"id": connection_id, "from": source, "to": target}
        network = str(operation.get("network") or operation.get("net") or (existing or {}).get("network") or "").strip()
        if network:
            connection["network"] = network
        project["connections"].append(connection)
        if network:
            set_connection_group_network(project, connection_id, network)
        return
    if op == "set_connection_network":
        set_connection_group_network(
            project,
            str(operation["connection_id"]),
            str(operation["network"]),
        )
        return
    if op == "connect_pins":
        module_id = operation["module_id"]
        module = modules[module_id]
        first = operation["first"]
        second = operation["second"]
        first_pin = next(
            pin for pin in find_component(module, first["component_id"])["pins"]
            if pin["id"] == first["pin_id"]
        )
        second_pin = next(
            pin for pin in find_component(module, second["component_id"])["pins"]
            if pin["id"] == second["pin_id"]
        )
        net_a = first_pin["net"]
        net_b = second_pin["net"]
        if net_a == net_b:
            changed_modules.add(module_id)
            return
        # Ground / node "0" must always survive a merge, regardless of click order,
        # so connecting a signal pin to ground never renames the ground reference.
        if net_b == "0":
            new_net, old_net = "0", net_a
        else:
            new_net, old_net = net_a, net_b
        for component in module["components"]:
            for pin in component["pins"]:
                if pin["net"] == old_net:
                    pin["net"] = new_net
        for port in module.get("ports", []):
            if port.get("net") == old_net:
                port["net"] = new_net
        changed_modules.add(module_id)
        return
    raise ValueError(f"unsupported operation: {op}")


class ProjectLock:
    """Best-effort cross-process lock so concurrent edits cannot clobber a revision."""

    def __init__(self, root: Path, timeout: float = 30.0) -> None:
        self.path = root / ".project.lock"
        self.timeout = timeout

    def __enter__(self) -> "ProjectLock":
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                fd = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, str(os.getpid()).encode("ascii"))
                os.close(fd)
                return self
            except FileExistsError:
                try:
                    stale = time.time() - self.path.stat().st_mtime > 60
                except FileNotFoundError:
                    continue
                if stale:
                    self.path.unlink(missing_ok=True)
                    continue
                if time.monotonic() >= deadline:
                    raise ValueError("project is locked by another operation; retry shortly")
                time.sleep(0.05)

    def __exit__(self, *_exc: Any) -> None:
        self.path.unlink(missing_ok=True)


# M2-06: module soft lease. A short-lived UI lock per module so two actors
# editing the same module get a structured conflict instead of a silent
# overwrite. File locks guard atomicity; leases guard intent. Expired leases
# are recoverable: a lease older than LEASE_TTL_SECONDS is treated as gone.
LEASE_TTL_SECONDS = 300.0


def lease_path(root: Path, module_id: str) -> Path:
    safe = "".join(c for c in module_id if c.isalnum() or c in ("-", "_"))
    return root / "leases" / f"{safe}.json"


def lease_is_active(existing: dict[str, Any], now: float | None = None) -> bool:
    """True while the lease still blocks other actors."""
    current = time.time() if now is None else now
    expires_at = existing.get("expires_at")
    if isinstance(expires_at, (int, float)):
        return current < float(expires_at)
    return current - float(existing.get("acquired_at", 0) or 0) < LEASE_TTL_SECONDS


def acquire_module_lease(
    root: Path, module_id: str, actor: str, ttl: float = LEASE_TTL_SECONDS
) -> dict[str, Any]:
    """Acquire or renew a soft lease on a module. Returns the lease record.

    If a non-expired lease exists for a different actor, raises ValueError
    with the holder so the UI can surface a structured conflict. An expired
    lease is silently taken over.
    """
    path = lease_path(root, module_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    now = time.time()
    if path.exists():
        existing = read_json(path)
        if existing.get("actor") != actor and lease_is_active(existing, now):
            raise ValueError(
                f"module {module_id} is leased by {existing.get('actor')} since "
                f"{existing.get('acquired_at')}; retry or ask the holder to release"
            )
    lease = {
        "schema": "actoviq.module-lease.v1",
        "module_id": module_id,
        "actor": actor,
        "acquired_at": now,
        "expires_at": now + ttl,
        "ttl_seconds": float(ttl),
    }
    atomic_write_json(path, lease)
    return lease


def release_module_lease(root: Path, module_id: str, actor: str) -> dict[str, Any]:
    """Release a lease; only the holder may release it. Expired leases are gone."""
    path = lease_path(root, module_id)
    if not path.exists():
        return {"released": True, "module_id": module_id, "note": "no lease present"}
    existing = read_json(path)
    if existing.get("actor") != actor:
        if lease_is_active(existing):
            raise ValueError(
                f"cannot release lease held by {existing.get('actor')}"
            )
    path.unlink(missing_ok=True)
    return {"released": True, "module_id": module_id, "actor": actor}


def check_module_lease(root: Path, module_id: str, actor: str) -> None:
    """Raise if a non-expired lease on module_id is held by a different actor."""
    path = lease_path(root, module_id)
    if not path.exists():
        return
    existing = read_json(path)
    if existing.get("actor") == actor:
        return
    if not lease_is_active(existing):
        return
    raise ValueError(
        f"module {module_id} is leased by {existing.get('actor')}; edit blocked"
    )


def command_lease_module_ids(command: dict[str, Any]) -> list[str]:
    """Modules whose soft leases must be checked for this command."""
    if command.get("schema") == "actoviq.command.v2":
        module_id = str(command.get("module_id") or "").strip()
        return [module_id] if module_id else []
    module_ids: list[str] = []
    for operation in command.get("operations") or []:
        if not isinstance(operation, dict):
            continue
        module_id = str(operation.get("module_id") or "").strip()
        if module_id:
            module_ids.append(module_id)
    return sorted(set(module_ids))


def _v2_point(value: Any, label: str) -> dict[str, float]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a position object")
    return {
        "x": schematic_position(value.get("x"), f"{label}.x"),
        "y": schematic_position(value.get("y"), f"{label}.y"),
    }


def _v2_same_point(left: dict[str, Any], right: dict[str, Any], epsilon: float = 0.001) -> bool:
    return (
        abs(float(left.get("x", 0)) - float(right.get("x", 0))) <= epsilon
        and abs(float(left.get("y", 0)) - float(right.get("y", 0))) <= epsilon
    )


def _v2_wire_endpoint(value: Any, label: str) -> dict[str, Any]:
    endpoint = _v2_point(value, label)
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an endpoint object")
    identities = []
    if value.get("component_id") and value.get("pin_id"):
        endpoint["component_id"] = str(value["component_id"])
        endpoint["pin_id"] = str(value["pin_id"])
        identities.append("pin")
    if value.get("port_id"):
        endpoint["port_id"] = str(value["port_id"])
        identities.append("port")
    if value.get("junction_id"):
        endpoint["junction_id"] = str(value["junction_id"])
        identities.append("junction")
    if len(identities) != 1:
        raise ValueError(f"{label} must identify exactly one pin, port, or junction")
    return endpoint


def _v2_stable_junction(wire_id: str, side: str, endpoint: dict[str, Any]) -> str:
    payload = "|".join((
        wire_id,
        side,
        format(float(endpoint.get("x", 0)), ".12g"),
        format(float(endpoint.get("y", 0)), ".12g"),
    ))
    return f"j_{hashlib.sha256(payload.encode('utf-8')).hexdigest()[:16]}"


def _v2_endpoint_touches(
    endpoint: dict[str, Any] | None,
    component_ids: set[str],
    port_ids: set[str],
) -> bool:
    if not isinstance(endpoint, dict):
        return False
    return (
        str(endpoint.get("component_id") or "") in component_ids
        or str(endpoint.get("port_id") or "") in port_ids
    )


def _v2_shift_wire_endpoint(
    wire: dict[str, Any],
    side: str,
    dx: float,
    dy: float,
) -> None:
    endpoint = wire.get(side)
    points = wire.get("points")
    if not isinstance(endpoint, dict) or not isinstance(points, list) or len(points) < 2:
        return
    index = 0 if side == "from" else len(points) - 1
    adjacent_index = 1 if side == "from" else len(points) - 2
    old = dict(points[index])
    moved = {"x": float(old["x"]) + dx, "y": float(old["y"]) + dy}
    points[index] = moved
    endpoint["x"] = moved["x"]
    endpoint["y"] = moved["y"]
    adjacent = dict(points[adjacent_index])
    if float(old["x"]) == float(adjacent["x"]):
        adjacent["x"] = moved["x"]
    elif float(old["y"]) == float(adjacent["y"]):
        adjacent["y"] = moved["y"]
    points[adjacent_index] = adjacent


def _v2_split_wire_at(
    module: dict[str, Any],
    wire: dict[str, Any],
    point: dict[str, float],
    junction_id: str,
) -> list[str]:
    points = wire.get("points", [])
    if len(points) < 2:
        raise ValueError(f"split_wire: wire {wire.get('id')} has no path")
    existing_index = next(
        (index for index, existing in enumerate(points) if _v2_same_point(existing, point)),
        -1,
    )
    if existing_index == 0:
        endpoint = wire.get("from")
        if isinstance(endpoint, dict):
            endpoint.clear()
            endpoint.update({**point, "junction_id": junction_id})
        else:
            wire["from"] = {**point, "junction_id": junction_id}
        return [str(wire["id"])]
    if existing_index == len(points) - 1:
        endpoint = wire.get("to")
        if isinstance(endpoint, dict):
            endpoint.clear()
            endpoint.update({**point, "junction_id": junction_id})
        else:
            wire["to"] = {**point, "junction_id": junction_id}
        return [str(wire["id"])]
    split_index = existing_index if existing_index >= 1 else -1
    if split_index < 1:
        for index in range(1, len(points)):
            left = points[index - 1]
            right = points[index]
            within_x = min(left["x"], right["x"]) - 0.001 <= point["x"] <= max(left["x"], right["x"]) + 0.001
            within_y = min(left["y"], right["y"]) - 0.001 <= point["y"] <= max(left["y"], right["y"]) + 0.001
            cross = (
                (right["x"] - left["x"]) * (point["y"] - left["y"])
                - (right["y"] - left["y"]) * (point["x"] - left["x"])
            )
            if within_x and within_y and abs(cross) <= 0.001:
                split_index = index
                break
    if split_index < 1:
        raise ValueError(f"split_wire: point is not on wire {wire.get('id')}")
    existing_ids = {str(item.get("id")) for item in module.get("wires", [])}
    base_id = f"{wire['id']}__{junction_id}"
    right_id = base_id
    suffix = 2
    while right_id in existing_ids:
        right_id = f"{base_id}_{suffix}"
        suffix += 1
    original_to = json.loads(json.dumps(wire["to"]))
    split_point = json.loads(json.dumps(points[split_index] if existing_index >= 1 else point))
    junction = {**split_point, "junction_id": junction_id}
    right_wire = json.loads(json.dumps(wire))
    right_wire["id"] = right_id
    if existing_index >= 1:
        right_wire["points"] = [split_point, *json.loads(json.dumps(points[split_index + 1 :]))]
        wire["points"] = json.loads(json.dumps(points[: split_index + 1]))
    else:
        right_wire["points"] = [point, *json.loads(json.dumps(points[split_index:]))]
        wire["points"] = [*json.loads(json.dumps(points[:split_index])), point]
    right_wire["from"] = dict(junction)
    right_wire["to"] = original_to
    wire["to"] = dict(junction)
    module.setdefault("wires", []).append(right_wire)
    return [str(wire["id"]), right_id]


def apply_v2_operation(
    module: dict[str, Any],
    operation: dict[str, Any],
) -> set[str]:
    """Apply one strict command.v2 operation to a module in memory."""
    if not isinstance(operation, dict):
        raise ValueError("v2 operation must be an object")
    name = str(operation.get("op") or "")
    affected: set[str] = set()
    components = module.setdefault("components", [])
    ports = module.setdefault("ports", [])
    wires = module.setdefault("wires", [])

    if name == "place_component":
        component = json.loads(json.dumps(operation.get("component")))
        if not isinstance(component, dict) or not component.get("id"):
            raise ValueError("place_component requires a component")
        if any(item.get("id") == component["id"] for item in components):
            raise ValueError(f"place_component: component {component['id']} already exists")
        components.append(component)
        affected.add(str(component["id"]))
    elif name == "update_component":
        component_id = str(operation.get("component_id") or "")
        component = next((item for item in components if item.get("id") == component_id), None)
        if component is None:
            raise ValueError(f"update_component: component {component_id} not found")
        for key in ("name", "value", "position", "rotation", "parameters"):
            if key in operation:
                component[key] = json.loads(json.dumps(operation[key]))
        affected.add(component_id)
    elif name == "move_entities":
        ids = {str(value) for value in operation.get("entity_ids", [])}
        if not ids:
            raise ValueError("move_entities requires entity_ids")
        delta = _v2_point(operation.get("delta"), "move_entities.delta")
        dx, dy = delta["x"], delta["y"]
        component_ids = {str(item["id"]) for item in components if str(item.get("id")) in ids}
        port_ids = {
            str(item["id"])
            for item in ports
            if f"port:{item.get('id')}" in ids
        }
        for component in components:
            if str(component.get("id")) in component_ids:
                position = _v2_point(component.get("position"), f"component {component.get('id')}.position")
                component["position"] = {"x": position["x"] + dx, "y": position["y"] + dy}
        for port in ports:
            if str(port.get("id")) in port_ids:
                position = _v2_point(port.get("position") or {"x": 0, "y": 0}, f"port {port.get('id')}.position")
                port["position"] = {"x": position["x"] + dx, "y": position["y"] + dy}
        mode = operation.get("mode")
        for wire in wires:
            from_moved = _v2_endpoint_touches(wire.get("from"), component_ids, port_ids)
            to_moved = _v2_endpoint_touches(wire.get("to"), component_ids, port_ids)
            if not from_moved and not to_moved:
                continue
            affected.add(str(wire.get("id")))
            if from_moved and to_moved:
                for point in wire.get("points", []):
                    point["x"] = float(point["x"]) + dx
                    point["y"] = float(point["y"]) + dy
                for side in ("from", "to"):
                    endpoint = wire.get(side)
                    if isinstance(endpoint, dict):
                        endpoint["x"] = float(endpoint["x"]) + dx
                        endpoint["y"] = float(endpoint["y"]) + dy
            elif mode == "free":
                for side, moved in (("from", from_moved), ("to", to_moved)):
                    if not moved:
                        continue
                    endpoint = wire.get(side)
                    if isinstance(endpoint, dict):
                        wire[side] = {
                            "x": endpoint["x"],
                            "y": endpoint["y"],
                            "junction_id": _v2_stable_junction(str(wire["id"]), side, endpoint),
                        }
            elif mode == "stretch":
                if from_moved:
                    _v2_shift_wire_endpoint(wire, "from", dx, dy)
                if to_moved:
                    _v2_shift_wire_endpoint(wire, "to", dx, dy)
            else:
                raise ValueError(f"move_entities has invalid mode: {mode}")
        affected.update(component_ids)
        affected.update(f"port:{value}" for value in port_ids)
    elif name == "delete_entities":
        ids = {str(value) for value in operation.get("entity_ids", [])}
        component_ids = {str(item.get("id")) for item in components if str(item.get("id")) in ids}
        port_ids = {str(item.get("id")) for item in ports if f"port:{item.get('id')}" in ids}
        module["components"] = [item for item in components if str(item.get("id")) not in component_ids]
        module["ports"] = [item for item in ports if str(item.get("id")) not in port_ids]
        kept_wires = []
        for wire in wires:
            remove = (
                str(wire.get("id")) in ids
                or _v2_endpoint_touches(wire.get("from"), component_ids, port_ids)
                or _v2_endpoint_touches(wire.get("to"), component_ids, port_ids)
            )
            if remove:
                affected.add(str(wire.get("id")))
            else:
                kept_wires.append(wire)
        module["wires"] = kept_wires
        affected.update(ids)
    elif name == "create_wire":
        wire_id = str(operation.get("wire_id") or "")
        if not wire_id or any(item.get("id") == wire_id for item in wires):
            raise ValueError(f"create_wire: invalid or duplicate wire id {wire_id}")
        points = [_v2_point(point, f"create_wire {wire_id}.point") for point in operation.get("points", [])]
        if len(points) < 2:
            raise ValueError("create_wire requires at least two points")
        start = _v2_wire_endpoint(operation.get("from"), "create_wire.from")
        end = _v2_wire_endpoint(operation.get("to"), "create_wire.to")
        if not _v2_same_point(points[0], start) or not _v2_same_point(points[-1], end):
            raise ValueError("create_wire path must start/end at its endpoints")
        wires.append({
            "id": wire_id,
            "points": points,
            "from": start,
            "to": end,
            "net": str(operation.get("net") or ""),
            "net_id": str(operation.get("net_id") or ""),
            "source": operation.get("source", "stored"),
        })
        affected.add(wire_id)
    elif name == "edit_wire_path":
        wire_id = str(operation.get("wire_id") or "")
        wire = next((item for item in wires if item.get("id") == wire_id), None)
        if wire is None:
            raise ValueError(f"edit_wire_path: wire {wire_id} not found")
        points = [_v2_point(point, f"edit_wire_path {wire_id}.point") for point in operation.get("points", [])]
        if len(points) < 2:
            raise ValueError("edit_wire_path requires at least two points")
        wire["points"] = points
        wire["from"].update(points[0])
        wire["to"].update(points[-1])
        affected.add(wire_id)
    elif name == "split_wire":
        wire_id = str(operation.get("wire_id") or "")
        wire = next((item for item in wires if item.get("id") == wire_id), None)
        if wire is None:
            raise ValueError(f"split_wire: wire {wire_id} not found")
        point = _v2_point(operation.get("point"), "split_wire.point")
        junction_id = str(operation.get("junction_id") or _v2_stable_junction(wire_id, "split", point))
        affected.update(_v2_split_wire_at(module, wire, point, junction_id))
    elif name == "join_wires":
        wire_ids = [str(value) for value in operation.get("wire_ids", [])]
        if len(wire_ids) < 2:
            raise ValueError("join_wires requires at least two wire ids")
        joined = []
        for wire_id in wire_ids:
            wire = next((item for item in module.get("wires", []) if item.get("id") == wire_id), None)
            if wire is None:
                raise ValueError(f"join_wires: wire {wire_id} not found")
            joined.append(wire)
        first = joined[0]
        if any(wire.get("net_id") != first.get("net_id") for wire in joined):
            raise ValueError("join_wires: all wires must belong to the same net")
        points = json.loads(json.dumps(first["points"]))
        tail = json.loads(json.dumps(first["to"]))
        for wire in joined[1:]:
            if _v2_same_point(points[-1], wire["points"][0]):
                points.extend(json.loads(json.dumps(wire["points"][1:])))
                tail = json.loads(json.dumps(wire["to"]))
            elif _v2_same_point(points[-1], wire["points"][-1]):
                points.extend(json.loads(json.dumps(list(reversed(wire["points"]))[1:])))
                tail = json.loads(json.dumps(wire["from"]))
            else:
                raise ValueError(f"join_wires: wire {wire['id']} is not connected")
        first["points"] = points
        first["to"] = tail
        removed = set(wire_ids[1:])
        module["wires"] = [wire for wire in module["wires"] if str(wire.get("id")) not in removed]
        affected.update(wire_ids)
    elif name == "upsert_junction":
        point = _v2_point(operation.get("point"), "upsert_junction.point")
        junction_id = str(operation.get("junction_id") or "")
        if not junction_id:
            raise ValueError("upsert_junction requires junction_id")
        matching = []
        for wire in list(module.get("wires", [])):
            if wire.get("net") != operation.get("net"):
                continue
            for index in range(1, len(wire.get("points", []))):
                left, right = wire["points"][index - 1], wire["points"][index]
                within_x = min(left["x"], right["x"]) - 0.001 <= point["x"] <= max(left["x"], right["x"]) + 0.001
                within_y = min(left["y"], right["y"]) - 0.001 <= point["y"] <= max(left["y"], right["y"]) + 0.001
                cross = (
                    (right["x"] - left["x"]) * (point["y"] - left["y"])
                    - (right["y"] - left["y"]) * (point["x"] - left["x"])
                )
                if within_x and within_y and abs(cross) <= 0.001:
                    matching.append(wire)
                    break
        if not matching:
            raise ValueError("upsert_junction: no wire at point")
        for wire in matching:
            affected.update(_v2_split_wire_at(module, wire, point, junction_id))
    elif name == "rename_net":
        old_net = str(operation.get("old_net") or "")
        new_net = str(operation.get("new_net") or "")
        if not old_net or not new_net:
            raise ValueError("rename_net requires old_net and new_net")
        for component in components:
            for pin in component.get("pins", []):
                if pin.get("net") == old_net:
                    pin["net"] = new_net
                    affected.add(f"{component.get('id')}.{pin.get('id')}")
        for port in ports:
            if port.get("net") == old_net:
                port["net"] = new_net
                affected.add(f"port:{port.get('id')}")
        for wire in wires:
            if wire.get("net") == old_net:
                wire["net"] = new_net
                affected.add(str(wire.get("id")))
        for net in module.get("nets", []):
            if net.get("name") == old_net:
                net["name"] = new_net
            aliases = net.get("aliases")
            if isinstance(aliases, list) and old_net in aliases:
                net["aliases"] = [new_net if alias == old_net else alias for alias in aliases]
    elif name == "upsert_port":
        port = json.loads(json.dumps(operation.get("port")))
        if not isinstance(port, dict) or not port.get("id"):
            raise ValueError("upsert_port requires a port")
        index = next((index for index, item in enumerate(ports) if item.get("id") == port["id"]), -1)
        if index >= 0:
            ports[index] = port
        else:
            ports.append(port)
        affected.add(f"port:{port['id']}")
    elif name == "place_module_instance":
        component_id = str(operation.get("component_id") or "")
        if not component_id or any(item.get("id") == component_id for item in components):
            raise ValueError(f"place_module_instance: invalid or duplicate id {component_id}")
        module_ref = json.loads(json.dumps(operation.get("module_ref")))
        pins = json.loads(json.dumps(operation.get("pins")))
        if not isinstance(module_ref, dict) or not module_ref.get("module_id"):
            raise ValueError("place_module_instance requires module_ref")
        if not isinstance(pins, list) or not pins:
            raise ValueError("place_module_instance requires pins")
        components.append({
            "id": component_id,
            "type": "MODULE",
            "name": component_id.upper(),
            "value": str(module_ref["module_id"]),
            "position": _v2_point(operation.get("position"), "place_module_instance.position"),
            "rotation": float(operation.get("rotation", 0)),
            "pins": pins,
            "module_ref": module_ref,
        })
        affected.add(component_id)
    elif name == "set_module_metadata":
        for key in ("name", "domain"):
            if key in operation:
                module[key] = operation[key]
    else:
        raise ValueError(f"unsupported v2 operation: {name}")
    return affected


def scan_driven_nodes(netlist: str) -> set[str]:
    """Collect node names already driven by a V/I source in a raw netlist."""
    driven: set[str] = set()
    for raw in netlist.splitlines():
        line = raw.strip()
        if not line or line.startswith("*") or line.startswith("."):
            continue
        tokens = line.split()
        if len(tokens) >= 2 and tokens[0][:1].upper() in {"V", "I"}:
            driven.add(tokens[1])
    return driven


def apply_command(root: Path, command: dict[str, Any]) -> dict[str, Any]:
    schema = command.get("schema")
    if schema not in {COMMAND_SCHEMA, "actoviq.command.v2"}:
        raise ValueError(f"unsupported command schema: {schema}")
    # Soft leases guard intent for both v1 and v2. Without this, set_module_schematic
    # and other v1 ops could silently overwrite a live editor session.
    with ProjectLock(root):
        actor = str(command.get("actor") or "unknown")
        for module_id in command_lease_module_ids(command):
            check_module_lease(root, module_id, actor)
        return _apply_command_locked(root, command)


def pending_command_path(root: Path, command_id: str) -> Path:
    normalized = str(command_id or "").strip()
    if not normalized or not re.fullmatch(r"[A-Za-z0-9_.:-]+", normalized):
        raise ValueError("pending command_id must contain only letters, digits, dot, colon, underscore, or dash")
    return root / "commands" / "pending" / f"{normalized}.json"


def pending_command_summary(command: dict[str, Any]) -> dict[str, Any]:
    operations = command.get("operations")
    operation_list = operations if isinstance(operations, list) else []
    operation_summaries: list[dict[str, Any]] = []
    affected_entities: set[str] = set()
    for operation in operation_list:
        if not isinstance(operation, dict):
            continue
        entity_ids = {
            str(operation[key])
            for key in (
                "component_id",
                "wire_id",
                "port_id",
                "annotation_id",
                "junction_id",
                "entity_id",
                "id",
            )
            if operation.get(key) is not None
        }
        for key in ("entity_ids", "wire_ids"):
            values = operation.get(key)
            if isinstance(values, list):
                entity_ids.update(str(value) for value in values if value is not None)
        for key in ("component", "port"):
            entity = operation.get(key)
            if isinstance(entity, dict) and entity.get("id") is not None:
                entity_ids.add(str(entity["id"]))
        affected_entities.update(entity_ids)
        operation_summaries.append({
            "op": str(operation.get("op") or "unknown"),
            "entities": sorted(entity_ids),
        })
    module_id = str(command.get("module_id") or "")
    if not module_id:
        module_ids = {
            str(operation.get("module_id"))
            for operation in operation_list
            if isinstance(operation, dict) and operation.get("module_id")
        }
    else:
        module_ids = {module_id}
    return {
        "operation_count": len(operation_list),
        "operations": operation_summaries,
        "affected_modules": sorted(module_ids),
        "affected_entities": sorted(affected_entities),
    }


def stage_pending_command(root: Path, command: dict[str, Any]) -> dict[str, Any]:
    project, modules = load_project(root)
    schema = command.get("schema")
    if schema not in {COMMAND_SCHEMA, "actoviq.command.v2"}:
        raise ValueError(f"unsupported command schema: {schema}")
    if command.get("project_id") != project["project_id"]:
        raise ValueError("command project_id does not match project")
    if command.get("base_revision") != project["revision"]:
        raise ValueError(
            f"stale revision: expected {project['revision']}, got {command.get('base_revision')}"
        )
    operations = command.get("operations")
    if not isinstance(operations, list) or not operations:
        raise ValueError("command operations must be a non-empty array")
    if any(not isinstance(operation, dict) for operation in operations):
        raise ValueError("command operations must contain objects")
    if schema == "actoviq.command.v2":
        module_id = str(command.get("module_id") or "")
        module = modules.get(module_id)
        if module is None:
            raise ValueError(f"v2 command references unknown module: {module_id}")
        expected = command.get("expected_module_revision")
        if expected is None:
            raise ValueError("v2 command requires expected_module_revision")
        if int(expected) != int(module.get("revision", 0)):
            raise ValueError(
                f"stale module revision: expected {module.get('revision', 0)}, got {expected}"
            )
        preview_module = json.loads(json.dumps(module))
        for operation in operations:
            apply_v2_operation(preview_module, operation)
        preview_module = upgrade_module_document(preview_module, repair_invalid_net_ids=True)
        ensure_module_stable_ids(preview_module)
        validate_module(preview_module, project.get("project_kind"))
    command_id = str(command.get("command_id") or "")
    target = pending_command_path(root, command_id)
    for directory in ("pending", "applied", "rejected"):
        candidate = root / "commands" / directory / f"{command_id}.json"
        if candidate.exists():
            raise ValueError(f"command_id already exists in commands/{directory}: {command_id}")
    envelope = {
        "schema": PENDING_COMMAND_SCHEMA,
        "command_id": command_id,
        "project_id": project["project_id"],
        "status": "pending",
        "staged_at": utc_now(),
        "command": command,
        "summary": pending_command_summary(command),
    }
    atomic_write_json(target, envelope)
    return {"ok": True, **envelope, "path": str(target)}


def list_pending_commands(root: Path) -> dict[str, Any]:
    pending_root = root / "commands" / "pending"
    proposals: list[dict[str, Any]] = []
    for candidate in sorted(pending_root.glob("*.json")):
        try:
            envelope = read_json(candidate)
            if envelope.get("schema") != PENDING_COMMAND_SCHEMA:
                continue
            proposals.append(envelope)
        except (OSError, ValueError, json.JSONDecodeError):
            continue
    proposals.sort(key=lambda entry: str(entry.get("staged_at") or ""), reverse=True)
    return {"ok": True, "pending": proposals, "count": len(proposals)}


def accept_pending_command(root: Path, command_id: str) -> dict[str, Any]:
    target = pending_command_path(root, command_id)
    if not target.exists():
        raise ValueError(f"pending command not found: {command_id}")
    envelope = read_json(target)
    if envelope.get("schema") != PENDING_COMMAND_SCHEMA or not isinstance(envelope.get("command"), dict):
        raise ValueError(f"invalid pending command envelope: {command_id}")
    # apply_command re-checks project/module revisions and leases at acceptance
    # time; an old proposal therefore cannot overwrite intervening edits.
    result = apply_command(root, envelope["command"])
    target.unlink(missing_ok=True)
    return {"ok": True, "accepted": command_id, **result}


def reject_pending_command(root: Path, command_id: str, reason: str = "") -> dict[str, Any]:
    target = pending_command_path(root, command_id)
    if not target.exists():
        raise ValueError(f"pending command not found: {command_id}")
    envelope = read_json(target)
    if envelope.get("schema") != PENDING_COMMAND_SCHEMA:
        raise ValueError(f"invalid pending command envelope: {command_id}")
    rejected = {
        **envelope,
        "status": "rejected",
        "rejected_at": utc_now(),
        "rejection_reason": str(reason or "").strip(),
    }
    rejected_path = root / "commands" / "rejected" / f"{command_id}.json"
    atomic_write_json(rejected_path, rejected)
    target.unlink(missing_ok=True)
    return {
        "ok": True,
        "rejected": command_id,
        "path": str(rejected_path),
        "project_id": envelope.get("project_id"),
    }


def _apply_command_locked(root: Path, command: dict[str, Any]) -> dict[str, Any]:
    project, modules = load_project(root)
    snapshot_project = json.loads(json.dumps(project))
    snapshot_modules = json.loads(json.dumps(modules))
    is_v2 = command.get("schema") == "actoviq.command.v2"
    if command.get("project_id") != project["project_id"]:
        raise ValueError("command project_id does not match project")
    if command.get("base_revision") != project["revision"]:
        raise ValueError(
            f"stale revision: expected {project['revision']}, got {command.get('base_revision')}"
        )
    operations = command.get("operations")
    if not isinstance(operations, list) or not operations:
        raise ValueError("command operations must be a non-empty array")

    changed_modules: set[str] = set()
    schematic_override_writes: dict[str, dict[str, Any]] = {}
    notebook_writes: dict[str, str | None] = {}
    if is_v2:
        module_id = str(command.get("module_id") or "")
        module = modules.get(module_id)
        if module is None:
            raise ValueError(f"v2 command references unknown module: {module_id}")
        expected_module_revision = command.get("expected_module_revision")
        if expected_module_revision is None:
            raise ValueError("v2 command requires expected_module_revision")
        if int(expected_module_revision) != int(module.get("revision", 0)):
            raise ValueError(
                f"stale module revision: expected {module.get('revision', 0)}, "
                f"got {expected_module_revision}"
            )
        peer = module.get("schematic_peer")
        if (
            isinstance(peer, dict)
            and peer.get("mode") == "external"
            and command.get("source") != "xschem"
        ):
            raise ValueError(
                f"module {module_id} is read-only because Xschem is authoritative"
            )
        affected_entities: set[str] = set()
        for operation in operations:
            affected_entities.update(apply_v2_operation(module, operation))
        command["affected_entities"] = sorted(affected_entities)
        if command.get("notebook_markdown") is not None:
            notebook_writes[module_id] = coerce_netlist_notebook_text(
                command.get("notebook_markdown")
            )
        changed_modules.add(module_id)
    else:
        for operation in operations:
            apply_operation(
                root,
                project,
                modules,
                operation,
                changed_modules,
                schematic_override_writes,
                notebook_writes,
            )

    project["revision"] += 1
    project["updated_at"] = utc_now()
    for module_id in changed_modules:
        modules[module_id] = upgrade_module_document(
            modules[module_id],
            repair_invalid_net_ids=is_v2,
        )
        ensure_module_stable_ids(modules[module_id])
        modules[module_id]["revision"] = int(modules[module_id].get("revision", 0)) + 1
        validate_module(modules[module_id], project.get("project_kind"))
    validate_project(project)
    # Only create revision history after every operation and invariant has
    # succeeded. A rejected transaction must not leave a misleading revision
    # directory behind.
    revision_root = snapshot_revision(
        root,
        snapshot_project,
        snapshot_modules,
        command,
    )
    for module_id, notebook in notebook_writes.items():
        notebook_path = root / "modules" / module_id / "netlist-notebook.md"
        if notebook is None:
            notebook_path.unlink(missing_ok=True)
        else:
            atomic_write_text(notebook_path, notebook)
    for module_id in changed_modules:
        atomic_write_json(module_path(root, module_id), modules[module_id])
    for module_id, overrides in schematic_override_writes.items():
        atomic_write_json(schematic_overrides_path(root, module_id), overrides)
    atomic_write_json(project_path(root), project)
    command_id = command.get("command_id") or f"command-{project['revision']:06d}"
    applied_path = root / "commands" / "applied" / f"{command_id}.json"
    atomic_write_json(applied_path, {**command, "applied_revision": project["revision"], "applied_at": utc_now()})
    write_revision_result(revision_root, project, modules, notebook_writes)
    erc = write_erc_result(root, project, modules)
    revision_metadata_path = revision_root / "metadata.json"
    revision_metadata = read_json(revision_metadata_path)
    revision_metadata["erc_status"] = erc["status"]
    revision_metadata["erc_summary"] = erc["summary"]
    atomic_write_json(revision_metadata_path, revision_metadata)
    return {
        "ok": True,
        "project_id": project["project_id"],
        "revision": project["revision"],
        "changed_modules": sorted(changed_modules),
        "command_path": str(applied_path),
        "erc": erc,
    }


class UnionFind:
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
            self.parent[right_root] = left_root


def sanitize_node(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_]+", "_", value).strip("_")
    return cleaned or "node"


def strip_control_blocks(netlist_text: str) -> str:
    """Remove .control/.endc decks so control verbs are not parsed as devices."""
    lines_out: list[str] = []
    in_control = False
    for raw in netlist_text.splitlines():
        lower = strip_spice_comment(raw).lower()
        if lower.startswith(".control"):
            in_control = True
            continue
        if lower.startswith(".endc"):
            in_control = False
            continue
        if in_control:
            continue
        lines_out.append(raw)
    return "\n".join(lines_out).rstrip() + ("\n" if lines_out else "")


def unwrap_simulation_subckt_wrapper(netlist_text: str) -> str:
    """If a simulation netlist is only one .subckt/.ends shell, keep the body.

    DeepSeek and similar models often wrap teaching circuits in .subckt even though
    project_kind=simulation forbids hierarchical definitions.
    """
    lines = [line.rstrip() for line in netlist_text.splitlines()]
    meaningful = [line for line in lines if strip_spice_comment(line)]
    if not meaningful:
        return netlist_text
    first = meaningful[0].lstrip().lower()
    if not first.startswith(".subckt"):
        return netlist_text
    # Count subckt/ends pairs; only unwrap a single top-level definition with no
    # leftover X-instances of that subckt outside the body.
    depth = 0
    body: list[str] = []
    saw_ends = False
    for raw in lines:
        stripped = strip_spice_comment(raw)
        lower = stripped.lower()
        if lower.startswith(".subckt"):
            depth += 1
            if depth == 1:
                continue
        if lower.startswith(".ends"):
            if depth == 1:
                saw_ends = True
                depth = 0
                continue
            if depth > 1:
                depth -= 1
        if depth >= 1:
            body.append(raw)
        elif stripped and not lower.startswith("*"):
            # Content outside the single subckt — do not unwrap.
            return netlist_text
    if not saw_ends or depth != 0 or not any(strip_spice_comment(line) for line in body):
        return netlist_text
    return "\n".join(body).rstrip() + "\n"


def extract_notebook_netlist(markdown: str) -> str:
    blocks = [
        match.strip()
        for match in re.findall(
            r"```(?:spice|cir|netlist)\s*\r?\n([\s\S]*?)```",
            markdown,
            flags=re.IGNORECASE,
        )
        if match.strip()
    ]
    if blocks:
        return "\n\n".join(blocks) + "\n"

    # LLMs often emit bare SPICE without a fenced code block. Accept that when
    # the body looks like a netlist (device lines / analysis directives).
    bare = markdown.strip()
    if bare:
        spice_line = re.compile(
            r"^\s*([A-Za-z]\w*|\.(title|end|tran|ac|dc|op|include|param|model|subckt|ends|control|probe|save|plot|print)\b)",
            flags=re.IGNORECASE,
        )
        meaningful = [line for line in bare.splitlines() if strip_spice_comment(line)]
        if meaningful and sum(1 for line in meaningful if spice_line.match(line)) >= max(1, len(meaningful) // 3):
            return bare + ("\n" if not bare.endswith("\n") else "")

        raise ValueError(
            "netlist notebook requires a fenced spice, cir, or netlist code block"
        )


def strip_spice_comment(line: str) -> str:
    stripped = line.strip()
    if not stripped or stripped.startswith(("*", ";", "//", "$")):
        return ""
    in_quote = False
    result: list[str] = []
    for char in line:
        if char == "'":
            in_quote = not in_quote
        if char == ";" and not in_quote:
            break
        result.append(char)
    return "".join(result).strip()


def merged_spice_lines(netlist_text: str) -> list[str]:
    lines: list[str] = []
    current = ""
    for raw in netlist_text.splitlines():
        stripped = raw.strip()
        if not stripped:
            if current:
                lines.append(current)
                current = ""
            continue
        if stripped.startswith("+"):
            if current:
                current = f"{current} {stripped[1:].strip()}"
            continue
        if current:
            lines.append(current)
        current = raw
    if current:
        lines.append(current)
    return lines


def compiled_component_name(module_id: str, component: dict[str, Any]) -> str:
    component_name = sanitize_node(f"{module_id}_{component['name']}")
    component_type = str(component["type"])
    if not component_name.upper().startswith(component_type):
        component_name = f"{component_type}{component_name}"
    return component_name


def schematic_render_map(
    module: dict[str, Any],
    renderer: str = "netlistsvg",
    schematic_document: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Map canonical module entities to a derived renderer without making SVG truth."""
    connectivity_module = upgrade_module_document(
        json.loads(json.dumps(module)),
        repair_legacy_wire_endpoints=False,
        repair_invalid_net_ids=False,
    )
    projected_module = (
        schematic_document.get("module")
        if isinstance(schematic_document, dict)
        and schematic_document.get("schema") == "actoviq.schematic-document.v1"
        and schematic_document.get("moduleId") == module.get("module_id")
        and isinstance(schematic_document.get("module"), dict)
        and schematic_document["module"].get("revision") == module.get("revision")
        else None
    )
    normalized = upgrade_module_document(
        json.loads(json.dumps(projected_module or connectivity_module)),
        repair_legacy_wire_endpoints=False,
        repair_invalid_net_ids=False,
    )
    module_id = str(normalized.get("module_id") or "")
    components: list[dict[str, Any]] = []
    pins: list[dict[str, Any]] = []
    ports: list[dict[str, Any]] = []
    wires: list[dict[str, Any]] = []
    junction_ids: set[str] = set()
    for component in normalized.get("components", []) or []:
        component_id = str(component.get("id") or "")
        components.append({
            "entity_id": component_id,
            "type": str(component.get("type") or ""),
            "render_id": compiled_component_name(module_id, component),
        })
        for index, pin in enumerate(component.get("pins", []) or []):
            pin_id = str(pin.get("id") or "")
            pins.append({
                "entity_id": f"{component_id}.{pin_id}",
                "component_id": component_id,
                "pin_id": pin_id,
                "render_index": index,
                "net": str(pin.get("net") or ""),
                "net_id": str(pin.get("net_id") or ""),
            })
    for port in normalized.get("ports", []) or []:
        ports.append({
            "entity_id": str(port.get("id") or ""),
            "net": str(port.get("net") or ""),
            "net_id": str(port.get("net_id") or ""),
        })
    for wire in normalized.get("wires", []) or []:
        wires.append({
            "entity_id": str(wire.get("id") or ""),
            "net": str(wire.get("net") or ""),
            "net_id": str(wire.get("net_id") or ""),
        })
        for endpoint_name in ("from", "to"):
            endpoint = wire.get(endpoint_name)
            if isinstance(endpoint, dict) and endpoint.get("junction_id"):
                junction_ids.add(str(endpoint["junction_id"]))
    nets = [
        {
            "entity_id": str(net.get("id") or ""),
            "name": str(net.get("name") or ""),
        }
        for net in normalized.get("nets", []) or []
    ]
    return {
        "schema": SCHEMATIC_RENDER_MAP_SCHEMA,
        "module_id": module_id,
        "module_revision": int(normalized.get("revision") or 0),
        "renderer": renderer,
        "connectivity_hash": ordered_connectivity_hash(connectivity_module),
        "entities": {
            "components": sorted(components, key=lambda item: item["entity_id"]),
            "pins": sorted(pins, key=lambda item: item["entity_id"]),
            "ports": sorted(ports, key=lambda item: item["entity_id"]),
            "nets": sorted(nets, key=lambda item: item["entity_id"]),
            "wires": sorted(wires, key=lambda item: item["entity_id"]),
            "junctions": [
                {"entity_id": junction_id}
                for junction_id in sorted(junction_ids)
            ],
        },
        "truth": {
            "schema": MODULE_SCHEMA,
            "role": "canonical_edit_source",
        },
        "projection": {
            "schema": "actoviq.schematic-document.v1",
            "artifact_consumed": projected_module is not None,
        },
        "render_output": {
            "role": "derived_preview_export",
            "editable": False,
        },
    }


def compiled_instance_name_map(module_id: str, components: list[dict[str, Any]]) -> dict[str, str]:
    names: dict[str, str] = {}
    for component in components:
        if component.get("type") == "BLOCK":
            continue
        compiled_name = compiled_component_name(module_id, component)
        names[str(component["name"]).casefold()] = compiled_name
        names[compiled_name.casefold()] = compiled_name
    return names


def rewrite_compiled_value_references(
    component_type: str,
    value: Any,
    instance_names: dict[str, str],
    node_name: Callable[[str], str],
) -> str:
    compiled_value = str(value)
    if component_type in {"F", "H"}:
        match = re.match(r"^(\s*)(\S+)(.*)$", compiled_value, flags=re.DOTALL)
        if match:
            control_source = instance_names.get(match.group(2).casefold(), match.group(2))
            compiled_value = f"{match.group(1)}{control_source}{match.group(3)}"
    if component_type != "B":
        return compiled_value

    def replace_behavior_reference(match: re.Match[str]) -> str:
        function = match.group(1)
        arguments = [argument.strip() for argument in match.group(2).split(",")]
        if function.casefold() == "v" and 1 <= len(arguments) <= 2 and all(arguments):
            return f"{function}({','.join(node_name(argument) for argument in arguments)})"
        if function.casefold() == "i" and len(arguments) == 1 and arguments[0]:
            reference = instance_names.get(arguments[0].casefold(), arguments[0])
            return f"{function}({reference})"
        return match.group(0)

    return re.sub(
        r"(?i)(?<![A-Za-z0-9_])([vi])\s*\(\s*([^()]*)\s*\)",
        replace_behavior_reference,
        compiled_value,
    )


_DC_RESERVED_SWEEP = frozenset({"temp", "data", "param"})


def rewrite_analysis_directive(
    directive: str,
    instance_names: dict[str, str] | None,
    node_names: dict[str, str] | None,
) -> str:
    """Rewrite hoisted analysis directives to compiled system instance/node names."""
    if not instance_names and not node_names:
        return directive
    instance_names = instance_names or {}
    node_names = node_names or {}
    text = str(directive).strip()
    if not text:
        return directive

    def map_node(name: str) -> str:
        key = name.casefold()
        if key in {"", "0"}:
            return name if name else "0"
        return node_names.get(key, name)

    def map_instance(name: str) -> str:
        return instance_names.get(name.casefold(), name)

    def replace_vi(match: re.Match[str]) -> str:
        function = match.group(1)
        arguments = [argument.strip() for argument in match.group(2).split(",")]
        if function.casefold() == "v" and arguments and all(arguments):
            return f"{function}({','.join(map_node(argument) for argument in arguments)})"
        if function.casefold() == "i" and len(arguments) == 1 and arguments[0]:
            return f"{function}({map_instance(arguments[0])})"
        return match.group(0)

    text = re.sub(
        r"(?i)(?<![A-Za-z0-9_])([vi])\s*\(\s*([^()]*)\s*\)",
        replace_vi,
        text,
    )
    text = re.sub(
        r"(?i)@([A-Za-z_][\w.]*)\[([^\]]+)\]",
        lambda match: f"@{map_instance(match.group(1))}[{match.group(2)}]",
        text,
    )

    if text.casefold().startswith(".dc"):
        parts = text.split()
        rewritten_parts = [parts[0]]
        for token in parts[1:]:
            if token.casefold() in _DC_RESERVED_SWEEP:
                rewritten_parts.append(token)
            elif token.casefold() in instance_names:
                rewritten_parts.append(instance_names[token.casefold()])
            else:
                rewritten_parts.append(token)
        text = " ".join(rewritten_parts)
    return text


def editable_component_name(module_id: str, instance_name: str) -> str:
    component_type = instance_name[:1].upper()
    rest = instance_name[1:]
    module_prefix = f"{module_id}_".lower()
    if rest.lower().startswith(module_prefix):
        tail = rest[len(module_prefix):]
        return tail if tail.upper().startswith(component_type) else f"{component_type}{tail}"
    return instance_name


def editable_component_id(name: str, used_ids: set[str]) -> str:
    base = re.sub(r"[^a-z0-9_]+", "_", name.lower()).strip("_") or "component"
    candidate = base
    suffix = 2
    while candidate in used_ids:
        candidate = f"{base}_{suffix}"
        suffix += 1
    used_ids.add(candidate)
    return candidate


def parse_editable_netlist_components(
    module_id: str,
    netlist_text: str,
    existing_module: dict[str, Any],
) -> list[dict[str, Any]]:
    existing_by_name = {
        str(component.get("name", "")).lower(): component
        for component in existing_module.get("components", [])
    }
    existing_by_compiled = {
        compiled_component_name(module_id, component).lower(): component
        for component in existing_module.get("components", [])
        if component.get("name") and component.get("type")
    }
    used_ids: set[str] = set()
    parsed: list[dict[str, Any]] = []
    grid_index = 0

    for raw in merged_spice_lines(netlist_text):
        line = strip_spice_comment(raw)
        if not line or line.startswith("."):
            continue
        tokens = line.split()
        if len(tokens) < 3:
            continue
        instance = tokens[0]
        component_type = instance[:1].upper()
        variable_node_count = component_type in {"X", "U"}
        if component_type not in EDITABLE_NODE_COUNTS and not variable_node_count:
            continue
        if instance.lower().startswith(EDITABLE_TESTBENCH_PREFIXES):
            continue
        if variable_node_count:
            assignment_index = next(
                (index for index, token in enumerate(tokens[1:], start=1) if "=" in token),
                len(tokens),
            )
            params_index = next(
                (index for index, token in enumerate(tokens[1:], start=1) if token.casefold() == "params:"),
                -1,
            )
            model_index = (params_index if params_index >= 0 else assignment_index) - 1
            if assignment_index == len(tokens) and params_index < 0:
                model_index = len(tokens) - 1
            if model_index < 2:
                continue
            nodes = tokens[1:model_index]
            value = " ".join(tokens[model_index:]).strip()
        else:
            node_count = EDITABLE_NODE_COUNTS[component_type]
            if len(tokens) < 1 + node_count:
                continue
            nodes = tokens[1:1 + node_count]
            value = " ".join(tokens[1 + node_count:]).strip() or "1"
        name = editable_component_name(module_id, instance)
        existing = existing_by_compiled.get(instance.lower()) or existing_by_name.get(name.lower())
        if existing:
            component_id = str(existing.get("id") or editable_component_id(name, used_ids))
            if component_id in used_ids:
                component_id = editable_component_id(name, used_ids)
            else:
                used_ids.add(component_id)
            position = existing.get("position") if isinstance(existing.get("position"), dict) else None
            rotation = existing.get("rotation", 0)
        else:
            component_id = editable_component_id(name, used_ids)
            position = {
                "x": 140 + (grid_index % 4) * 180,
                "y": 120 + (grid_index // 4) * 140,
            }
            # V/I default upright; R stays 0 here — schematic render picks h/v by topology.
            rotation = 90 if component_type in {"V", "I"} else 0
            if component_type in {"V", "I"}:
                # Rare series sources may stay horizontal in the editor.
                source_name = str(instance)
                if re.search(r"(?:^vser|^iser|series)", source_name, flags=re.IGNORECASE):
                    rotation = 0
        grid_index += 1
        pin_names = EDITABLE_PIN_NAMES.get(component_type, [])
        pins = [
            {
                "id": pin_names[index][0] if index < len(pin_names) else f"p{index + 1}",
                "name": pin_names[index][1] if index < len(pin_names) else str(index + 1),
                "net": node,
            }
            for index, node in enumerate(nodes)
        ]
        parsed.append({
            "id": component_id,
            "type": component_type,
            "name": name,
            "value": value,
            "position": position,
            "rotation": rotation,
            "pins": pins,
        })
    return parsed


def parse_spice_source(
    module_id: str,
    netlist_text: str,
    components: list[dict[str, Any]],
) -> dict[str, Any]:
    known_instances = {
        compiled_component_name(module_id, component).lower()
        for component in components
        if component.get("type") != "BLOCK"
    }
    known_instances.update(
        str(component.get("name", "")).lower()
        for component in components
        if component.get("type") != "BLOCK"
    )
    models: list[str] = []
    directives: list[str] = []
    opaque: list[str] = []
    for raw in merged_spice_lines(netlist_text):
        line = strip_spice_comment(raw)
        if not line:
            continue
        low = line.lower()
        if low == ".end":
            continue
        if low.startswith((".model", ".param", ".include", ".lib", ".func")):
            models.append(line)
            continue
        if low.startswith("."):
            directives.append(line)
            continue
        instance = line.split(maxsplit=1)[0].lower()
        if instance not in known_instances:
            opaque.append(line)
    return {
        "source": netlist_text,
        "models": models,
        "directives": directives,
        "opaque": opaque,
        "generated_testbench": "standalone module testbench generated by circuit_project.py" in netlist_text.lower(),
    }


_GENERIC_PORT_NAMES = frozenset({"in", "input", "out", "output"})


def is_generic_module_port(port: dict[str, Any]) -> bool:
    port_id = str(port.get("id", "")).strip().casefold()
    name = str(port.get("name", "")).strip().casefold()
    return port_id in _GENERIC_PORT_NAMES or name in _GENERIC_PORT_NAMES


def prefer_module_port_candidate(
    current: tuple[int, dict[str, Any], str, str],
    candidate: tuple[int, dict[str, Any], str, str],
) -> bool:
    """Return True when candidate should replace the current same-net winner."""
    current_port = current[1]
    candidate_port = candidate[1]
    current_inferred = bool(current_port.get("inferred"))
    candidate_inferred = bool(candidate_port.get("inferred"))
    if current_inferred and not candidate_inferred:
        return True
    if (not current_inferred) and candidate_inferred:
        return False
    current_generic = is_generic_module_port(current_port)
    candidate_generic = is_generic_module_port(candidate_port)
    if current_generic and not candidate_generic:
        return True
    if (not current_generic) and candidate_generic:
        return False
    return False


def port_alias_remap(
    previous_ports: list[dict[str, Any]],
    next_ports: list[dict[str, Any]],
) -> dict[str, str]:
    """Map dropped port ids to a surviving port on the same SPICE net."""
    survivors_by_net: dict[str, str] = {}
    surviving_ids: set[str] = set()
    for port in next_ports:
        port_id = str(port.get("id", "")).strip()
        net_key = str(port.get("net", "")).strip().casefold()
        if port_id:
            surviving_ids.add(port_id)
        if port_id and net_key and net_key not in survivors_by_net:
            survivors_by_net[net_key] = port_id
    remap: dict[str, str] = {}
    for port in previous_ports:
        port_id = str(port.get("id", "")).strip()
        net_key = str(port.get("net", "")).strip().casefold()
        if not port_id or port_id in surviving_ids:
            continue
        winner = survivors_by_net.get(net_key)
        if winner and winner != port_id:
            remap[port_id] = winner
    return remap


def rewrite_module_port_connections(
    project: dict[str, Any],
    module_id: str,
    previous_ports: list[dict[str, Any]],
    next_ports: list[dict[str, Any]],
) -> None:
    """Rewrite or drop project connections after module port ids change."""
    remap = port_alias_remap(previous_ports, next_ports)
    surviving_ids = {
        str(port.get("id", "")).strip()
        for port in next_ports
        if str(port.get("id", "")).strip()
    }
    rewritten: list[dict[str, Any]] = []
    for connection in project.get("connections", []):
        next_connection = dict(connection)
        drop = False
        for endpoint_name in ("from", "to"):
            endpoint = dict(next_connection.get(endpoint_name) or {})
            if endpoint.get("module_id") != module_id:
                next_connection[endpoint_name] = endpoint
                continue
            port_id = str(endpoint.get("port_id", "")).strip()
            if port_id in remap:
                endpoint["port_id"] = remap[port_id]
            elif port_id and port_id not in surviving_ids:
                drop = True
                break
            next_connection[endpoint_name] = endpoint
        if not drop:
            rewritten.append(next_connection)
    project["connections"] = rewritten


def infer_editable_ports(existing_ports: list[dict[str, Any]], components: list[dict[str, Any]]) -> list[dict[str, Any]]:
    nodes: list[str] = []
    for component in components:
        for pin in component.get("pins", []):
            node = str(pin.get("net", "")).strip()
            if node and node not in nodes:
                nodes.append(node)
    node_keys = {node.casefold() for node in nodes}

    # Nets already driven by on-schematic sources are not external interfaces.
    # A buck with local Vin must not also grow an inferred IN/VIN port on the
    # same net (that port is only for external or cross-module stimulus).
    source_driven_nets = {
        str((component.get("pins") or [{}])[0].get("net", "")).strip().casefold()
        for component in components
        if str(component.get("type", "")).upper() in {"V", "I"}
        and (component.get("pins") or [])
    }
    source_driven_nets.discard("")

    # A SPICE net is the electrical identity (case-insensitive), not the port
    # id. Keep one interface per live net and prefer an explicit named module
    # port over inferred or generic IN/OUT aliases.
    candidates: list[tuple[int, dict[str, Any], str, str]] = []
    for index, port in enumerate(existing_ports):
        port_id = str(port.get("id", "")).strip()
        net = str(port.get("net", "")).strip()
        net_key = net.casefold()
        if not port_id or not net_key:
            continue
        live_net = net_key in node_keys
        generic_interface = is_generic_module_port(port)
        if not live_net and (port.get("inferred") or generic_interface):
            continue
        if (
            port.get("inferred")
            and net_key in source_driven_nets
            and str(port.get("signal_type", "")) in {"analog", "power"}
            and str(port.get("direction", "")) == "input"
        ):
            continue
        candidates.append((index, port, port_id, net_key))

    winner_by_net: dict[str, tuple[int, dict[str, Any], str, str]] = {}
    for candidate in candidates:
        current = winner_by_net.get(candidate[3])
        if current is None or prefer_module_port_candidate(current, candidate):
            winner_by_net[candidate[3]] = candidate

    ports: list[dict[str, Any]] = []
    used_port_ids: set[str] = set()
    existing_nets: set[str] = set()
    for index, port, port_id, net_key in candidates:
        winner = winner_by_net.get(net_key)
        if winner is None or winner[0] != index:
            continue
        if port_id in used_port_ids:
            continue
        used_port_ids.add(port_id)
        existing_nets.add(net_key)
        ports.append(port)

    def add_port(port_id: str, name: str, direction: str, signal_type: str, net: str) -> None:
        net_key = net.casefold()
        if net_key in existing_nets or port_id in used_port_ids:
            return
        if net_key in source_driven_nets and signal_type in {"analog", "power"} and direction == "input":
            return
        used_port_ids.add(port_id)
        existing_nets.add(net_key)
        port = make_port(port_id, name, direction, signal_type, net)
        port["inferred"] = True
        ports.append(port)

    lower_to_node = {node.lower(): node for node in nodes}
    if "0" in nodes:
        add_port("gnd", "GND", "bidirectional", "ground", "0")
    # vin is a supply rail name, not an analog signal input.
    for rail in ("vdd", "vcc", "vee", "vss", "vin"):
        if rail in lower_to_node:
            add_port(rail, rail.upper(), "input", "power", lower_to_node[rail])
    for label in ("in", "input", "rf_in"):
        if label in lower_to_node:
            add_port("input", "IN", "input", "analog", lower_to_node[label])
            break
    for label in ("out", "vout", "output", "rf_out"):
        if label in lower_to_node:
            add_port("output", "OUT", "output", "analog", lower_to_node[label])
            break
    return ports


def sync_module_from_netlist(root: Path, module_id: str) -> dict[str, Any]:
    project, modules = load_project(root)
    if module_id not in modules:
        raise ValueError(f"unknown module: {module_id}")
    notebook_path = root / "modules" / module_id / "netlist-notebook.md"
    if not notebook_path.exists():
        return {"ok": True, "project_id": project["project_id"], "module_id": module_id, "changed": False}
    module_file = module_path(root, module_id)
    if module_file.exists() and notebook_path.stat().st_mtime <= module_file.stat().st_mtime:
        return {"ok": True, "project_id": project["project_id"], "module_id": module_id, "changed": False}

    module = modules[module_id]
    netlist_text = extract_notebook_netlist(notebook_path.read_text(encoding="utf-8"))
    parsed_components = parse_editable_netlist_components(module_id, netlist_text, module)
    parsed_ids = {str(component.get("id")) for component in parsed_components}
    schematic_blocks = [
        component for component in module.get("components", [])
        if component.get("type") in {"BLOCK", "GND"} and str(component.get("id")) not in parsed_ids
    ]
    components = [*parsed_components, *schematic_blocks]
    if not components:
        return {"ok": True, "project_id": project["project_id"], "module_id": module_id, "changed": False}
    previous_ports = list(module.get("ports", []))
    ports = infer_editable_ports(previous_ports, components)
    next_module = {
        **module,
        "components": components,
        "ports": ports,
        "wires": module.get("wires", []),
        "annotations": module.get("annotations", []),
    }
    validate_module(next_module, project.get("project_kind"))

    comparable_keys = ("components", "ports", "wires", "annotations")
    before = {key: module.get(key) for key in comparable_keys}
    after = {key: next_module.get(key) for key in comparable_keys}
    changed = json.dumps(before, ensure_ascii=False, sort_keys=True) != json.dumps(after, ensure_ascii=False, sort_keys=True)
    if not changed:
        return {"ok": True, "project_id": project["project_id"], "module_id": module_id, "changed": False}

    with ProjectLock(root):
        project, modules = load_project(root)
        module = modules[module_id]
        previous_ports = list(module.get("ports", []))
        ports = infer_editable_ports(previous_ports, components)
        next_module = {
            **module,
            "components": components,
            "ports": ports,
            "wires": module.get("wires", []),
            "annotations": module.get("annotations", []),
            "revision": int(module.get("revision", 0)) + 1,
        }
        ensure_module_stable_ids(next_module)
        validate_module(next_module, project.get("project_kind"))
        modules[module_id] = next_module
        module_ref = find_module_ref(project, module_id)
        module_ref["ports"] = ports
        rewrite_module_port_connections(project, module_id, previous_ports, ports)
        validate_project(project)
        project["revision"] = int(project.get("revision", 0)) + 1
        project["updated_at"] = utc_now()
        atomic_write_json(project_path(root), project)
        atomic_write_json(module_path(root, module_id), next_module)
    return {
        "ok": True,
        "project_id": project["project_id"],
        "module_id": module_id,
        "changed": True,
        "revision": project["revision"],
        "module_revision": next_module["revision"],
    }


def hydrated_summary_module(root: Path, module_id: str, module: dict[str, Any]) -> dict[str, Any]:
    module_file = module_path(root, module_id)
    notebook_path = root / "modules" / module_id / "netlist-notebook.md"
    build_netlist_path = root / "build" / "modules" / module_id / "design.cir"
    netlist_text = ""

    try:
        if notebook_path.exists() and (
            not module.get("components")
            or not module_file.exists()
            or notebook_path.stat().st_mtime > module_file.stat().st_mtime
        ):
            netlist_text = extract_notebook_netlist(notebook_path.read_text(encoding="utf-8"))
        elif not module.get("components") and build_netlist_path.exists():
            netlist_text = build_netlist_path.read_text(encoding="utf-8")
    except (OSError, ValueError):
        netlist_text = ""

    if not netlist_text:
        return module

    parsed_components = parse_editable_netlist_components(module_id, netlist_text, module)
    parsed_ids = {str(component.get("id")) for component in parsed_components}
    schematic_blocks = [
        component for component in module.get("components", [])
        if component.get("type") in {"BLOCK", "GND"} and str(component.get("id")) not in parsed_ids
    ]
    components = [*parsed_components, *schematic_blocks]
    if not components:
        return module
    next_module = {
        **module,
        "components": components,
        "ports": infer_editable_ports(list(module.get("ports", [])), components),
        "wires": module.get("wires", []),
        "annotations": module.get("annotations", []),
    }
    try:
        validate_module(next_module, DEFAULT_PROJECT_KIND)
    except ValueError:
        try:
            validate_module(next_module, "analog_ic")
        except ValueError:
            return module
    return next_module


def build_report_markdown(
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]],
    netlist_text: str,
    simulation: dict[str, Any] | None,
    erc: dict[str, Any] | None = None,
) -> str:
    lines: list[str] = [
        f"# {project['name']}",
        "",
        f"Revision {project['revision']} · {len(project['modules'])} modules · "
        f"{len(project.get('connections', []))} connections · generated {utc_now()}",
        "",
        "## Modules",
        "",
    ]
    for module_ref in project["modules"]:
        module = modules.get(module_ref["id"], {})
        ports = module_ref.get("ports", [])

        def nets(*, direction: str | None = None, ground: bool = False) -> str:
            selected = {
                port.get("net", "")
                for port in ports
                if (port.get("signal_type") == "ground") == ground
                and (ground or port.get("direction") == direction)
            }
            return ", ".join(sorted(selected)) or "—"

        lines.append(f"### {module_ref.get('name', module_ref['id'])} (`{module_ref['id']}`)")
        if module_ref.get("kind"):
            lines.append(f"- Kind: {module_ref['kind']}")
        if module_ref.get("function"):
            lines.append(f"- Function: {module_ref['function']}")
        lines.append(
            f"- IN: {nets(direction='input')} · OUT: {nets(direction='output')} · GND: {nets(ground=True)}"
        )
        params = module_ref.get("parameters") or {}
        if params:
            lines.append("- Parameters: " + ", ".join(f"{key} = {value}" for key, value in params.items()))
        lines.append(f"- Components: {len(module.get('components', []))}")
        if (module_ref.get("notes") or "").strip():
            lines.append(f"- Agent note: {module_ref['notes'].strip()}")
        lines.append("")

    connections = project.get("connections", [])
    if connections:
        lines.extend(["## System networks", ""])
        for connection in connections:
            label = connection.get("network") or connection.get("id")
            source = connection["from"]
            target = connection["to"]
            lines.append(
                f"- **{label}**: `{source['module_id']}.{source['port_id']}`"
                f" → `{target['module_id']}.{target['port_id']}`"
            )
        lines.append("")

    lines.extend(["## Electrical rules", ""])
    if erc is None:
        lines.append("_ERC was not available for this report._")
    else:
        summary = erc.get("summary") or {}
        lines.extend([
            f"- Source revision: `{erc.get('source_revision', 'unknown')}`",
            f"- Document hash: `{erc.get('document_hash', 'unknown')}`",
            f"- Status: **{erc.get('status', 'unknown')}**",
            f"- Errors: {summary.get('errors', 0)}",
            f"- Warnings: {summary.get('warnings', 0)}",
        ])
        diagnostics = erc.get("diagnostics") or []
        if diagnostics:
            lines.extend([
                "",
                "| Severity | Code | Location | Diagnostic |",
                "| --- | --- | --- | --- |",
            ])
            for diagnostic in diagnostics:
                location = ".".join(
                    str(diagnostic.get(key))
                    for key in ("module_id", "component_id", "pin_id", "port_id")
                    if diagnostic.get(key)
                ) or "project"
                lines.append(
                    f"| {diagnostic.get('severity', '')} | {diagnostic.get('code', '')} | "
                    f"{location} | {diagnostic.get('message', '')} |"
                )
    lines.extend(["", "## Simulation", ""])
    if simulation is None:
        lines.append("_Not simulated yet. Run \"Simulate system\" to populate analyses and metrics._")
    else:
        execution_status = simulation.get("execution_status") or (
            "success" if simulation.get("ok") else "failed"
        )
        measurement_status = simulation.get("measurement_status", "unknown")
        specification_status = simulation.get("specification_status", "not_evaluated")
        lines.extend([
            f"- Run: `{simulation.get('run_id', 'legacy')}`",
            f"- Source revision: `{simulation.get('source_revision', project.get('revision', 'unknown'))}`",
            f"- Document hash: `{simulation.get('document_hash', 'unknown')}`",
            f"- Execution: **{execution_status}**",
            f"- Measurements: **{measurement_status}**",
            f"- Specifications: **{specification_status}**",
            f"- Backend: `{simulation.get('ngspice', '')}`",
            f"- Simulated at: {simulation.get('simulated_at', '')}",
        ])
        lines.append("")
        analyses = simulation.get("analyses") or []
        if analyses:
            lines.extend([
                "### Analyses",
                "",
                "| Analysis | Type | Directive | Execution | Measurements | Specifications | Dataset |",
                "| --- | --- | --- | --- | --- | --- | --- |",
            ])
            for analysis in analyses:
                dataset = analysis.get("dataset") or {}
                dataset_summary = "not produced"
                if dataset:
                    dataset_summary = (
                        f"{dataset.get('point_count', 0)} points / "
                        f"{len(dataset.get('traces') or [])} traces"
                    )
                lines.append(
                    f"| {analysis.get('id', '')} | {analysis.get('type', '')} | "
                    f"`{analysis.get('directive', '')}` | "
                    f"{analysis.get('execution_status', analysis.get('status', 'unknown'))} | "
                    f"{analysis.get('measurement_status', 'unknown')} | "
                    f"{analysis.get('specification_status', 'not_evaluated')} | {dataset_summary} |"
                )
                for diagnostic in analysis.get("diagnostics") or []:
                    lines.append(f"- `{analysis.get('id', '')}`: {diagnostic}")
            lines.append("")
        metrics = simulation.get("metrics") or []
        if metrics:
            lines.extend([
                "### Metrics",
                "",
                "| Metric | Value | Measurement | Specification |",
                "| --- | --- | --- | --- |",
            ])
            for metric in metrics:
                unit = metric.get("unit", "")
                value = metric.get("value")
                shown = f"{value:.4g} {unit}".strip() if isinstance(value, (int, float)) else "failed"
                measured = metric.get("measurement_status")
                if measured is None:
                    measured = "measured" if value is not None else "failed"
                specification = metric.get("specification_status")
                if specification is None:
                    specification = "passed" if metric.get("pass") else "not_evaluated"
                lines.append(
                    f"| {metric['name']} | {shown} | {measured} | {specification} |"
                )
        else:
            lines.append("_No measurements were produced._")
        specifications = simulation.get("specifications") or []
        if specifications:
            lines.extend([
                "",
                "### Specification Results",
                "",
                "| Metric | Minimum | Maximum | Actual | Unit | Status |",
                "| --- | --- | --- | --- | --- | --- |",
            ])
            for specification in specifications:
                lines.append(
                    f"| {specification.get('metric', '')} | "
                    f"{specification.get('minimum', '') if specification.get('minimum') is not None else ''} | "
                    f"{specification.get('maximum', '') if specification.get('maximum') is not None else ''} | "
                    f"{specification.get('value', '') if specification.get('value') is not None else 'missing'} | "
                    f"{specification.get('unit', '')} | {specification.get('status', '')} |"
                )
        for diagnostic in simulation.get("specification_diagnostics") or []:
            lines.append(f"- Specification configuration: {diagnostic}")
    lines.extend(["", "## System netlist", "", "```spice", netlist_text.strip(), "```", ""])
    return "\n".join(lines)


def write_project_report(
    root: Path,
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]],
    netlist_text: str,
    simulation: dict[str, Any] | None,
) -> Path:
    report_path = root / "build" / "system" / "report.md"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    erc_path = root / "build" / "erc.json"
    erc = read_json(erc_path) if erc_path.exists() else None
    report_path.write_text(
        build_report_markdown(project, modules, netlist_text, simulation, erc),
        encoding="utf-8",
    )
    return report_path


def compile_project(root: Path) -> dict[str, Any]:
    project, modules = load_project(root)
    device_catalog = resolve_project_device_catalog(project)
    if project_composition(project)["mode"] == "hierarchical":
        return compile_hierarchical_project(root, project, modules, device_catalog=device_catalog)
    erc = write_erc_result(root, project, modules)
    union = UnionFind()
    port_lookup: dict[tuple[str, str], dict[str, Any]] = {}
    for module_ref in project["modules"]:
        for port in module_ref.get("ports", []):
            key = f"{module_ref['id']}::{port['id']}"
            union.find(key)
            port_lookup[(module_ref["id"], port["id"])] = port
    for connection in project.get("connections", []):
        source = connection["from"]
        target = connection["to"]
        union.union(
            f"{source['module_id']}::{source['port_id']}",
            f"{target['module_id']}::{target['port_id']}",
        )

    connection_networks: dict[str, set[str]] = {}
    for connection in project.get("connections", []):
        network = str(connection.get("network", "")).strip()
        if not network:
            continue
        source = connection["from"]
        root_key = union.find(f"{source['module_id']}::{source['port_id']}")
        connection_networks.setdefault(root_key, set()).add(network)

    groups: dict[str, list[tuple[str, str, dict[str, Any]]]] = {}
    for (module_id, port_id), port in port_lookup.items():
        groups.setdefault(union.find(f"{module_id}::{port_id}"), []).append((module_id, port_id, port))
    global_names: dict[str, str] = {}
    used_names: set[str] = {"0"}
    for root_key, members in groups.items():
        labels = connection_networks.get(root_key, set())
        if len(labels) > 1:
            raise ValueError(
                f"conflicting system network names for one connected group: {sorted(labels)}"
            )
        if any(port.get("signal_type") == "ground" or port.get("net") == "0" for _, _, port in members):
            global_names[root_key] = "0"
            continue
        preferred = next(iter(labels), None) or next(
            (
                port["name"].lower()
                for _, _, port in members
                if port.get("direction") == "output" and port.get("name")
            ),
            f"{members[0][0]}_{members[0][1]}",
        )
        node = sanitize_node(preferred)
        suffix = 2
        base = node
        while node in used_names:
            node = f"{base}_{suffix}"
            suffix += 1
        used_names.add(node)
        global_names[root_key] = node

    source_map: dict[str, Any] = {"components": {}, "blocks": {}, "nodes": {}}
    lines = [
        f"* {project['name']}",
        "* Generated from actoviq.project.v1 by circuit_project.py",
    ]
    model_lines: list[str] = []
    notebook_directives: list[dict[str, Any]] = []
    output_nodes: list[str] = []
    input_nodes: list[str] = []
    for module_ref in project["modules"]:
        module_id = module_ref["id"]
        module = modules[module_id]
        lines.append(f"* MODULE: {module_id} - {module['name']}")
        module_instance_names: dict[str, str] | None = None
        module_node_names: dict[str, str] | None = None
        if module["components"]:
            local_node_map: dict[str, str] = {"0": "0"}
            for port in module.get("ports", []):
                root_key = union.find(f"{module_id}::{port['id']}")
                local_node_map[port["net"]] = global_names[root_key]
                if port.get("direction") == "output" and port.get("signal_type") == "analog":
                    output_nodes.append(global_names[root_key])
                if port.get("direction") == "input" and port.get("signal_type") == "analog":
                    input_nodes.append(global_names[root_key])
            local_node_names = {local_net.casefold(): node for local_net, node in local_node_map.items()}

            def compiled_node_name(local_net: str) -> str:
                local_net = str(local_net)
                if local_net in local_node_map:
                    return local_node_map[local_net]
                folded = local_net.casefold()
                if folded in local_node_names:
                    return local_node_names[folded]
                node = sanitize_node(f"{module_id}_{local_net}")
                local_node_map[local_net] = node
                local_node_names[folded] = node
                return node

            instance_names = compiled_instance_name_map(module_id, module["components"])
            for component in module["components"]:
                component_type = component["type"]
                if component_type == "GND":
                    # Ground symbols carry no SPICE card; their pin already ties net '0'.
                    continue
                if component_type == "BLOCK":
                    component_name = sanitize_node(f"{module_id}_{component['name']}")
                    pin_summary = ", ".join(
                        f"{pin.get('name', pin.get('id', 'PIN'))}={pin.get('net', '')}"
                        for pin in component.get("pins", [])
                    )
                    lines.append(f"* BLOCK {component_name}: {component.get('value', '')} [{pin_summary}]")
                    source_map["blocks"][component_name] = {
                        "module_id": module_id,
                        "component_id": component["id"],
                        "pins": component.get("pins", []),
                    }
                    continue
                if component_type == "MODULE":
                    component_name = sanitize_node(f"{module_id}_{component['name']}")
                    child_id = str((component.get("module_ref") or {}).get("module_id") or "")
                    lines.append(
                        f"* MODULE {component_name}: child={child_id} "
                        f"(ignored in flat composition; set composition.mode=hierarchical)"
                    )
                    continue
                component_name = compiled_component_name(module_id, component)
                for pin in component.get("pins", []) or []:
                    compiled_node_name(str(pin.get("net") or ""))
                compiled_value = rewrite_compiled_value_references(
                    component_type,
                    component["value"],
                    instance_names,
                    compiled_node_name,
                )
                line = emit_leaf_component_line(
                    component,
                    device_catalog=device_catalog,
                    node_map=local_node_map,
                    compiled_name=component_name,
                    compiled_value=compiled_value,
                )
                if line:
                    lines.append(line)
                source_map["components"][component_name] = {
                    "module_id": module_id,
                    "component_id": component["id"],
                }
            for local_net, global_node in local_node_map.items():
                source_map["nodes"][global_node] = {"module_id": module_id, "local_net": local_net}
            module_instance_names = instance_names
            module_node_names = {
                str(local_net).casefold(): global_node
                for local_net, global_node in local_node_map.items()
            }
        else:
            # Notebook-backed module: splice its SPICE body (devices + models)
            # and hoist its analysis/measurement directives to the system deck so
            # MOSFET/active and DC/transient designs simulate at the system level,
            # not only through the auto-generated AC test bench. Local node names
            # are kept verbatim (a notebook module is a self-contained sub-circuit).
            notebook_path = root / "modules" / module_id / "netlist-notebook.md"
            if notebook_path.exists():
                for raw in extract_notebook_netlist(
                    notebook_path.read_text(encoding="utf-8")
                ).splitlines():
                    stripped = raw.strip()
                    if not stripped or stripped.startswith("*"):
                        continue
                    low = stripped.lower()
                    if low == ".end":
                        continue
                    if low.startswith(".model"):
                        if stripped not in model_lines:
                            model_lines.append(stripped)
                    elif low.startswith(ANALYSIS_DIRECTIVE_PREFIXES):
                        notebook_directives.append({
                            "text": stripped,
                            "instance_names": None,
                            "node_names": None,
                        })
                    else:
                        lines.append(stripped)

        spice = module.get("spice") if isinstance(module.get("spice"), dict) else {}
        generated_testbench = bool(spice.get("generated_testbench")) or (
            "standalone module testbench generated by circuit_project.py" in str(spice.get("source", "")).lower()
        )
        if not generated_testbench:
            for raw in spice.get("opaque", []):
                stripped = str(raw).strip()
                if stripped and stripped not in lines:
                    lines.append(stripped)
        for raw in spice.get("models", []):
            stripped = str(raw).strip()
            if stripped and stripped not in model_lines:
                model_lines.append(stripped)
        if not generated_testbench:
            for raw in spice.get("directives", []):
                stripped = str(raw).strip()
                if (
                    stripped
                    and stripped.lower() != ".end"
                    and stripped not in {entry["text"] for entry in notebook_directives}
                ):
                    notebook_directives.append({
                        "text": stripped,
                        "instance_names": module_instance_names,
                        "node_names": module_node_names,
                    })

    if model_lines:
        lines.append("* Device models")
        lines.extend(model_lines)

    if notebook_directives:
        # Structured modules prefix instance/node names; rewrite hoisted analyses
        # so system-level `.dc VIN` resolves to `Vflash_core_VIN`, etc.
        rewritten_directives = [
            rewrite_analysis_directive(
                str(entry["text"]),
                entry.get("instance_names"),
                entry.get("node_names"),
            )
            for entry in notebook_directives
        ]
        lines.append("* Analysis (from module notebooks)")
        lines.extend(rewritten_directives)
        probed = re.findall(
            r"(?i)v(?:db)?\(\s*([a-z0-9_.:+\-]+)", " ".join(rewritten_directives)
        )
        if probed:
            source_map["primary_output_node"] = probed[-1]
    else:
        ac = project.get("analyses", {}).get("ac", {})
        if ac.get("enabled", True):
            points = int(ac.get("points_per_decade", 20))
            start = float(ac.get("start_hz", 10))
            stop = float(ac.get("stop_hz", 1_000_000))
            lines.append(f".ac dec {points} {start:g} {stop:g}")
            if output_nodes:
                consumed = set(input_nodes)
                system_outputs = [node for node in output_nodes if node not in consumed]
                output_node = (system_outputs or output_nodes)[-1]
                lines.append(f".meas ac output_1khz_db find vdb({output_node}) at=1k")
                lines.append(f".meas ac output_10khz_db find vdb({output_node}) at=10k")
                lines.append(f".print ac vdb({output_node})")
                source_map["primary_output_node"] = output_node
    lines.append(".end")
    build_root = root / "build" / "system"
    build_root.mkdir(parents=True, exist_ok=True)
    netlist_path = build_root / "design.final.cir"
    netlist_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    atomic_write_json(build_root / "source-map.json", source_map)
    manifest = {
        "schema": "actoviq.build.v1",
        "project_id": project["project_id"],
        "revision": project["revision"],
        "source_revision": project["revision"],
        "document_hash": project_document_hash(project, modules),
        "built_at": utc_now(),
        "status": "compiling",
        "netlist": "system/design.final.cir",
        "source_map": "system/source-map.json",
        "erc": "erc.json",
        "erc_status": erc["status"],
        "erc_summary": erc["summary"],
        "modules": {},
    }
    atomic_write_json(root / "build" / "build-manifest.json", manifest)
    # Recompiling invalidates any prior run, so the report is design-only until
    # the next simulate_project regenerates it with fresh AC metrics.
    write_project_report(root, project, modules, "\n".join(lines) + "\n", None)
    module_results = []
    for module_ref in project["modules"]:
        module_results.append(compile_module(root, module_ref["id"]))
    final_manifest = {
        **manifest,
        "built_at": utc_now(),
        "status": "compiled",
        "modules": {
            result["module_id"]: {
                "status": "compiled",
                "revision": result["revision"],
                "netlist": f"modules/{result['module_id']}/design.cir",
                "schematic": (
                    f"modules/{result['module_id']}/schematic.svg"
                    if result.get("render", {}).get("ok")
                    else None
                ),
                "renderer": result.get("render", {}).get("renderer", "netlistsvg"),
                "render_ok": bool(result.get("render", {}).get("ok")),
                "schematic_document": (
                    f"modules/{result['module_id']}/schematic-document.json"
                    if result.get("schematic_document_path")
                    else None
                ),
                "render_map": f"modules/{result['module_id']}/schematic-render-map.json",
            }
            for result in module_results
        },
    }
    atomic_write_json(root / "build" / "build-manifest.json", final_manifest)
    return {
        "ok": True,
        "project_id": project["project_id"],
        "revision": project["revision"],
        "netlist_path": str(netlist_path),
        "manifest_path": str(root / "build" / "build-manifest.json"),
        "primary_output_node": source_map.get("primary_output_node"),
        "erc": erc,
        "modules": {
            result["module_id"]: result for result in module_results
        },
    }


def run_json_script(script_path: Path, args: list[str], timeout_sec: int = 90) -> dict[str, Any]:
    completed = subprocess.run(
        [sys.executable, str(script_path), *args],
        cwd=str(script_path.parent),
        text=True,
        capture_output=True,
        timeout=timeout_sec,
        check=False,
    )
    line = next(
        (entry for entry in reversed(completed.stdout.splitlines()) if entry.strip()),
        "",
    )
    try:
        result = json.loads(line)
    except json.JSONDecodeError:
        result = {
            "ok": False,
            "error": completed.stderr.strip() or completed.stdout.strip(),
        }
    if completed.returncode != 0:
        result["ok"] = False
    return result


def resolve_netlistsvg_bin() -> str:
    repo_root = Path(__file__).resolve().parents[3]
    local_bin = repo_root / "node_modules" / ".bin" / ("netlistsvg.cmd" if os.name == "nt" else "netlistsvg")
    return str(local_bin) if local_bin.exists() else "netlistsvg"


def render_module_schematic(
    build_root: Path,
    netlist_path: Path,
    module: dict[str, Any],
    renderer: str = "netlistsvg",
) -> dict[str, Any]:
    scripts_root = Path(__file__).resolve().parent
    svg_path = build_root / "schematic.svg"
    if renderer == "grid-experimental":
        grid = run_json_script(
            scripts_root / "render_grid.py",
            ["--netlist", str(netlist_path), "--svg-path", str(svg_path)],
            timeout_sec=60,
        )
        if grid.get("ok") and svg_path.exists():
            return {
                "ok": True,
                "json_path": "",
                "svg_path": str(svg_path),
                "renderer": "grid-experimental",
                "details": grid,
            }
        return {
            "ok": False,
            "json_path": "",
            "svg_path": str(svg_path) if svg_path.exists() else "",
            "renderer": "grid-experimental",
            "details": grid,
        }
    input_port = next(
        (
            port for port in module.get("ports", [])
            if port.get("direction") == "input" and port.get("signal_type") != "ground"
        ),
        None,
    )
    output_port = next(
        (
            port for port in module.get("ports", [])
            if port.get("direction") == "output" and port.get("signal_type") != "ground"
        ),
        None,
    )
    json_path = build_root / "design.json"
    convert_args = [
        "--netlist-path", str(netlist_path),
        "--json-path", str(json_path),
        "--view", "schematic",
    ]
    if input_port:
        convert_args.extend(["--input-node", str(input_port["net"])])
    if output_port:
        convert_args.extend(["--output-node", str(output_port["net"])])
    converted = run_json_script(scripts_root / "netlist_to_json.py", convert_args)
    if not converted.get("ok"):
        return {
            "ok": False,
            "stage": "netlist_to_json",
            "error": converted.get("error") or converted.get("stderr"),
        }
    project_root = build_root.parents[2]
    overrides_path = schematic_overrides_path(project_root, module["module_id"])
    render_args = [
        "--json-path", str(json_path),
        "--svg-path", str(svg_path),
        "--netlistsvg-bin", resolve_netlistsvg_bin(),
        "--skin-profile", "analog",
        "--timeout-sec", "45",
    ]
    if overrides_path.exists():
        render_args.extend(["--overrides-path", str(overrides_path)])
    rendered = run_json_script(
        scripts_root / "render_netlistsvg.py",
        render_args,
        timeout_sec=60,
    )
    return {
        "ok": bool(rendered.get("ok")) and svg_path.exists(),
        "json_path": str(json_path),
        "svg_path": str(svg_path) if svg_path.exists() else "",
        "renderer": "netlistsvg",
        "details": rendered,
    }


def compile_module(root: Path, module_id: str, renderer: str = "netlistsvg") -> dict[str, Any]:
    project, modules = load_project(root)
    erc = write_erc_result(root, project, modules)
    if module_id not in modules:
        raise ValueError(f"unknown module: {module_id}")
    module = modules[module_id]
    node_map: dict[str, str] = {"0": "0"}
    node_names: dict[str, str] = {"0": "0"}

    def node_name(local_net: str) -> str:
        local_net = str(local_net)
        if local_net in node_map:
            return node_map[local_net]
        folded = local_net.casefold()
        if folded in node_names:
            return node_names[folded]
        node = sanitize_node(local_net)
        node_map[local_net] = node
        node_names[folded] = node
        return node

    body_lines = [
        f"* {project['name']} / {module['name']}",
        "* Standalone module testbench generated by circuit_project.py",
    ]
    driven_nodes: set[str] = set()
    instance_names = compiled_instance_name_map(module_id, module["components"])
    for component in module["components"]:
        component_type = component["type"]
        if component_type == "GND":
            # Ground symbols carry no SPICE card; their pin already ties net '0'.
            continue
        if component_type == "BLOCK":
            component_name = sanitize_node(f"{module_id}_{component['name']}")
            pin_summary = ", ".join(
                f"{pin.get('name', pin.get('id', 'PIN'))}={pin.get('net', '')}"
                for pin in component.get("pins", [])
            )
            body_lines.append(f"* BLOCK {component_name}: {component.get('value', '')} [{pin_summary}]")
            continue
        if component_type == "MODULE":
            child_id = str((component.get("module_ref") or {}).get("module_id") or "")
            body_lines.append(
                f"* MODULE {component.get('name')}: child={child_id} "
                f"(see design.hier.cir for .subckt/X expansion)"
            )
            continue
        component_name = compiled_component_name(module_id, component)
        for pin in component.get("pins", []) or []:
            node_name(str(pin.get("net") or ""))
        compiled_value = rewrite_compiled_value_references(
            component_type,
            component["value"],
            instance_names,
            node_name,
        )
        line = emit_leaf_component_line(
            component,
            device_catalog=resolve_project_device_catalog(project),
            node_map=node_map,
            compiled_name=component_name,
            compiled_value=compiled_value,
        )
        if line:
            body_lines.append(line)
        if component_type in {"V", "I"} and component["pins"]:
            driven_nodes.add(node_name(component["pins"][0]["net"]))

    def testbench_tail(existing_driven: set[str]) -> list[str]:
        tail: list[str] = []
        outputs: list[str] = []
        local_driven = set(existing_driven)
        for port in module.get("ports", []):
            node = node_name(port["net"])
            if port["signal_type"] == "analog" and port["direction"] == "input" and node not in local_driven:
                tail.append(f"Vtest_{sanitize_node(port['id'])} {node} 0 DC 0 AC 1")
                local_driven.add(node)
            elif port["signal_type"] == "power" and port["direction"] == "input" and node not in local_driven:
                tail.append(f"Vtest_{sanitize_node(port['id'])} {node} 0 DC 5")
                local_driven.add(node)
            if port["signal_type"] == "analog" and port["direction"] == "output":
                outputs.append(node)
                tail.append(f"Rload_{sanitize_node(port['id'])} {node} 0 1meg")
        tail.append(".ac dec 20 10 1meg")
        if outputs:
            output_node = outputs[-1]
            tail.append(f".meas ac module_output_1khz_db find vdb({output_node}) at=1k")
            tail.append(f".meas ac module_output_10khz_db find vdb({output_node}) at=10k")
            tail.append(f".print ac vdb({output_node})")
        return tail

    notebook_path = root / "modules" / module_id / "netlist-notebook.md"
    if notebook_path.exists():
        notebook_netlist = extract_notebook_netlist(notebook_path.read_text(encoding="utf-8"))
        if re.search(r"(?im)^\s*\.meas\b", notebook_netlist):
            # The notebook defines its own measurements; run it verbatim.
            netlist_text = notebook_netlist
        else:
            # Wrap the user's schematic netlist with a generated testbench so the
            # module still produces simulation metrics. Schematic rendering filters
            # the Vtest_/Rload_ helpers out through the "schematic" view.
            trimmed = re.sub(r"(?im)^\s*\.end\s*$", "", notebook_netlist).rstrip()
            tail = testbench_tail(scan_driven_nodes(notebook_netlist))
            netlist_text = "\n".join([trimmed, *tail, ".end"]) + "\n"
        # SPICE treats the first line as the title and ignores it, so a notebook
        # that starts with a component would lose that element in ngspice. Ensure
        # a leading comment/title line whenever the user's netlist lacks one.
        if not netlist_text.lstrip().startswith("*"):
            netlist_text = f"* {project['name']} / {module['name']}\n{netlist_text}"
    else:
        netlist_text = "\n".join([*body_lines, *testbench_tail(driven_nodes), ".end"]) + "\n"
    build_root = root / "build" / "modules" / module_id
    build_root.mkdir(parents=True, exist_ok=True)
    netlist_path = build_root / "design.cir"
    netlist_path.write_text(netlist_text, encoding="utf-8")
    atomic_write_json(build_root / "connectivity.json", connectivity_payload(module))
    if any(str(component.get("type") or "").upper() == "MODULE" for component in module.get("components", []) or []):
        hier_lines = [
            f"* hierarchical view for {module_id}",
            *emit_module_subckt(module_id, module, modules, unknown_policy="error"),
            ".end",
        ]
        (build_root / "design.hier.cir").write_text("\n".join(hier_lines) + "\n", encoding="utf-8")
    schematic_document_path = build_root / "schematic-document.json"
    schematic_document = read_json(schematic_document_path) if schematic_document_path.exists() else None
    render_result = render_module_schematic(build_root, netlist_path, module, renderer)
    render_map_path = build_root / "schematic-render-map.json"
    atomic_write_json(
        render_map_path,
        schematic_render_map(module, renderer, schematic_document),
    )
    manifest_path = root / "build" / "build-manifest.json"
    manifest = read_json(manifest_path) if manifest_path.exists() else {
        "schema": "actoviq.build.v1",
        "project_id": project["project_id"],
        "revision": project["revision"],
        "built_at": utc_now(),
        "status": "compiled",
    }
    manifest.setdefault("modules", {})[module_id] = {
        "status": "compiled",
        "revision": module["revision"],
        "netlist": f"modules/{module_id}/design.cir",
        "schematic": f"modules/{module_id}/schematic.svg" if render_result.get("ok") else None,
        "renderer": render_result.get("renderer", "netlistsvg"),
        "render_ok": bool(render_result.get("ok")),
        "schematic_document": (
            f"modules/{module_id}/schematic-document.json"
            if schematic_document_path.exists()
            else None
        ),
        "render_map": f"modules/{module_id}/schematic-render-map.json",
    }
    manifest["erc"] = "erc.json"
    manifest["erc_status"] = erc["status"]
    manifest["erc_summary"] = erc["summary"]
    atomic_write_json(manifest_path, manifest)
    return {
        "ok": True,
        "project_id": project["project_id"],
        "module_id": module_id,
        "revision": module["revision"],
        "netlist_path": str(netlist_path),
        "schematic_path": render_result.get("svg_path", ""),
        "schematic_document_path": str(schematic_document_path) if schematic_document_path.exists() else "",
        "render_map_path": str(render_map_path),
        "render": render_result,
        "erc": erc,
    }


def resolve_ngspice(value: str) -> str:
    candidates = [
        value.strip(),
        os.environ.get("NGSPICE_BIN", "").strip(),
    ]
    config_path = Path(__file__).resolve().parents[1] / "tool_paths.json"
    if config_path.exists():
        try:
            candidates.append(str(read_json(config_path).get("ngspice_bin", "")).strip())
        except (OSError, json.JSONDecodeError):
            pass
    candidates.append("ngspice")
    for candidate in candidates:
        if not candidate:
            continue
        path_value = Path(candidate)
        if path_value.exists():
            if os.name == "nt" and path_value.name.lower() == "ngspice.exe":
                console = path_value.with_name("ngspice_con.exe")
                if console.exists():
                    return str(console.resolve())
            return str(path_value.resolve())
        resolved = shutil.which(candidate)
        if resolved:
            return resolved
    raise ValueError("ngspice executable not found; configure Settings, NGSPICE_BIN, or tool_paths.json")


def parse_measurements(netlist_text: str, log_text: str) -> list[dict[str, Any]]:
    """Surface every ``.meas``/``.measure`` result from an ngspice batch log.

    Measurement names are read from the netlist so this works for any analysis
    (ac/dc/tran) and any user-defined measurement name, not just the AC dB
    metrics the generated test benches happen to emit. A measurement that
    ngspice could not evaluate (e.g. ``find ... at=`` outside the swept
    interval) is reported as a failed metric instead of silently vanishing.
    """
    metrics: list[dict[str, Any]] = []
    seen: set[str] = set()
    for name in re.findall(r"(?im)^\s*\.meas(?:ure)?\s+\w+\s+([a-z_]\w*)", netlist_text):
        if name in seen:
            continue
        seen.add(name)
        match = re.search(rf"(?im)^\s*{re.escape(name)}\s*=\s*([-+0-9.eE]+)", log_text)
        value: float | None = None
        if match:
            try:
                value = float(match.group(1))
            except ValueError:
                value = None
        metrics.append({
            "name": name,
            "value": value,
            "unit": "dB" if name.lower().endswith("_db") else "",
            "pass": value is not None,
            "measurement_status": "measured" if value is not None else "failed",
            "specification_status": "not_evaluated",
            "source": "ngspice-measure",
        })
    return metrics


ANALYSIS_LINE = re.compile(r"^\s*\.(op|dc|ac|tran|sp|noise|pz)\b", re.IGNORECASE)
ANALYSIS_OUTPUT_LINE = re.compile(
    r"^\s*\.(?:meas(?:ure)?|print|plot|probe)\s+(op|dc|ac|tran|sp|noise|pz)\b",
    re.IGNORECASE,
)


CURRENT_PROBE_PARAMETER = {
    "R": "i",
    "C": "i",
    "L": "i",
    "D": "id",
    "M": "id",
    "Q": "ic",
}


def current_probe_vectors(lines: list[str]) -> list[str]:
    vectors: list[str] = []
    for raw in lines:
        stripped = strip_spice_comment(raw)
        if not stripped or stripped.startswith("."):
            continue
        instance = stripped.split(maxsplit=1)[0]
        parameter = CURRENT_PROBE_PARAMETER.get(instance[:1].upper())
        if parameter and re.fullmatch(r"[A-Za-z][A-Za-z0-9_.:+\-]*", instance):
            vectors.append(f"@{instance}[{parameter}]")
    return list(dict.fromkeys(vectors))


def advanced_directive_parts(directive: str) -> tuple[str, list[str], dict[str, str]]:
    tokens = shlex.split(directive)
    if len(tokens) < 2 or tokens[0].lower() != ".actoviq":
        raise ValueError(f"invalid Vibe Analog analysis directive: {directive}")
    positional: list[str] = []
    options: dict[str, str] = {}
    for token in tokens[2:]:
        if "=" in token:
            key, value = token.split("=", 1)
            options[key.lower()] = value
        else:
            positional.append(token)
    return tokens[1].lower(), positional, options


def split_analysis_decks(netlist_text: str) -> list[dict[str, Any]]:
    lines = netlist_text.splitlines()
    title = lines[0] if lines and lines[0].strip() else "* Vibe Analog simulation"
    analyses: list[tuple[str, str]] = []
    advanced_directives: list[str] = []
    base_lines: list[str] = [title]
    output_lines: list[tuple[str, str]] = []
    for index, raw in enumerate(lines):
        if index == 0:
            continue
        stripped = raw.strip()
        low = stripped.lower()
        if low == ".end":
            continue
        if low.startswith(".actoviq "):
            advanced_directives.append(stripped)
            continue
        analysis_match = ANALYSIS_LINE.match(stripped)
        if analysis_match:
            analyses.append((analysis_match.group(1).lower(), stripped))
            continue
        output_match = ANALYSIS_OUTPUT_LINE.match(stripped)
        if output_match:
            output_lines.append((output_match.group(1).lower(), stripped))
            continue
        base_lines.append(raw)
    if not analyses:
        analyses.append(("op", ".op"))
    probe_vectors = current_probe_vectors(base_lines)
    if probe_vectors:
        base_lines.append(f".save all {' '.join(probe_vectors)}")
    counts: dict[str, int] = {}
    decks: list[dict[str, Any]] = []
    ordinary_by_type: dict[str, dict[str, Any]] = {}
    for analysis_type, directive in analyses:
        counts[analysis_type] = counts.get(analysis_type, 0) + 1
        normalized_type = "sparameter" if analysis_type == "sp" else analysis_type
        analysis_id = f"{normalized_type}-{counts[analysis_type]}"
        related = [line for line_type, line in output_lines if line_type == analysis_type]
        if not any(re.match(r"(?i)^\s*\.print\b", line) for line in related):
            probes = []
            for line in related:
                probes.extend(re.findall(r"(?i)\b(?:v(?:db|m|p|r|i)?|i)\([^()]+\)", line))
            if probes:
                related.append(f".print {analysis_type} {' '.join(dict.fromkeys(probes))}")
        deck = "\n".join([*base_lines, directive, *related, ".end", ""])
        analysis = {
            "id": analysis_id,
            "type": normalized_type,
            "directive_type": analysis_type,
            "directive": directive,
            "deck": deck,
        }
        decks.append(analysis)
        ordinary_by_type.setdefault(analysis_type, analysis)

    advanced_counts: dict[str, int] = {}
    for directive in advanced_directives:
        kind, positional, options = advanced_directive_parts(directive)
        if kind == "spec":
            continue
        advanced_counts[kind] = advanced_counts.get(kind, 0) + 1
        analysis_id = f"{'parameter-sweep' if kind == 'sweep' else kind}-{advanced_counts[kind]}"
        if kind == "fft":
            trace = positional[0] if positional else ""
            window = options.get("window", "blackman")
            transient = ordinary_by_type.get("tran")
            error = None
            if not transient:
                error = "FFT requires a transient analysis in the same netlist."
            elif not trace or not re.fullmatch(r"[A-Za-z0-9_#().:+,\-]+", trace):
                error = "FFT requires a valid transient vector such as v(out)."
            elif window not in {
                "none", "rectangular", "bartlet", "hanning", "hann", "blackman",
                "blackmanharris", "hamming", "gaussian", "flattop",
            }:
                error = f"Unsupported FFT window: {window}"
            tran_command = transient["directive"].lstrip(".") if transient else "tran 1n 1u"
            deck = "\n".join([
                *base_lines,
                ".control",
                tran_command,
                f"linearize {trace or 'v(out)'}",
                f"set specwindow={window}",
                f"fft {trace or 'v(out)'}",
                f"write vectors.raw {trace or 'v(out)'}",
                "quit",
                ".endc",
                ".end",
                "",
            ])
            decks.append({
                "id": analysis_id,
                "type": "fft",
                "directive_type": "fft",
                "directive": directive,
                "deck": deck,
                "configuration_error": error,
            })
            continue
        if kind in {"sweep", "montecarlo"}:
            required = 4 if kind == "sweep" else 4
            requested_type = options.get("analysis", "ac").lower()
            inner = ordinary_by_type.get(requested_type)
            error = None
            if len(positional) < required:
                error = (
                    ".actoviq sweep requires TARGET START STOP COUNT."
                    if kind == "sweep"
                    else ".actoviq montecarlo requires TARGET NOMINAL RELATIVE_SIGMA RUNS."
                )
            elif inner is None:
                error = f"{kind} requires a .{requested_type} analysis in the same netlist."
            decks.append({
                "id": analysis_id,
                "type": "parameter_sweep" if kind == "sweep" else "monte_carlo",
                "directive_type": kind,
                "directive": directive,
                "deck": inner["deck"] if inner else "\n".join([*base_lines, ".op", ".end", ""]),
                "inner_type": inner["type"] if inner else requested_type,
                "target": positional[0] if positional else "",
                "start": positional[1] if len(positional) > 1 else "",
                "stop": positional[2] if len(positional) > 2 else "",
                "count": positional[3] if len(positional) > 3 else "",
                "seed": options.get("seed", "1"),
                "configuration_error": error,
            })
            continue
        decks.append({
            "id": analysis_id,
            "type": kind,
            "directive_type": kind,
            "directive": directive,
            "deck": "\n".join([*base_lines, ".op", ".end", ""]),
            "configuration_error": f"Unsupported Vibe Analog analysis: {kind}",
        })
    return decks


def parse_raw_scalar(token: str) -> complex:
    normalized = token.strip().strip("()")
    if "," in normalized:
        real, imaginary = normalized.split(",", 1)
        return complex(float(real), float(imaginary))
    return complex(float(normalized), 0.0)


def raw_header_int(header: str, name: str) -> int:
    match = re.search(rf"(?im)^{re.escape(name)}:\s*(\d+)", header)
    if not match:
        raise ValueError(f"ngspice rawfile is missing {name}")
    return int(match.group(1))


def parse_ngspice_raw(raw_path: Path) -> list[dict[str, Any]]:
    data = raw_path.read_bytes()
    cursor = 0
    plots: list[dict[str, Any]] = []
    while cursor < len(data):
        while cursor < len(data) and data[cursor] in b"\r\n\x00 \t":
            cursor += 1
        if cursor >= len(data):
            break
        markers = [
            (position, marker)
            for marker in (b"Values:", b"Binary:")
            if (position := data.find(marker, cursor)) >= 0
        ]
        if not markers:
            break
        marker_position, marker = min(markers, key=lambda value: value[0])
        header = data[cursor:marker_position].decode("utf-8", errors="replace")
        if "Title:" not in header:
            cursor = marker_position + len(marker)
            continue
        variable_count = raw_header_int(header, "No. Variables")
        point_count = raw_header_int(header, "No. Points")
        flags_match = re.search(r"(?im)^Flags:\s*(.+)$", header)
        flags = (flags_match.group(1).strip().lower().split() if flags_match else ["real"])
        complex_values = "complex" in flags
        plotname_match = re.search(r"(?im)^Plotname:\s*(.+)$", header)
        variables: list[dict[str, str]] = []
        variables_section = header.split("Variables:", 1)[-1] if "Variables:" in header else ""
        for raw in variables_section.splitlines():
            match = re.match(r"^\s*\d+\s+(\S+)\s+(\S+)", raw)
            if match:
                variables.append({"name": match.group(1), "kind": match.group(2)})
        if len(variables) != variable_count:
            raise ValueError(
                f"ngspice rawfile variable table has {len(variables)} entries, expected {variable_count}"
            )
        line_end = data.find(b"\n", marker_position)
        values_start = len(data) if line_end < 0 else line_end + 1
        values: list[list[complex]] = [[] for _ in range(variable_count)]
        if marker == b"Binary:":
            scalar_count = point_count * variable_count * (2 if complex_values else 1)
            byte_count = scalar_count * 8
            if values_start + byte_count > len(data):
                raise ValueError("ngspice binary rawfile is truncated")
            scalar_values = struct.unpack_from(f"<{scalar_count}d", data, values_start)
            scalar_index = 0
            for _point in range(point_count):
                for variable_index in range(variable_count):
                    if complex_values:
                        value = complex(scalar_values[scalar_index], scalar_values[scalar_index + 1])
                        scalar_index += 2
                    else:
                        value = complex(scalar_values[scalar_index], 0.0)
                        scalar_index += 1
                    values[variable_index].append(value)
            cursor = values_start + byte_count
        else:
            cursor = values_start
            for _point in range(point_count):
                for variable_index in range(variable_count):
                    while cursor < len(data):
                        next_line = data.find(b"\n", cursor)
                        if next_line < 0:
                            next_line = len(data)
                        line = data[cursor:next_line].decode("utf-8", errors="replace").strip()
                        cursor = min(len(data), next_line + 1)
                        if line:
                            break
                    tokens = line.split()
                    if not tokens:
                        raise ValueError("ngspice ASCII rawfile is truncated")
                    token = tokens[-1]
                    values[variable_index].append(parse_raw_scalar(token))
        plots.append({
            "plotname": plotname_match.group(1).strip() if plotname_match else "ngspice analysis",
            "flags": flags,
            "variables": variables,
            "values": values,
            "point_count": point_count,
        })
    return plots


def variable_unit(kind: str, name: str) -> str:
    low_kind = kind.lower()
    low_name = name.lower()
    if low_kind == "frequency" or low_name == "frequency":
        return "Hz"
    if low_kind == "time" or low_name == "time":
        return "s"
    if "pole(" in low_name or "zero(" in low_name:
        return "rad/s"
    if "noise" in low_name:
        return "V/sqrt(Hz)"
    if low_kind == "voltage" or low_name.startswith("v("):
        return "V"
    if low_kind == "current" or low_name.startswith("i("):
        return "A"
    return ""


def plot_to_dataset(plot: dict[str, Any], analysis_id: str, analysis_type: str) -> dict[str, Any]:
    variables = plot["variables"]
    values = plot["values"]
    if analysis_type == "pz":
        scale_name = "root"
        scale_unit = ""
        scale_values = [0.0]
        trace_variables = variables
        trace_values = values
    else:
        scale_name = variables[0]["name"] if variables else "index"
        scale_unit = variable_unit(variables[0]["kind"], variables[0]["name"]) if variables else ""
        scale_values = [value.real for value in values[0]] if values else []
        trace_variables = variables[1:]
        trace_values = values[1:]
    traces: list[dict[str, Any]] = []
    for variable, variable_values in zip(trace_variables, trace_values):
        real = [value.real for value in variable_values]
        imaginary = [value.imag for value in variable_values]
        trace: dict[str, Any] = {
            "name": variable["name"],
            "unit": variable_unit(variable["kind"], variable["name"]),
            "real": real,
        }
        if "complex" in plot["flags"] or any(abs(value) > 1e-30 for value in imaginary):
            magnitude = [math.hypot(real_value, imaginary_value) for real_value, imaginary_value in zip(real, imaginary)]
            trace.update({
                "imag": imaginary,
                "magnitude": magnitude,
                "db": [20 * math.log10(max(value, 1e-300)) for value in magnitude],
                "phase_deg": [math.degrees(math.atan2(imag_value, real_value)) for real_value, imag_value in zip(real, imaginary)],
            })
        traces.append(trace)
    return {
        "schema": "actoviq.simulation-dataset.v1",
        "id": f"{analysis_id}-dataset-1",
        "analysis_id": analysis_id,
        "analysis_type": analysis_type,
        "plotname": plot["plotname"],
        "point_count": plot["point_count"],
        "x": {
            "name": scale_name,
            "unit": scale_unit,
            "values": scale_values,
        },
        "traces": traces,
    }


def measured_metric(name: str, value: float | None, unit: str, source: str = "derived") -> dict[str, Any]:
    return {
        "name": name,
        "value": value,
        "unit": unit,
        "pass": value is not None and math.isfinite(value),
        "measurement_status": "measured" if value is not None and math.isfinite(value) else "failed",
        "specification_status": "not_evaluated",
        "source": source,
    }


def primary_trace(dataset: dict[str, Any]) -> dict[str, Any] | None:
    traces = dataset.get("traces", [])
    def output_score(trace: dict[str, Any]) -> int:
        name = str(trace.get("name", "")).lower()
        if re.fullmatch(r"v\((?:v?out|output)\)", name):
            return 0
        if "vout" in name or "output" in name:
            return 1
        if "out" in name:
            return 2
        return 100

    preferred = sorted((trace for trace in traces if output_score(trace) < 100), key=output_score)
    voltages = [trace for trace in traces if trace.get("unit") == "V"]
    return (preferred or voltages or traces or [None])[0]


def crossing_x(x: list[float], y: list[float], target: float, start_index: int = 1) -> float | None:
    for index in range(max(1, start_index), min(len(x), len(y))):
        left = y[index - 1] - target
        right = y[index] - target
        if left == 0:
            return x[index - 1]
        if left * right <= 0 and y[index] != y[index - 1]:
            ratio = (target - y[index - 1]) / (y[index] - y[index - 1])
            return x[index - 1] + ratio * (x[index] - x[index - 1])
    return None


def derived_metrics(dataset: dict[str, Any]) -> list[dict[str, Any]]:
    analysis_type = dataset.get("analysis_type")
    x = [float(value) for value in dataset.get("x", {}).get("values", [])]
    trace = primary_trace(dataset)
    if not trace or not x:
        return []
    metrics: list[dict[str, Any]] = []
    if analysis_type == "ac" and trace.get("db"):
        db = [float(value) for value in trace["db"]]
        phase = [float(value) for value in trace.get("phase_deg", [])]
        bandwidth = crossing_x(x, db, db[0] - 3.0)
        metrics.append(measured_metric("bandwidth_3db", bandwidth, "Hz"))
        unity = crossing_x(x, db, 0.0)
        if unity is not None and phase:
            unity_index = min(range(len(x)), key=lambda index: abs(x[index] - unity))
            metrics.append(measured_metric("phase_margin", 180.0 + phase[unity_index], "deg"))
        if phase:
            phase_crossing = crossing_x(x, phase, -180.0)
            if phase_crossing is not None:
                phase_index = min(range(len(x)), key=lambda index: abs(x[index] - phase_crossing))
                metrics.append(measured_metric("gain_margin", -db[phase_index], "dB"))
    elif analysis_type == "tran":
        y = [float(value) for value in trace.get("real", [])]
        if len(y) >= 2:
            low = min(y)
            high = max(y)
            span = high - low
            t10 = crossing_x(x, y, low + 0.1 * span) if span > 0 else None
            t90 = crossing_x(x, y, low + 0.9 * span) if span > 0 else None
            rise_time = t90 - t10 if t10 is not None and t90 is not None and t90 >= t10 else None
            slopes = [
                (y[index] - y[index - 1]) / (x[index] - x[index - 1])
                for index in range(1, min(len(x), len(y)))
                if x[index] != x[index - 1]
            ]
            metrics.extend([
                measured_metric("rise_time_10_90", rise_time, "s"),
                measured_metric("slew_rate_positive", max(slopes) if slopes else None, "V/s"),
                measured_metric("slew_rate_negative", min(slopes) if slopes else None, "V/s"),
            ])
            tail = y[max(0, int(len(y) * 0.8)):]
            metrics.append(measured_metric("output_ripple", max(tail) - min(tail) if tail else None, "V"))
    elif analysis_type == "dc":
        y = [float(value) for value in trace.get("real", [])]
        if len(y) >= 2 and x[-1] != x[0]:
            metrics.append(measured_metric("dc_output_min", min(y), trace.get("unit", "")))
            metrics.append(measured_metric("dc_output_max", max(y), trace.get("unit", "")))
            metrics.append(measured_metric("dc_line_slope", (y[-1] - y[0]) / (x[-1] - x[0]), "V/V"))
    elif analysis_type == "sparameter" and trace.get("magnitude"):
        return_loss = [-20 * math.log10(max(float(value), 1e-300)) for value in trace["magnitude"]]
        metrics.append(measured_metric("minimum_return_loss", min(return_loss), "dB"))
    elif analysis_type == "noise":
        for noise_trace in dataset.get("traces", []):
            values = [abs(float(value)) for value in noise_trace.get("real", [])]
            if not values:
                continue
            index = min(range(len(x)), key=lambda item: abs(x[item] - 1_000.0))
            metrics.append(measured_metric(f"{noise_trace['name']}_at_1khz", values[index], noise_trace.get("unit", "")))
    elif analysis_type == "fft":
        magnitude = [float(value) for value in trace.get("magnitude", trace.get("real", []))]
        candidates = [index for index, frequency in enumerate(x) if frequency > 0 and index < len(magnitude)]
        if candidates:
            dominant = max(candidates, key=lambda index: magnitude[index])
            metrics.append(measured_metric("dominant_frequency", x[dominant], "Hz"))
            metrics.append(measured_metric("dominant_magnitude", magnitude[dominant], trace.get("unit", "")))
    elif analysis_type == "pz":
        pole_count = sum("pole" in str(item.get("name", "")).lower() for item in dataset.get("traces", []))
        zero_count = sum("zero" in str(item.get("name", "")).lower() for item in dataset.get("traces", []))
        metrics.append(measured_metric("pole_count", float(pole_count), ""))
        metrics.append(measured_metric("zero_count", float(zero_count), ""))
    return metrics


SPICE_NUMBER_SUFFIXES = {
    "t": 1e12,
    "g": 1e9,
    "meg": 1e6,
    "k": 1e3,
    "m": 1e-3,
    "u": 1e-6,
    "n": 1e-9,
    "p": 1e-12,
    "f": 1e-15,
}


def parse_spice_number(value: str) -> float:
    match = re.fullmatch(
        r"\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*([A-Za-z]+)?\s*",
        value,
        flags=re.IGNORECASE,
    )
    if not match:
        raise ValueError(f"invalid SPICE scalar: {value}")
    number = float(match.group(1))
    suffix = (match.group(2) or "").lower()
    if not suffix:
        return number
    multiplier = next(
        (factor for name, factor in sorted(SPICE_NUMBER_SUFFIXES.items(), key=lambda item: -len(item[0])) if suffix.startswith(name)),
        None,
    )
    if multiplier is None:
        raise ValueError(f"unsupported SPICE scalar suffix: {value}")
    return number * multiplier


def simple_spice_parameters(deck: str) -> dict[str, float]:
    raw_values: dict[str, str] = {}
    for raw in deck.splitlines():
        stripped = strip_spice_comment(raw)
        if not re.match(r"(?i)^\s*\.param\b", stripped):
            continue
        declaration = re.sub(r"(?i)^\s*\.param\b", "", stripped, count=1)
        for match in re.finditer(r"([A-Za-z_]\w*)\s*=\s*(\{[^}]+\}|[^\s]+)", declaration):
            raw_values[match.group(1).lower()] = match.group(2)

    resolved: dict[str, float] = {}

    def resolve(name: str, resolving: set[str]) -> float:
        key = name.lower()
        if key in resolved:
            return resolved[key]
        if key in resolving or key not in raw_values:
            raise ValueError(f"unresolved SPICE parameter: {name}")
        token = raw_values[key].strip()
        reference = token[1:-1].strip() if token.startswith("{") and token.endswith("}") else token
        try:
            value = parse_spice_number(reference)
        except ValueError:
            value = resolve(reference, {*resolving, key})
        resolved[key] = value
        return value

    for parameter in raw_values:
        try:
            resolve(parameter, set())
        except ValueError:
            continue
    return resolved


def passive_ac_current_specs(deck: str) -> list[tuple[str, str, str, str, float]]:
    parameters = simple_spice_parameters(deck)
    specs: list[tuple[str, str, str, str, float]] = []
    for raw in deck.splitlines():
        stripped = strip_spice_comment(raw)
        if not stripped or stripped.startswith("."):
            continue
        tokens = stripped.split()
        if len(tokens) < 4 or tokens[0][:1].upper() not in {"R", "C", "L"}:
            continue
        value_token = tokens[3].strip()
        reference = (
            value_token[1:-1].strip().lower()
            if value_token.startswith("{") and value_token.endswith("}")
            else ""
        )
        try:
            value = parameters[reference] if reference else parse_spice_number(value_token)
        except (KeyError, ValueError):
            continue
        if value > 0:
            specs.append((tokens[0], tokens[0][0].upper(), tokens[1], tokens[2], value))
    return specs


def add_passive_ac_currents(dataset: dict[str, Any], deck: str) -> None:
    if dataset.get("analysis_type") != "ac":
        return
    frequencies = [float(value) for value in dataset.get("x", {}).get("values", [])]
    if not frequencies:
        return
    traces = dataset.get("traces", [])
    by_name = {
        str(trace.get("name", "")).replace(" ", "").lower(): trace
        for trace in traces
    }

    def node_values(node: str) -> list[complex] | None:
        if node.lower() in {"0", "gnd!"}:
            return [0j] * len(frequencies)
        trace = by_name.get(f"v({node})".replace(" ", "").lower())
        if not trace:
            return None
        real = trace.get("real", [])
        imaginary = trace.get("imag", [0.0] * len(real))
        if len(real) != len(frequencies) or len(imaginary) != len(real):
            return None
        return [complex(float(real_value), float(imag_value)) for real_value, imag_value in zip(real, imaginary)]

    for instance, kind, positive_node, negative_node, value in passive_ac_current_specs(deck):
        positive = node_values(positive_node)
        negative = node_values(negative_node)
        if positive is None or negative is None:
            continue
        voltage = [left - right for left, right in zip(positive, negative)]
        if kind == "R":
            current = [item / value for item in voltage]
        elif kind == "C":
            current = [item * complex(0.0, 2.0 * math.pi * frequency * value) for item, frequency in zip(voltage, frequencies)]
        else:
            current = [
                item / complex(0.0, 2.0 * math.pi * frequency * value)
                for item, frequency in zip(voltage, frequencies)
            ]
        magnitude = [abs(item) for item in current]
        replacement = {
            "name": f"i(@{instance}[i])",
            "unit": "A",
            "real": [item.real for item in current],
            "imag": [item.imag for item in current],
            "magnitude": magnitude,
            "db": [20 * math.log10(max(item, 1e-300)) for item in magnitude],
            "phase_deg": [math.degrees(math.atan2(item.imag, item.real)) for item in current],
            "source": "derived_from_ac_node_voltages",
        }
        existing = next(
            (
                index for index, trace in enumerate(traces)
                if str(trace.get("name", "")).replace(" ", "").lower()
                == replacement["name"].replace(" ", "").lower()
            ),
            None,
        )
        if existing is None:
            traces.append(replacement)
        else:
            traces[existing] = replacement


def parse_simulation_specifications(netlist_text: str) -> tuple[list[dict[str, Any]], list[str]]:
    specifications: list[dict[str, Any]] = []
    diagnostics: list[str] = []
    for line_number, raw in enumerate(netlist_text.splitlines(), start=1):
        stripped = raw.strip()
        if not re.match(r"(?i)^\.actoviq\s+spec\b", stripped):
            continue
        try:
            _kind, positional, options = advanced_directive_parts(stripped)
            if not positional:
                raise ValueError("spec requires a metric name")
            if "min" not in options and "max" not in options:
                raise ValueError("spec requires min=, max=, or both")
            minimum = parse_spice_number(options["min"]) if "min" in options else None
            maximum = parse_spice_number(options["max"]) if "max" in options else None
            if minimum is not None and maximum is not None and minimum > maximum:
                raise ValueError("spec min cannot be greater than max")
            specifications.append({
                "metric": positional[0],
                "minimum": minimum,
                "maximum": maximum,
                "unit": options.get("unit", ""),
                "directive": stripped,
                "line": line_number,
            })
        except ValueError as exc:
            diagnostics.append(f"line {line_number}: {exc}")
    return specifications, diagnostics


def evaluate_simulation_specifications(
    metrics: list[dict[str, Any]],
    specifications: list[dict[str, Any]],
) -> tuple[str, list[dict[str, Any]]]:
    if not specifications:
        return "not_evaluated", []
    outcomes: list[dict[str, Any]] = []
    for specification in specifications:
        matching = [metric for metric in metrics if metric.get("name") == specification["metric"]]
        measured = next(
            (
                metric for metric in matching
                if isinstance(metric.get("value"), (int, float)) and math.isfinite(float(metric["value"]))
            ),
            None,
        )
        value = float(measured["value"]) if measured else None
        passed = bool(
            value is not None
            and (specification["minimum"] is None or value >= specification["minimum"])
            and (specification["maximum"] is None or value <= specification["maximum"])
        )
        status = "passed" if passed else "failed" if measured else "missing"
        target = {
            "minimum": specification["minimum"],
            "maximum": specification["maximum"],
            "unit": specification["unit"],
        }
        if measured:
            measured["specification_status"] = status
            measured["specification"] = target
        outcomes.append({
            **specification,
            "value": value,
            "status": status,
        })
    return (
        "passed" if all(outcome["status"] == "passed" for outcome in outcomes) else "failed",
        outcomes,
    )


def replace_sweep_target(deck: str, target: str, value: float) -> tuple[str, bool]:
    formatted = f"{value:.12g}"
    if target.lower().startswith("param:"):
        parameter = target.split(":", 1)[1]
        pattern = re.compile(rf"(?i)(\b{re.escape(parameter)}\s*=\s*)([^\s)]+)")
        replaced, count = pattern.subn(lambda match: f"{match.group(1)}{formatted}", deck, count=1)
        return replaced, count == 1
    output: list[str] = []
    changed = False
    for raw in deck.splitlines():
        tokens = raw.split()
        if tokens and tokens[0].lower() == target.lower() and tokens[0][:1].upper() in {"R", "C", "L"}:
            if len(tokens) < 4:
                return deck, False
            tokens[3] = formatted
            output.append(" ".join(tokens))
            changed = True
        else:
            output.append(raw)
    return "\n".join(output) + ("\n" if deck.endswith("\n") else ""), changed


def select_analysis_plot(plots: list[dict[str, Any]], analysis_type: str) -> dict[str, Any] | None:
    if not plots:
        return None
    if analysis_type == "noise":
        return max(plots, key=lambda plot: int(plot.get("point_count", 0)))
    if analysis_type == "pz":
        return next(
            (plot for plot in plots if "pole" in str(plot.get("plotname", "")).lower()),
            plots[-1],
        )
    return plots[-1]


def configuration_error_result(
    analysis: dict[str, Any],
    analysis_root: Path,
    message: str,
) -> dict[str, Any]:
    return {
        "id": analysis["id"],
        "type": analysis["type"],
        "directive": analysis["directive"],
        "status": "configuration_error",
        "execution_status": "not_run",
        "measurement_status": "not_requested",
        "specification_status": "not_evaluated",
        "diagnostics": [message],
        "metrics": [],
        "dataset": None,
        "deck_path": str(analysis_root / "deck.cir"),
        "log_path": str(analysis_root / "ngspice.log"),
    }


def run_ensemble_analysis(
    executable: str,
    run_root: Path,
    analysis: dict[str, Any],
) -> dict[str, Any]:
    analysis_root = run_root / analysis["id"]
    analysis_root.mkdir(parents=True, exist_ok=True)
    deck_path = analysis_root / "deck.cir"
    atomic_write_text(deck_path, analysis["deck"])
    try:
        count = int(analysis["count"])
        if analysis["type"] == "parameter_sweep":
            if count < 2 or count > 101:
                raise ValueError("parameter sweep count must be between 2 and 101")
            start = parse_spice_number(str(analysis["start"]))
            stop = parse_spice_number(str(analysis["stop"]))
            values = [start + (stop - start) * index / (count - 1) for index in range(count)]
        else:
            if count < 2 or count > 200:
                raise ValueError("Monte Carlo run count must be between 2 and 200")
            nominal = parse_spice_number(str(analysis["start"]))
            relative_sigma = float(analysis["stop"])
            if relative_sigma <= 0 or relative_sigma > 1:
                raise ValueError("Monte Carlo relative sigma must be within 0..1")
            generator = random.Random(int(analysis.get("seed", 1)))
            values = [generator.gauss(nominal, abs(nominal) * relative_sigma) for _ in range(count)]
    except (TypeError, ValueError) as exc:
        return configuration_error_result(analysis, analysis_root, str(exc))

    members_root = analysis_root / "members"
    datasets: list[tuple[float, dict[str, Any]]] = []
    member_summaries: list[dict[str, Any]] = []
    diagnostics: list[str] = []
    for index, value in enumerate(values):
        member_deck, changed = replace_sweep_target(analysis["deck"], analysis["target"], value)
        if not changed:
            return configuration_error_result(
                analysis,
                analysis_root,
                f"Sweep target {analysis['target']} was not found or is not a supported R/C/L device or param.",
            )
        member_id = f"member-{index + 1:03d}"
        member = run_analysis(executable, members_root, {
            "id": member_id,
            "type": analysis["inner_type"],
            "directive_type": analysis["inner_type"],
            "directive": analysis["directive"],
            "deck": member_deck,
        })
        member_summaries.append({
            "id": member_id,
            "value": value,
            "status": member.get("status"),
        })
        member_dataset_path = members_root / member_id / "dataset.json"
        if member.get("status") == "completed" and member_dataset_path.exists():
            datasets.append((value, read_json(member_dataset_path)))
        else:
            diagnostics.extend(str(item) for item in member.get("diagnostics", []))

    if not datasets:
        return {
            **configuration_error_result(analysis, analysis_root, "No ensemble member produced a dataset."),
            "status": "failed",
            "execution_status": "failed",
            "members": member_summaries,
            "diagnostics": diagnostics or ["No ensemble member produced a dataset."],
        }

    first_dataset = datasets[0][1]
    point_count = min(int(dataset.get("point_count", 0)) for _, dataset in datasets)
    x_values = list(first_dataset["x"]["values"][:point_count])
    aggregate_traces: list[dict[str, Any]] = []
    samples: list[float] = []
    for value, dataset in datasets:
        trace = primary_trace(dataset)
        if trace is None:
            continue
        next_trace = {
            key: (list(field[:point_count]) if isinstance(field, list) else field)
            for key, field in trace.items()
        }
        next_trace["name"] = f"{trace['name']} [{analysis['target']}={value:.6g}]"
        aggregate_traces.append(next_trace)
        series = next_trace.get("magnitude") or next_trace.get("real") or []
        if series:
            samples.append(float(series[-1]))

    dataset = {
        "schema": "actoviq.simulation-dataset.v1",
        "id": f"{analysis['id']}-dataset-1",
        "analysis_id": analysis["id"],
        "analysis_type": analysis["type"],
        "plotname": "Parameter sweep" if analysis["type"] == "parameter_sweep" else "Monte Carlo",
        "point_count": point_count,
        "x": {**first_dataset["x"], "values": x_values},
        "traces": aggregate_traces,
        "members": [{"value": value} for value, _dataset in datasets],
    }
    dataset_path = analysis_root / "dataset.json"
    atomic_write_json(dataset_path, dataset)
    metrics = [measured_metric("ensemble_member_count", float(len(datasets)), "")]
    if samples:
        metrics.extend([
            measured_metric("ensemble_output_min", min(samples), aggregate_traces[0].get("unit", "")),
            measured_metric("ensemble_output_max", max(samples), aggregate_traces[0].get("unit", "")),
            measured_metric("ensemble_output_mean", statistics.fmean(samples), aggregate_traces[0].get("unit", "")),
            measured_metric(
                "ensemble_output_stddev",
                statistics.pstdev(samples) if len(samples) > 1 else 0.0,
                aggregate_traces[0].get("unit", ""),
            ),
        ])
    status = "completed" if len(datasets) == len(values) else "partial"
    return {
        "id": analysis["id"],
        "type": analysis["type"],
        "directive": analysis["directive"],
        "status": status,
        "execution_status": "success" if status == "completed" else "partial",
        "measurement_status": "success",
        "specification_status": "not_evaluated",
        "diagnostics": diagnostics,
        "metrics": metrics,
        "members": member_summaries,
        "dataset": {
            "path": str(dataset_path.relative_to(run_root.parent.parent)).replace("\\", "/"),
            "id": dataset["id"],
            "plotname": dataset["plotname"],
            "point_count": point_count,
            "x_name": dataset["x"]["name"],
            "x_unit": dataset["x"]["unit"],
            "traces": [
                {"name": trace["name"], "unit": trace.get("unit", ""), "complex": "imag" in trace}
                for trace in aggregate_traces
            ],
        },
        "deck_path": str(deck_path),
        "log_path": str(analysis_root / "ngspice.log"),
    }


def has_sparameter_ports(deck: str) -> bool:
    ports = {
        int(value)
        for value in re.findall(r"(?im)^\s*v\S+\s+\S+\s+\S+.*\bportnum\s*(?:=\s*)?(\d+)", deck)
    }
    return len(ports) >= 2 and ports == set(range(1, len(ports) + 1))


def run_analysis(
    executable: str,
    run_root: Path,
    analysis: dict[str, Any],
) -> dict[str, Any]:
    analysis_root = run_root / analysis["id"]
    analysis_root.mkdir(parents=True, exist_ok=True)
    deck_path = analysis_root / "deck.cir"
    raw_path = analysis_root / "vectors.raw"
    log_path = analysis_root / "ngspice.log"
    atomic_write_text(deck_path, analysis["deck"])
    if analysis.get("configuration_error"):
        return configuration_error_result(
            analysis,
            analysis_root,
            str(analysis["configuration_error"]),
        )
    if analysis["type"] in {"parameter_sweep", "monte_carlo"}:
        return run_ensemble_analysis(executable, run_root, analysis)
    if analysis["type"] == "sparameter" and not has_sparameter_ports(analysis["deck"]):
        return configuration_error_result(
            analysis,
            analysis_root,
            "S-parameter analysis requires at least two consecutive VSRC portnum ports with Z0.",
        )
    try:
        # Windows rejects long working-directory paths before ngspice starts.
        # Execute from a short temporary directory, then persist every artifact
        # beneath the revisioned run directory once the process has exited.
        with tempfile.TemporaryDirectory(prefix="actoviq-ngspice-") as temporary:
            execution_root = Path(temporary)
            execution_deck_path = execution_root / "deck.cir"
            execution_raw_path = execution_root / "vectors.raw"
            execution_log_path = execution_root / "ngspice.log"
            execution_deck_path.write_text(analysis["deck"], encoding="utf-8")
            command = [executable, "-b"]
            if analysis["type"] != "fft":
                command.extend(["-r", str(execution_raw_path)])
            command.extend(["-o", str(execution_log_path), str(execution_deck_path)])
            completed = subprocess.run(
                command,
                cwd=str(execution_root),
                text=True,
                capture_output=True,
                timeout=120,
                check=False,
            )
            log_text = (
                execution_log_path.read_text(encoding="utf-8", errors="replace")
                if execution_log_path.exists() else ""
            )
            plots = parse_ngspice_raw(execution_raw_path) if execution_raw_path.exists() else []
            if execution_raw_path.exists():
                shutil.copyfile(execution_raw_path, raw_path)
            atomic_write_text(log_path, log_text)
            measurement_log_path: Path | None = None
            measurement_log_text = log_text
            if re.search(r"(?im)^\s*\.meas(?:ure)?\b", analysis["deck"]):
                measurement_log_path = analysis_root / "measurements.log"
                execution_measurement_path = execution_root / "measurements.log"
                subprocess.run(
                    [executable, "-b", "-o", str(execution_measurement_path), str(execution_deck_path)],
                    cwd=str(execution_root),
                    text=True,
                    capture_output=True,
                    timeout=120,
                    check=False,
                )
                measurement_log_text = (
                    execution_measurement_path.read_text(encoding="utf-8", errors="replace")
                    if execution_measurement_path.exists() else ""
                )
                atomic_write_text(measurement_log_path, measurement_log_text)
        selected_plot = select_analysis_plot(plots, analysis["type"])
        dataset = (
            plot_to_dataset(selected_plot, analysis["id"], analysis["type"])
            if selected_plot else None
        )
        dataset_path = analysis_root / "dataset.json"
        if dataset:
            add_passive_ac_currents(dataset, analysis["deck"])
            atomic_write_json(dataset_path, dataset)
        metrics = parse_measurements(analysis["deck"], measurement_log_text)
        if dataset:
            metrics.extend(derived_metrics(dataset))
        measured = [metric for metric in metrics if metric.get("measurement_status") == "measured"]
        status = "completed" if completed.returncode == 0 and dataset else "failed"
        diagnostics = []
        if status == "failed":
            diagnostics.append(log_text[-2000:] or completed.stderr.strip() or "ngspice produced no dataset")
        return {
            "id": analysis["id"],
            "type": analysis["type"],
            "directive": analysis["directive"],
            "status": status,
            "execution_status": "success" if completed.returncode == 0 else "failed",
            "measurement_status": (
                "not_requested" if not metrics else "success" if len(measured) == len(metrics) else "partial"
            ),
            "specification_status": "not_evaluated",
            "return_code": completed.returncode,
            "diagnostics": diagnostics,
            "metrics": metrics,
            "dataset": ({
                "path": str(dataset_path.relative_to(run_root.parent.parent)).replace("\\", "/"),
                "id": dataset["id"],
                "plotname": dataset["plotname"],
                "point_count": dataset["point_count"],
                "x_name": dataset["x"]["name"],
                "x_unit": dataset["x"]["unit"],
                "traces": [
                    {"name": trace["name"], "unit": trace["unit"], "complex": "imag" in trace}
                    for trace in dataset["traces"]
                ],
            } if dataset else None),
            "deck_path": str(deck_path),
            "raw_path": str(raw_path) if raw_path.exists() else None,
            "log_path": str(log_path),
            "measurement_log_path": str(measurement_log_path) if measurement_log_path else None,
            "stderr": completed.stderr.strip(),
        }
    except subprocess.TimeoutExpired:
        return {
            "id": analysis["id"],
            "type": analysis["type"],
            "directive": analysis["directive"],
            "status": "failed",
            "execution_status": "timeout",
            "measurement_status": "not_requested",
            "specification_status": "not_evaluated",
            "diagnostics": ["ngspice analysis exceeded the 120 second timeout."],
            "metrics": [],
            "dataset": None,
            "deck_path": str(deck_path),
            "log_path": str(log_path),
        }


class NgspiceSimulationProvider:
    """Adapter that keeps ngspice execution behind the provider-neutral run loop."""

    provider_id = "ngspice"

    def __init__(self, executable: str, osdi_paths: list[Path] | None = None):
        self.executable = executable
        self.osdi_paths = [Path(path).expanduser().resolve() for path in (osdi_paths or [])]
        self.execution_target = "local_windows" if os.name == "nt" else "local_linux"

    def run_analysis(self, run_root: Path, analysis: dict[str, Any]) -> dict[str, Any]:
        prepared = dict(analysis)
        prepared["deck"] = inject_ngspice_osdi(str(analysis["deck"]), self.osdi_paths)
        return run_analysis(self.executable, run_root, prepared)

    def metadata(self) -> dict[str, str]:
        version = Path(self.executable).name
        try:
            completed = subprocess.run(
                [self.executable, "--version"],
                shell=False,
                check=False,
                capture_output=True,
                text=True,
                timeout=10,
            )
            text = "\n".join((completed.stdout, completed.stderr)).strip()
            for line in text.splitlines():
                stripped = line.strip("* ").strip()
                if "ngspice-" in stripped.casefold():
                    version = stripped[:240]
                    break
            else:
                if text:
                    version = text.splitlines()[0][:240]
        except (OSError, subprocess.TimeoutExpired):
            pass
        return {
            "id": self.provider_id,
            "executable": self.executable,
            "version": version,
            "osdi": [str(path) for path in self.osdi_paths],
        }


def pdk_fingerprint(project: dict[str, Any]) -> str:
    profile = project.get("analog_ic_profile")
    if not isinstance(profile, dict):
        return ""
    binding = profile.get("pdk_binding")
    if isinstance(binding, dict):
        source = binding
    else:
        pdk = profile.get("pdk")
        source = {
            "name": pdk.get("name", ""),
            "corner": pdk.get("corner", ""),
            "temperature_c": pdk.get("temperature_c"),
        } if isinstance(pdk, dict) else {}
    if not source:
        return ""
    return hashlib.sha256(
        json.dumps(source, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def execute_simulation_run(
    root: Path,
    provider: NgspiceSimulationProvider | str,
    netlist_path: Path,
    source_revision: int,
    document_hash: str,
    scope: str,
    pdk_hash: str = "",
) -> dict[str, Any]:
    if isinstance(provider, str):
        provider = NgspiceSimulationProvider(provider)
    netlist_text = netlist_path.read_text(encoding="utf-8", errors="replace")
    simulation_root = netlist_path.parent / "simulation"
    runs_root = simulation_root / "runs"
    run_id = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')}-{document_hash[:8] or 'document'}"
    run_root = runs_root / run_id
    run_root.mkdir(parents=True, exist_ok=False)
    analyses = [provider.run_analysis(run_root, analysis) for analysis in split_analysis_decks(netlist_text)]
    metrics = [metric for analysis in analyses for metric in analysis.get("metrics", [])]
    specifications, specification_diagnostics = parse_simulation_specifications(netlist_text)
    specification_status, specification_results = evaluate_simulation_specifications(metrics, specifications)
    if specification_diagnostics:
        specification_status = "invalid"
    for analysis in analyses:
        metric_names = {metric.get("name") for metric in analysis.get("metrics", [])}
        relevant = [result for result in specification_results if result["metric"] in metric_names]
        analysis["specification_status"] = (
            "not_evaluated" if not relevant else
            "passed" if all(result["status"] == "passed" for result in relevant) else "failed"
        )
    completed = [analysis for analysis in analyses if analysis.get("status") == "completed"]
    failed = [analysis for analysis in analyses if analysis.get("status") != "completed"]
    result = {
        "schema": "actoviq.simulation.v3",
        "run_id": run_id,
        "scope": scope,
        "source_revision": source_revision,
        "document_hash": document_hash,
        "ok": len(failed) == 0 and len(completed) > 0,
        "execution_status": "success" if not failed else "partial" if completed else "failed",
        "measurement_status": (
            "not_requested" if not metrics else
            "success" if all(metric.get("measurement_status") == "measured" for metric in metrics) else "partial"
        ),
        "specification_status": specification_status,
        "verified": specification_status == "passed",
        "specifications": specification_results,
        "specification_diagnostics": specification_diagnostics,
        "analysis_count": len(analyses),
        "analyses": analyses,
        "metrics": metrics,
        "provider": provider.metadata(),
        "execution_target": provider.execution_target,
        "pdk_fingerprint": pdk_hash,
        "verification": {
            "executed": len(completed) > 0,
            "measured": bool(metrics) and all(
                metric.get("measurement_status") == "measured" for metric in metrics
            ),
            "spec_passed": specification_status == "passed",
            "lvs_clean": None,
            "ams_verified": False,
        },
        "ngspice": provider.executable,
        "simulated_at": utc_now(),
    }
    validate_simulation_run(result)
    atomic_write_json(run_root / "run.json", result)
    atomic_write_json(simulation_root / "result.json", result)
    return result


def execute_xyce_simulation_run(
    provider: XyceProvider,
    profile: dict[str, Any],
    netlist_path: Path,
    source_revision: int,
    document_hash: str,
    scope: str,
    pdk_hash: str = "",
) -> dict[str, Any]:
    simulation_root = netlist_path.parent / "simulation"
    run_id = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')}-{document_hash[:8] or 'document'}"
    run_root = simulation_root / "runs" / run_id
    result = provider.run_deck(netlist_path, run_root)
    specifications, specification_diagnostics = parse_simulation_specifications(
        netlist_path.read_text(encoding="utf-8", errors="replace")
    )
    specification_status, specification_results = evaluate_simulation_specifications(
        result.get("metrics", []),
        specifications,
    )
    if specification_diagnostics:
        specification_status = "invalid"
    result.update({
        "run_id": run_id,
        "scope": scope,
        "source_revision": source_revision,
        "document_hash": document_hash,
        "pdk_fingerprint": pdk_hash,
        "specification_status": specification_status,
        "verified": specification_status == "passed",
        "specifications": specification_results,
        "specification_diagnostics": specification_diagnostics,
        "simulation_profile_id": str(profile["id"]),
    })
    result["verification"]["spec_passed"] = specification_status == "passed"
    validate_simulation_run(result)
    atomic_write_json(run_root / "run.json", result)
    atomic_write_json(simulation_root / "result.json", result)
    return result


def execute_profiled_simulation(
    project: dict[str, Any],
    netlist_path: Path,
    source_revision: int,
    document_hash: str,
    scope: str,
    ngspice_bin: str,
    osdi_paths: list[Path] | None = None,
) -> dict[str, Any]:
    try:
        profile = resolve_simulation_profile(project, legacy_ngspice=ngspice_bin)
    except FileNotFoundError:
        if simulation_profile_id(project) != "ngspice-local":
            raise
        profile = resolve_simulation_profile(
            project,
            legacy_ngspice=resolve_ngspice(ngspice_bin),
        )
    netlist_path = assert_profile_path(profile, netlist_path)
    provider_id = str(profile["providerId"])
    if provider_id == "ngspice":
        result = execute_simulation_run(
            netlist_path.parents[2],
            NgspiceSimulationProvider(str(profile["executable"]), osdi_paths),
            netlist_path,
            source_revision,
            document_hash,
            scope,
            pdk_fingerprint(project),
        )
        result["simulation_profile_id"] = str(profile["id"])
        run_path = netlist_path.parent / "simulation" / "runs" / result["run_id"] / "run.json"
        atomic_write_json(run_path, result)
        atomic_write_json(netlist_path.parent / "simulation" / "result.json", result)
        return result
    if osdi_paths:
        raise ValueError("OSDI artifacts can only be loaded by an ngspice execution profile")
    return execute_xyce_simulation_run(
        XyceProvider(str(profile["executable"])),
        profile,
        netlist_path,
        source_revision,
        document_hash,
        scope,
        pdk_fingerprint(project),
    )


def simulate_dual_profiles(
    root: Path,
    left_profile_id: str,
    right_profile_id: str,
    relative_tolerance: float,
    absolute_tolerance: float,
    ngspice_bin: str = "",
) -> dict[str, Any]:
    if not left_profile_id or not right_profile_id or left_profile_id == right_profile_id:
        raise ValueError("dual simulation requires two different execution profiles")
    if relative_tolerance < 0 or absolute_tolerance < 0:
        raise ValueError("simulation comparison tolerances cannot be negative")
    project, _ = load_project(root)
    compiled = compile_project(root)
    manifest = read_json(root / "build" / "build-manifest.json")
    netlist_value = compiled.get("netlist_path") or compiled.get("netlist")
    if not netlist_value:
        raise ValueError("compile_project did not return a netlist path")
    netlist_path = Path(str(netlist_value))
    if not netlist_path.is_absolute():
        netlist_path = (root / "build" / netlist_path).resolve()
    source_revision = int(manifest.get("source_revision", manifest.get("revision", 0)))
    document_hash = str(manifest.get("document_hash", ""))

    def run(profile_id: str) -> dict[str, Any]:
        profile_project = json.loads(json.dumps(project))
        current = profile_project.get("analog_ic_profile")
        if not isinstance(current, dict) or current.get("schema") != "actoviq.analog-ic-profile.v2":
            current = {
                "schema": "actoviq.analog-ic-profile.v2",
                "pdk_binding": {"schema": "actoviq.pdk-binding.v1", "pdk_ref": "unbound"},
            }
        profile_project["analog_ic_profile"] = {
            **current,
            "simulation_profile_id": profile_id,
        }
        return execute_profiled_simulation(
            profile_project,
            netlist_path,
            source_revision,
            document_hash,
            "project",
            ngspice_bin,
        )

    left = run(left_profile_id)
    right = run(right_profile_id)
    comparison = compare_simulation_metrics(
        left,
        right,
        relative_tolerance,
        absolute_tolerance,
    )
    comparison_root = netlist_path.parent / "simulation" / "comparisons"
    run_id = f"dual-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')}"
    result = validate_verification_run({
        "schema": "actoviq.verification-run.v1",
        "run_id": run_id,
        "kind": "dual_simulation_comparison",
        "provider_id": "actoviq",
        "executed": bool(
            left.get("verification", {}).get("executed")
            and right.get("verification", {}).get("executed")
        ),
        "status": "passed" if comparison["ok"] else "failed",
        "diagnostics": [] if comparison["ok"] else ["simulation metrics differ or have no common measured values"],
        "artifacts": [
            {
                "kind": "left_simulation",
                "path": str(netlist_path.parent / "simulation" / "runs" / left["run_id"] / "run.json"),
            },
            {
                "kind": "right_simulation",
                "path": str(netlist_path.parent / "simulation" / "runs" / right["run_id"] / "run.json"),
            },
        ],
        "metadata": {
            "source_revision": source_revision,
            "document_hash": document_hash,
            "left_profile_id": left_profile_id,
            "right_profile_id": right_profile_id,
            "left_run_id": left["run_id"],
            "right_run_id": right["run_id"],
            "comparison": comparison,
        },
        "finished_at": utc_now(),
    })
    atomic_write_json(comparison_root / f"{run_id}.json", result)
    atomic_write_json(netlist_path.parent / "simulation" / "dual-comparison.json", result)
    return result


def simulate_post_layout(
    root: Path,
    deck: Path,
    layout: Path,
    schematic: Path,
    lvs_run_path: Path,
    ngspice_bin: str = "",
) -> dict[str, Any]:
    project, _ = load_project(root)
    deck = deck.expanduser().resolve()
    layout = layout.expanduser().resolve()
    schematic = schematic.expanduser().resolve()
    lvs_run_path = lvs_run_path.expanduser().resolve()
    for path, label in (
        (deck, "post-layout deck"),
        (layout, "layout"),
        (schematic, "schematic netlist"),
        (lvs_run_path, "LVS run"),
    ):
        if not path.is_file():
            raise ValueError(f"{label} does not exist: {path}")
    lvs_run = read_json(lvs_run_path)
    lvs_metadata = lvs_run.get("metadata") if isinstance(lvs_run.get("metadata"), dict) else {}
    if (
        lvs_run.get("schema") != "actoviq.verification-run.v1"
        or lvs_run.get("kind") != "lvs"
        or lvs_run.get("status") != "passed"
        or lvs_metadata.get("lvs_clean") is not True
    ):
        raise ValueError("post-layout simulation requires a passed, clean LVS run")
    layout_hash = hashlib.sha256(layout.read_bytes()).hexdigest()
    schematic_hash = hashlib.sha256(schematic.read_bytes()).hexdigest()
    if lvs_metadata.get("layout_hash") != layout_hash:
        raise ValueError("selected layout does not match the clean LVS run")
    if lvs_metadata.get("schematic_hash") != schematic_hash:
        raise ValueError("selected schematic does not match the clean LVS run")
    run_root = root / "build" / "physical" / "post_layout" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    run_root.mkdir(parents=True, exist_ok=False)
    local_deck = run_root / f"post-layout{deck.suffix or '.cir'}"
    shutil.copy2(deck, local_deck)
    result = execute_profiled_simulation(
        project,
        local_deck,
        int(project.get("revision", 0)),
        project_document_hash(*load_project(root)),
        "post_layout",
        ngspice_bin,
    )
    result["verification"]["lvs_clean"] = True
    result["post_layout"] = {
        "layout_path": str(layout),
        "layout_hash": layout_hash,
        "schematic_path": str(schematic),
        "schematic_hash": schematic_hash,
        "lvs_run_path": str(lvs_run_path),
        "lvs_run_id": str(lvs_run.get("run_id") or ""),
        "source_deck_path": str(deck),
        "source_deck_hash": hashlib.sha256(deck.read_bytes()).hexdigest(),
    }
    validate_simulation_run(result)
    simulation_root = local_deck.parent / "simulation"
    atomic_write_json(simulation_root / "runs" / result["run_id"] / "run.json", result)
    atomic_write_json(simulation_root / "result.json", result)
    return result


def simulate_project(
    root: Path,
    ngspice_bin: str,
    osdi_paths: list[Path] | None = None,
) -> dict[str, Any]:
    project, modules = load_project(root)
    analog_ic = supports_analog_ic_profile(project.get("project_kind"))
    if analog_ic and project.get("analog_ic_profile"):
        audit = audit_analog_ic_project(root, project, modules)
        atomic_write_json(root / "build" / "analog-ic" / "audit.json", audit)
        if not audit.get("ok"):
            codes = ", ".join(str(item.get("code")) for item in audit.get("errors", []))
            raise ValueError(f"analog IC audit failed before simulation: {codes}")
    compile_result = compile_project(root)
    netlist_path = Path(compile_result["netlist_path"])
    if analog_ic and project.get("analog_ic_profile"):
        atomic_write_text(
            netlist_path,
            rewrite_analog_ic_model_paths(netlist_path.read_text(encoding="utf-8"), root),
        )
    manifest_path = root / "build" / "build-manifest.json"
    manifest = read_json(manifest_path)
    result = execute_profiled_simulation(
        project,
        netlist_path,
        int(manifest.get("source_revision", manifest.get("revision", compile_result.get("revision", 0)))),
        str(manifest.get("document_hash", "")),
        "project",
        ngspice_bin,
        osdi_paths,
    )
    manifest["status"] = "simulated" if result["ok"] else "simulation_failed"
    manifest["simulation"] = "system/simulation/result.json"
    manifest["simulation_run_id"] = result["run_id"]
    atomic_write_json(manifest_path, manifest)
    report_project, report_modules = load_project(root)
    write_project_report(
        root,
        report_project,
        report_modules,
        netlist_path.read_text(encoding="utf-8"),
        result,
    )
    return result


def simulate_module(
    root: Path,
    module_id: str,
    ngspice_bin: str,
    osdi_paths: list[Path] | None = None,
) -> dict[str, Any]:
    project, modules = load_project(root)
    analog_ic = supports_analog_ic_profile(project.get("project_kind"))
    if analog_ic and project.get("analog_ic_profile"):
        audit = audit_analog_ic_project(root, project, modules)
        atomic_write_json(root / "build" / "analog-ic" / "audit.json", audit)
        if not audit.get("ok"):
            codes = ", ".join(str(item.get("code")) for item in audit.get("errors", []))
            raise ValueError(f"analog IC audit failed before simulation: {codes}")
    compile_result = compile_module(root, module_id)
    netlist_path = Path(compile_result["netlist_path"])
    if analog_ic and project.get("analog_ic_profile"):
        atomic_write_text(
            netlist_path,
            rewrite_analog_ic_model_paths(netlist_path.read_text(encoding="utf-8"), root),
        )
    manifest_path = root / "build" / "build-manifest.json"
    manifest = read_json(manifest_path)
    result = execute_profiled_simulation(
        project,
        netlist_path,
        int(manifest.get("source_revision", manifest.get("revision", 0))),
        str(manifest.get("document_hash", project_document_hash(*load_project(root)))),
        f"module:{module_id}",
        ngspice_bin,
        osdi_paths,
    )
    result["module_id"] = module_id
    atomic_write_json(netlist_path.parent / "simulation" / "result.json", result)
    manifest.setdefault("modules", {}).setdefault(module_id, {})["status"] = (
        "simulated" if result["ok"] else "simulation_failed"
    )
    manifest["modules"][module_id]["simulation"] = f"modules/{module_id}/simulation/result.json"
    manifest["modules"][module_id]["simulation_run_id"] = result["run_id"]
    atomic_write_json(manifest_path, manifest)
    return result


def project_summary(root: Path) -> dict[str, Any]:
    project, modules = load_project(root)
    erc = evaluate_erc(project, modules)
    modules = {
        module_id: hydrated_summary_module(root, module_id, module)
        for module_id, module in modules.items()
    }
    for module_ref in project.get("modules", []):
        module_id = module_ref.get("id")
        if module_id in modules and modules[module_id].get("ports"):
            module_ref["ports"] = modules[module_id]["ports"]
    return {
        "ok": True,
        "project": project,
        "modules": modules,
        "erc": erc,
        "project_root": str(root.resolve()),
    }



def agent_context(root: Path) -> dict[str, Any]:
    project, modules = load_project(root)
    kind = ensure_project_kind(project)
    kind_info = kind_summary(kind)
    erc = write_erc_result(root, project, modules)
    document_hash = project_document_hash(project, modules)
    manifest_path = root / "build" / "build-manifest.json"
    manifest = read_json(manifest_path) if manifest_path.exists() else None
    simulation_path = root / "build" / "system" / "simulation" / "result.json"
    simulation = read_json(simulation_path) if simulation_path.exists() else None
    build_current = bool(
        manifest
        and int(manifest.get("source_revision", manifest.get("revision", -1))) == project["revision"]
        and str(manifest.get("document_hash", "")) == document_hash
    )
    simulation_current = bool(
        simulation
        and int(simulation.get("source_revision", -1)) == project["revision"]
        and str(simulation.get("document_hash", "")) == document_hash
    )
    bridges = list_bridges(root)
    pcb_readiness = pcb_export_readiness(project, modules) if supports_eda_bridge(kind) else None
    analog_ic_audit = (
        audit_analog_ic_project(root, project, modules)
        if supports_analog_ic_profile(kind) and project.get("analog_ic_profile")
        else None
    )
    if supports_analog_ic_profile(kind) and not project.get("analog_ic_profile"):
        next_action = "configure_analog_ic"
    elif analog_ic_audit and not analog_ic_audit.get("ok"):
        next_action = "fix_analog_ic_audit"
    elif erc["blocking"]:
        next_action = "fix_erc"
    elif not build_current:
        next_action = "compile"
    elif requires_simulation(kind) and not simulation_current:
        next_action = "simulate"
    elif requires_simulation(kind) and simulation and simulation.get("specification_status") == "not_evaluated":
        next_action = "evaluate_specifications"
    elif supports_eda_bridge(kind) and pcb_readiness and not pcb_readiness.get("ready"):
        next_action = "complete_pcb_readiness"
    elif supports_eda_bridge(kind) and not bridges:
        next_action = "link_bridge"
    else:
        next_action = "ready"
    allowed_operations = [
        "upsert_module_netlist",
        "set_module_netlist",
        "set_module_schematic",
        "upsert_module",
        "remove_module",
        "add_component",
        "remove_component",
        "add_port",
        "connect_pins",
        "connect_ports",
        "set_connection_network",
        "set_component_value",
        "move_component",
        "set_module_metadata",
        "set_module_note",
    ]
    if supports_lcsc_binding(kind):
        allowed_operations.append("bind_lcsc_part")
    if supports_eda_bridge(kind):
        allowed_operations.append("place_library_component")
    if supports_analog_ic_profile(kind):
        allowed_operations.append("set_analog_ic_profile")
    return {
        "ok": True,
        "protocol_version": AGENT_PROTOCOL_VERSION,
        "compatibility": {
            "project_schema": PROJECT_SCHEMA,
            "module_schema": MODULE_SCHEMA,
            "command_schema": COMMAND_SCHEMA,
            "erc_schema": ERC_SCHEMA,
            "simulation_schema": "actoviq.simulation.v2",
        },
        "workspace_root": str(root.parent.parent.resolve()),
        "project_root": str(root.resolve()),
        "project_id": project["project_id"],
        "project_kind": kind,
        "kind": kind_info,
        "bridges": bridges,
        "lcsc": {
            "supported": supports_lcsc_binding(kind),
            "tools": ["search_lcsc_parts", "get_lcsc_part", "bind_lcsc_part"] if supports_lcsc_binding(kind) else [],
        },
        "analog_ic": {
            "supported": supports_analog_ic_profile(kind),
            "audit": analog_ic_audit,
            "virtuoso_export": supports_virtuoso_export(kind),
        },
        "pcb_readiness": pcb_readiness,
        "base_revision": project["revision"],
        "document_hash": document_hash,
        "project": project,
        "modules": modules,
        "erc": erc,
        "build": {
            "state": "current" if build_current else "stale" if manifest else "missing",
            "manifest": manifest,
        },
        "simulation": {
            "state": "current" if simulation_current else "stale" if simulation else "missing",
            "run": simulation,
            "required": requires_simulation(kind),
        },
        "next_action": next_action,
        "modularity": modularity_summary(project, modules),
        "reference_catalog": catalog_summary_for_agent(
            project,
            modules,
            connectivity_hash_fn=connectivity_hash,
        ),
        "transaction": {
            "schema": COMMAND_SCHEMA,
            "project_id": project["project_id"],
            "base_revision": project["revision"],
            "allowed_operations": allowed_operations,
        },
    }


def apply_layout_from_reference_command(
    root: Path,
    *,
    module_id: str,
    asset_id: str,
) -> dict[str, Any]:
    """Apply a schematic_layout snapshot or layout_idiom guide without changing SPICE."""
    project, modules = load_project(root)
    if module_id not in modules:
        raise ValueError(f"unknown module: {module_id}")
    prepared = prepare_layout_from_reference(
        project,
        modules,
        module_id=module_id,
        asset_id=asset_id,
        connectivity_hash_fn=connectivity_hash,
    )
    if prepared.get("mode") == "snapshot":
        if not prepared.get("hash_match"):
            return {**prepared, "applied": False, "ok": False, "error": prepared.get("message")}
        layout_ref = prepared["layout_reference"]
        module = modules[module_id]
        components = apply_placements_to_components(module, layout_ref)
        try:
            candidate = _evaluate_layout_candidate(
                module_id,
                module,
                components,
                prepared["connectivity_hash"],
            )
        except ValueError as error:
            return {
                "ok": False,
                "applied": False,
                "mode": "snapshot",
                "asset_id": asset_id,
                "module_id": module_id,
                "connectivity_hash": prepared["connectivity_hash"],
                "hash_match": True,
                "error": f"layout snapshot matched connectivity but reroute failed: {error}",
            }
        command = {
            "schema": COMMAND_SCHEMA,
            "command_id": f"apply-layout-ref-{asset_id}-{int(time.time())}",
            "actor": "agent",
            "project_id": project["project_id"],
            "base_revision": project["revision"],
            "message": f"Apply schematic layout reference {asset_id} to {module_id}",
            "operations": [
                {
                    "op": "set_module_schematic",
                    "module_id": module_id,
                    "expected_connectivity_hash": prepared["connectivity_hash"],
                    "connectivity_view": "design",
                    "components": candidate["components"],
                    "ports": candidate["ports"],
                    "wires": candidate["wires"],
                    "nets": candidate["nets"],
                    "annotations": module.get("annotations", []),
                }
            ],
        }
        applied = apply_command(root, command)
        return {
            "ok": True,
            "applied": True,
            "mode": "snapshot",
            "asset_id": asset_id,
            "module_id": module_id,
            "connectivity_hash": prepared["connectivity_hash"],
            "quality": candidate.get("quality"),
            "revision": applied.get("revision"),
            "apply_result": applied,
        }

    if prepared.get("mode") == "idiom":
        if prepared.get("use_as") != "guide_router":
            return {**prepared, "applied": False, "ok": False, "error": prepared.get("message")}
        patch = prepared.get("layout_patch") or {"schema": "actoviq.layout-patch.v1", "operations": []}
        if not patch.get("operations"):
            return {**prepared, "applied": False, "ok": False, "error": "idiom produced no layout operations"}
        output_dir = root / "build" / "layout-reviews" / f"idiom-{asset_id}"
        output_dir.mkdir(parents=True, exist_ok=True)
        document_hash = project_document_hash(project, modules)
        state = prepare_layout_review(
            project,
            modules,
            module_id=module_id,
            view="design",
            document_hash=document_hash,
            source_revision=int(project["revision"]),
            output_dir=output_dir,
        )
        patch_set = {
            "schema": "actoviq.layout-patch-set.v1",
            "source_revision": int(project["revision"]),
            "connectivity_hash": state["connectivity_hash"],
            "candidates": [patch],
        }
        evaluated = evaluate_layout_patches(
            project,
            modules,
            read_json(Path(state["state_path"])),
            patch_set,
            module_id=module_id,
            document_hash=document_hash,
            source_revision=int(project["revision"]),
            output_dir=output_dir,
            view="design",
        )
        applied_result = None
        if evaluated.get("improved") and isinstance(evaluated.get("module_schematic"), dict):
            winner = evaluated["module_schematic"]
            command = {
                "schema": COMMAND_SCHEMA,
                "command_id": f"apply-idiom-{asset_id}-{int(time.time())}",
                "actor": "agent",
                "project_id": project["project_id"],
                "base_revision": project["revision"],
                "message": f"Apply layout idiom {asset_id} to {module_id}",
                "operations": [
                    {
                        "op": "set_module_schematic",
                        "module_id": module_id,
                        "expected_connectivity_hash": state["connectivity_hash"],
                        "connectivity_view": "design",
                        "components": winner.get("components", []),
                        "ports": winner.get("ports", []),
                        "wires": winner.get("wires", []),
                        "nets": winner.get("nets", []),
                        "annotations": modules[module_id].get("annotations", []),
                    }
                ],
            }
            applied_result = apply_command(root, command)
        return {
            "ok": True,
            "applied": bool(applied_result),
            "mode": "idiom",
            "asset_id": asset_id,
            "module_id": module_id,
            "prepare": prepared,
            "evaluate": evaluated,
            "apply_result": applied_result,
            "message": (
                "idiom guide applied after quality improvement"
                if applied_result
                else "idiom guide evaluated without improvement; source unchanged"
            ),
        }

    return {**prepared, "applied": False, "ok": False, "error": prepared.get("message") or "cannot apply layout reference"}


def insert_module_from_circuit_reference(
    root: Path,
    *,
    asset_id: str,
    module_id: str | None = None,
) -> dict[str, Any]:
    asset = load_asset(asset_id)
    if asset.get("kind") not in {"circuit_module", "circuit_project"}:
        raise ValueError("insert-module requires a circuit_module or circuit_project asset")
    files = (asset.get("payload") or {}).get("files") or {}
    notebook_rel = files.get("netlist_notebook") or "netlist-notebook.md"
    notebook_path = Path(asset["root_path"]) / "payload" / notebook_rel
    if not notebook_path.exists():
        raise ValueError(f"circuit reference notebook missing: {notebook_path}")
    notebook = notebook_path.read_text(encoding="utf-8")
    project, _modules = load_project(root)
    mid = module_id or _slugify_module_id(str(asset.get("name") or asset_id))
    command = {
        "schema": COMMAND_SCHEMA,
        "command_id": f"insert-ref-{asset_id}-{int(time.time())}",
        "actor": "agent",
        "project_id": project["project_id"],
        "base_revision": project["revision"],
        "message": f"Insert circuit reference {asset_id} as module {mid}",
        "operations": [
            {
                "op": "upsert_module_netlist",
                "module_id": mid,
                "name": str(asset.get("name") or mid),
                "kind": "imported",
                "function": f"Imported from reference {asset_id}",
                "netlist_notebook": notebook,
                "preview_enabled": True,
                "position": {"x": 120, "y": 120},
                "size": {"width": 380, "height": 300},
            }
        ],
    }
    applied = apply_command(root, command)
    return {"ok": True, "module_id": mid, "asset_id": asset_id, "apply_result": applied}


def create_project_from_circuit_reference(
    *,
    asset_id: str,
    name: str | None = None,
    project_kind: str = DEFAULT_PROJECT_KIND,
    projects_root: Path | None = None,
) -> dict[str, Any]:
    asset = load_asset(asset_id)
    if asset.get("kind") not in {"circuit_module", "circuit_project"}:
        raise ValueError("create-project requires a circuit_module or circuit_project asset")
    files = (asset.get("payload") or {}).get("files") or {}
    notebook_rel = files.get("netlist_notebook") or "netlist-notebook.md"
    notebook_path = Path(asset["root_path"]) / "payload" / notebook_rel
    if not notebook_path.exists():
        raise ValueError(f"circuit reference notebook missing: {notebook_path}")
    notebook = notebook_path.read_text(encoding="utf-8")
    resolved = resolve_projects_root(projects_root=str(projects_root) if projects_root else None)
    project_name = name or str(asset.get("name") or asset_id)
    root = initialize_project(
        Path(resolved["projects_root"]),
        project_name,
        None,
        False,
        project_kind=project_kind,
    )
    project, _modules = load_project(root)
    mid = "core"
    command = {
        "schema": COMMAND_SCHEMA,
        "command_id": f"seed-ref-{asset_id}-001",
        "actor": "agent",
        "project_id": project["project_id"],
        "base_revision": project["revision"],
        "message": f"Seed project from circuit reference {asset_id}",
        "operations": [
            {
                "op": "upsert_module_netlist",
                "module_id": mid,
                "name": project_name,
                "kind": "imported",
                "function": f"Seeded from reference {asset_id}",
                "netlist_notebook": notebook,
                "preview_enabled": True,
                "position": {"x": 100, "y": 100},
                "size": {"width": 420, "height": 320},
                "parameters": {
                    "reference_asset_id": asset_id,
                    **({f"model_hint_{i}": hint for i, hint in enumerate((asset.get("model_hints") or [])[:4])}),
                },
            }
        ],
    }
    applied = apply_command(root, command)
    return {
        "ok": True,
        "project_id": project["project_id"],
        "project_root": str(root.resolve()),
        "module_id": mid,
        "asset_id": asset_id,
        "workspace_resolution": resolved,
        "apply_result": applied,
        "model_hints": asset.get("model_hints") or [],
    }


def promote_visual_from_module(
    root: Path,
    *,
    module_id: str,
    visual_asset_id: str,
    name: str | None = None,
) -> dict[str, Any]:
    """Snapshot current module placement and promote a layout_visual to schematic_layout."""
    project, modules = load_project(root)
    if module_id not in modules:
        raise ValueError(f"unknown module: {module_id}")
    from reference_assets import build_layout_reference

    module = modules[module_id]
    hash_value = connectivity_hash(project, {module_id: module}, module_id, "design")
    layout_ref = build_layout_reference(module_id, module, connectivity_hash_value=hash_value)
    return promote_visual_to_layout(
        visual_asset_id=visual_asset_id,
        layout_ref=layout_ref,
        name=name or f"{module_id}-from-visual",
    )


def pack_template_layouts_from_project(
    project_root: Path,
    template_root: Path,
    *,
    memory_id: str,
    template_relative: str,
    trust: str,
) -> dict[str, Any]:
    """Write per-module layout-reference.json into a saved template and register catalog."""
    from reference_assets import (
        build_layout_reference,
        register_project_template_catalog,
        write_json as ref_write_json,
    )

    project, modules = load_project(project_root)
    layout_refs: list[dict[str, Any]] = []
    module_layout_refs: list[dict[str, Any]] = []
    for module_id, module in modules.items():
        hash_value = connectivity_hash(project, {module_id: module}, module_id, "design")
        layout = build_layout_reference(module_id, module, connectivity_hash_value=hash_value)
        module_dir = template_root / "modules" / module_id
        module_dir.mkdir(parents=True, exist_ok=True)
        ref_write_json(module_dir / "layout-reference.json", layout)
        layout_refs.append({"module_id": module_id, "layout": layout})
        module_layout_refs.append(
            {
                "module_id": module_id,
                "path": f"modules/{module_id}/layout-reference.json",
                "connectivity_hash": hash_value,
            }
        )

    catalog = register_project_template_catalog(
        memory_id=memory_id,
        project_name=str(project.get("name") or memory_id),
        template_relative=template_relative,
        layout_refs=layout_refs,
        trust=trust,
        source_project_id=str(project.get("project_id") or ""),
        source_revision=int(project.get("revision") or 0),
    )

    manifest_path = template_root / "template.json"
    if manifest_path.exists():
        manifest = read_json(manifest_path)
        manifest["schema"] = "actoviq.design-template.v3"
        manifest["layout_coverage"] = {
            "module_count": len(module_layout_refs),
            "modules_with_layout": len(module_layout_refs),
        }
        manifest["module_layout_refs"] = module_layout_refs
        manifest["catalog_asset_id"] = memory_id
        atomic_write_json(manifest_path, manifest)

    return {
        "ok": True,
        "memory_id": memory_id,
        "module_layout_refs": module_layout_refs,
        "catalog": catalog,
    }


def _slugify_module_id(value: str) -> str:
    text = re.sub(r"[^A-Za-z0-9_.-]+", "_", value.strip()).strip("._-")
    if not text:
        return "imported"
    if text[0].isdigit():
        text = f"m_{text}"
    return text[:48]


def pcb_export_readiness(project: dict[str, Any], modules: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Check whether a pcb_schematic project is ready for an EDA handoff."""
    from kicad_library import get_footprint, get_symbol

    missing_lcsc: list[dict[str, str]] = []
    missing_refdes: list[dict[str, str]] = []
    missing_symbol: list[dict[str, str]] = []
    missing_footprint: list[dict[str, str]] = []
    unknown_library_part: list[dict[str, str]] = []
    try:
        index = kicad_library_index()
    except Exception:
        # Library unavailable: skip symbol/footprint resolution rather than
        # flag every component as unknown.
        index = None
    physical_types = {"R", "C", "L", "D", "Q", "M", "U", "BLOCK", "X"}
    for module_id, module in modules.items():
        for component in module.get("components", []) or []:
            if not isinstance(component, dict):
                continue
            component_type = str(component.get("type", "")).upper()
            if component_type in {"V", "I"} and component.get("mount_policy") != "design_include":
                continue
            eda = component.get("eda") if isinstance(component.get("eda"), dict) else {}
            entry = {"module_id": module_id, "component_id": str(component.get("id", ""))}
            if not str(eda.get("lcsc_id") or "").strip() and component_type in physical_types:
                missing_lcsc.append(entry)
            if not str(eda.get("refdes") or component.get("name") or "").strip():
                missing_refdes.append(entry)
            if index is None:
                continue
            if component_type not in physical_types or component.get("mount_policy") == "testbench_exclude":
                continue
            symbol_id = str(eda.get("symbol") or "").strip()
            symbol_entry = None
            if not symbol_id:
                missing_symbol.append(entry)
            else:
                symbol_entry = get_symbol(index, symbol_id)
                if symbol_entry is None:
                    unknown_library_part.append({**entry, "symbol": symbol_id})
            footprint = str(eda.get("footprint") or "").strip()
            resolved_footprint = footprint or (
                resolve_library_footprint(index, symbol_entry) if symbol_entry is not None else ""
            )
            if not resolved_footprint:
                missing_footprint.append(entry)
            elif footprint and get_footprint(index, footprint) is None:
                unknown_library_part.append({**entry, "footprint": footprint})
    ready = not (
        missing_lcsc or missing_refdes or missing_symbol or missing_footprint or unknown_library_part
    )
    hints: list[str] = []
    if missing_lcsc or missing_refdes:
        hints.extend([
            "Bind LCSC parts (eda.lcsc_id) for physical components before bridge push.",
            "Ensure each exportable component has a refdes/name.",
        ])
    if missing_symbol or missing_footprint:
        hints.append(
            "Place physical components from the bundled KiCad library "
            "(place_library_component) or set eda.symbol/eda.footprint."
        )
    if unknown_library_part:
        hints.append(
            "eda.symbol/eda.footprint must resolve against the bundled KiCad library index."
        )
    return {
        "ready": ready,
        "missing_lcsc_id": missing_lcsc,
        "missing_refdes": missing_refdes,
        "missing_symbol": missing_symbol,
        "missing_footprint": missing_footprint,
        "unknown_library_part": unknown_library_part,
        "hints": hints,
    }


def persist_bridge_pull(root: Path, pull_result: dict[str, Any]) -> dict[str, Any]:
    conflicts = pull_result.get("conflicts") or []
    if pull_result.get("ok") is not True or pull_result.get("requires_review"):
        return {**pull_result, "persisted": False}
    if pull_result.get("policy") == "manual_review" and conflicts:
        return {**pull_result, "requires_review": True, "persisted": False}
    updated = pull_result.get("updated_modules") or {}
    if not updated:
        return {**pull_result, "persisted": False}

    with ProjectLock(root):
        project, modules = load_project(root)
        original_project = json.loads(json.dumps(project))
        original_modules = {
            str(module_id): json.loads(json.dumps(modules[module_id])) if module_id in modules else None
            for module_id in updated
        }
        next_project = json.loads(json.dumps(project))
        next_modules = {module_id: json.loads(json.dumps(module)) for module_id, module in modules.items()}
        kind = next_project.get("project_kind")
        changed_module_ids: list[str] = []

        for raw_module_id, raw_module in updated.items():
            module_id = str(raw_module_id)
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", module_id):
                raise ValueError(f"invalid bridge module id: {module_id!r}")
            if not isinstance(raw_module, dict):
                raise ValueError(f"bridge module must be an object: {module_id}")
            incoming = upgrade_module_document(json.loads(json.dumps(raw_module)))
            incoming["module_id"] = module_id
            previous_revision = int(next_modules.get(module_id, {}).get("revision", -1))
            incoming["revision"] = previous_revision + 1
            ensure_module_stable_ids(incoming)
            validate_module(incoming, kind)
            next_modules[module_id] = incoming
            changed_module_ids.append(module_id)

            module_ref = next((entry for entry in next_project.get("modules", []) if entry.get("id") == module_id), None)
            if module_ref is None:
                next_project["modules"].append({
                    "id": module_id,
                    "name": incoming.get("name", module_id),
                    "kind": "imported",
                    "function": "",
                    "parameters": {},
                    "notes": "Imported via EDA bridge",
                    "preview_enabled": True,
                    "source": f"modules/{module_id}/module.circuit.json",
                    "position": {"x": 100, "y": 100},
                    "size": {"width": 360, "height": 280},
                    "ports": incoming.get("ports", []),
                })
            else:
                module_ref["name"] = incoming.get("name", module_ref.get("name", module_id))
                module_ref["ports"] = incoming.get("ports", [])

        next_project["revision"] = int(next_project.get("revision", 0)) + 1
        next_project["updated_at"] = utc_now()
        ensure_project_stable_ids(next_project, next_modules)
        validate_project(next_project)

        written_modules: list[str] = []
        try:
            for module_id in changed_module_ids:
                atomic_write_json(module_path(root, module_id), next_modules[module_id])
                written_modules.append(module_id)
            atomic_write_json(project_path(root), next_project)
        except OSError:
            for module_id in written_modules:
                original = original_modules[module_id]
                if original is None:
                    module_path(root, module_id).unlink(missing_ok=True)
                else:
                    atomic_write_json(module_path(root, module_id), original)
            atomic_write_json(project_path(root), original_project)
            raise

    return {
        **pull_result,
        "updated_modules": {module_id: next_modules[module_id] for module_id in changed_module_ids},
        "revision": next_project["revision"],
        "persisted": True,
    }


def run_lcsc_bind(
    root: Path,
    module_id: str,
    component_id: str,
    lcsc_id: str,
    *,
    api_key: str = "",
    api_secret: str = "",
    use_fallback: bool = False,
) -> dict[str, Any]:
    from lcsc_search import bind_part_to_component, get_part

    project, modules = load_project(root)
    if not supports_lcsc_binding(project.get("project_kind", DEFAULT_PROJECT_KIND)):
        raise ValueError("LCSC binding requires project_kind=pcb_schematic")
    if module_id not in modules:
        raise ValueError(f"unknown module: {module_id}")
    module = modules[module_id]
    component = next((entry for entry in module.get("components", []) if entry.get("id") == component_id), None)
    if component is None:
        raise ValueError(f"unknown component: {component_id}")
    looked_up = get_part(lcsc_id, api_key=api_key, api_secret=api_secret, use_fallback=use_fallback)
    if not looked_up.get("ok"):
        raise ValueError(looked_up.get("error") or f"LCSC part not found: {lcsc_id}")
    bind_part_to_component(component, looked_up["part"])
    ensure_module_stable_ids(module)
    module["revision"] = int(module.get("revision", 0)) + 1
    project["revision"] = int(project.get("revision", 0)) + 1
    project["updated_at"] = utc_now()
    validate_module(module, project.get("project_kind"))
    validate_project(project)
    atomic_write_json(module_path(root, module_id), module)
    atomic_write_json(project_path(root), project)
    return {
        "ok": True,
        "project_id": project["project_id"],
        "revision": project["revision"],
        "module_id": module_id,
        "component_id": component_id,
        "lcsc_id": str(looked_up["part"].get("lcsc_id") or lcsc_id).upper(),
        "part": looked_up["part"],
        "component": component,
    }


def materialize_kicad_unknowns(
    root: Path,
    peer_root: Path,
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]],
    pull_result: dict[str, Any],
) -> dict[str, Any]:
    """Create disconnected BLOCK components for cold-imported foreign KiCad symbols."""
    from eda_kicad_import import (
        _collect_peer_instances,
        _component_key,
        _kicad_rotation_to_internal,
        _load_coordinate_transform,
        _mm_to_internal,
        _page_offset,
    )

    instances, _warnings = _collect_peer_instances(Path(peer_root))
    transform = _load_coordinate_transform(Path(peer_root))
    known = {
        _component_key(component)
        for module in modules.values()
        for component in module.get("components", []) or []
        if isinstance(component, dict)
    }
    known.update(
        str(component.get("id", ""))
        for module in modules.values()
        for component in module.get("components", []) or []
        if isinstance(component, dict)
    )
    created = 0
    created_keys: list[str] = []
    target_id = next(iter(modules), "sheet1")
    module = modules.setdefault(target_id, {
        "schema": MODULE_SCHEMA,
        "module_id": target_id,
        "name": target_id,
        "revision": 0,
        "ports": [],
        "components": [],
        "nets": [],
        "wires": [],
        "annotations": [],
    })
    page_proxy = {"id": target_id, "components": module.get("components", []), "ports": []}
    for instance in instances:
        stable_id = str(instance.get("stable_id") or "").strip()
        if not stable_id or stable_id in known:
            continue
        page_id = str(instance.get("page_id") or target_id).strip() or target_id
        if page_id in modules:
            module = modules[page_id]
            target_id = page_id
        offset_x, offset_y = _page_offset(page_id, page_proxy, transform)
        position = _mm_to_internal(float(instance["x_mm"]), float(instance["y_mm"]), offset_x, offset_y)
        component_id = f"imp_{created + 1}"
        component = {
            "id": component_id,
            "stable_id": stable_id,
            "type": "BLOCK",
            "name": instance.get("refdes") or component_id,
            "value": instance.get("value") or instance.get("lib_id") or "imported",
            "position": position,
            "rotation": _kicad_rotation_to_internal(int(instance.get("rotation_kicad", 0))),
            "pins": [{"id": "1", "name": "1", "net": "NC", "side": "left"}],
            "block": {"width": 120, "height": 80},
            "eda": {
                "foreign_symbol": instance.get("lib_id", ""),
                "refdes": instance.get("refdes") or "",
                "physical": True,
            },
        }
        module.setdefault("components", []).append(component)
        known.add(stable_id)
        created += 1
        created_key = f"{target_id}:{stable_id}:foreign"
        created_keys.append(created_key)
        pull_result.setdefault("id_map", {})[stable_id] = {
            "peer_kind": "kicad",
            "page_id": target_id,
            "component_id": component_id,
            "refdes": instance.get("refdes") or "",
            "source_file": instance.get("source_file", ""),
        }
        pull_result.setdefault("updated_modules", {})[target_id] = module
    if created_keys:
        pull_result.setdefault("applied", []).extend(created_keys)
    pull_result["cold_start_created"] = created
    return pull_result


def bridge_import_cold(
    *,
    projects_root: Path,
    peer_kind: str,
    peer_root: Path,
    name: str,
    project_kind: str = "pcb_schematic",
    policy: str = "layout_wins",
) -> dict[str, Any]:
    """Create a PCB schematic project and pull an existing KiCad/JLCEDA peer (cold start)."""
    kind = normalize_project_kind(project_kind)
    if not supports_eda_bridge(kind):
        raise ValueError("cold-start import requires project_kind=pcb_schematic")
    root = initialize_project(projects_root, name, None, False, project_kind=kind)
    seed_module = {
        "schema": MODULE_SCHEMA,
        "module_id": "sheet1",
        "name": "Imported sheet",
        "revision": 0,
        "ports": [],
        "components": [],
        "nets": [],
        "wires": [],
        "annotations": [],
    }
    ensure_module_stable_ids(seed_module)
    project, modules = load_project(root)
    modules["sheet1"] = seed_module
    project["modules"] = [{
        "id": "sheet1",
        "name": seed_module["name"],
        "kind": "imported",
        "function": "",
        "parameters": {},
        "notes": "Cold-start import sheet",
        "preview_enabled": True,
        "source": "modules/sheet1/module.circuit.json",
        "position": {"x": 100, "y": 100},
        "size": {"width": 360, "height": 280},
        "ports": [],
    }]
    validate_module(seed_module, kind)
    validate_project(project)
    atomic_write_json(module_path(root, "sheet1"), seed_module)
    atomic_write_json(project_path(root), project)
    link_bridge(root, peer_kind, peer_root, policy=policy)
    pull_result = pull_bridge(root, peer_kind, project=project, modules=modules, policy=policy)
    if peer_kind == "kicad":
        pull_result = materialize_kicad_unknowns(root, peer_root, project, modules, pull_result)
    pull_result = persist_bridge_pull(root, pull_result)
    imported_count = len(pull_result.get("applied") or [])
    cold_ok = bool(pull_result.get("ok")) and imported_count > 0
    return {
        **project_summary(root),
        "ok": cold_ok,
        "project_root": str(root),
        "project_id": project["project_id"],
        "project_kind": kind,
        "peer_kind": peer_kind,
        "pull": pull_result,
    }


def parse_command(args: argparse.Namespace) -> dict[str, Any]:
    if args.command_json:
        return json.loads(args.command_json)
    if args.command_file:
        return read_json(Path(args.command_file))
    raise ValueError("--command-json or --command-file is required")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    for name, demo in (("create", False), ("create-demo", True)):
        subparser = subparsers.add_parser(name)
        subparser.add_argument(
            "--projects-root",
            default="",
            help="Projects directory. Defaults to the active GUI workspace projectsDir.",
        )
        subparser.add_argument(
            "--workspace-id",
            default="",
            help="Create under this workspace's projectsDir (does not change active).",
        )
        subparser.add_argument("--name", required=True)
        subparser.add_argument("--project-id", default="")
        subparser.add_argument(
            "--project-kind",
            default=DEFAULT_PROJECT_KIND,
            choices=["simulation", "pcb_schematic", "analog_ic", "mixed_signal_ic"],
            help="Project type gate for validation, Agent defaults, and Bridge/LCSC.",
        )
        subparser.set_defaults(demo=demo)

    workspace_list = subparsers.add_parser(
        "workspace-list",
        help="List GUI workspaces and mark the active one.",
    )
    workspace_list.set_defaults()

    workspace_active = subparsers.add_parser(
        "workspace-active",
        help="Show the active workspace root and projectsDir (use before create).",
    )
    workspace_active.set_defaults()

    workspace_use = subparsers.add_parser(
        "workspace-use",
        help="Select the active workspace (shared with the Electron GUI).",
    )
    workspace_use.add_argument("--workspace-id", required=True)

    workspace_resolve = subparsers.add_parser(
        "workspace-resolve-projects-root",
        help="Resolve where create/create-demo will write projects.",
    )
    workspace_resolve.add_argument("--projects-root", default="")
    workspace_resolve.add_argument("--workspace-id", default="")

    summary = subparsers.add_parser("summary")
    summary.add_argument("--project-root", required=True)

    erc_parser = subparsers.add_parser("erc")
    erc_parser.add_argument("--project-root", required=True)

    agent_context_parser = subparsers.add_parser("agent-context")
    agent_context_parser.add_argument("--project-root", required=True)

    apply_parser = subparsers.add_parser("apply")
    apply_parser.add_argument("--project-root", required=True)
    apply_parser.add_argument("--command-json", default="")
    apply_parser.add_argument("--command-file", default="")

    pending_stage_parser = subparsers.add_parser(
        "pending-stage",
        help="Persist an Agent transaction for explicit user review.",
    )
    pending_stage_parser.add_argument("--project-root", required=True)
    pending_stage_parser.add_argument("--command-json", default="")
    pending_stage_parser.add_argument("--command-file", default="")

    pending_list_parser = subparsers.add_parser(
        "pending-list",
        help="List transactions waiting for user review.",
    )
    pending_list_parser.add_argument("--project-root", required=True)

    pending_accept_parser = subparsers.add_parser(
        "pending-accept",
        help="Apply a pending transaction after re-checking its preconditions.",
    )
    pending_accept_parser.add_argument("--project-root", required=True)
    pending_accept_parser.add_argument("--command-id", required=True)

    pending_reject_parser = subparsers.add_parser(
        "pending-reject",
        help="Reject a pending transaction without changing project revision.",
    )
    pending_reject_parser.add_argument("--project-root", required=True)
    pending_reject_parser.add_argument("--command-id", required=True)
    pending_reject_parser.add_argument("--reason", default="")

    compile_parser = subparsers.add_parser("compile")
    compile_parser.add_argument("--project-root", required=True)

    compile_module_parser = subparsers.add_parser("compile-module")
    compile_module_parser.add_argument("--project-root", required=True)
    compile_module_parser.add_argument("--module-id", required=True)
    compile_module_parser.add_argument(
        "--renderer",
        default="netlistsvg",
        choices=["netlistsvg", "grid-experimental"],
    )

    render_map_parser = subparsers.add_parser(
        "schematic-render-map",
        help="Emit the canonical entity map and connectivity hash used by a derived renderer.",
    )
    render_map_parser.add_argument("--module-file", required=True)
    render_map_parser.add_argument("--schematic-document", default="")
    render_map_parser.add_argument(
        "--renderer",
        default="netlistsvg",
        choices=["netlistsvg", "grid-experimental"],
    )

    overrides_export_parser = subparsers.add_parser(
        "schematic-overrides-export",
        help="Export legacy netlistsvg placement overrides without treating them as edit truth.",
    )
    overrides_export_parser.add_argument("--project-root", required=True)
    overrides_export_parser.add_argument("--module-id", required=True)
    overrides_export_parser.add_argument("--output-path", required=True)

    overrides_import_parser = subparsers.add_parser(
        "schematic-overrides-import",
        help="Import validated legacy netlistsvg placement overrides and emit a migration report.",
    )
    overrides_import_parser.add_argument("--project-root", required=True)
    overrides_import_parser.add_argument("--module-id", required=True)
    overrides_import_parser.add_argument("--input-path", required=True)

    overrides_report_parser = subparsers.add_parser(
        "schematic-overrides-report",
        help="Report how legacy renderer placements map to canonical module entities.",
    )
    overrides_report_parser.add_argument("--project-root", required=True)
    overrides_report_parser.add_argument("--module-id", required=True)

    simulate_parser = subparsers.add_parser("simulate")
    simulate_parser.add_argument("--project-root", required=True)
    simulate_parser.add_argument("--ngspice-bin", default="")
    simulate_parser.add_argument("--osdi", action="append", default=[])

    simulate_module_parser = subparsers.add_parser("simulate-module")
    simulate_module_parser.add_argument("--project-root", required=True)
    simulate_module_parser.add_argument("--module-id", required=True)
    simulate_module_parser.add_argument("--ngspice-bin", default="")
    simulate_module_parser.add_argument("--osdi", action="append", default=[])

    openvaf_parser = subparsers.add_parser(
        "openvaf-compile",
        help="Compile one Verilog-A model into a cached ngspice OSDI artifact.",
    )
    openvaf_parser.add_argument("--source", required=True)
    openvaf_parser.add_argument("--cache-root", required=True)
    openvaf_parser.add_argument("--openvaf-bin", default="")
    openvaf_parser.add_argument("--flag", action="append", default=[])

    xyce_parser = subparsers.add_parser(
        "simulate-xyce",
        help="Run a Xyce-compatible deck using the independent Xyce provider.",
    )
    xyce_parser.add_argument("--deck", required=True)
    xyce_parser.add_argument("--run-root", required=True)
    xyce_parser.add_argument("--xyce-bin", default="")
    xyce_parser.add_argument("--arg", action="append", default=[])

    dual_sim_parser = subparsers.add_parser(
        "simulate-dual",
        help="Compile once, run two configured open simulators, and compare measured metrics.",
    )
    dual_sim_parser.add_argument("--project-root", required=True)
    dual_sim_parser.add_argument("--left-profile", required=True)
    dual_sim_parser.add_argument("--right-profile", required=True)
    dual_sim_parser.add_argument("--relative-tolerance", type=float, default=0.001)
    dual_sim_parser.add_argument("--absolute-tolerance", type=float, default=1e-9)
    dual_sim_parser.add_argument("--ngspice-bin", default="")

    post_layout_parser = subparsers.add_parser(
        "simulate-post-layout",
        help="Run a self-contained PEX testbench only after hash-bound clean LVS.",
    )
    post_layout_parser.add_argument("--project-root", required=True)
    post_layout_parser.add_argument("--deck", required=True)
    post_layout_parser.add_argument("--layout", required=True)
    post_layout_parser.add_argument("--schematic", required=True)
    post_layout_parser.add_argument("--lvs-run", required=True)
    post_layout_parser.add_argument("--ngspice-bin", default="")

    klayout_drc_parser = subparsers.add_parser("verify-klayout-drc")
    klayout_drc_parser.add_argument("--layout", required=True)
    klayout_drc_parser.add_argument("--rule-deck", required=True)
    klayout_drc_parser.add_argument("--run-root", required=True)
    klayout_drc_parser.add_argument("--klayout-bin", default="")

    klayout_lvs_parser = subparsers.add_parser("verify-klayout-lvs")
    klayout_lvs_parser.add_argument("--layout", required=True)
    klayout_lvs_parser.add_argument("--schematic", required=True)
    klayout_lvs_parser.add_argument("--rule-deck", required=True)
    klayout_lvs_parser.add_argument("--run-root", required=True)
    klayout_lvs_parser.add_argument("--klayout-bin", default="")

    magic_parser = subparsers.add_parser("extract-magic")
    magic_parser.add_argument("--layout", required=True)
    magic_parser.add_argument("--tech-file", required=True)
    magic_parser.add_argument("--run-root", required=True)
    magic_parser.add_argument("--top-cell", required=True)
    magic_parser.add_argument("--magic-bin", default="")
    magic_parser.add_argument("--pex", action="store_true")

    netgen_parser = subparsers.add_parser("verify-netgen-lvs")
    netgen_parser.add_argument("--extracted", required=True)
    netgen_parser.add_argument("--schematic", required=True)
    netgen_parser.add_argument("--setup-file", required=True)
    netgen_parser.add_argument("--run-root", required=True)
    netgen_parser.add_argument("--extracted-cell", required=True)
    netgen_parser.add_argument("--schematic-cell", required=True)
    netgen_parser.add_argument("--netgen-bin", default="")

    hdl_sim_parser = subparsers.add_parser("hdl-simulate")
    hdl_sim_parser.add_argument("--project-root", required=True)
    hdl_sim_parser.add_argument("--manifest", default="")
    hdl_sim_parser.add_argument("--source-set", default="")
    hdl_sim_parser.add_argument("--run-root", required=True)
    hdl_sim_parser.add_argument("--iverilog-bin", default="")
    hdl_sim_parser.add_argument("--vvp-bin", default="")

    hdl_synth_parser = subparsers.add_parser("hdl-synthesize")
    hdl_synth_parser.add_argument("--project-root", required=True)
    hdl_synth_parser.add_argument("--manifest", default="")
    hdl_synth_parser.add_argument("--source-set", default="")
    hdl_synth_parser.add_argument("--run-root", required=True)
    hdl_synth_parser.add_argument("--yosys-bin", default="")

    hdl_gate_parser = subparsers.add_parser("hdl-gate-regression")
    hdl_gate_parser.add_argument("--project-root", required=True)
    hdl_gate_parser.add_argument("--manifest", default="")
    hdl_gate_parser.add_argument("--source-set", default="")
    hdl_gate_parser.add_argument("--synthesis-run", required=True)
    hdl_gate_parser.add_argument("--run-root", required=True)
    hdl_gate_parser.add_argument("--iverilog-bin", default="")
    hdl_gate_parser.add_argument("--vvp-bin", default="")

    openroad_parser = subparsers.add_parser("hdl-openroad")
    openroad_parser.add_argument("--project-root", required=True)
    openroad_parser.add_argument("--script", required=True)
    openroad_parser.add_argument("--run-root", required=True)
    openroad_parser.add_argument("--openroad-bin", default="")

    mixed_parser = subparsers.add_parser("mixed-signal-check")
    mixed_parser.add_argument("--contract", required=True)
    mixed_parser.add_argument("--run-root", required=True)
    mixed_parser.add_argument("--analog-run", default="")
    mixed_parser.add_argument("--digital-run", default="")

    analog_ic_audit_parser = subparsers.add_parser(
        "analog-ic-audit",
        help="Validate PDK binding and explicit MOS W/L/M/NF sizing before simulation.",
    )
    analog_ic_audit_parser.add_argument("--project-root", required=True)
    analog_ic_audit_parser.add_argument("--output-path", default="")

    xschem_link_parser = subparsers.add_parser(
        "xschem-link",
        help="Set one module's explicit Xschem ownership mode.",
    )
    xschem_link_parser.add_argument("--project-root", required=True)
    xschem_link_parser.add_argument("--module-id", required=True)
    xschem_link_parser.add_argument("--mode", choices=["native", "bridge", "external"], required=True)
    xschem_link_parser.add_argument("--peer-file", default="")

    for name in ("xschem-push", "xschem-pull", "xschem-take-ownership"):
        xschem_parser = subparsers.add_parser(name)
        xschem_parser.add_argument("--project-root", required=True)
        xschem_parser.add_argument("--module-id", required=True)

    xschem_validate_parser = subparsers.add_parser(
        "xschem-validate",
        help=(
            "Headless-netlist an exported Xschem .sch and compare connectivity to a module. "
            "Product path is schematic-export → xschem-validate (not peer link/push)."
        ),
    )
    xschem_validate_parser.add_argument(
        "--schematic-file",
        "--peer-file",
        dest="schematic_file",
        required=True,
        help="Exported .sch path (alias: --peer-file, deprecated name)",
    )
    xschem_validate_parser.add_argument("--run-root", required=True)
    xschem_validate_parser.add_argument("--xschem-bin", default="")
    xschem_validate_parser.add_argument("--project-root", default="")
    xschem_validate_parser.add_argument("--module-id", default="")

    pdk_list_parser = subparsers.add_parser(
        "pdk-list",
        help="List local-only registered PDK installations.",
    )
    pdk_list_parser.add_argument("--registry-path", default="")

    pdk_catalog_parser = subparsers.add_parser(
        "pdk-open-catalog",
        help="List built-in open PDK sources and official homepage URLs.",
    )
    pdk_catalog_parser.set_defaults()

    pdk_install_parser = subparsers.add_parser(
        "pdk-install-open",
        help="Acquire an open PDK source tree after explicit user license acceptance.",
    )
    pdk_install_parser.add_argument(
        "--adapter",
        choices=["ihp-sg13g2", "sky130", "gf180mcu"],
        required=True,
    )
    pdk_install_parser.add_argument("--destination", required=True)
    pdk_install_parser.add_argument("--revision", default="")
    pdk_install_parser.add_argument("--git-bin", default="")
    pdk_install_parser.add_argument("--license-accepted", action="store_true")

    for name in ("pdk-scan", "pdk-register"):
        pdk_parser = subparsers.add_parser(
            name,
            help="Discover PDK capabilities without copying foundry files.",
        )
        pdk_parser.add_argument("--root", required=True)
        pdk_parser.add_argument(
            "--adapter",
            choices=["ihp-sg13g2", "sky130", "gf180mcu", "commercial"],
            required=True,
        )
        pdk_parser.add_argument("--version", default="")
        pdk_parser.add_argument("--revision", default="")
        pdk_parser.add_argument("--mapping-file", default="")
        pdk_parser.add_argument("--registry-path", default="")
        if name == "pdk-register":
            pdk_parser.add_argument(
                "--license-accepted",
                action="store_true",
                help="Confirm that the user is authorized to use this local PDK.",
            )

    export_parser = subparsers.add_parser(
        "export-eda",
        help="Export editable schematic packages from the current structured project revision.",
    )
    export_parser.add_argument("--project-root", required=True)
    export_parser.add_argument("--scope", choices=["project", "module"], default="project")
    export_parser.add_argument("--module-id", default="")
    export_parser.add_argument("--targets", default="kicad,altium,orcad,virtuoso")
    export_parser.add_argument("--view", choices=["design", "simulation"], default="design")
    export_parser.add_argument("--mapping-file", default="")
    export_parser.add_argument("--native-convert", choices=["auto", "never", "required"], default="auto")
    export_parser.add_argument("--strict-layout", action="store_true")
    export_parser.add_argument("--source-revision", type=int, required=True)
    export_parser.add_argument(
        "--output-dir",
        default="",
        help="Optional parent directory for the export. Defaults to <project>/build/exports.",
    )

    schematic_export = subparsers.add_parser(
        "schematic-export",
        help="Simple desktop Export: one format + output path, gated by project_kind.",
    )
    schematic_export.add_argument("--project-root", required=True)
    schematic_export.add_argument("--format", required=True)
    schematic_export.add_argument("--output-path", required=True)
    schematic_export.add_argument("--module-id", default="")
    schematic_export.add_argument("--source-revision", type=int, required=True)

    schematic_import = subparsers.add_parser(
        "schematic-import",
        help="Simple desktop Import: one external schematic into a module, gated by project_kind.",
    )
    schematic_import.add_argument("--project-root", required=True)
    schematic_import.add_argument("--format", required=True)
    schematic_import.add_argument("--source-path", required=True)
    schematic_import.add_argument("--module-id", required=True)

    prepare_layout_parser = subparsers.add_parser(
        "prepare-layout-review",
        help="Prepare a deterministic routed candidate and vision-review stage without modifying the project.",
    )
    prepare_layout_parser.add_argument("--project-root", required=True)
    prepare_layout_parser.add_argument("--module-id", required=True)
    prepare_layout_parser.add_argument("--source-revision", type=int, required=True)
    prepare_layout_parser.add_argument("--view", choices=["design", "simulation"], default="design")
    prepare_layout_parser.add_argument("--output-dir", required=True)

    evaluate_layout_parser = subparsers.add_parser(
        "evaluate-layout-patches",
        help="Validate and score one strict vision layout patch-set without modifying the project.",
    )
    evaluate_layout_parser.add_argument("--project-root", required=True)
    evaluate_layout_parser.add_argument("--module-id", required=True)
    evaluate_layout_parser.add_argument("--source-revision", type=int, required=True)
    evaluate_layout_parser.add_argument("--state-path", required=True)
    evaluate_layout_parser.add_argument("--view", choices=["design", "simulation"], default=None)
    evaluate_layout_parser.add_argument("--output-dir", required=True)
    patch_source = evaluate_layout_parser.add_mutually_exclusive_group(required=True)
    patch_source.add_argument("--patch-set-json", default="")
    patch_source.add_argument("--patch-set-file", default="")

    subparsers.add_parser("reference-catalog-list", help="List workspace reference catalog assets.")

    ref_import_cir = subparsers.add_parser(
        "reference-import-circuit",
        help="Import a .cir/.sp file into the reference catalog (flattened).",
    )
    ref_import_cir.add_argument("--file", required=True)
    ref_import_cir.add_argument("--as", dest="as_kind", choices=["circuit_module", "circuit_project"], default="circuit_module")
    ref_import_cir.add_argument("--name", default="")
    ref_import_cir.add_argument("--subckt-name", default="")

    ref_import_vis = subparsers.add_parser(
        "reference-import-visual",
        help="Import a schematic screenshot/PDF page as layout_visual reference.",
    )
    ref_import_vis.add_argument("--file", required=True)
    ref_import_vis.add_argument("--name", default="")

    ref_prepare = subparsers.add_parser(
        "prepare-layout-from-reference",
        help="Check whether a layout/idiom/visual reference can be applied to a module.",
    )
    ref_prepare.add_argument("--project-root", required=True)
    ref_prepare.add_argument("--module-id", required=True)
    ref_prepare.add_argument("--asset-id", required=True)

    ref_apply = subparsers.add_parser(
        "apply-layout-from-reference",
        help="Apply schematic_layout snapshot or layout_idiom guide (never changes SPICE).",
    )
    ref_apply.add_argument("--project-root", required=True)
    ref_apply.add_argument("--module-id", required=True)
    ref_apply.add_argument("--asset-id", required=True)

    ref_insert = subparsers.add_parser(
        "reference-insert-module",
        help="Insert a circuit reference as a new module into an existing project.",
    )
    ref_insert.add_argument("--project-root", required=True)
    ref_insert.add_argument("--asset-id", required=True)
    ref_insert.add_argument("--module-id", default="")

    ref_create = subparsers.add_parser(
        "reference-create-project",
        help="Create a new project seeded from a circuit reference.",
    )
    ref_create.add_argument("--asset-id", required=True)
    ref_create.add_argument("--name", default="")
    ref_create.add_argument("--project-kind", default=DEFAULT_PROJECT_KIND)
    ref_create.add_argument("--projects-root", default="")

    ref_promote = subparsers.add_parser(
        "reference-promote-visual-layout",
        help="Promote a layout_visual into a schematic_layout asset using a layout-reference JSON.",
    )
    ref_promote.add_argument("--asset-id", required=True)
    ref_promote.add_argument("--layout-reference-json", default="")
    ref_promote.add_argument("--layout-reference-file", default="")
    ref_promote.add_argument("--name", default="")

    ref_pack = subparsers.add_parser(
        "reference-pack-from-project",
        help="Write layout-reference.json into a design-memory template and register catalog.",
    )
    ref_pack.add_argument("--project-root", required=True)
    ref_pack.add_argument("--template-root", required=True)
    ref_pack.add_argument("--memory-id", required=True)
    ref_pack.add_argument("--template-relative", required=True)
    ref_pack.add_argument("--trust", default="unverified")

    ref_promote_mod = subparsers.add_parser(
        "reference-promote-from-module",
        help="Promote layout_visual using the current module placement snapshot.",
    )
    ref_promote_mod.add_argument("--project-root", required=True)
    ref_promote_mod.add_argument("--module-id", required=True)
    ref_promote_mod.add_argument("--asset-id", required=True)
    ref_promote_mod.add_argument("--name", default="")

    bridge_list = subparsers.add_parser("bridge-list", help="List linked EDA bridges.")
    bridge_list.add_argument("--project-root", required=True)

    bridge_status_parser = subparsers.add_parser("bridge-status", help="Show bridge link status.")
    bridge_status_parser.add_argument("--project-root", required=True)
    bridge_status_parser.add_argument("--peer-kind", choices=["kicad", "jlceda"], default="")

    bridge_link_parser = subparsers.add_parser("bridge-link", help="Link a KiCad or JLCEDA peer folder.")
    bridge_link_parser.add_argument("--project-root", required=True)
    bridge_link_parser.add_argument("--peer-kind", choices=["kicad", "jlceda"], required=True)
    bridge_link_parser.add_argument("--peer-root", required=True)
    bridge_link_parser.add_argument(
        "--policy",
        choices=["layout_wins", "connectivity_wins", "manual_review"],
        default="manual_review",
    )

    bridge_unlink_parser = subparsers.add_parser("bridge-unlink", help="Remove an EDA bridge link.")
    bridge_unlink_parser.add_argument("--project-root", required=True)
    bridge_unlink_parser.add_argument("--peer-kind", choices=["kicad", "jlceda"], required=True)

    bridge_push_parser = subparsers.add_parser("bridge-push", help="Push Vibe Analog schematic to a linked peer.")
    bridge_push_parser.add_argument("--project-root", required=True)
    bridge_push_parser.add_argument("--peer-kind", choices=["kicad", "jlceda"], required=True)
    bridge_push_parser.add_argument("--source-revision", type=int, required=True)

    bridge_pull_parser = subparsers.add_parser("bridge-pull", help="Pull peer edits into Vibe Analog by stable_id.")
    bridge_pull_parser.add_argument("--project-root", required=True)
    bridge_pull_parser.add_argument("--peer-kind", choices=["kicad", "jlceda"], required=True)
    bridge_pull_parser.add_argument(
        "--policy",
        choices=["layout_wins", "connectivity_wins", "manual_review"],
        default="",
    )

    bridge_cold = subparsers.add_parser(
        "bridge-import-cold",
        help="Create a new project from an existing KiCad/JLCEDA peer (cold start).",
    )
    bridge_cold.add_argument("--projects-root", default="")
    bridge_cold.add_argument("--workspace-id", default="")
    bridge_cold.add_argument("--peer-kind", choices=["kicad", "jlceda"], required=True)
    bridge_cold.add_argument("--peer-root", required=True)
    bridge_cold.add_argument("--name", required=True)
    bridge_cold.add_argument(
        "--project-kind",
        default="pcb_schematic",
        choices=["pcb_schematic"],
    )
    bridge_cold.add_argument(
        "--policy",
        choices=["layout_wins", "connectivity_wins", "manual_review"],
        default="layout_wins",
    )

    lcsc_search_parser = subparsers.add_parser("lcsc-search", help="Search LCSC / 立创商城 parts.")
    lcsc_search_parser.add_argument("--query", required=True)
    lcsc_search_parser.add_argument("--limit", type=int, default=20)
    lcsc_search_parser.add_argument("--api-key", default=os.environ.get("ACTOVIQ_LCSC_API_KEY", ""))
    lcsc_search_parser.add_argument("--api-secret", default=os.environ.get("ACTOVIQ_LCSC_API_SECRET", ""))
    lcsc_search_parser.add_argument("--use-fallback", action="store_true")

    lcsc_get_parser = subparsers.add_parser("lcsc-get", help="Fetch one LCSC part by C-number.")
    lcsc_get_parser.add_argument("--lcsc-id", required=True)
    lcsc_get_parser.add_argument("--api-key", default=os.environ.get("ACTOVIQ_LCSC_API_KEY", ""))
    lcsc_get_parser.add_argument("--api-secret", default=os.environ.get("ACTOVIQ_LCSC_API_SECRET", ""))
    lcsc_get_parser.add_argument("--use-fallback", action="store_true")

    lcsc_bind_parser = subparsers.add_parser("lcsc-bind", help="Bind an LCSC part onto a module component.")
    lcsc_bind_parser.add_argument("--project-root", required=True)
    lcsc_bind_parser.add_argument("--module-id", required=True)
    lcsc_bind_parser.add_argument("--component-id", required=True)
    lcsc_bind_parser.add_argument("--lcsc-id", required=True)
    lcsc_bind_parser.add_argument("--api-key", default=os.environ.get("ACTOVIQ_LCSC_API_KEY", ""))
    lcsc_bind_parser.add_argument("--api-secret", default=os.environ.get("ACTOVIQ_LCSC_API_SECRET", ""))
    lcsc_bind_parser.add_argument("--use-fallback", action="store_true")

    kicad_lib_search = subparsers.add_parser(
        "kicad-lib-search", help="Search bundled KiCad symbol library."
    )
    kicad_lib_search.add_argument("--query", required=True)
    kicad_lib_search.add_argument("--limit", type=int, default=10)

    kicad_lib_get = subparsers.add_parser(
        "kicad-lib-get", help="Fetch one bundled KiCad symbol or footprint."
    )
    kicad_lib_get.add_argument("--symbol", default="")
    kicad_lib_get.add_argument("--footprint", default="")

    subparsers.add_parser(
        "kicad-lib-reindex", help="Force rebuild of the KiCad library index cache."
    )

    # M2-06: module soft lease commands. UI semantics, not a file lock.
    lease_acquire = subparsers.add_parser(
        "module-lease-acquire", help="Acquire or renew a soft lease on a module."
    )
    lease_acquire.add_argument("--project-root", required=True)
    lease_acquire.add_argument("--module-id", required=True)
    lease_acquire.add_argument("--actor", required=True)
    lease_acquire.add_argument("--ttl", default="")
    lease_release = subparsers.add_parser(
        "module-lease-release", help="Release a soft lease on a module."
    )
    lease_release.add_argument("--project-root", required=True)
    lease_release.add_argument("--module-id", required=True)
    lease_release.add_argument("--actor", required=True)
    return parser



def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.command == "workspace-list":
            result = list_workspaces()
        elif args.command == "workspace-active":
            result = get_active_workspace()
        elif args.command == "workspace-use":
            result = select_workspace(args.workspace_id)
        elif args.command == "workspace-resolve-projects-root":
            result = resolve_projects_root(
                projects_root=args.projects_root or None,
                workspace_id=args.workspace_id or None,
            )
        elif args.command == "pdk-list":
            registry = load_pdk_registry(args.registry_path or None)
            result = {"ok": True, **registry}
        elif args.command == "pdk-open-catalog":
            result = {"ok": True, "pdks": open_pdk_catalog()}
        elif args.command == "pdk-install-open":
            result = {
                "ok": True,
                "receipt": install_open_pdk(
                    args.adapter,
                    args.destination,
                    revision=args.revision,
                    license_accepted=bool(args.license_accepted),
                    git_bin=args.git_bin,
                ),
            }
        elif args.command in {"pdk-scan", "pdk-register"}:
            installation = scan_pdk_installation(
                args.root,
                args.adapter,
                version=args.version,
                revision=args.revision,
                mapping_file=args.mapping_file or None,
            )
            if args.command == "pdk-register":
                installation = register_pdk_installation(
                    installation,
                    license_accepted=bool(args.license_accepted),
                    path=args.registry_path or None,
                )
            result = {"ok": True, "installation": installation}
        elif args.command == "xschem-link":
            root = Path(args.project_root).resolve()
            project, modules = load_project(root)
            module = modules.get(args.module_id)
            if module is None:
                raise ValueError(f"unknown module: {args.module_id}")
            binding = make_xschem_binding(args.mode, args.peer_file)
            link_result: dict[str, Any] = {"ok": True, "binding": binding}
            if args.mode == "bridge":
                link_result = push_xschem(module, binding, int(project["revision"]))
                binding = link_result["binding"]
            elif args.mode == "external":
                link_result = link_existing_xschem(module, binding, int(project["revision"]))
                binding = link_result["binding"]
            applied = apply_command(root, {
                "schema": COMMAND_SCHEMA,
                "command_id": f"xschem-link-{args.module_id}-{project['revision'] + 1}",
                "actor": "user",
                "project_id": project["project_id"],
                "base_revision": project["revision"],
                "message": f"Set Xschem mode to {args.mode}",
                "operations": [{
                    "op": "set_schematic_peer",
                    "module_id": args.module_id,
                    "binding": binding,
                }],
            })
            result = {**link_result, "revision": applied["revision"], "erc": applied["erc"]}
        elif args.command in {"xschem-push", "xschem-pull", "xschem-take-ownership"}:
            root = Path(args.project_root).resolve()
            project, modules = load_project(root)
            module = modules.get(args.module_id)
            if module is None:
                raise ValueError(f"unknown module: {args.module_id}")
            binding = validate_xschem_binding(module.get("schematic_peer"))
            if args.command == "xschem-push":
                sync_result = push_xschem(module, binding, int(project["revision"]))
                operations = [{
                    "op": "set_schematic_peer",
                    "module_id": args.module_id,
                    "binding": sync_result["binding"],
                }]
            else:
                sync_result = pull_xschem(module, binding)
                if sync_result.get("requires_review"):
                    result = sync_result
                    print(json.dumps(result, ensure_ascii=False))
                    return 0
                next_module = sync_result["updated_module"]
                next_binding = sync_result["binding"]
                if args.command == "xschem-take-ownership":
                    next_binding = {**next_binding, "mode": "native"}
                    next_module["schematic_peer"] = next_binding
                operations = [
                    {
                        "op": "set_module_schematic",
                        "module_id": args.module_id,
                        "module": next_module,
                        "source": "xschem",
                    },
                    {
                        "op": "set_schematic_peer",
                        "module_id": args.module_id,
                        "binding": next_binding,
                    },
                ]
            applied = apply_command(root, {
                "schema": COMMAND_SCHEMA,
                "command_id": f"{args.command}-{args.module_id}-{project['revision'] + 1}",
                "actor": "user",
                "project_id": project["project_id"],
                "base_revision": project["revision"],
                "message": args.command,
                "operations": operations,
            })
            result = {**sync_result, "revision": applied["revision"], "erc": applied["erc"]}
        elif args.command == "xschem-validate":
            source_module = None
            if args.project_root or args.module_id:
                if not args.project_root or not args.module_id:
                    raise ValueError("Xschem connectivity validation requires both project root and module id")
                _, source_modules = load_project(Path(args.project_root).resolve())
                source_module = source_modules.get(args.module_id)
                if source_module is None:
                    raise ValueError(f"unknown module: {args.module_id}")
            result = validate_xschem_headless(
                Path(args.schematic_file),
                Path(args.run_root),
                args.xschem_bin,
                source_module,
            )
        elif args.command in {"create", "create-demo"}:
            resolved = resolve_projects_root(
                projects_root=args.projects_root or None,
                workspace_id=args.workspace_id or None,
            )
            root = initialize_project(
                Path(resolved["projects_root"]),
                args.name,
                args.project_id or None,
                bool(args.demo),
                project_kind=getattr(args, "project_kind", DEFAULT_PROJECT_KIND),
            )
            result = {
                **project_summary(root),
                "workspace_resolution": resolved,
            }
        elif args.command == "summary":
            result = project_summary(Path(args.project_root).resolve())
        elif args.command == "erc":
            root = Path(args.project_root).resolve()
            result = write_erc_result(root, *load_project(root))
            result = {"ok": True, **result}
        elif args.command == "agent-context":
            result = agent_context(Path(args.project_root).resolve())
        elif args.command == "apply":
            result = apply_command(Path(args.project_root).resolve(), parse_command(args))
        elif args.command == "pending-stage":
            result = stage_pending_command(Path(args.project_root).resolve(), parse_command(args))
        elif args.command == "pending-list":
            result = list_pending_commands(Path(args.project_root).resolve())
        elif args.command == "pending-accept":
            result = accept_pending_command(
                Path(args.project_root).resolve(),
                args.command_id,
            )
        elif args.command == "pending-reject":
            result = reject_pending_command(
                Path(args.project_root).resolve(),
                args.command_id,
                args.reason,
            )
        elif args.command == "module-lease-acquire":
            result = acquire_module_lease(
                Path(args.project_root).resolve(),
                args.module_id,
                args.actor,
                ttl=float(args.ttl) if args.ttl else LEASE_TTL_SECONDS,
            )
            result = {"ok": True, **result}
        elif args.command == "module-lease-release":
            result = release_module_lease(
                Path(args.project_root).resolve(),
                args.module_id,
                args.actor,
            )
            result = {"ok": True, **result}
        elif args.command == "compile":
            result = compile_project(Path(args.project_root).resolve())
        elif args.command == "compile-module":
            result = compile_module(Path(args.project_root).resolve(), args.module_id, args.renderer)
        elif args.command == "schematic-render-map":
            result = schematic_render_map(
                read_json(Path(args.module_file)),
                args.renderer,
                read_json(Path(args.schematic_document)) if args.schematic_document else None,
            )
        elif args.command == "schematic-overrides-export":
            result = export_schematic_overrides(
                Path(args.project_root).resolve(),
                args.module_id,
                Path(args.output_path),
            )
        elif args.command == "schematic-overrides-import":
            result = import_schematic_overrides(
                Path(args.project_root).resolve(),
                args.module_id,
                Path(args.input_path),
            )
        elif args.command == "schematic-overrides-report":
            root = Path(args.project_root).resolve()
            project, modules = load_project(root)
            if args.module_id not in modules:
                raise ValueError(f"unknown module: {args.module_id}")
            result = {
                "ok": True,
                **schematic_overrides_migration_report(
                    root,
                    project,
                    modules[args.module_id],
                    read_schematic_overrides(root, project, args.module_id),
                ),
            }
        elif args.command == "simulate":
            result = simulate_project(
                Path(args.project_root).resolve(),
                args.ngspice_bin,
                [Path(path) for path in args.osdi],
            )
        elif args.command == "simulate-module":
            result = simulate_module(
                Path(args.project_root).resolve(),
                args.module_id,
                args.ngspice_bin,
                [Path(path) for path in args.osdi],
            )
        elif args.command == "openvaf-compile":
            result = OpenVafProvider(args.openvaf_bin).compile(
                Path(args.source),
                Path(args.cache_root),
                list(args.flag),
            )
        elif args.command == "simulate-xyce":
            result = XyceProvider(args.xyce_bin).run_deck(
                Path(args.deck),
                Path(args.run_root),
                list(args.arg),
            )
        elif args.command == "simulate-dual":
            result = simulate_dual_profiles(
                Path(args.project_root).resolve(),
                args.left_profile,
                args.right_profile,
                args.relative_tolerance,
                args.absolute_tolerance,
                args.ngspice_bin,
            )
        elif args.command == "simulate-post-layout":
            result = simulate_post_layout(
                Path(args.project_root).resolve(),
                Path(args.deck),
                Path(args.layout),
                Path(args.schematic),
                Path(args.lvs_run),
                args.ngspice_bin,
            )
        elif args.command == "verify-klayout-drc":
            result = KLayoutProvider(args.klayout_bin).run_drc(
                Path(args.layout),
                Path(args.rule_deck),
                Path(args.run_root),
            )
        elif args.command == "verify-klayout-lvs":
            result = KLayoutProvider(args.klayout_bin).run_lvs(
                Path(args.layout),
                Path(args.schematic),
                Path(args.rule_deck),
                Path(args.run_root),
            )
        elif args.command == "extract-magic":
            magic_provider = MagicProvider(args.magic_bin)
            result = (
                magic_provider.extract_pex(
                    Path(args.layout),
                    Path(args.tech_file),
                    Path(args.run_root),
                    args.top_cell,
                )
                if args.pex
                else magic_provider.extract(
                    Path(args.layout),
                    Path(args.tech_file),
                    Path(args.run_root),
                    args.top_cell,
                )
            )
        elif args.command == "verify-netgen-lvs":
            result = NetgenProvider(args.netgen_bin).run_lvs(
                Path(args.extracted),
                Path(args.schematic),
                Path(args.setup_file),
                Path(args.run_root),
                args.extracted_cell,
                args.schematic_cell,
            )
        elif args.command == "hdl-simulate":
            project_root = Path(args.project_root).resolve()
            manifest = load_hdl_manifest(
                project_root,
                Path(args.manifest).resolve() if args.manifest else None,
            )
            result = IcarusProvider(args.iverilog_bin, args.vvp_bin).simulate(
                project_root,
                manifest,
                Path(args.run_root),
                args.source_set,
            )
        elif args.command == "hdl-synthesize":
            project_root = Path(args.project_root).resolve()
            manifest = load_hdl_manifest(
                project_root,
                Path(args.manifest).resolve() if args.manifest else None,
            )
            result = YosysProvider(args.yosys_bin).synthesize(
                project_root,
                manifest,
                Path(args.run_root),
                args.source_set,
            )
        elif args.command == "hdl-gate-regression":
            project_root = Path(args.project_root).resolve()
            manifest = load_hdl_manifest(
                project_root,
                Path(args.manifest).resolve() if args.manifest else None,
            )
            result = run_gate_regression(
                project_root,
                manifest,
                read_json(Path(args.synthesis_run).resolve()),
                Path(args.run_root),
                IcarusProvider(args.iverilog_bin, args.vvp_bin),
                args.source_set,
            )
        elif args.command == "hdl-openroad":
            result = OpenRoadProvider(args.openroad_bin).run_script(
                Path(args.project_root),
                Path(args.script),
                Path(args.run_root),
            )
        elif args.command == "mixed-signal-check":
            analog_run = read_json(Path(args.analog_run).resolve()) if args.analog_run else None
            digital_run = read_json(Path(args.digital_run).resolve()) if args.digital_run else None
            result = verify_mixed_signal_contract(
                Path(args.contract),
                Path(args.run_root),
                analog_run,
                digital_run,
            )
        elif args.command == "analog-ic-audit":
            root = Path(args.project_root).resolve()
            project, modules = load_project(root)
            result = audit_analog_ic_project(root, project, modules)
            output_path = (
                Path(args.output_path).resolve()
                if args.output_path
                else root / "build" / "analog-ic" / "audit.json"
            )
            atomic_write_json(output_path, result)
        elif args.command == "export-eda":
            root = Path(args.project_root).resolve()
            project, modules = load_project(root)
            erc = evaluate_erc(project, modules)
            requested_targets = [target.strip().lower() for target in args.targets.split(",") if target.strip()]
            if "virtuoso" in requested_targets and normalize_project_kind(project.get("project_kind")) == "analog_ic":
                analog_audit = audit_analog_ic_project(root, project, modules)
                atomic_write_json(root / "build" / "analog-ic" / "audit.json", analog_audit)
                if not analog_audit.get("ok"):
                    codes = ", ".join(str(item.get("code")) for item in analog_audit.get("errors", []))
                    raise ValueError(f"analog IC audit failed before Virtuoso export: {codes}")
            result = export_eda(
                root,
                project,
                modules,
                erc,
                project_document_hash(project, modules),
                scope=args.scope,
                module_id=args.module_id or None,
                targets=requested_targets,
                view=args.view,
                mapping_file=args.mapping_file,
                native_convert=args.native_convert,
                strict_layout=bool(args.strict_layout),
                source_revision=args.source_revision,
                output_dir=args.output_dir or None,
            )
        elif args.command == "schematic-export":
            from schematic_handoff import export_schematic

            root = Path(args.project_root).resolve()
            project, modules = load_project(root)
            erc = evaluate_erc(project, modules)
            result = export_schematic(
                root,
                project,
                modules,
                erc,
                project_document_hash(project, modules),
                fmt=args.format,
                output_path=args.output_path,
                module_id=args.module_id or None,
                source_revision=args.source_revision,
            )
        elif args.command == "schematic-import":
            from schematic_handoff import import_schematic as build_schematic_import

            root = Path(args.project_root).resolve()
            project, modules = load_project(root)
            preview = build_schematic_import(
                root,
                project,
                modules,
                fmt=args.format,
                source_path=args.source_path,
                module_id=args.module_id,
                persist=False,
            )
            updated_module = preview["module"]
            applied = apply_command(root, {
                "schema": COMMAND_SCHEMA,
                "command_id": f"schematic-import-{args.module_id}-{project['revision'] + 1}",
                "actor": "user",
                "project_id": project["project_id"],
                "base_revision": project["revision"],
                "message": f"Import {args.format} schematic into {args.module_id}",
                "operations": [{
                    "op": "set_module_schematic",
                    "module_id": args.module_id,
                    "components": updated_module.get("components", []),
                    "ports": updated_module.get("ports", []),
                    "wires": updated_module.get("wires", []),
                    "nets": updated_module.get("nets", []),
                    "annotations": updated_module.get("annotations", []),
                    "source": "schematic-import",
                }],
            })
            result = {
                "ok": True,
                "format": args.format,
                "module_id": args.module_id,
                "project_id": project["project_id"],
                "revision": applied["revision"],
                "created": preview.get("created", 0),
                "source": preview.get("source"),
                "fidelity": preview.get("fidelity"),
                "note": preview.get("note"),
                "files": preview.get("files"),
            }
        elif args.command == "prepare-layout-review":
            root = Path(args.project_root).resolve()
            project, modules = load_project(root)
            result = prepare_layout_review(
                project,
                modules,
                module_id=args.module_id,
                view=args.view,
                document_hash=project_document_hash(project, modules),
                source_revision=args.source_revision,
                output_dir=Path(args.output_dir).resolve(),
            )
        elif args.command == "evaluate-layout-patches":
            root = Path(args.project_root).resolve()
            project, modules = load_project(root)
            patch_set = json.loads(args.patch_set_json) if args.patch_set_json else read_json(Path(args.patch_set_file).resolve())
            result = evaluate_layout_patches(
                project,
                modules,
                read_json(Path(args.state_path).resolve()),
                patch_set,
                module_id=args.module_id,
                document_hash=project_document_hash(project, modules),
                source_revision=args.source_revision,
                output_dir=Path(args.output_dir).resolve(),
                view=args.view,
            )
        elif args.command == "reference-catalog-list":
            result = list_catalog()
        elif args.command == "reference-import-circuit":
            result = import_circuit_reference(
                Path(args.file),
                as_kind=args.as_kind,
                name=args.name or None,
                subckt_name=args.subckt_name or None,
            )
        elif args.command == "reference-import-visual":
            result = import_visual_reference(Path(args.file), name=args.name or None)
        elif args.command == "prepare-layout-from-reference":
            root = Path(args.project_root).resolve()
            project, modules = load_project(root)
            result = prepare_layout_from_reference(
                project,
                modules,
                module_id=args.module_id,
                asset_id=args.asset_id,
                connectivity_hash_fn=connectivity_hash,
            )
        elif args.command == "apply-layout-from-reference":
            result = apply_layout_from_reference_command(
                Path(args.project_root).resolve(),
                module_id=args.module_id,
                asset_id=args.asset_id,
            )
        elif args.command == "reference-insert-module":
            result = insert_module_from_circuit_reference(
                Path(args.project_root).resolve(),
                asset_id=args.asset_id,
                module_id=args.module_id or None,
            )
        elif args.command == "reference-create-project":
            result = create_project_from_circuit_reference(
                asset_id=args.asset_id,
                name=args.name or None,
                project_kind=args.project_kind,
                projects_root=Path(args.projects_root).resolve() if args.projects_root else None,
            )
        elif args.command == "reference-promote-visual-layout":
            layout_ref = (
                json.loads(args.layout_reference_json)
                if args.layout_reference_json
                else read_json(Path(args.layout_reference_file).resolve())
            )
            result = promote_visual_to_layout(
                visual_asset_id=args.asset_id,
                layout_ref=layout_ref,
                name=args.name or None,
            )
        elif args.command == "reference-pack-from-project":
            result = pack_template_layouts_from_project(
                Path(args.project_root).resolve(),
                Path(args.template_root).resolve(),
                memory_id=args.memory_id,
                template_relative=args.template_relative,
                trust=args.trust,
            )
        elif args.command == "reference-promote-from-module":
            result = promote_visual_from_module(
                Path(args.project_root).resolve(),
                module_id=args.module_id,
                visual_asset_id=args.asset_id,
                name=args.name or None,
            )
        elif args.command == "bridge-list":
            result = {"ok": True, "bridges": list_bridges(Path(args.project_root).resolve())}
        elif args.command == "bridge-status":
            result = bridge_status(Path(args.project_root).resolve(), args.peer_kind or None)
        elif args.command == "bridge-link":
            root = Path(args.project_root).resolve()
            project, _modules = load_project(root)
            if not supports_eda_bridge(project.get("project_kind", DEFAULT_PROJECT_KIND)):
                raise ValueError("KiCad/JLCEDA handoff requires project_kind=pcb_schematic")
            result = link_bridge(root, args.peer_kind, args.peer_root, policy=args.policy)
        elif args.command == "bridge-unlink":
            result = unlink_bridge(Path(args.project_root).resolve(), args.peer_kind)
        elif args.command == "bridge-push":
            root = Path(args.project_root).resolve()
            project, modules = load_project(root)
            if not supports_eda_bridge(project.get("project_kind", DEFAULT_PROJECT_KIND)):
                raise ValueError("KiCad/JLCEDA handoff requires project_kind=pcb_schematic")
            result = push_bridge(
                root,
                args.peer_kind,
                project=project,
                modules=modules,
                document_hash=project_document_hash(project, modules),
                source_revision=args.source_revision,
            )
        elif args.command == "bridge-pull":
            root = Path(args.project_root).resolve()
            project, modules = load_project(root)
            if not supports_eda_bridge(project.get("project_kind", DEFAULT_PROJECT_KIND)):
                raise ValueError("KiCad/JLCEDA handoff requires project_kind=pcb_schematic")
            result = pull_bridge(
                root,
                args.peer_kind,
                project=project,
                modules=modules,
                policy=args.policy or None,
            )
            result = persist_bridge_pull(root, result)
        elif args.command == "bridge-import-cold":
            resolved = resolve_projects_root(
                projects_root=args.projects_root or None,
                workspace_id=args.workspace_id or None,
            )
            result = bridge_import_cold(
                projects_root=Path(resolved["projects_root"]),
                peer_kind=args.peer_kind,
                peer_root=Path(args.peer_root),
                name=args.name,
                project_kind=args.project_kind,
                policy=args.policy,
            )
        elif args.command == "lcsc-search":
            from lcsc_search import search_parts

            result = search_parts(
                args.query,
                api_key=args.api_key,
                api_secret=args.api_secret,
                use_fallback=bool(args.use_fallback),
                limit=args.limit,
            )
        elif args.command == "lcsc-get":
            from lcsc_search import get_part

            result = get_part(
                args.lcsc_id,
                api_key=args.api_key,
                api_secret=args.api_secret,
                use_fallback=bool(args.use_fallback),
            )
        elif args.command == "lcsc-bind":
            result = run_lcsc_bind(
                Path(args.project_root).resolve(),
                args.module_id,
                args.component_id,
                args.lcsc_id,
                api_key=args.api_key,
                api_secret=args.api_secret,
                use_fallback=bool(args.use_fallback),
            )
        elif args.command == "kicad-lib-search":
            from kicad_library import load_index, resolve_lib_root, search_symbols

            index = load_index(resolve_lib_root())
            results = [
                {
                    "id": entry["id"],
                    "lib": entry["lib"],
                    "name": entry["name"],
                    "description": entry.get("description", ""),
                    "default_footprint": entry.get("default_footprint", ""),
                    "pin_count": len(entry.get("pins", [])),
                }
                for entry in search_symbols(index, args.query, limit=args.limit)
            ]
            result = {"ok": True, "results": results}
        elif args.command == "kicad-lib-get":
            from kicad_library import get_footprint, get_symbol, load_index, resolve_lib_root

            if bool(args.symbol) == bool(args.footprint):
                raise ValueError("pass exactly one of --symbol or --footprint")
            index = load_index(resolve_lib_root())
            if args.symbol:
                symbol = get_symbol(index, args.symbol)
                if symbol is None:
                    raise ValueError(f"symbol not found: {args.symbol}")
                result = {"ok": True, "symbol": symbol}
            else:
                footprint = get_footprint(index, args.footprint)
                if footprint is None:
                    raise ValueError(f"footprint not found: {args.footprint}")
                result = {"ok": True, "footprint": footprint}
        elif args.command == "kicad-lib-reindex":
            from kicad_library import load_index, resolve_lib_root

            index = load_index(resolve_lib_root(), force=True)
            result = {
                "ok": True,
                "symbols": len(index["symbols"]),
                "footprints": len(index["footprints"]),
                "cache_path": index["cache_path"],
            }
        else:
            raise ValueError(f"unknown command: {args.command}")
        print(json.dumps(result, ensure_ascii=False))
        return 0 if args.command != "analog-ic-audit" or result.get("ok") else 1
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
