#!/usr/bin/env python3
"""Regression: KiCad net-label export for board-level (pcb_schematic) modules.

Covers three guarantees that the compact-cell autorouter cannot provide:

* modules with multi-pin X devices and high-fanout power nets export through
  per-pin stub wires plus same-named local net labels instead of failing;
* the exported connectivity partition still matches the source module
  (structural package validation always, vendor XML round-trip when
  kicad-cli is installed);
* components carrying ``eda.symbol``/``eda.footprint`` embed the real bundled
  KiCad symbol (with ``extends`` inheritance resolved) and write the
  Footprint property, while plain components keep the generated symbols.

Run: python scripts/eda-export-labels-regression.py
"""

from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "skills" / "circuit-design-ngspice" / "scripts"))

from eda_export import (  # noqa: E402
    SYMBOL_MAP_SCHEMA,
    _bounds_overlap,
    _label_effective_bounds,
    _label_route_module,
    _write_kicad,
    build_eda_ir,
    export_eda,
    verify_routed_connectivity,
)
from eda_kicad_validate import find_kicad_cli, validate_kicad_package  # noqa: E402
from eda_symbols import prepare_component, resolve_symbol_map  # noqa: E402
from kicad_lib_embed import symbol_definition_lines  # noqa: E402

OUTPUT = REPO / "output" / "eda-export-labels-regression"
DOCUMENT_HASH = "b" * 64


def pin(pin_id: str, net: str, side: str | None = None) -> dict:
    value = {"id": pin_id, "name": pin_id.upper(), "net": net}
    if side:
        value["side"] = side
    return value


def component(component_id: str, kind: str, value: str, x: int, y: int, pins: list[dict], **extra: object) -> dict:
    return {
        "id": component_id,
        "type": kind,
        "name": component_id.upper(),
        "value": value,
        "position": {"x": x, "y": y},
        "rotation": 0,
        "pins": pins,
        **extra,
    }


def board_module() -> dict:
    mcu_pins: list[dict] = []
    net_by_pin = {
        "1": "vdd_3v3", "9": "vdd_3v3", "24": "vdd_3v3", "36": "vdd_3v3", "48": "vdd_3v3",
        "8": "gnd", "23": "gnd", "35": "gnd", "47": "gnd",
        "2": "led_user", "5": "osc_in", "6": "osc_out", "7": "nrst", "44": "boot0",
    }
    for number in range(1, 49):
        # BLOCK pins use the package pin number as id; for eda.symbol
        # components that id maps 1:1 onto the library symbol pin number.
        mcu_pins.append(pin(str(number), net_by_pin.get(str(number), f"nc_p{number}")))
    components = [
        component(
            "xu1", "BLOCK", "STM32F103C8Tx", 0, 0, mcu_pins,
            block={"width": 160, "height": 520},
            eda={
                "symbol": "MCU_ST_STM32F1:STM32F103C8Tx",
                "footprint": "Package_QFP:LQFP-48_7x7mm_P0.5mm",
            },
        ),
        component(
            "xj1", "X", "USB_MicroB_Receptacle", -400, -300,
            [pin("p1", "usb_5v"), pin("p2", "usb_dm"), pin("p3", "usb_dp"), pin("p4", "nc_usb_id"), pin("p5", "gnd")],
        ),
        component("c1", "C", "100n", -260, 460, [pin("a", "vdd_3v3"), pin("b", "gnd")]),
        component("c2", "C", "100n", -100, 460, [pin("a", "vdd_3v3"), pin("b", "gnd")]),
        component("c3", "C", "100n", 60, 460, [pin("a", "vdd_3v3"), pin("b", "gnd")]),
        component("c4", "C", "10u", 220, 460, [pin("a", "vdd_3v3"), pin("b", "gnd")]),
        component("r1", "R", "1k", 320, -160, [pin("a", "led_user"), pin("b", "led_user_k")]),
        component("d1", "D", "LED", 480, -160, [pin("a", "led_user_k"), pin("k", "gnd")]),
        component("r2", "R", "10k", 320, 160, [pin("a", "boot0"), pin("b", "gnd")]),
        component("x1", "X", "Crystal_8MHz", -420, 160, [pin("p1", "osc_in"), pin("p2", "osc_out")]),
        component("c5", "C", "18p", -580, 260, [pin("a", "osc_in"), pin("b", "gnd")]),
        component("c6", "C", "18p", -560, 300, [pin("a", "osc_out"), pin("b", "gnd")]),
    ]
    ports = [
        {"id": "gnd", "name": "GND", "direction": "bidirectional", "signal_type": "ground", "net": "gnd"},
        {"id": "vdd_3v3", "name": "VDD_3V3", "direction": "bidirectional", "signal_type": "power", "net": "vdd_3v3"},
        {"id": "usb_5v", "name": "USB_5V", "direction": "input", "signal_type": "power", "net": "usb_5v"},
    ]
    return {
        "schema": "actoviq.module.v2",
        "module_id": "mcu_board",
        "name": "MCU Board",
        "revision": 3,
        "ports": ports,
        "components": components,
        "nets": [],
        "wires": [],
        "annotations": [],
    }


