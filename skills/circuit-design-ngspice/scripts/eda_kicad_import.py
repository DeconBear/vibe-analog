#!/usr/bin/env python3
"""Import KiCad schematic peer edits back into Vibe Analog modules."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

from eda_export import GRID, MM_PER_UNIT, _kicad_page_offset, _kicad_snap_internal, connectivity_hash


PROPERTY_RE = re.compile(r'\(property\s+"([^"]+)"\s+("(?:\\.|[^"\\])*"|[^\s()]+)')
TOP_SYMBOL_RE = re.compile(
    r'^\s*\(symbol\s+\(lib_id\s+"([^"]+)"\)\s+\(at\s+([-\d.]+)\s+([-\d.]+)\s+(\d+)\)',
    re.MULTILINE,
)
UUID_RE = re.compile(r"\(uuid\s+([^\s()]+)\)")
UNIT_RE = re.compile(r"\(unit\s+(\d+)\)")


def _component_key(component: dict[str, Any]) -> str:
    stable = str(component.get("stable_id", "")).strip()
    if stable:
        return stable
    return str(component.get("id", "")).strip()


def _find_kicad_roots(peer_root: Path) -> list[Path]:
    candidates: list[Path] = []
    sync_kicad = peer_root / "actoviq-sync" / "kicad"
    if sync_kicad.is_dir():
        candidates.append(sync_kicad)
    if peer_root.is_dir():
        if list(peer_root.glob("*.kicad_sch")) or list(peer_root.glob("*.kicad_pro")):
            candidates.append(peer_root)
        nested = peer_root / "kicad"
        if nested.is_dir():
            candidates.append(nested)
    return candidates


def _load_coordinate_transform(peer_root: Path) -> dict[str, Any]:
    for relative in (
        Path("actoviq-sync") / "coordinate-transform.json",
        Path("coordinate-transform.json"),
    ):
        path = peer_root / relative
        if path.is_file():
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(payload, dict):
                return payload
    return {}


def _page_offset(page_id: str, page: dict[str, Any], transform: dict[str, Any]) -> tuple[float, float]:
    pages = transform.get("kicad_pages") or {}
    entry = pages.get(page_id) or pages.get(str(page_id))
    if isinstance(entry, dict):
        offset = entry.get("offset_internal") or {}
        return float(offset.get("x", 0.0)), float(offset.get("y", 0.0))
    return _kicad_page_offset(page)


def _parse_property_block(block: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for match in PROPERTY_RE.finditer(block):
        key = match.group(1)
        raw = match.group(2)
        if raw.startswith('"') and raw.endswith('"'):
            content = raw[1:-1]
            values[key] = re.sub(
                r'\\([\\"nrt])',
                lambda escaped: {
                    "\\": "\\",
                    '"': '"',
                    "n": "\n",
                    "r": "\r",
                    "t": "\t",
                }[escaped.group(1)],
                content,
            )
        else:
            values[key] = raw
    return values


def parse_kicad_schematic(path: Path) -> list[dict[str, Any]]:
    text = path.read_text(encoding="utf-8")
    instances: list[dict[str, Any]] = []
    for match in TOP_SYMBOL_RE.finditer(text):
        start = match.start()
        depth = 0
        end = start
        for index, char in enumerate(text[start:], start):
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
                if depth == 0:
                    end = index + 1
                    break
        block = text[start:end]
        properties = _parse_property_block(block)
        unit_match = UNIT_RE.search(block)
        actoviq_id = properties.get("ACTOVIQ_ID", "").strip()
        stable_id = actoviq_id
        if not stable_id:
            uuid_match = UUID_RE.search(block)
            peer_identity = uuid_match.group(1) if uuid_match else f"{match.group(1)}:{match.group(2)}:{match.group(3)}"
            digest = hashlib.sha256(f"{path.name}|{peer_identity}".encode("utf-8")).hexdigest()[:20]
            stable_id = f"foreign-kicad-{digest}"
        instances.append(
            {
                "page_id": properties.get("ACTOVIQ_PAGE_ID", path.stem).strip(),
                "component_id": stable_id,
                "stable_id": stable_id,
                "lib_id": match.group(1),
                "x_mm": float(match.group(2)),
                "y_mm": float(match.group(3)),
                "rotation_kicad": int(match.group(4)) % 360,
                "refdes": properties.get("Reference", "").strip(),
                "unit": int(unit_match.group(1)) if unit_match else 1,
                "value": properties.get("Value", "").strip(),
                "source_file": str(path),
                "has_actoviq_id": bool(actoviq_id),
            }
        )
    return instances


def _mm_to_internal(x_mm: float, y_mm: float, offset_x: float, offset_y: float) -> dict[str, float]:
    internal_x = _kicad_snap_internal((x_mm / MM_PER_UNIT) - offset_x)
    internal_y = _kicad_snap_internal((y_mm / MM_PER_UNIT) - offset_y)
    return {"x": internal_x, "y": internal_y}


def _kicad_rotation_to_internal(rotation_kicad: int) -> int:
    return (-int(rotation_kicad)) % 360


def _index_modules(modules: dict[str, dict[str, Any]]) -> dict[tuple[str, str], dict[str, Any]]:
    index: dict[tuple[str, str], dict[str, Any]] = {}
    for module_id, module in modules.items():
        for component in module.get("components", []) or []:
            if not isinstance(component, dict):
                continue
            keys = {
                str(component.get("id", "")).strip(),
                str(component.get("stable_id", "")).strip(),
            }
            for key in keys:
                if key:
                    index[(module_id, key)] = component
                    index[(module_id, _component_key(component))] = component
    return index


def _collect_peer_instances(peer_root: Path) -> tuple[list[dict[str, Any]], list[str]]:
    warnings: list[str] = []
    instances: list[dict[str, Any]] = []
    seen_roots = set()
    for root in _find_kicad_roots(peer_root):
        resolved = root.resolve()
        if resolved in seen_roots:
            continue
        seen_roots.add(resolved)
        schematics = sorted(root.glob("*.kicad_sch"))
        if not schematics:
            continue
        for schematic in schematics:
            if schematic.name.endswith("-root.kicad_sch"):
                continue
            parsed = parse_kicad_schematic(schematic)
            if not parsed and schematic.stat().st_size > 0:
                warnings.append(f"no importable symbols found in {schematic}")
            foreign_count = sum(1 for instance in parsed if not instance.get("has_actoviq_id"))
            if foreign_count:
                warnings.append(
                    f"{foreign_count} symbol(s) without ACTOVIQ_ID in {schematic}; treating them as foreign blocks"
                )
            instances.extend(parsed)
    return instances, warnings


def _connectivity_conflicts(
    project: dict[str, Any],
    modules: dict[str, dict[str, Any]],
    peer_instances: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    conflicts: list[dict[str, Any]] = []
    # Peer-only geometry import does not rebuild connectivity yet; flag unknown symbols only.
    known: set[tuple[str, str]] = set()
    for module_id, module in modules.items():
        for component in module.get("components", []) or []:
            if isinstance(component, dict):
                known.add((module_id, _component_key(component)))
                known.add((module_id, str(component.get("id", "")).strip()))
    for instance in peer_instances:
        page_id = str(instance.get("page_id", "")).strip()
        stable_id = str(instance.get("stable_id", "")).strip()
        if page_id and stable_id and (page_id, stable_id) not in known:
            conflicts.append(
                {
                    "code": "unknown_component",
                    "message": f"KiCad instance {page_id}:{stable_id} has no matching module component",
                    "page_id": page_id,
                    "stable_id": stable_id,
                    "lib_id": instance.get("lib_id", ""),
                }
            )
    if conflicts:
        return conflicts
    return conflicts


def import_kicad_peer(
    peer_root: Path,
    modules: dict[str, dict[str, Any]],
    *,
    project: dict[str, Any] | None = None,
    policy: str | None = None,
) -> dict[str, Any]:
    peer_root = Path(peer_root).expanduser().resolve()
    if not peer_root.is_dir():
        raise ValueError(f"KiCad peer root does not exist: {peer_root}")

    peer_instances, warnings = _collect_peer_instances(peer_root)
    transform = _load_coordinate_transform(peer_root)
    updated_modules: dict[str, dict[str, Any]] = {}
    id_map: dict[str, dict[str, Any]] = {}
    applied: list[str] = []

    index = _index_modules(modules)
    for instance in peer_instances:
        page_id = str(instance.get("page_id", "")).strip()
        stable_id = str(instance.get("stable_id", "")).strip()
        module = modules.get(page_id)
        if module is None:
            continue
        component = index.get((page_id, stable_id))
        if component is None:
            continue
        offset_x, offset_y = _page_offset(page_id, module, transform)
        position = _mm_to_internal(instance["x_mm"], instance["y_mm"], offset_x, offset_y)
        rotation = _kicad_rotation_to_internal(instance["rotation_kicad"])
        clone = updated_modules.setdefault(page_id, json.loads(json.dumps(module)))
        target = None
        for entry in clone.get("components", []) or []:
            if isinstance(entry, dict) and _component_key(entry) == _component_key(component):
                target = entry
                break
        if target is None:
            continue
        target["position"] = position
        target["rotation"] = rotation
        if instance.get("value"):
            target["value"] = instance["value"]
        eda = dict(target.get("eda") or {})
        eda["symbol"] = instance["lib_id"]
        eda["unit"] = int(instance.get("unit") or 1)
        if instance.get("refdes"):
            eda["refdes"] = instance["refdes"]
            package_identity = f"{page_id}|{instance['lib_id']}|{instance['refdes']}"
            eda["package_id"] = f"pkg_kicad_{hashlib.sha256(package_identity.encode('utf-8')).hexdigest()[:16]}"
        target["eda"] = eda
        key = _component_key(component)
        id_map[key] = {
            "peer_kind": "kicad",
            "page_id": page_id,
            "refdes": instance.get("refdes", ""),
            "source_file": instance.get("source_file", ""),
        }
        applied.append(f"{page_id}:{key}")

    conflicts = _connectivity_conflicts(project or {}, modules, peer_instances) if project else []
    connectivity_before = connectivity_hash(project, modules) if project else ""
    connectivity_after = connectivity_hash(project, updated_modules or modules) if project else connectivity_before

    effective_policy = policy or "manual_review"
    blocked = effective_policy == "connectivity_wins" and conflicts
    ok = not blocked and bool(applied)

    return {
        "ok": ok,
        "conflicts": conflicts,
        "updated_modules": {} if blocked else updated_modules,
        "id_map": id_map,
        "connectivity_hash_before": connectivity_before,
        "connectivity_hash_after": connectivity_after,
        "applied": applied,
        "warnings": warnings,
        "peer_instance_count": len(peer_instances),
    }
