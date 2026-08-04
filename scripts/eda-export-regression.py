#!/usr/bin/env python3
"""Regression coverage for deterministic EDA IR and multi-target exports."""

from __future__ import annotations

import copy
import json
import re
import shutil
import sys
from unittest.mock import patch
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
SKILL_SCRIPTS = REPO / "skills" / "circuit-design-ngspice" / "scripts"
sys.path.insert(0, str(SKILL_SCRIPTS))

from eda_export import (  # noqa: E402
    PATCH_SCHEMA,
    PATCH_SET_SCHEMA,
    SYMBOL_MAP_SCHEMA,
    _kicad_page_offset,
    _kicad_local_pin_position,
    _layout_candidates,
    _pin_position,
    _same_net_junction_keys,
    _native_status,
    _spice_lines,
    _write_kicad,
    build_eda_ir,
    connectivity_hash,
    evaluate_layout_patches,
    export_eda,
    prepare_layout_review,
    score_layout,
    validate_layout_patch,
    validate_layout_patch_set,
    verify_routed_connectivity,
)
from eda_kicad_validate import find_kicad_cli, validate_kicad_package  # noqa: E402
from eda_portable_validate import (  # noqa: E402
    validate_altium_import_package,
    validate_orcad_edif,
    validate_virtuoso_package,
)
from eda_symbols import assign_refdes, prepare_component, resolve_symbol_map  # noqa: E402
from circuit_project import apply_operation, upgrade_module_document, validate_module  # noqa: E402


def port(port_id: str, direction: str, signal_type: str, net: str) -> dict:
    return {"id": port_id, "name": port_id.upper(), "direction": direction, "signal_type": signal_type, "net": net}


def pin(pin_id: str, net: str, side: str | None = None) -> dict:
    value = {"id": pin_id, "name": pin_id.upper(), "net": net}
    if side:
        value["side"] = side
    return value


def component(component_id: str, kind: str, value: str, x: int, y: int, pins: list[dict], rotation: int = 0, **extra: object) -> dict:
    return {"id": component_id, "type": kind, "name": component_id.upper(), "value": value, "position": {"x": x, "y": y}, "rotation": rotation, "pins": pins, **extra}


def ldo_module() -> dict:
    return {
        "schema": "actoviq.module.v2",
        "module_id": "pmos_ldo",
        "name": "PMOS LDO Bench",
        "revision": 4,
        "ports": [
            port("in", "input", "power", "vin"),
            port("out", "output", "analog", "out"),
            port("gate", "input", "analog", "gate"),
        ],
        "components": [
            component("mpass", "M", "PMOSPASS", 360, 240, [pin("d", "out"), pin("g", "gate"), pin("s", "vin"), pin("b", "vin")]),
            component("rpu", "R", "47k", 180, 120, [pin("a", "vin"), pin("b", "gate")], 90),
            component("rload", "R", "10k", 620, 300, [pin("a", "out"), pin("b", "0")], 90),
            # Ideal sources without an explicit design_include policy are bench
            # objects.  Design export must omit them while simulation keeps them.
            component("vin_source", "V", "DC 5", 80, 240, [pin("p", "vin"), pin("n", "0")]),
            component("iload", "I", "DC 1m", 720, 300, [pin("p", "out"), pin("n", "0")]),
        ],
        "nets": [
            {"id": "net_vin", "name": "vin", "kind": "power"},
            {"id": "net_out", "name": "out", "kind": "analog"},
            {"id": "net_gate", "name": "gate", "kind": "analog"},
            {"id": "net_0", "name": "0", "kind": "ground"},
        ],
        "wires": [],
        "annotations": [],
    }


def real_pmos_ldo_layout_module() -> dict:
    """Equivalent topology/geometry to the existing PMOS LDO Bench rev7."""

    return {
        "schema": "actoviq.module.v2",
        "module_id": "ldo",
        "name": "PMOS series LDO",
        "revision": 7,
        "ports": [
            {**port("gnd", "bidirectional", "ground", "0")},
            {**port("input", "input", "analog", "vin"), "position": {"x": -40, "y": 120}},
            port("output", "output", "analog", "out"),
            port("export_vref", "bidirectional", "analog", "vref"),
        ],
        "components": [
            component("vin", "V", "DC {VIN_NOM} AC 0", 140, 420, [pin("p", "vin"), pin("n", "0")], 90),
            component("vref_src", "V", "DC {VREF} AC 1", 140, 660, [pin("p", "vref"), pin("n", "0")], 90),
            component("rpu", "R", "47k", 700, 180, [pin("a", "vin"), pin("b", "gate")], 90),
            component("qerr", "Q", "QNPN", 320, 500, [pin("c", "gate"), pin("b", "vref"), pin("e", "fb")]),
            component("mpass", "M", "PMOSPASS W=20m L=1u", 820, 340, [pin("d", "out"), pin("g", "gate"), pin("s", "vin"), pin("b", "vin")]),
            component("rfb1", "R", "{RTOP}", 1020, 440, [pin("a", "out"), pin("b", "fb")], 90),
            component("rfb2", "R", "{RBOT}", 1020, 680, [pin("a", "fb"), pin("b", "0")], 90),
            component("cout", "C", "{COUTVAL}", 1300, 640, [pin("a", "out"), pin("b", "0")], 90),
            component("iload", "I", "DC 0 PULSE(0 {ILOAD_STEP} 0.5m 1u 1u 0.5m 5m)", 1160, 640, [pin("p", "out"), pin("n", "0")], 90),
        ],
        "nets": [
            {"id": "net_vin", "name": "vin", "kind": "analog"},
            {"id": "net_0", "name": "0", "kind": "ground"},
            {"id": "net_vref", "name": "vref", "kind": "signal"},
            {"id": "net_gate", "name": "gate", "kind": "signal"},
            {"id": "net_fb", "name": "fb", "kind": "signal"},
            {"id": "net_out", "name": "out", "kind": "analog"},
        ],
        "wires": [],
        "annotations": [],
    }


def auxiliary_module() -> dict:
    return {
        "schema": "actoviq.module.v2",
        "module_id": "control",
        "name": "Control and testbench",
        "revision": 2,
        "ports": [port("sense", "input", "analog", "sense"), port("drive", "output", "analog", "drive")],
        "components": [
            component("controller", "BLOCK", "ERROR_AMP", 260, 200, [pin("sense", "sense", "left"), pin("ref", "vref", "left"), pin("drive", "drive", "right")], block={"width": 160, "height": 100}),
            component("vref", "V", "DC 1.2", 80, 340, [pin("p", "vref"), pin("n", "0")], mount_policy="testbench_exclude"),
        ],
        "nets": [
            {"id": "net_sense", "name": "sense"}, {"id": "net_drive", "name": "drive"},
            {"id": "net_vref", "name": "vref"}, {"id": "net_0", "name": "0", "kind": "ground"},
        ],
        "wires": [],
        "annotations": [],
    }