def breakout_module() -> dict:
    return {
        "schema": "actoviq.module.v2",
        "module_id": "breakout",
        "name": "Breakout",
        "revision": 3,
        "ports": [
            {"id": "gnd", "name": "GND", "direction": "bidirectional", "signal_type": "ground", "net": "gnd"},
            {"id": "vdd_3v3", "name": "VDD_3V3", "direction": "bidirectional", "signal_type": "power", "net": "vdd_3v3"},
        ],
        "components": [component("j1", "X", "Hdr_1x02", 0, 0, [pin("p1", "vdd_3v3"), pin("p2", "gnd")])],
        "nets": [],
        "wires": [],
        "annotations": [],
    }


def project_fixture() -> tuple[dict, dict[str, dict]]:
    modules = {"mcu_board": board_module(), "breakout": breakout_module()}
    project = {
        "schema": "actoviq.project.v2",
        "project_id": "eda-labels-regression",
        "name": "EDA Labels Regression",
        "project_kind": "pcb_schematic",
        "revision": 3,
        "modules": [
            {
                "id": "mcu_board",
                "name": "MCU Board",
                "kind": "circuit",
                "source": "modules/mcu_board/module.circuit.json",
                "position": {"x": 0, "y": 0},
                "size": {"width": 900, "height": 700},
                "ports": modules["mcu_board"]["ports"],
            },
            {
                "id": "breakout",
                "name": "Breakout",
                "kind": "circuit",
                "source": "modules/breakout/module.circuit.json",
                "position": {"x": 1000, "y": 0},
                "size": {"width": 300, "height": 200},
                "ports": modules["breakout"]["ports"],
            },
        ],
        "connections": [
            {"id": "pwr", "from": {"module_id": "mcu_board", "port_id": "vdd_3v3"}, "to": {"module_id": "breakout", "port_id": "vdd_3v3"}, "network": "VDD_3V3"},
            {"id": "gnd", "from": {"module_id": "mcu_board", "port_id": "gnd"}, "to": {"module_id": "breakout", "port_id": "gnd"}, "network": "GND"},
        ],
    }
    return project, modules


def run_export(output: Path, project: dict, modules: dict, *, scope: str = "module") -> dict:
    return export_eda(
        output,
        project,
        modules,
        {"blocking": False, "summary": {"errors": 0}},
        DOCUMENT_HASH,
        scope=scope,
        module_id="mcu_board" if scope == "module" else None,
        targets=["kicad"],
        view="design",
        mapping_file="",
        native_convert="auto",
        strict_layout=False,
        source_revision=3,
    )


