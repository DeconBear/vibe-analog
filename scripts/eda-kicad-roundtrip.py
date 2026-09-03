#!/usr/bin/env python3
"""Round-trip coverage for KiCad bridge push/pull geometry preservation."""

from __future__ import annotations

import json
import re
import shutil
import sys
import tempfile
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
SKILL_SCRIPTS = REPO / "skills" / "circuit-design-ngspice" / "scripts"
sys.path.insert(0, str(SKILL_SCRIPTS))

from circuit_project import (  # noqa: E402
    MODULE_SCHEMA,
    atomic_write_json,
    initialize_project,
    load_project,
    module_path,
    project_document_hash,
)
from eda_bridge import link_bridge, pull_bridge, push_bridge  # noqa: E402
from stable_ids import ensure_module_stable_ids  # noqa: E402


def make_module() -> dict:
    module = {
        "schema": MODULE_SCHEMA,
        "module_id": "filter",
        "name": "RC Filter",
        "revision": 0,
        "ports": [
            {"id": "in", "name": "IN", "direction": "input", "signal_type": "analog", "net": "in"},
            {"id": "out", "name": "OUT", "direction": "output", "signal_type": "analog", "net": "out"},
        ],
        "components": [
            {
                "id": "r1",
                "type": "R",
                "name": "R1",
                "value": "1k",
                "position": {"x": 200, "y": 200},
                "rotation": 0,
                "pins": [{"id": "a", "name": "1", "net": "in"}, {"id": "b", "name": "2", "net": "mid"}],
            },
            {
                "id": "c1",
                "type": "C",
                "name": "C1",
                "value": "100n",
                "position": {"x": 420, "y": 200},
                "rotation": 90,
                "pins": [{"id": "a", "name": "1", "net": "mid"}, {"id": "b", "name": "2", "net": "out"}],
            },
        ],
        "nets": [
            {"id": "net_in", "name": "in", "kind": "analog"},
            {"id": "net_mid", "name": "mid", "kind": "analog"},
            {"id": "net_out", "name": "out", "kind": "analog"},
        ],
        "wires": [],
        "annotations": [],
    }
    ensure_module_stable_ids(module)
    return module


def write_filter_project(root: Path) -> None:
    module = make_module()
    project_path = root / "project.circuit.json"
    project = json.loads(project_path.read_text(encoding="utf-8"))
    project["project_kind"] = "pcb_schematic"
    project["modules"] = [{"id": "filter", "name": module["name"], "ports": module["ports"]}]
    atomic_write_json(project_path, project)
    atomic_write_json(module_path(root, "filter"), module)


def find_schematic(peer_root: Path) -> Path:
    sync_kicad = peer_root / "actoviq-sync" / "kicad"
    candidates = sorted(sync_kicad.glob("*.kicad_sch"))
    if not candidates:
        raise AssertionError("KiCad push did not produce a schematic file")
    return candidates[0]


def mutate_schematic_position(schematic: Path, *, dx_mm: float, dy_mm: float, delta_rot: int) -> None:
    text = schematic.read_text(encoding="utf-8")

    def repl(match: re.Match[str]) -> str:
        lib_id = match.group(1)
        x = float(match.group(2)) + dx_mm
        y = float(match.group(3)) + dy_mm
        rot = (int(match.group(4)) + delta_rot) % 360
        return f'(symbol (lib_id "{lib_id}") (at {x:.4f} {y:.4f} {rot})'

    updated = re.sub(
        r'\(symbol \(lib_id "([^"]+)"\) \(at ([-\d.]+) ([-\d.]+) (\d+)\)',
        repl,
        text,
        count=1,
    )
    assert updated != text, "expected schematic geometry mutation"
    schematic.write_text(updated, encoding="utf-8")


def mutate_schematic_wire(schematic: Path, *, dx_mm: float) -> None:
    text = schematic.read_text(encoding="utf-8")

    def repl(match: re.Match[str]) -> str:
        x = float(match.group(1)) + dx_mm
        y = float(match.group(2))
        return f"(wire (pts (xy {x:.4f} {y:.4f})"

    updated = re.sub(
        r"\(wire \(pts \(xy ([-\d.]+) ([-\d.]+)\)",
        repl,
        text,
        count=1,
    )
    assert updated != text, "expected schematic wire mutation"
    schematic.write_text(updated, encoding="utf-8")


def main() -> int:
    temp_root = Path(tempfile.mkdtemp(prefix="actoviq-kicad-roundtrip-"))
    try:
        projects_root = temp_root / "projects"
        peer_root = temp_root / "peer-kicad"
        projects_root.mkdir(parents=True)
        peer_root.mkdir(parents=True)

        project_root = initialize_project(
            projects_root,
            "KiCad Roundtrip",
            "kicad-roundtrip",
            demo=False,
            project_kind="pcb_schematic",
        )
        write_filter_project(project_root)
        project, modules = load_project(project_root)
        document_hash = project_document_hash(project, modules)
        stable_ids_before = {
            component["id"]: component.get("stable_id")
            for component in modules["filter"]["components"]
        }
        positions_before = {
            component["id"]: dict(component["position"])
            for component in modules["filter"]["components"]
        }

        link_bridge(project_root, "kicad", peer_root, policy="layout_wins")
        push_result = push_bridge(
            project_root,
            "kicad",
            project=project,
            modules=modules,
            document_hash=document_hash,
            source_revision=project["revision"],
        )
        assert push_result["ok"], push_result
        schematic = find_schematic(peer_root)
        mutate_schematic_position(schematic, dx_mm=25.4, dy_mm=12.7, delta_rot=90)

        pull_result = pull_bridge(
            project_root,
            "kicad",
            project=project,
            modules=modules,
            policy="layout_wins",
        )
        assert pull_result["ok"], pull_result
        assert pull_result.get("connectivity_drift") is not True, (
            "a layout-only peer edit must not be flagged as connectivity drift"
        )
        updated = pull_result["updated_modules"]["filter"]
        r1 = next(item for item in updated["components"] if item["id"] == "r1")
        assert r1.get("stable_id") == stable_ids_before["r1"], "stable_id must be preserved"
        assert r1["position"] != positions_before["r1"], "position should reflect peer geometry edit"
        assert int(r1.get("rotation", 0)) != 0, "rotation should reflect peer geometry edit"

        # A peer-side connectivity edit must be surfaced (connectivity_drift warning +
        # review gate) instead of being silently dropped by the layout-only pull.
        mutate_schematic_wire(schematic, dx_mm=5.08)
        drift_pull = pull_bridge(
            project_root,
            "kicad",
            project=project,
            modules=modules,
            policy="layout_wins",
        )
        assert drift_pull.get("connectivity_drift") is True, drift_pull.get("warnings")
        assert drift_pull.get("requires_review") is True, "connectivity drift must gate automatic persistence"
        drift_codes = {warning.get("code") for warning in drift_pull.get("warnings") or []}
        assert "connectivity_drift" in drift_codes, drift_pull.get("warnings")

        print(
            json.dumps(
                {
                    "ok": True,
                    "project_root": str(project_root),
                    "peer_root": str(peer_root),
                    "schematic": str(schematic),
                    "applied": pull_result.get("applied", []),
                },
                ensure_ascii=False,
            )
        )
        return 0
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