def wire_validation_module() -> dict:
    return {
        "schema": "actoviq.module.v2",
        "module_id": "wire_validation",
        "name": "Wire validation",
        "revision": 1,
        "ports": [{
            **port("in", "input", "analog", "signal"),
            "net_id": "net_signal",
            "position": {"x": 40, "y": 0},
        }],
        "components": [component("r1", "R", "1k", 0, 0, [
            {**pin("a", "signal"), "net_id": "net_signal"},
            {**pin("b", "0"), "net_id": "net_0"},
        ])],
        "nets": [
            {"id": "net_signal", "name": "signal", "kind": "analog", "aliases": ["sig"]},
            {"id": "net_other", "name": "other", "kind": "signal", "aliases": []},
            {"id": "net_0", "name": "0", "kind": "ground", "aliases": []},
        ],
        "wires": [
            {
                "id": "w1",
                "points": [{"x": 0, "y": 0}, {"x": 20, "y": 0}],
                "from": {"x": 0, "y": 0, "component_id": "r1", "pin_id": "a"},
                "to": {"x": 20, "y": 0, "junction_id": "j_signal"},
                "net": "signal",
                "net_id": "net_signal",
                "source": "stored",
            },
            {
                "id": "w2",
                "points": [{"x": 20, "y": 0}, {"x": 40, "y": 0}],
                "from": {"x": 20, "y": 0, "junction_id": "j_signal"},
                "to": {"x": 40, "y": 0, "port_id": "in"},
                "net": "sig",
                "net_id": "net_signal",
                "source": "stored",
            },
        ],
        "annotations": [],
    }


def assert_wire_validation() -> None:
    valid = wire_validation_module()
    validate_module(valid)

    invalid_mutations = [
        lambda value: value["wires"][0]["from"].update(component_id="missing"),
        lambda value: value["wires"][0]["from"].update(pin_id="missing"),
        lambda value: value["wires"][1]["to"].update(port_id="missing"),
        lambda value: value["wires"][0]["to"].pop("junction_id"),
        lambda value: value["wires"][0].update(points=[{"x": 0, "y": 0}]),
        lambda value: value["wires"][0].update(points=[{"x": 0, "y": 0}, {"x": 0, "y": 0}, {"x": 20, "y": 0}]),
        lambda value: value["wires"][0]["points"].__setitem__(1, {"x": 20, "y": 20}),
        lambda value: value["wires"][0]["points"].__setitem__(0, {"x": -1, "y": 0}),
        lambda value: value["wires"][0]["points"].__setitem__(-1, {"x": 21, "y": 0}),
        lambda value: value["wires"][0].update(net="0", net_id="net_0"),
        lambda value: value["wires"][0].update(net_id="net_missing"),
        lambda value: value["wires"][0].update(net="other"),
        lambda value: (value["wires"][1]["from"].update(x=21), value["wires"][1]["points"][0].update(x=21)),
    ]
    for index, mutate in enumerate(invalid_mutations):
        candidate = copy.deepcopy(valid)
        mutate(candidate)
        try:
            validate_module(candidate)
            raise AssertionError(f"invalid wire case {index} was accepted")
        except ValueError:
            pass

    legacy = copy.deepcopy(valid)
    legacy["schema"] = "actoviq.module.v1"
    legacy["wires"][0]["to"].pop("junction_id")
    legacy["wires"][1]["from"].pop("junction_id")
    repeated = copy.deepcopy(legacy)
    upgrade_module_document(legacy, repair_legacy_wire_endpoints=True)
    upgrade_module_document(repeated, repair_legacy_wire_endpoints=True)
    upgraded_ids = (legacy["wires"][0]["to"]["junction_id"], legacy["wires"][1]["from"]["junction_id"])
    assert upgraded_ids[0] == upgraded_ids[1], "legacy endpoints at one net coordinate must share a junction"
    assert upgraded_ids == (
        repeated["wires"][0]["to"]["junction_id"],
        repeated["wires"][1]["from"]["junction_id"],
    ), "legacy junction upgrade must be deterministic"
    validate_module(legacy)

    strict_candidate = copy.deepcopy(repeated)
    strict_candidate["wires"][0]["to"].pop("junction_id")
    strict_candidate["wires"][1]["from"].pop("junction_id")
    upgrade_module_document(strict_candidate)
    try:
        validate_module(strict_candidate)
        raise AssertionError("new identity-less wire endpoints were accepted")
    except ValueError:
        pass

    invalid_net_id = copy.deepcopy(valid)
    invalid_net_id["wires"][0]["net_id"] = "net_missing"
    upgrade_module_document(invalid_net_id)
    try:
        validate_module(invalid_net_id)
        raise AssertionError("new unknown wire net_id was repaired instead of rejected")
    except ValueError:
        pass

    pure_crossing = copy.deepcopy(valid)
    pure_crossing["components"].append(component("r2", "R", "1k", 0, 0, [
        {**pin("a", "other"), "net_id": "net_other"},
        {**pin("b", "other"), "net_id": "net_other"},
    ]))
    pure_crossing["wires"].append({
        "id": "w_cross", "net": "other", "net_id": "net_other", "source": "stored",
        "from": {"x": 10, "y": -20, "component_id": "r2", "pin_id": "a"},
        "to": {"x": 10, "y": 20, "component_id": "r2", "pin_id": "b"},
        "points": [{"x": 10, "y": -20}, {"x": 10, "y": 20}],
    })
    validate_module(pure_crossing)

    endpoint_contact = copy.deepcopy(pure_crossing)
    endpoint_contact["wires"][-1]["to"].update(x=10, y=0)
    endpoint_contact["wires"][-1]["points"][-1] = {"x": 10, "y": 0}
    try:
        validate_module(endpoint_contact)
        raise AssertionError("different-net endpoint-on-segment contact was accepted")
    except ValueError as error:
        assert "different-net endpoint on foreign segment" in str(error)


def assert_routed_connectivity_gate() -> None:
    nets = [
        {
            "id": "net_h", "name": "h",
            "endpoints": [
                {"kind": "pin", "component_id": "rh", "pin_id": "a", "x": -20, "y": 0},
                {"kind": "pin", "component_id": "rh", "pin_id": "b", "x": 20, "y": 0},
            ],
        },
        {
            "id": "net_v", "name": "v",
            "endpoints": [
                {"kind": "pin", "component_id": "rv", "pin_id": "a", "x": 0, "y": -20},
                {"kind": "pin", "component_id": "rv", "pin_id": "b", "x": 0, "y": 20},
            ],
        },
    ]
    wires = [
        {
            "id": "horizontal", "net_id": "net_h", "net": "h",
            "from": {"component_id": "rh", "pin_id": "a"},
            "to": {"component_id": "rh", "pin_id": "b"},
            "points": [{"x": -20, "y": 0}, {"x": 20, "y": 0}],
        },
        {
            "id": "vertical", "net_id": "net_v", "net": "v",
            "from": {"component_id": "rv", "pin_id": "a"},
            "to": {"component_id": "rv", "pin_id": "b"},
            "points": [{"x": 0, "y": -20}, {"x": 0, "y": 20}],
        },
    ]
    crossing = verify_routed_connectivity(nets, wires)
    assert crossing["ok"], "a pure interior crossing must remain electrically disconnected"
    assert crossing["source_partition_hash"] == crossing["routed_partition_hash"]

    same_name_nets = copy.deepcopy(nets)
    same_name_wires = copy.deepcopy(wires)
    for net in same_name_nets:
        net["name"] = "shared-display-label"
    for wire in same_name_wires:
        wire["net"] = "shared-display-label"
    same_name_crossing = verify_routed_connectivity(same_name_nets, same_name_wires)
    assert same_name_crossing["ok"], "stable net_id values must isolate nets that share a display label"
    assert same_name_crossing["source_partition_hash"] == same_name_crossing["routed_partition_hash"]

    endpoint_contact_nets = copy.deepcopy(nets)
    endpoint_contact_nets[1]["endpoints"][0].update(x=0, y=0)
    endpoint_contact_wires = copy.deepcopy(wires)
    endpoint_contact_wires[1]["points"][0] = {"x": 0, "y": 0}
    endpoint_contact = verify_routed_connectivity(endpoint_contact_nets, endpoint_contact_wires)
    assert not endpoint_contact["ok"]
    assert {error["category"] for error in endpoint_contact["errors"]} & {"endpoint_on_segment", "endpoint_on_foreign_net"}

    overlap_nets = copy.deepcopy(nets)
    overlap_nets[1]["endpoints"][0].update(x=-10, y=0)
    overlap_nets[1]["endpoints"][1].update(x=10, y=0)
    overlap_wires = copy.deepcopy(wires)
    overlap_wires[1]["points"] = [{"x": -10, "y": 0}, {"x": 10, "y": 0}]
    overlap = verify_routed_connectivity(overlap_nets, overlap_wires)
    assert not overlap["ok"] and "collinear_overlap" in {error["category"] for error in overlap["errors"]}

    disconnected = verify_routed_connectivity(nets, wires[1:])
    assert not disconnected["ok"] and "missing_routed_connection" in {error["category"] for error in disconnected["errors"]}

    dangling_stub = copy.deepcopy(wires[:1])
    dangling_stub.append({
        "id": "dangling", "net_id": "net_h", "net": "h",
        "from": {"x": 0, "y": 0}, "to": {"x": 0, "y": 10},
        "points": [{"x": 0, "y": 0}, {"x": 0, "y": 10}],
    })
    dangling = verify_routed_connectivity(nets[:1], dangling_stub)
    assert not dangling["ok"] and "dangling_routed_stub" in {error["category"] for error in dangling["errors"]}