def text_block_collisions(schematic: str) -> list[tuple[str, str, str, str]]:
    """Conservative Reference/Value text-block intersection check.

    Blocks assume ref ~6 chars / value ~8 chars at 1.27 mm width and 1.9 mm
    height, expanded by the same justify rules the writer emits.  Only blocks
    of different components count.
    """

    blocks: list[tuple[str, str, float, float, float, float]] = []
    for match in re.finditer(r"  \(symbol \(lib_id ", schematic):
        start = match.start()
        depth = 0
        end = start
        for index, character in enumerate(schematic[start:], start):
            if character == "(":
                depth += 1
            elif character == ")":
                depth -= 1
                if depth == 0:
                    end = index + 1
                    break
        block = schematic[start:end]
        owner = re.search(r'\(property "Reference" "([^"]*)"', block)
        for prop in ("Reference", "Value"):
            prop_match = re.search(
                r'\(property "%s" "([^"]*)" \(at ([-\d.]+) ([-\d.]+)[^)]*\) \(effects([^)]*(?:\)[^)]*)?)\)' % prop,
                block,
            )
            if not prop_match:
                continue
            text = prop_match.group(1)
            x, y = float(prop_match.group(2)), float(prop_match.group(3))
            effects = prop_match.group(4)
            justify = "left" if "justify left" in effects else "right" if "justify right" in effects else None
            width = max(6 if prop == "Reference" else 8, len(text)) * 1.27
            height = 1.9
            if justify == "left":
                span = (x, x + width)
            elif justify == "right":
                span = (x - width, x)
            else:
                span = (x - width / 2, x + width / 2)
            blocks.append((owner.group(1) if owner else "?", prop, span[0], y - height / 2, span[1], y + height / 2))
    collisions = []
    for index, left in enumerate(blocks):
        for right in blocks[index + 1:]:
            if left[0] == right[0]:
                continue
            if left[2] < right[4] and left[4] > right[2] and left[3] < right[5] and left[5] > right[3]:
                collisions.append((left[0], left[1], right[0], right[1]))
    return collisions


def assert_no_text_collisions(export_root: Path, context: str) -> None:
    for schematic in sorted((export_root / "kicad").glob("*.kicad_sch")):
        collisions = text_block_collisions(schematic.read_text(encoding="utf-8"))
        assert not collisions, f"{context}: property text blocks collide in {schematic.name}: {collisions[:5]}"


def assert_stacked_passives_text(output: Path) -> None:
    """Vertically stacked library passives must not collide property texts.

    Reproduces the C12/C13-style crowding from the STM32 power_supply sheet:
    same-orientation real-symbol passives one grid row apart, plus a wide
    value text on an adjacent IC that used to overlap a neighbour's Reference.
    """

    module = {
        "schema": "actoviq.module.v2",
        "module_id": "passives",
        "name": "Passives",
        "revision": 1,
        "ports": [
            {"id": "gnd", "name": "GND", "direction": "bidirectional", "signal_type": "ground", "net": "gnd"},
            {"id": "vin", "name": "VIN", "direction": "input", "signal_type": "power", "net": "vin"},
        ],
        "components": [
            component("c1", "C", "10u", 0, 0, [pin("a", "vin"), pin("b", "gnd")],
                      eda={"symbol": "Device:C", "footprint": "Capacitor_SMD:C_0603_1608Metric"}),
            component("c2", "C", "100n", 0, 140, [pin("a", "vin"), pin("b", "gnd")],
                      eda={"symbol": "Device:C", "footprint": "Capacitor_SMD:C_0603_1608Metric"}),
            component("r1", "R", "1k", 140, 0, [pin("a", "vin"), pin("b", "gnd")],
                      eda={"symbol": "Device:R", "footprint": "Resistor_SMD:R_0603_1608Metric"}),
            component("r2", "R", "10k", 140, 140, [pin("a", "vin"), pin("b", "gnd")],
                      eda={"symbol": "Device:R", "footprint": "Resistor_SMD:R_0603_1608Metric"}),
            component(
                "u1", "BLOCK", "AMS1117-3.3", 320, 60,
                [pin("1", "gnd"), pin("2", "vout"), pin("3", "vin")],
                block={"width": 120, "height": 80},
                eda={"symbol": "Regulator_Linear:AMS1117-3.3", "footprint": "Package_TO_SOT_SMD:SOT-223"},
            ),
            component("c3", "C", "10u", 480, 60, [pin("a", "vout"), pin("b", "gnd")],
                      eda={"symbol": "Device:C", "footprint": "Capacitor_SMD:C_0603_1608Metric"}),
        ],
        "nets": [],
        "wires": [],
        "annotations": [],
    }
    project = {
        "schema": "actoviq.project.v2",
        "project_id": "eda-labels-passives",
        "name": "EDA Labels Passives",
        "project_kind": "pcb_schematic",
        "revision": 1,
        "modules": [
            {
                "id": "passives",
                "name": "Passives",
                "kind": "circuit",
                "source": "modules/passives/module.circuit.json",
                "position": {"x": 0, "y": 0},
                "size": {"width": 600, "height": 300},
                "ports": module["ports"],
            }
        ],
        "connections": [],
    }
    result = export_eda(
        output,
        project,
        {"passives": module},
        {"blocking": False, "summary": {"errors": 0}},
        DOCUMENT_HASH,
        scope="module",
        module_id="passives",
        targets=["kicad"],
        view="design",
        mapping_file="",
        native_convert="auto",
        strict_layout=False,
        source_revision=1,
    )
    assert result["ok"], f"stacked-passives export failed: {result}"
    export_root = Path(result["export_root"])
    assert_no_text_collisions(export_root, "stacked passives")
    if find_kicad_cli():
        detail = result["manifest"]["targets"]["kicad"]["detail"]
        assert detail.get("connectivity_roundtrip") == "passed"


def assert_stub_direction_probe() -> None:
    """A pin corridor of foreign stubs must not trap a victim pin's stub.

    Reproduces the STM32 rev-13 failure where a library-symbol capacitor pin
    below a column of MCU nc-pin stubs could not escape in its natural
    (vertical) direction at any length and the export died.  The label router
    must probe perpendicular (then opposite) directions deterministically.
    """

    big_pins = [pin(f"p{index}", f"nc{index}", "left") for index in range(8)]
    module = {
        "schema": "actoviq.module.v2",
        "module_id": "corridor",
        "name": "Corridor",
        "ports": [],
        "components": [
            component("big", "BLOCK", "BIG", 0, 0, big_pins, block={"width": 120, "height": 200}),
            component(
                "victim", "BLOCK", "V", -80, -120,
                [pin("1", "sig_a", "bottom"), pin("2", "sig_b", "top")],
                block={"width": 120, "height": 80},
            ),
        ],
        "nets": [],
        "wires": [],
        "annotations": [],
    }
    components = [prepare_component(entry) for entry in module["components"]]
    nets, wires, _ = _label_route_module(module, components)
    report = verify_routed_connectivity(nets, wires)
    assert report["ok"], f"corridor stubs must verify cleanly: {report['errors'][:3]}"
    victim_stub = next(
        wire for wire in wires
        if wire["from"].get("component_id") == "victim" and wire["from"].get("pin_id") == "1"
    )
    start, end = victim_stub["points"]
    assert float(start["y"]) == float(end["y"]), (
        "the trapped pin must escape sideways around the foreign stub corridor"
    )


def assert_project_scope_export(output: Path, project: dict, modules: dict) -> None:
    """Hierarchical project export: root sheet pins must connect via stub wires."""

    result = run_export(output, project, modules, scope="project")
    assert result["ok"], f"project-scope export failed: {result}"
    export_root = Path(result["export_root"])
    kicad_dir = export_root / "kicad"
    root_schematic = kicad_dir / "EDA_Labels_Regression.kicad_sch"
    assert root_schematic.is_file(), "hierarchical root schematic missing"
    root_text = root_schematic.read_text(encoding="utf-8")
    assert "(wire (pts " in root_text, "root sheet pins must be bridged to their labels with wires"
    left_edge_pins = re.findall(r'\(pin "([A-Z0-9_]+)" \w+ \(at [\d.]+ [\d.]+ (\d+)\)', root_text)
    assert left_edge_pins and all(angle == "180" for _, angle in left_edge_pins), (
        f"left-edge sheet pins must face 180 to expose a live tip: {left_edge_pins[:4]}"
    )
    ir = json.loads((export_root / "ir" / "project.eda.json").read_text(encoding="utf-8"))
    symbol_map = json.loads((export_root / "ir" / "symbol-map.resolved.json").read_text(encoding="utf-8"))
    report = validate_kicad_package(kicad_dir, ir, symbol_map)
    assert report["passed"]
    assert_no_text_collisions(export_root, "project scope")
    if find_kicad_cli():
        detail = result["manifest"]["targets"]["kicad"]["detail"]
        assert detail.get("connectivity_roundtrip") == "passed", (
            "project-scope vendor netlist must match cross-module connectivity"
        )
        erc = json.loads((export_root / "reports" / "kicad-erc.json").read_text(encoding="utf-8"))
        tolerable = {"pin_not_driven", "power_pin_not_driven"}
        errors = [
            violation.get("type")
            for sheet in erc.get("sheets", [])
            for violation in sheet.get("violations", [])
            if violation.get("severity") == "error" and violation.get("type") not in tolerable
        ]
        assert not errors, f"hierarchical export must not produce ERC errors: {errors}"