def assert_layout_transaction_connectivity_guard() -> None:
    project, fixture_modules = project_fixture()
    module = upgrade_module_document(copy.deepcopy(fixture_modules["pmos_ldo"]))
    guarded_hash = connectivity_hash(project, {"pmos_ldo": module}, "pmos_ldo", "design")

    def operation_for(candidate: dict) -> dict:
        return {
            "op": "set_module_schematic",
            "module_id": "pmos_ldo",
            "expected_connectivity_hash": guarded_hash,
            "connectivity_view": "design",
            "components": copy.deepcopy(candidate["components"]),
            "ports": copy.deepcopy(candidate["ports"]),
            "wires": copy.deepcopy(candidate.get("wires", [])),
            "nets": copy.deepcopy(candidate["nets"]),
            "annotations": copy.deepcopy(candidate.get("annotations", [])),
        }

    moved_module = copy.deepcopy(module)
    moved_module["components"][0]["position"]["x"] += 20
    guarded_project = copy.deepcopy(project)
    guarded_modules = {"pmos_ldo": copy.deepcopy(module)}
    apply_operation(
        Path("."),
        guarded_project,
        guarded_modules,
        operation_for(moved_module),
        set(),
        {},
        {},
    )
    assert connectivity_hash(guarded_project, guarded_modules, "pmos_ldo", "design") == guarded_hash

    changed_module = copy.deepcopy(module)
    changed_pin = next(component for component in changed_module["components"] if component["id"] == "rpu")["pins"][0]
    changed_pin["net"] = "gate"
    changed_pin["net_id"] = "net_gate"
    try:
        apply_operation(
            Path("."),
            copy.deepcopy(project),
            {"pmos_ldo": copy.deepcopy(module)},
            operation_for(changed_module),
            set(),
            {},
            {},
        )
    except ValueError as error:
        assert "would change authoritative connectivity" in str(error)
    else:
        raise AssertionError("layout transaction must reject an electrically changed schematic")


def assert_quality_dimensions() -> None:
    label_nets = [{
        "id": "net_label", "name": "label_net",
        "endpoints": [
            {"kind": "pin", "component_id": "remote", "pin_id": "a", "x": -20, "y": 500},
            {"kind": "pin", "component_id": "remote", "pin_id": "b", "x": 20, "y": 500},
        ],
    }]
    label_wires = [{
        "id": "label-wire", "net_id": "net_label", "net": "label_net",
        "from": {"component_id": "remote", "pin_id": "a"},
        "to": {"component_id": "remote", "pin_id": "b"},
        "points": [{"x": -20, "y": 500}, {"x": 20, "y": 500}],
    }]
    label_components = [
        component("label", "R", "1k", -100, 0, [pin("a", "n1"), pin("b", "n2")]),
        component("obstacle", "R", "1k", 20, 0, [pin("a", "n3"), pin("b", "n4")]),
    ]
    label_quality = score_layout("labels", label_components, label_nets, label_wires, {}, "1" * 64)
    assert label_quality["lexicographic_cost"][3] > 0
    assert any(issue["category"] == "label_overlap" and issue["component_ids"] and issue["bounds"] and issue["fix_category"] for issue in label_quality["issues"])

    congested_nets = []
    congested_wires = []
    for index in range(4):
        y = 5 + index * 10
        net_id = f"net_{index}"
        congested_nets.append({
            "id": net_id, "name": f"n{index}",
            "endpoints": [
                {"kind": "pin", "component_id": f"r{index}", "pin_id": "a", "x": 5, "y": y},
                {"kind": "pin", "component_id": f"r{index}", "pin_id": "b", "x": 75, "y": y},
            ],
        })
        congested_wires.append({
            "id": f"wire_{index}", "net_id": net_id, "net": f"n{index}",
            "from": {"component_id": f"r{index}", "pin_id": "a"},
            "to": {"component_id": f"r{index}", "pin_id": "b"},
            "points": [{"x": 5, "y": y}, {"x": 75, "y": y}],
        })
    congestion_quality = score_layout("congestion", [], congested_nets, congested_wires, {}, "2" * 64)
    assert congestion_quality["lexicographic_cost"][4] > 0
    assert any(issue["category"] == "corridor_congestion" and len(issue["net_ids"]) == 4 and issue["bounds"] for issue in congestion_quality["issues"])

    flow_nets = [
        {
            "id": "net_in", "name": "in",
            "endpoints": [
                {"kind": "port", "port_id": "in", "x": 40, "y": 100},
                {"kind": "pin", "component_id": "rin", "pin_id": "a", "x": 60, "y": 100},
            ],
        },
        {
            "id": "net_out", "name": "out",
            "endpoints": [
                {"kind": "port", "port_id": "out", "x": -40, "y": 200},
                {"kind": "pin", "component_id": "rout", "pin_id": "a", "x": -20, "y": 200},
            ],
        },
    ]
    flow_wires = [
        {"id": "win", "net_id": "net_in", "net": "in", "from": {"port_id": "in"}, "to": {"component_id": "rin", "pin_id": "a"}, "points": [{"x": 40, "y": 100}, {"x": 60, "y": 100}]},
        {"id": "wout", "net_id": "net_out", "net": "out", "from": {"port_id": "out"}, "to": {"component_id": "rout", "pin_id": "a"}, "points": [{"x": -40, "y": 200}, {"x": -20, "y": 200}]},
    ]
    flow_quality = score_layout("flow", [], flow_nets, flow_wires, {}, "3" * 64)
    assert flow_quality["lexicographic_cost"][6] > 0
    assert any(issue["category"] == "signal_flow_violation" and issue["net_ids"] and issue["bounds"] for issue in flow_quality["issues"])

    port_quality = score_layout(
        "ports",
        [],
        [],
        [],
        {"in": {"x": 0, "y": 0}, "out": {"x": 20, "y": 0}},
        "4" * 64,
        [
            {"id": "in", "name": "IN", "net": "vin", "direction": "input", "signal_type": "analog"},
            {"id": "out", "name": "OUT", "net": "vout", "direction": "output", "signal_type": "analog"},
        ],
    )
    assert port_quality["metrics"]["port_overlaps"] == 1
    assert port_quality["lexicographic_cost"][1] > 0
    assert any(
        issue["category"] == "port_overlap"
        and issue["net_ids"] == ["vin", "vout"]
        and issue["bounds"]
        and issue["fix_category"] == "move_ports"
        for issue in port_quality["issues"]
    )