def assert_stacked_components_relocated(output: Path) -> None:
    """Stacked library-symbol components must fall through to a lane candidate.

    Reproduces the STM32 rev-14 failure: auto-grid placement put a crystal
    and an LED at the same position, so their real library-symbol pins
    coincided and no straight label stub could leave the point without a
    foreign-net contact.  The label flow must try the deterministic layout
    candidates in order until one separates the components.
    """

    module = {
        "schema": "actoviq.module.v2",
        "module_id": "stacked",
        "name": "Stacked",
        "revision": 1,
        "ports": [
            {"id": "gnd", "name": "GND", "direction": "bidirectional", "signal_type": "ground", "net": "gnd"},
        ],
        "components": [
            component(
                "r1", "BLOCK", "1k", 0, 0, [pin("1", "sig_a"), pin("2", "gnd")],
                block={"width": 80, "height": 120},
                eda={"symbol": "Device:R", "footprint": "Resistor_SMD:R_0603_1608Metric"},
            ),
            component(
                "r2", "BLOCK", "1k", 0, 0, [pin("1", "sig_b"), pin("2", "gnd")],
                block={"width": 80, "height": 120},
                eda={"symbol": "Device:R", "footprint": "Resistor_SMD:R_0603_1608Metric"},
            ),
        ],
        "nets": [],
        "wires": [],
        "annotations": [],
    }
    project = {
        "schema": "actoviq.project.v2",
        "project_id": "eda-labels-stacked",
        "name": "EDA Labels Stacked",
        "project_kind": "pcb_schematic",
        "revision": 1,
        "modules": [
            {
                "id": "stacked",
                "name": "Stacked",
                "kind": "circuit",
                "source": "modules/stacked/module.circuit.json",
                "position": {"x": 0, "y": 0},
                "size": {"width": 400, "height": 300},
                "ports": module["ports"],
            }
        ],
        "connections": [],
    }
    result = export_eda(
        output,
        project,
        {"stacked": module},
        {"blocking": False, "summary": {"errors": 0}},
        DOCUMENT_HASH,
        scope="module",
        module_id="stacked",
        targets=["kicad"],
        view="design",
        mapping_file="",
        native_convert="auto",
        strict_layout=False,
        source_revision=1,
    )
    assert result["ok"], f"stacked-component export failed: {result}"
    export_root = Path(result["export_root"])
    ir = json.loads((export_root / "ir" / "project.eda.json").read_text(encoding="utf-8"))
    page = ir["pages"][0]
    positions = {
        str(entry["id"]): (float(entry["position"]["x"]), float(entry["position"]["y"]))
        for entry in page["components"]
    }
    assert positions["r1"] != positions["r2"], (
        f"stacked components must be separated: {positions}"
    )
    assert (0.0, 0.0) in {positions["r1"], positions["r2"]}, (
        f"the non-colliding component must keep its source slot (minimal perturbation): {positions}"
    )
    assert all(net.get("connection") == "label" for net in page["nets"])
    if find_kicad_cli():
        detail = result["manifest"]["targets"]["kicad"]["detail"]
        assert detail.get("connectivity_roundtrip") == "passed", (
            "relocated label stubs must still reproduce the source partition"
        )


def assert_label_mode_export(export_root: Path, result: dict) -> None:
    kicad_dir = export_root / "kicad"
    schematics = sorted(kicad_dir.glob("*.kicad_sch"))
    assert len(schematics) == 1, f"expected one schematic, found {schematics}"
    schematic = schematics[0].read_text(encoding="utf-8")

    # Net-label mode: every module pin endpoint carries a local net label.
    ir = json.loads((export_root / "ir" / "project.eda.json").read_text(encoding="utf-8"))
    page = ir["pages"][0]
    pin_endpoints = [
        (net, endpoint)
        for net in page["nets"]
        for endpoint in net["endpoints"]
        if endpoint.get("kind") == "pin"
    ]
    assert pin_endpoints and all(net.get("connection") == "label" for net in page["nets"]), (
        "board-level module must fall into net-label connection mode"
    )
    # Layout quality: a label-mode page must stay compact and overlap-free,
    # using placement bounds that include real library symbol extents.
    component_bounds = {
        str(entry["id"]): _label_effective_bounds(entry) for entry in page["components"]
    }
    bound_ids = sorted(component_bounds)
    collisions = [
        (left, right)
        for index, left in enumerate(bound_ids)
        for right in bound_ids[index + 1:]
        if _bounds_overlap(component_bounds[left], component_bounds[right])
    ]
    assert not collisions, f"exported page must not overlap components: {collisions}"
    span_x = max(bounds["max_x"] for bounds in component_bounds.values()) - min(
        bounds["min_x"] for bounds in component_bounds.values()
    )
    span_y = max(bounds["max_y"] for bounds in component_bounds.values()) - min(
        bounds["min_y"] for bounds in component_bounds.values()
    )
    aspect = span_x / span_y if span_y else 1.0
    assert 0.5 <= aspect <= 3.0, f"exported page bounding box must stay near-landscape, got {aspect:.2f}"
    local_labels = re.findall(r'^\s{2}\(label "([^"]+)"', schematic, re.MULTILINE)
    assert len(local_labels) == len(pin_endpoints), (
        f"expected one local label per pin endpoint ({len(pin_endpoints)}), found {len(local_labels)}"
    )
    for net_name in ("GND", "VDD_3V3", "USB_5V"):
        assert f'(global_label "{net_name}"' in schematic, f"port global label {net_name} missing"
    gnd_pin_count = sum(
        1 for net in page["nets"] if net["name"] == "gnd" for endpoint in net["endpoints"] if endpoint.get("kind") == "pin"
    )
    assert gnd_pin_count > 6 and local_labels.count("GND") == gnd_pin_count, (
        "every gnd pin must carry a GND local label named after its port"
    )

    # Real library symbol embedding for the eda.symbol MCU.
    assert '(symbol "MCU_ST_STM32F1:STM32F103C8Tx"' in schematic, "embedded MCU symbol missing from lib_symbols"
    assert '(lib_id "MCU_ST_STM32F1:STM32F103C8Tx")' in schematic, "MCU instance lib_id must reference the real symbol"
    assert '(property "Footprint" "Package_QFP:LQFP-48_7x7mm_P0.5mm"' in schematic, "MCU Footprint property missing"
    mcu_pins_in_instance = re.search(
        r'\(symbol \(lib_id "MCU_ST_STM32F1:STM32F103C8Tx".*?\n  \)', schematic, re.DOTALL
    )
    assert mcu_pins_in_instance, "MCU instance block not found"
    instance_pin_numbers = re.findall(r'\(pin "(\d+)" \(uuid', mcu_pins_in_instance.group(0))
    assert len(instance_pin_numbers) == 48 and len(set(instance_pin_numbers)) == 48, (
        "MCU instance must map all 48 symbol pins by pin number"
    )

    library_file = kicad_dir / "MCU_ST_STM32F1.kicad_sym"
    assert library_file.is_file(), "project-local MCU library file missing"
    library_text = library_file.read_text(encoding="utf-8")
    assert re.search(r'\(symbol "?STM32F103C8Tx"?$', library_text, re.MULTILINE), "project-local library must keep the bare cell name"
    table = (kicad_dir / "sym-lib-table").read_text(encoding="utf-8")
    assert '(name "MCU_ST_STM32F1")' in table and "${KIPRJMOD}/MCU_ST_STM32F1.kicad_sym" in table

    # Generic components keep the generated portable symbols.
    standard_library = (kicad_dir / "Vibe_Analog_Standard.kicad_sym").read_text(encoding="utf-8")
    assert '(symbol "R"' in standard_library or '(symbol R' in standard_library
    connector_cells = re.findall(r'\(symbol "?([^"\s]+)"?', standard_library)
    assert any(cell.startswith("Block_5Pin") for cell in connector_cells), (
        "5-pin X connector must keep a generated multi-pin block symbol"
    )
    # The generated 5-pin connector symbol must expose five distinct pin
    # anchors (the degenerate all-pins-on-one-point geometry is gone).
    block_start = standard_library.find('(symbol "Block_5Pin')
    block_end = standard_library.find('\n  (symbol "', block_start + 1)
    block_text = standard_library[block_start:block_end if block_end > 0 else len(standard_library)]
    pin_ats = re.findall(r"\(pin \w+ line \(at ([-\d.]+) ([-\d.]+)", block_text)
    assert len(pin_ats) == 5 and len(set(pin_ats)) == 5, f"connector pins collapsed: {pin_ats}"

    # Structural validation of the portable package.
    symbol_map = json.loads((export_root / "ir" / "symbol-map.resolved.json").read_text(encoding="utf-8"))
    report = validate_kicad_package(kicad_dir, ir, symbol_map)
    assert report["passed"] and report["instances"] == len(page["components"])

    detail = result["manifest"]["targets"]["kicad"]["detail"]
    assert detail["structural_status"] == "syntax_validated"
    if find_kicad_cli():
        assert detail.get("connectivity_roundtrip") == "passed", (
            "vendor netlist partition must match the source module when kicad-cli is available"
        )
        roundtrip = json.loads((export_root / "reports" / "kicad-connectivity-roundtrip.json").read_text(encoding="utf-8"))
        assert roundtrip["passed"] and not roundtrip["missing_endpoints"] and not roundtrip["unexpected_endpoints"]
        erc = json.loads((export_root / "reports" / "kicad-erc.json").read_text(encoding="utf-8"))
        # pin_not_driven / power_pin_not_driven are properties of the board
        # design itself (power arrives from off-sheet ports); they are not
        # export defects.  Geometry/connectivity ERC errors must not occur.
        tolerable = {"pin_not_driven", "power_pin_not_driven"}
        errors = [
            violation
            for sheet in erc.get("sheets", [])
            for violation in sheet.get("violations", [])
            if violation.get("severity") == "error" and violation.get("type") not in tolerable
        ]
        assert not errors, f"vendor ERC must not report export geometry errors: {errors}"