def project_fixture() -> tuple[dict, dict[str, dict]]:
    modules = {"pmos_ldo": ldo_module(), "control": auxiliary_module()}
    project = {
        "schema": "actoviq.project.v2",
        "project_id": "eda-regression",
        "name": "EDA Export Regression",
        "revision": 7,
        "modules": [
            {"id": "pmos_ldo", "name": "PMOS LDO Bench", "kind": "ldo", "source": "modules/pmos_ldo/module.circuit.json", "position": {"x": 0, "y": 0}, "size": {"width": 800, "height": 600}, "ports": modules["pmos_ldo"]["ports"]},
            {"id": "control", "name": "Control", "kind": "control", "source": "modules/control/module.circuit.json", "position": {"x": 900, "y": 0}, "size": {"width": 500, "height": 400}, "ports": modules["control"]["ports"]},
        ],
        "connections": [
            {"id": "feedback", "from": {"module_id": "pmos_ldo", "port_id": "out"}, "to": {"module_id": "control", "port_id": "sense"}, "network": "VOUT"},
            {"id": "drive", "from": {"module_id": "control", "port_id": "drive"}, "to": {"module_id": "pmos_ldo", "port_id": "gate"}, "network": "GATE"},
        ],
    }
    return project, modules


def balanced(text: str) -> bool:
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


def kicad_instance_for_refdes(schematic: str, refdes: str) -> str:
    marker = f'(property "Reference" "{refdes}"'
    marker_index = schematic.find(marker)
    assert marker_index >= 0, f"KiCad instance for {refdes} is missing"
    start = schematic.rfind("  (symbol (lib_id ", 0, marker_index)
    assert start >= 0, f"KiCad instance block for {refdes} is missing"
    end = schematic.find("\n  (symbol (lib_id ", marker_index)
    if end < 0:
        end = len(schematic)
    return schematic[start:end]


def assert_eda_semantics(ir: dict) -> None:
    components = [entry for page in ir["pages"] for entry in page["components"]]
    refdes = []
    for entry in components:
        semantics = entry.get("eda")
        assert isinstance(semantics, dict), f"{entry['id']} is missing EDA semantics"
        assert semantics.get("device_class"), f"{entry['id']} has no EDA device class"
        assert semantics.get("subtype"), f"{entry['id']} has no EDA subtype"
        assert semantics.get("refdes_prefix"), f"{entry['id']} has no refdes prefix"
        assert re.fullmatch(r"[A-Z]+[1-9][0-9]*", str(semantics.get("refdes", ""))), f"invalid refdes for {entry['id']}"
        source_pin_ids = {str(pin_value["id"]) for pin_value in entry.get("pins", [])}
        assert set(semantics.get("pin_roles", {})) == source_pin_ids, f"incomplete pin roles for {entry['id']}"
        for pin_value in entry.get("pins", []):
            pin_semantics = pin_value.get("eda")
            assert isinstance(pin_semantics, dict) and pin_semantics.get("role"), f"{entry['id']}.{pin_value['id']} has no terminal role"
            assert pin_semantics.get("side") in {"left", "right", "top", "bottom"}
            assert isinstance(pin_semantics.get("order"), int)
        refdes.append(semantics["refdes"])
    assert len(refdes) == len(set(refdes)), "EDA refdes must be unique across the export"


def assert_kicad_primitive_library(output: Path) -> None:
    components = [
        component("r", "R", "1k", 120, 100, [pin("a", "n1"), pin("b", "n2")]),
        component("c", "C", "10n", 260, 100, [pin("a", "n2"), pin("b", "0")]),
        component("l", "L", "1m", 400, 100, [pin("a", "n2"), pin("b", "n3")]),
        component("d", "D", "DGEN", 540, 100, [pin("a", "n3"), pin("k", "0")]),
        component("m", "M", "NMOS", 160, 260, [pin("d", "n4"), pin("g", "n3"), pin("s", "0"), pin("b", "0")]),
        component("q", "Q", "NPN", 340, 260, [pin("c", "n4"), pin("b", "n3"), pin("e", "0")]),
        component("v", "V", "DC 5", 520, 260, [pin("p", "n4"), pin("n", "0")]),
        component("i", "I", "DC 1m", 680, 260, [pin("p", "n4"), pin("n", "0")]),
    ]
    page = {
        "id": "primitives",
        "name": "Portable primitives",
        "components": components,
        "ports": [
            {**port("in", "input", "analog", "n1"), "position": {"x": 40, "y": 100}},
            {**port("out", "output", "analog", "n4"), "position": {"x": 760, "y": 260}},
        ],
        "nets": [],
        "wires": [],
        "annotations": [],
    }
    assign_refdes([page])
    primitive_ir = {
        "pages": [page],
        "connectivity": {"records": [], "hash": "0" * 64},
    }
    primitive_map = resolve_symbol_map(None, [page], ["kicad"], SYMBOL_MAP_SCHEMA)
    root = output / "kicad-primitives"
    _write_kicad(root, "Portable_Primitives", primitive_ir, primitive_map)
    report = validate_kicad_package(root / "kicad", primitive_ir, primitive_map)
    assert report["instances"] == len(components)
    library = (root / "kicad" / "Vibe_Analog_Standard.kicad_sym").read_text(encoding="utf-8")
    for cell in ("R", "C", "L", "Diode", "NMOS_4PIN", "NPN", "Voltage_Source", "Current_Source"):
        assert f'(symbol "{cell}"' in library, f"portable KiCad library is missing {cell}"
    schematic = (root / "kicad" / "Portable_Primitives.kicad_sch").read_text(encoding="utf-8")
    assert '(global_label "IN"' in schematic and '(global_label "OUT"' in schematic


def assert_flattened_spice_uses_unique_refdes() -> None:
    pages = [
        {"id": "first", "components": [component("r", "R", "1k", 0, 0, [pin("a", "n"), pin("b", "0")])]},
        {"id": "second", "components": [component("r", "R", "2k", 0, 0, [pin("a", "n"), pin("b", "0")])]},
    ]
    for page in pages:
        page["components"][0]["name"] = "R1"
    assign_refdes(pages)
    records = [
        {"module_id": page["id"], "component_id": "r", "pin_id": pin_id, "net": net}
        for page in pages for pin_id, net in (("a", "shared"), ("b", "0"))
    ]
    lines = _spice_lines({"pages": pages, "connectivity": {"records": records, "hash": "0" * 64}})
    instances = [line for line in lines if line and not line.startswith("*") and line != ".END"]
    assert [line.split()[0] for line in instances] == ["R1", "R2"], "flattened SPICE must use export-wide unique refdes"