def assert_symbol_extraction() -> None:
    embedded = symbol_definition_lines("MCU_ST_STM32F1", "STM32F103C8Tx", name="MCU_ST_STM32F1:STM32F103C8Tx")
    embedded_text = "\n".join(embedded)
    assert embedded[0].strip() == '(symbol "MCU_ST_STM32F1:STM32F103C8Tx"'
    assert "(extends" not in embedded_text, "extends inheritance must be flattened"
    assert '(symbol "STM32F103C8Tx_0_1"' in embedded_text or "(symbol STM32F103C8Tx_0_1" in embedded_text
    assert '(symbol "STM32F103C8Tx_1_1"' in embedded_text or "(symbol STM32F103C8Tx_1_1" in embedded_text
    assert len(re.findall(r"^\s+\(pin\b", embedded_text, re.MULTILINE)) >= 48
    assert "Package_QFP:LQFP-48_7x7mm_P0.5mm" in embedded_text
    bare = "\n".join(symbol_definition_lines("MCU_ST_STM32F1", "STM32F103C8Tx", indent=""))
    assert bare.splitlines()[0].strip().strip('"').endswith("STM32F103C8Tx")


def main() -> int:
    assert_symbol_extraction()
    assert_stub_direction_probe()
    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)
    OUTPUT.mkdir(parents=True)
    project, modules = project_fixture()

    first = run_export(OUTPUT / "first", project, modules)
    first_root = Path(first["export_root"])
    assert first["ok"], f"export failed: {first}"
    assert_label_mode_export(first_root, first)
    assert_no_text_collisions(first_root, "mcu fixture")

    # Determinism: identical inputs must reproduce identical schematics.
    second = run_export(OUTPUT / "second", project, modules)
    second_root = Path(second["export_root"])
    first_sch = next((first_root / "kicad").glob("*.kicad_sch")).read_bytes()
    second_sch = next((second_root / "kicad").glob("*.kicad_sch")).read_bytes()
    assert first_sch == second_sch, "label-mode export must be deterministic"

    # The plain in-memory path (no export wrapper) agrees on the IR.
    ir, _ = build_eda_ir(project, modules, scope="module", module_id="mcu_board", view="design", document_hash=DOCUMENT_HASH)
    assert all(
        net.get("connection") == "label" for net in ir["pages"][0]["nets"]
    ), "high-fanout board module must select net-label routing deterministically"

    # Hierarchical project export (root sheet pins + cross-module nets).
    assert_project_scope_export(OUTPUT / "project", project, modules)

    # Stacked library-symbol components relocate via lane candidates.
    assert_stacked_components_relocated(OUTPUT / "stacked")

    # Stacked same-orientation library passives keep property texts apart.
    assert_stacked_passives_text(OUTPUT / "passives")

    print(json.dumps({"ok": True, "export_root": str(first_root), "kicad_cli": bool(find_kicad_cli())}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