def main() -> int:
    assert_wire_validation()
    assert_routed_connectivity_gate()
    assert_layout_transaction_connectivity_guard()
    assert_quality_dimensions()
    output = REPO / "output" / "eda-export-regression"
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    assert_kicad_primitive_library(output)
    assert_flattened_spice_uses_unique_refdes()
    project, modules = project_fixture()
    orientation_candidates = _layout_candidates(modules["pmos_ldo"], "design")
    repeated_candidates = _layout_candidates(modules["pmos_ldo"], "design")
    assert 8 <= len(orientation_candidates) <= 16, "generic deterministic layout must emit 8..16 candidates"
    assert orientation_candidates == repeated_candidates, "layout candidate generation must be deterministic"
    assert any(
        next(entry for entry in candidate if entry["id"] == "mpass")["rotation"] in {90, 270}
        for candidate in orientation_candidates
    ), "multi-pin devices must receive orthogonal orientation candidates"
    document_hash = "a" * 64
    expected_hash = connectivity_hash(project, modules, view="design")
    ir, quality = build_eda_ir(project, modules, scope="project", module_id=None, view="design", document_hash=document_hash)
    assert ir["schema"] == "actoviq.eda-ir.v1"
    assert ir["connectivity"]["hash"] == expected_hash
    assert_eda_semantics(ir)
    block_variants = [{
        "id": "variants",
        "components": [
            component("left_right", "BLOCK", "A", 0, 0, [pin("a", "n1", "left"), pin("b", "n2", "right")]),
            component("top_bottom", "BLOCK", "B", 0, 0, [pin("a", "n1", "top"), pin("b", "n2", "bottom")]),
        ],
    }]
    variant_map = resolve_symbol_map(None, block_variants, ["kicad"], SYMBOL_MAP_SCHEMA)
    variant_cells = {
        binding["cell"]
        for binding in variant_map["targets"]["kicad"]["components"].values()
    }
    assert len(variant_cells) == 2, "different BLOCK pin geometry must not reuse one KiCad cell"
    repeated_ir, _ = build_eda_ir(project, modules, scope="project", module_id=None, view="design", document_hash=document_hash)
    first_refdes = {f"{page['id']}:{entry['id']}": entry["eda"]["refdes"] for page in ir["pages"] for entry in page["components"]}
    repeated_refdes = {f"{page['id']}:{entry['id']}": entry["eda"]["refdes"] for page in repeated_ir["pages"] for entry in page["components"]}
    assert repeated_refdes == first_refdes, "refdes allocation must be deterministic"
    ldo = next(page for page in ir["pages"] if page["id"] == "pmos_ldo")
    assert {entry["id"] for entry in ldo["components"]} == {"mpass", "rpu", "rload"}, "design view must implicitly exclude unforced V/I sources"
    rpu = next(entry for entry in ldo["components"] if entry["id"] == "rpu")
    mpass = next(entry for entry in ldo["components"] if entry["id"] == "mpass")
    assert rpu["eda"]["device_class"] == "resistor"
    assert mpass["eda"]["subtype"].lower() == "pmos", "PMOS model semantics were not inferred"
    assert rpu["eda"]["refdes"].startswith("R") and mpass["eda"]["refdes"].startswith("M")
    assert {pin_value["id"]: pin_value["side"] for pin_value in mpass["pins"]} == {
        "d": "top", "g": "left", "s": "bottom", "b": "right",
    }, "default MOSFET pin sides must follow terminal roles"
    custom_sides = prepare_component(component(
        "rsense", "R", "1k", 0, 0,
        [pin("a", "n1", "top"), pin("b", "n2", "bottom")],
    ))
    assert [pin_value["side"] for pin_value in custom_sides["pins"]] == ["top", "bottom"], "explicit pin sides must be preserved"
    rpu_records = [record for record in ir["connectivity"]["records"] if record.get("component_id") == "rpu"]
    assert len(rpu["pins"]) == 2 and {record["pin_id"] for record in rpu_records} == {"a", "b"}
    assert all(next(port_value for port_value in ldo["ports"] if port_value["id"] == port_id)["position"] for port_id in ("in", "out"))
    ldo_quality = next(report for report in quality["modules"] if report["module_id"] == "pmos_ldo")
    assert ldo_quality["metrics"]["component_overlaps"] == 0
    assert ldo_quality["metrics"]["wire_through_components"] == 0
    assert ldo_quality["metrics"]["wire_crossings"] == 0
    assert ldo_quality["readability_score"] >= 90

    real_ldo = real_pmos_ldo_layout_module()
    # Keep the Python EDA projection locked to the editor's symbol-pin contract.
    # A coordinate drift here makes a visually connected wire export as a
    # dangling KiCad pin even though the source netlist itself is correct.
    real_by_id = {
        str(entry["id"]): prepare_component(entry)
        for entry in real_ldo["components"]
    }
    expected_pin_positions = {
        ("vin", "p"): {"x": 140.0, "y": 368.0},
        ("rpu", "a"): {"x": 700.0, "y": 128.0},
        ("qerr", "b"): {"x": 262.0, "y": 500.0},
        ("mpass", "d"): {"x": 842.0, "y": 392.0},
        ("mpass", "g"): {"x": 762.0, "y": 340.0},
        ("mpass", "s"): {"x": 842.0, "y": 288.0},
        ("mpass", "b"): {"x": 878.0, "y": 340.0},
    }
    for (component_id, pin_id), expected_position in expected_pin_positions.items():
        source_component = real_by_id[component_id]
        pin_index = next(
            index
            for index, entry in enumerate(source_component["pins"])
            if entry["id"] == pin_id
        )
        assert _pin_position(source_component, source_component["pins"][pin_index], pin_index) == expected_position
        kicad_pin = _kicad_local_pin_position(source_component, source_component["pins"][pin_index], pin_index)
        assert kicad_pin["x"] % 10 == 0 and kicad_pin["y"] % 10 == 0
    real_project = {
        "schema": "actoviq.project.v2",
        "project_id": "pmos-ldo-bench-rev7-layout-regression",
        "name": "PMOS LDO Bench rev7 layout regression",
        "revision": 7,
        "modules": [{"id": "ldo", "name": real_ldo["name"], "source": "modules/ldo/module.circuit.json"}],
        "connections": [],
    }
    real_ir, real_quality = build_eda_ir(
        real_project,
        {"ldo": real_ldo},
        scope="module",
        module_id="ldo",
        view="design",
        document_hash="rev7-layout-regression",
    )
    real_report = real_quality["modules"][0]
    assert real_report["readability_score"] >= 90
    assert all(real_report["metrics"][field] == 0 for field in (
        "missing_connections",
        "component_overlaps",
        "wire_through_components",
        "port_overlaps",
        "wire_crossings",
        "label_overlaps",
        "congestion",
        "flow_feedback_issues",
    ))
    assert real_report["routed_connectivity"]["ok"]
    assert real_report["routed_connectivity"]["source_partition_hash"] == real_report["routed_connectivity"]["routed_partition_hash"]
    assert sum(issue["category"] == "long_wire" for issue in real_report["issues"]) == real_report["metrics"]["long_wires"]
    for issue in (entry for entry in real_report["issues"] if entry["category"] in {"long_wire", "excessive_bends"}):
        assert issue["net_ids"] and issue["bounds"] and issue["fix_category"]
    real_source_snapshot = json.dumps(real_ldo, sort_keys=True)
    real_review = prepare_layout_review(
        real_project,
        {"ldo": real_ldo},
        module_id="ldo",
        view="design",
        document_hash="rev7-layout-regression",
        source_revision=7,
        output_dir=output / "layout-review" / "real-pmos-rev7",
    )
    real_persisted = {**copy.deepcopy(real_ldo), **copy.deepcopy(real_review["module_schematic"])}
    validate_module(real_persisted)
    real_visible_quality = real_review["visible_layout_quality"]
    assert real_visible_quality["readability_score"] >= 90
    assert all(real_visible_quality["metrics"][field] == 0 for field in (
        "missing_connections",
        "component_overlaps",
        "wire_through_components",
        "port_overlaps",
        "wire_crossings",
        "label_overlaps",
        "congestion",
        "flow_feedback_issues",
    )), "the complete user-visible PMOS bench must pass layout hard checks"
    assert real_review["visible_connectivity_hash"] == connectivity_hash(
        real_project,
        {"ldo": real_ldo},
        "ldo",
        "simulation",
    )
    assert real_visible_quality["routed_connectivity"]["source_partition_hash"] == real_visible_quality["routed_connectivity"]["routed_partition_hash"]
    assert {entry["id"] for entry in real_persisted["components"]} == {
        "vin", "vref_src", "rpu", "qerr", "mpass", "rfb1", "rfb2", "cout", "iload",
    }, "layout review must restore every excluded PMOS LDO bench source"
    assert real_persisted["wires"], "complete PMOS LDO source module must be rerouted"
    assert json.dumps(real_ldo, sort_keys=True) == real_source_snapshot, "real PMOS layout preparation must not modify source data"
    real_page = real_ir["pages"][0]
    real_junctions = _same_net_junction_keys(real_page["wires"])
    assert real_junctions, "real PMOS LDO must materialize its T branches as explicit junctions"
    for net_id, x, y in real_junctions:
        matching = [
            endpoint
            for wire in real_page["wires"]
            if wire["net_id"] == net_id
            for endpoint in (wire["from"], wire["to"])
            if (endpoint.get("x"), endpoint.get("y")) == (x, y)
        ]
        assert len(matching) >= 3 and all(endpoint.get("junction_id") for endpoint in matching), "T branches must share one stable junction identity"
        assert len({endpoint["junction_id"] for endpoint in matching}) == 1
    offset_x, offset_y = _kicad_page_offset(real_page)
    assert all(
        point["x"] + offset_x >= 0 and point["y"] + offset_y >= 0
        for wire in real_page["wires"]
        for point in wire["points"]
    ), "KiCad page transform must keep negative IN coordinates inside the sheet"
    kicad_cli = find_kicad_cli()
    if kicad_cli:
        native_root = output / "real-pmos-native-kicad"
        native_map = resolve_symbol_map(None, real_ir["pages"], ["kicad"], SYMBOL_MAP_SCHEMA)
        _write_kicad(native_root, "Real_PMOS_LDO", real_ir, native_map)
        native_status, _, native_files, native_detail = _native_status(
            "kicad", "auto", native_root, "Real_PMOS_LDO", real_ir, native_map
        )
        assert native_status in {"native", "warning"}
        assert native_detail["connectivity_roundtrip"] == "passed"
        erc_path = next(path for path in native_files if path.name == "kicad-erc.json")
        erc_data = json.loads(erc_path.read_text(encoding="utf-8"))
        violation_types = {
            str(violation.get("type", ""))
            for sheet in erc_data.get("sheets", [])
            for violation in sheet.get("violations", [])
        }
        assert "endpoint_off_grid" not in violation_types, "KiCad connection points must remain on the 50 mil grid"
    control = next(page for page in ir["pages"] if page["id"] == "control")
    assert {entry["id"] for entry in control["components"]} == {"controller"}, "design view must exclude testbench components"
    simulation_ir, _ = build_eda_ir(project, modules, scope="project", module_id=None, view="simulation", document_hash=document_hash)
    simulation_ldo = next(page for page in simulation_ir["pages"] if page["id"] == "pmos_ldo")
    assert {"vin_source", "iload"} <= {entry["id"] for entry in simulation_ldo["components"]}, "simulation view must retain ideal sources"

    result = export_eda(
        output, project, modules,
        {"blocking": False, "summary": {"errors": 0}}, document_hash,
        scope="project", module_id=None, targets=["kicad", "altium", "orcad", "virtuoso"],
        view="design", mapping_file="", native_convert="never", strict_layout=False, source_revision=7,
    )
    export_root = Path(result["export_root"])
    manifest = json.loads((export_root / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["source"]["connectivity_hash"] == expected_hash
    for target in ("kicad", "altium", "orcad", "virtuoso"):
        target_connectivity = json.loads((export_root / target / "connectivity.json").read_text(encoding="utf-8"))
        assert target_connectivity["hash"] == expected_hash
        assert manifest["targets"][target]["connectivity_hash"] == expected_hash
        target_status = manifest["targets"][target]
        assert target_status["status"] == "import_ready", "validated packages are import-ready when native conversion is disabled"
        assert target_status["detail"]["structural_status"] in {
            "syntax_validated", "kicad_import_source", "generated_unverified",
        }

    altium_report = validate_altium_import_package(export_root / "altium", export_root / "kicad", ir, json.loads(
        (export_root / "ir" / "symbol-map.resolved.json").read_text(encoding="utf-8")
    ))
    assert altium_report["passed"] and altium_report["kicad_package"]["instances"] == sum(
        len(page["components"]) for page in ir["pages"]
    )
    resolved_map_data = json.loads((export_root / "ir" / "symbol-map.resolved.json").read_text(encoding="utf-8"))
    with patch.dict("os.environ", {"ALTIUM_BIN": ""}):
        assert _native_status("altium", "never", export_root, "EDA_Export_Regression", ir, resolved_map_data)[0] == "import_ready"
        assert _native_status("altium", "auto", export_root, "EDA_Export_Regression", ir, resolved_map_data)[0] == "import_ready"
        assert _native_status("altium", "required", export_root, "EDA_Export_Regression", ir, resolved_map_data)[0] == "failed"
    with patch.dict("os.environ", {"ALTIUM_BIN": "configured-but-no-adapter"}):
        assert _native_status("altium", "auto", export_root, "EDA_Export_Regression", ir, resolved_map_data)[0] == "warning"

    kicad_schematics = sorted((export_root / "kicad").glob("*.kicad_sch"))
    assert all(balanced(path.read_text(encoding="utf-8")) for path in kicad_schematics)
    kicad_text = "\n".join(path.read_text(encoding="utf-8") for path in kicad_schematics)
    standard_symbols = export_root / "kicad" / "Vibe_Analog_Standard.kicad_sym"
    assert standard_symbols.is_file(), "KiCad export must ship the standard project-local symbol library"
    symbol_text = standard_symbols.read_text(encoding="utf-8")
    package_report = validate_kicad_package(export_root / "kicad", ir, json.loads(
        (export_root / "ir" / "symbol-map.resolved.json").read_text(encoding="utf-8")
    ))
    assert package_report["passed"] and package_report["instances"] == sum(
        len(page["components"]) for page in ir["pages"]
    )
    assert "Vibe Analog_Standard:" in kicad_text and "Vibe Analog_Generic:" not in kicad_text
    assert "(junction (at " in kicad_text, "KiCad export must emit explicit T-junction objects"
    assert "PMOS_4PIN" in symbol_text and "(polyline " in symbol_text and ("(arc " in symbol_text or "(circle " in symbol_text), "standard library must contain recognizable device graphics"
    assert '(number "1"' in symbol_text and '(number "2"' in symbol_text
    assert not re.search(r'\((?:number|pin) "(?:a|b)"', kicad_text + "\n" + symbol_text), "source pin IDs must not leak into KiCad target pin numbers"
    for physical in (mpass, rpu, next(entry for entry in ldo["components"] if entry["id"] == "rload")):
        instance = kicad_instance_for_refdes(kicad_text, physical["eda"]["refdes"])
        assert "(on_board yes)" in instance, f"physical component {physical['id']} must be on_board"

    corrupt_package = output / "corrupt-kicad-package"
    if corrupt_package.exists():
        shutil.rmtree(corrupt_package)
    shutil.copytree(export_root / "kicad", corrupt_package)
    corrupt_page = corrupt_package / "EDA_Export_Regression-pmos_ldo.kicad_sch"
    corrupt_text = corrupt_page.read_text(encoding="utf-8").replace(
        '(lib_id "Vibe Analog_Standard:R")', '(lib_id "Vibe Analog_Standard:Missing_R")', 1,
    )
    corrupt_page.write_text(corrupt_text, encoding="utf-8")
    try:
        validate_kicad_package(corrupt_package)
        raise AssertionError("KiCad instance with an unresolved lib_id was accepted")
    except ValueError as error:
        assert "missing embedded symbol" in str(error)

    orcad_text = next((export_root / "orcad").glob("*.edf")).read_text(encoding="utf-8")
    orcad_report = validate_orcad_edif(
        next((export_root / "orcad").glob("*.edf")), ir,
        json.loads((export_root / "ir" / "symbol-map.resolved.json").read_text(encoding="utf-8")),
    )
    assert orcad_report["passed"] and orcad_report["instances"] == sum(len(page["components"]) for page in ir["pages"])
    assert orcad_report["nets"] == sum(len(page["nets"]) for page in ir["pages"])
    assert balanced(orcad_text)
    assert re.search(r"\(design\s", orcad_text, re.IGNORECASE), "OrCAD EDIF must contain a top-level design"
    assert re.search(r"\(figure\s", orcad_text, re.IGNORECASE), "OrCAD EDIF symbols/schematic must include figure graphics"
    assert re.search(r"\(property\s+REFDES\b", orcad_text, re.IGNORECASE)
    assert re.search(r"\(property\s+VALUE\b", orcad_text, re.IGNORECASE)

    virtuoso_map = (export_root / "virtuoso" / "device-map.json").read_text(encoding="utf-8").lower()
    virtuoso_skill = (export_root / "virtuoso" / "create_schematic.il").read_text(encoding="utf-8").lower()
    virtuoso_report = validate_virtuoso_package(
        export_root / "virtuoso", ir,
        json.loads((export_root / "ir" / "symbol-map.resolved.json").read_text(encoding="utf-8")),
    )
    assert virtuoso_report["passed"] and virtuoso_report["top_cell"]
    assert virtuoso_report["mapped_components"] == sum(len(page["components"]) for page in ir["pages"])
    assert "pmos4" in virtuoso_map and "pmos4" in virtuoso_skill, "PMOS instances must map to analogLib/pmos4"
    assert "generic_fallback" in virtuoso_map and "; actoviq_top " in virtuoso_skill
    virtuoso_spice = next((export_root / "virtuoso").glob("*.spice")).read_text(encoding="utf-8")
    block_line = next(line for line in virtuoso_spice.splitlines() if "ERROR_AMP" in line)
    assert block_line.split()[0].upper().startswith("X") and not block_line.upper().startswith("BLOCK"), "BLOCK SPICE instance names must start with X"

    corrupt_orcad = output / "corrupt.edf"
    corrupt_orcad.write_text(re.sub(r"\(portRef\s+[^\s()]+", "(portRef BROKEN_PIN", orcad_text, count=1), encoding="utf-8")
    try:
        validate_orcad_edif(
            corrupt_orcad, ir,
            json.loads((export_root / "ir" / "symbol-map.resolved.json").read_text(encoding="utf-8")),
        )
        raise AssertionError("OrCAD EDIF with a changed pin reference was accepted")
    except ValueError:
        pass

    corrupt_virtuoso = output / "corrupt-virtuoso"
    if corrupt_virtuoso.exists():
        shutil.rmtree(corrupt_virtuoso)
    shutil.copytree(export_root / "virtuoso", corrupt_virtuoso)
    corrupt_spice = next(corrupt_virtuoso.glob("*.spice"))
    spice_text = corrupt_spice.read_text(encoding="utf-8")
    first_instance = next(line for line in spice_text.splitlines() if line and not line.startswith("*") and line.upper() != ".END")
    tokens = first_instance.split()
    tokens[1] = "BROKEN_NET"
    corrupt_spice.write_text(spice_text.replace(first_instance, " ".join(tokens), 1), encoding="utf-8")
    try:
        validate_virtuoso_package(
            corrupt_virtuoso, ir,
            json.loads((export_root / "ir" / "symbol-map.resolved.json").read_text(encoding="utf-8")),
        )
        raise AssertionError("Virtuoso package with a changed SPICE net was accepted")
    except ValueError as error:
        assert "SPICE/CDL" in str(error)

    altium_readme = (export_root / "altium" / "IMPORT_ALTIUM.md").read_text(encoding="utf-8")
    assert "KiCad" in altium_readme and "Import Wizard" in altium_readme and ".kicad_pro" in altium_readme
    for source in (export_root / "kicad").iterdir():
        if source.is_file() and (source.suffix in {".kicad_pro", ".kicad_sch", ".kicad_sym"} or source.name == "sym-lib-table"):
            copied = export_root / "altium" / source.name
            assert copied.is_file() and copied.read_bytes() == source.read_bytes(), f"Altium package must preserve KiCad import source {source.name}"
    assert all((export_root / relative_path).is_file() for relative_path in manifest["files"])

    custom_mapping = output / "custom-symbol-map.json"
    custom_mapping.write_text(json.dumps({
        "schema": SYMBOL_MAP_SCHEMA,
        "targets": {"kicad": {"components": {"pmos_ldo:rpu": {
            "library": "Fixture Lib", "cell": "Mapped Resistor", "view": "symbol",
            "pin_map": {"a": "11", "b": "22"},
        }}}},
    }), encoding="utf-8")
    custom_result = export_eda(
        output / "custom-map-run", project, modules,
        {"blocking": False, "summary": {"errors": 0}}, document_hash,
        scope="module", module_id="pmos_ldo", targets=["kicad"], view="design",
        mapping_file=str(custom_mapping), native_convert="never", strict_layout=False, source_revision=7,
    )
    custom_root = Path(custom_result["export_root"])
    resolved_mapping = (custom_root / "ir" / "symbol-map.resolved.json").read_text(encoding="utf-8")
    custom_kicad = "\n".join(path.read_text(encoding="utf-8") for path in (custom_root / "kicad").glob("*.kicad_sch"))
    assert "Fixture Lib" in resolved_mapping and "Mapped Resistor" in resolved_mapping
    assert 'Fixture Lib:Mapped Resistor' in custom_kicad, "custom KiCad library/cell mapping was not consumed exactly"
    for target_pin in ("11", "22"):
        assert re.search(rf'\((?:pin|number) "{target_pin}"', custom_kicad), f"custom KiCad pin {target_pin} was not consumed"

    conflicting_mapping = output / "conflicting-kicad-cell-map.json"
    conflicting_mapping.write_text(json.dumps({
        "schema": SYMBOL_MAP_SCHEMA,
        "targets": {"kicad": {"components": {
            "pmos_ldo:rpu": {
                "library": "Fixture", "cell": "Shared_R", "view": "symbol",
                "pin_map": {"a": "1", "b": "2"},
            },
            "pmos_ldo:rload": {
                "library": "Fixture", "cell": "Shared_R", "view": "symbol",
                "pin_map": {"a": "2", "b": "1"},
            },
        }}},
    }), encoding="utf-8")
    try:
        export_eda(
            output / "conflicting-map-run", project, modules,
            {"blocking": False, "summary": {"errors": 0}}, document_hash,
            scope="module", module_id="pmos_ldo", targets=["kicad"], view="design",
            mapping_file=str(conflicting_mapping), native_convert="never", strict_layout=False, source_revision=7,
        )
        raise AssertionError("two incompatible pin geometries reused one KiCad cell")
    except ValueError as error:
        assert "conflicting KiCad symbol definitions" in str(error)

    custom_parent = output / "custom-output-parent"
    custom_parent.mkdir(parents=True, exist_ok=True)
    output_dir_result = export_eda(
        output / "default-root-ignored", project, modules,
        {"blocking": False, "summary": {"errors": 0}}, document_hash,
        scope="module", module_id="pmos_ldo", targets=["kicad"], view="design",
        mapping_file="", native_convert="never", strict_layout=False, source_revision=7,
        output_dir=str(custom_parent),
    )
    output_dir_root = Path(output_dir_result["export_root"])
    assert output_dir_root.parent == custom_parent.resolve(), "optional output_dir must become the export parent"
    assert output_dir_root.name == output_dir_result["export_id"]
    assert (output_dir_root / "manifest.json").is_file()
    assert "kicad" in output_dir_result["targets"]
    assert output_dir_result["targets"]["kicad"]["status"] == "import_ready"
    assert output_dir_result["targets"]["kicad"]["detail"]["structural_status"] == "syntax_validated"

    validate_layout_patch({"schema": PATCH_SCHEMA, "operations": [
        {"op": "move_component", "component_id": "rpu", "dx_grid": 1, "dy_grid": -2},
        {"op": "rotate_component", "component_id": "rpu", "rotation": 90},
        {"op": "move_port", "port_id": "in", "dx_grid": -1, "dy_grid": 0},
    ]}, {"rpu"}, {"in"})
    try:
        validate_layout_patch({"schema": PATCH_SCHEMA, "operations": [{"op": "delete_component", "component_id": "rpu"}]}, {"rpu"}, {"in"})
        raise AssertionError("electrical layout patch mutation was accepted")
    except ValueError:
        pass
    for invalid_patch in (
        {"schema": PATCH_SCHEMA, "operations": [
            {"op": "move_component", "component_id": "rpu", "dx_grid": 4, "dy_grid": 0},
            {"op": "move_component", "component_id": "rpu", "dx_grid": 4, "dy_grid": 0},
        ]},
        {"schema": PATCH_SCHEMA, "operations": [
            {"op": "rotate_component", "component_id": "rpu", "rotation": 90},
            {"op": "rotate_component", "component_id": "rpu", "rotation": 180},
        ]},
    ):
        try:
            validate_layout_patch(invalid_patch, {"rpu"}, {"in"})
            raise AssertionError("cumulative or conflicting layout operations were accepted")
        except ValueError:
            pass

    source_snapshot = json.dumps({"project": project, "modules": modules}, sort_keys=True)
    review = prepare_layout_review(
        project,
        modules,
        module_id="pmos_ldo",
        view="design",
        document_hash=document_hash,
        source_revision=7,
        output_dir=output / "layout-review" / "prepare",
    )
    assert all(Path(review[field]).is_file() for field in ("state_path", "svg_path", "layout_quality_report_path"))
    assert review["changed"] == review["improved"], "equal-score deterministic routing must not overwrite a manual layout"
    assert {entry["id"] for entry in review["module_schematic"]["components"]} == {entry["id"] for entry in modules["pmos_ldo"]["components"]}, "design review must retain excluded bench components"
    persisted = {**copy.deepcopy(modules["pmos_ldo"]), **copy.deepcopy(review["module_schematic"])}
    validate_module(persisted)
    assert all(
        wire.get("source") in {"stored", "net"}
        for wire in persisted["wires"]
    ), "layout write-back must use only schema-approved wire source values"
    assert json.dumps({"project": project, "modules": modules}, sort_keys=True) == source_snapshot, "layout preparation must not modify source data"

    empty_patch_set = {
        "schema": PATCH_SET_SCHEMA,
        "source_revision": 7,
        "connectivity_hash": review["connectivity_hash"],
        "candidates": [{"schema": PATCH_SCHEMA, "operations": []}],
    }
    state = json.loads(Path(review["state_path"]).read_text(encoding="utf-8"))
    evaluated = evaluate_layout_patches(
        project,
        modules,
        state,
        empty_patch_set,
        module_id="pmos_ldo",
        document_hash=document_hash,
        source_revision=7,
        output_dir=output / "layout-review" / "round-1",
        view="design",
    )
    assert not evaluated["improved"] and evaluated["lexicographic_cost"] == evaluated["before_lexicographic_cost"]
    assert evaluated["changed"] == review["changed"], "an equal-score LLM patch must not create a new source write"
    assert evaluated["candidate_results"] == [{
        "index": 0,
        "accepted": True,
        "improved": False,
        "lexicographic_cost": evaluated["lexicographic_cost"],
        "readability_score": evaluated["readability_score"],
    }]

    validate_layout_patch_set(
        empty_patch_set,
        expected_revision=7,
        expected_connectivity_hash=review["connectivity_hash"],
        component_ids={entry["id"] for entry in state["candidate"]["components"]},
        port_ids={entry["id"] for entry in modules["pmos_ldo"]["ports"]},
        component_defs=state["candidate"]["components"],
    )
    invalid_patch_sets = [
        {**empty_patch_set, "source_revision": 6},
        {**empty_patch_set, "connectivity_hash": "0" * 64},
        {**empty_patch_set, "unknown": True},
        {**empty_patch_set, "candidates": empty_patch_set["candidates"] * 5},
    ]
    for invalid_patch_set in invalid_patch_sets:
        try:
            validate_layout_patch_set(
                invalid_patch_set,
                expected_revision=7,
                expected_connectivity_hash=review["connectivity_hash"],
                component_ids={entry["id"] for entry in state["candidate"]["components"]},
                port_ids={entry["id"] for entry in modules["pmos_ldo"]["ports"]},
                component_defs=state["candidate"]["components"],
            )
            raise AssertionError("invalid layout patch-set source/schema was accepted")
        except ValueError:
            pass
    promoted_port_patch = {
        **empty_patch_set,
        "candidates": [{"schema": PATCH_SCHEMA, "operations": [{"op": "move_port", "port_id": "export_0", "dx_grid": 1, "dy_grid": 0}]}],
    }
    try:
        evaluate_layout_patches(
            project,
            modules,
            state,
            promoted_port_patch,
            module_id="pmos_ldo",
            document_hash=document_hash,
            source_revision=7,
            output_dir=output / "layout-review" / "invalid-port",
            view="design",
        )
        raise AssertionError("non-persistable projected port was accepted by layout patch evaluation")
    except ValueError as error:
        assert "move_port" in str(error)

    bad_mapping = output / "bad-symbol-map.json"
    bad_mapping.write_text(json.dumps({"schema": SYMBOL_MAP_SCHEMA, "targets": {"kicad": {"components": {"rpu": {"pin_map": {"a": "1"}}}}}}), encoding="utf-8")
    try:
        export_eda(output, project, modules, {"blocking": False, "summary": {"errors": 0}}, document_hash, scope="module", module_id="pmos_ldo", targets=["kicad"], view="design", mapping_file=str(bad_mapping), native_convert="never", strict_layout=False, source_revision=7)
        raise AssertionError("incomplete pin mapping was accepted")
    except ValueError as error:
        assert "pin map" in str(error)
    for revision, erc, message in ((6, {"blocking": False}, "stale source revision"), (7, {"blocking": True, "summary": {"errors": 1}}, "blocking ERC")):
        try:
            export_eda(output, project, modules, erc, document_hash, scope="project", module_id=None, targets=["kicad"], view="design", mapping_file="", native_convert="never", strict_layout=False, source_revision=revision)
            raise AssertionError(f"{message} was accepted")
        except ValueError as error:
            assert message.split()[0] in str(error)
    print(json.dumps({"ok": True, "export_root": str(export_root), "connectivity_hash": expected_hash, "ldo_readability": ldo_quality["readability_score"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
