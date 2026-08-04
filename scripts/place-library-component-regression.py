#!/usr/bin/env python3
"""Regression coverage for the place_library_component command op.

Places bundled KiCad library parts (STM32F103C8Tx, AMS1117-3.3, Device:R)
into a pcb_schematic project and asserts BLOCK component structure, pin
coverage discipline, idempotent re-placement, and PCB readiness gating.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SKILL_SCRIPTS = REPO / "skills" / "circuit-design-ngspice" / "scripts"
sys.path.insert(0, str(SKILL_SCRIPTS))

import circuit_project as cp  # noqa: E402
from eda_export import SYMBOL_MAP_SCHEMA, _component_bounds, _stable_uuid, export_eda  # noqa: E402
from eda_kicad_validate import validate_kicad_package  # noqa: E402
from eda_symbols import resolve_symbol_map  # noqa: E402
from kicad_library import get_symbol, load_index, resolve_lib_root  # noqa: E402

STM32 = "MCU_ST_STM32F1:STM32F103C8Tx"
AMS1117 = "Regulator_Linear:AMS1117-3.3"
DEVICE_R = "Device:R"
DEVICE_C = "Device:C"
DEVICE_LED = "Device:LED"


def pin_nets_for(symbol: dict, net_for_name) -> dict[str, str]:
    return {str(pin["number"]): net_for_name(pin) for pin in symbol["pins"]}


def stm32_net(pin: dict) -> str:
    name = str(pin["name"]).upper()
    if name == "VBAT" or name.startswith("VDD"):
        return "vdd_3v3"
    if name.startswith("VSS"):
        return "gnd"
    if name in {"NC", "~", ""}:
        return f"nc_{pin['number']}"
    return str(pin["name"]).lower()


def command(project: dict, revision: int, command_id: str, operations: list[dict]) -> dict:
    return {
        "schema": "actoviq.command.v1",
        "command_id": command_id,
        "actor": "regression",
        "project_id": project["project_id"],
        "base_revision": revision,
        "operations": operations,
    }


def expect_apply_failure(root: Path, cmd: dict, *needles: str) -> str:
    try:
        cp.apply_command(root, cmd)
    except ValueError as error:
        message = str(error)
        for needle in needles:
            assert needle in message, f"error {message!r} missing {needle!r}"
        return message
    raise AssertionError(f"apply unexpectedly succeeded; expected error containing {needles}")


def main() -> int:
    index = load_index(resolve_lib_root())
    stm32 = get_symbol(index, STM32)
    ams1117 = get_symbol(index, AMS1117)
    device_r = get_symbol(index, DEVICE_R)
    assert stm32 and len(stm32["pins"]) == 48, "STM32F103C8Tx missing from index"
    assert ams1117 and len(ams1117["pins"]) == 3, "AMS1117-3.3 missing from index"
    assert device_r and len(device_r["pins"]) == 2, "Device:R missing from index"

    # Keep temp writes on the repo drive (the system drive is space-tight).
    tmp_base = REPO / "output"
    tmp_base.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="place-library-component-", dir=tmp_base) as tmp:
        root = cp.initialize_project(
            Path(tmp) / "projects", "place library regression", None, False,
            project_kind="pcb_schematic",
        )
        project, _modules = cp.load_project(root)

        ams_nets = pin_nets_for(
            ams1117, lambda pin: {"VI": "vin_5v", "VO": "vdd_3v3", "GND": "gnd"}[pin["name"]]
        )
        r_nets = pin_nets_for(
            device_r, lambda pin: {"1": "vdd_3v3", "2": "led_user"}[pin["number"]]
        )
        seed = command(project, project["revision"], "place-library-seed", [
            {
                "op": "upsert_module_netlist",
                "module_id": "mcu_core",
                "name": "MCU core",
                "netlist_notebook": "* seeded\nR1 vdd_3v3 led_user 10k\n",
            },
            {
                "op": "place_library_component",
                "module_id": "mcu_core",
                "name": "XU1",
                "value": "STM32F103C8T6",
                "symbol": STM32,
                "pin_nets": pin_nets_for(stm32, stm32_net),
                "position": {"x": 300, "y": 200},
            },
            {
                "op": "place_library_component",
                "module_id": "mcu_core",
                "name": "XU2",
                "value": "AMS1117-3.3",
                "symbol": AMS1117,
                "pin_nets": ams_nets,
            },
            {
                "op": "place_library_component",
                "module_id": "mcu_core",
                "name": "R2",
                "value": "10k",
                "symbol": DEVICE_R,
                "pin_nets": r_nets,
            },
            {
                "op": "place_library_component",
                "module_id": "mcu_core",
                "name": "C9",
                "value": "100n",
                "symbol": DEVICE_C,
                "pin_nets": {"1": "vdd_3v3", "2": "gnd"},
            },
            {
                "op": "place_library_component",
                "module_id": "mcu_core",
                "name": "D1",
                "value": "LED",
                "symbol": DEVICE_LED,
                # KiCad Device:LED pin 1 = K (cathode), pin 2 = A (anode).
                "pin_nets": {"1": "gnd", "2": "led_user"},
            },
        ])
        applied = cp.apply_command(root, seed)
        assert applied["ok"] is True, applied
        revision = applied["revision"]

        module = json.loads(
            (root / "modules" / "mcu_core" / "module.circuit.json").read_text(encoding="utf-8")
        )
        components = {component["id"]: component for component in module["components"]}

        xu1 = components["xu1"]
        assert xu1["type"] == "BLOCK", xu1["type"]
        assert xu1["name"] == "XU1" and xu1["value"] == "STM32F103C8T6"
        assert len(xu1["pins"]) == 48, f"xu1 pin count: {len(xu1['pins'])}"
        pins_by_id = {pin["id"]: pin for pin in xu1["pins"]}
        assert pins_by_id["34"]["name"] == "PA13", pins_by_id["34"]
        assert pins_by_id["1"]["name"] == "VBAT", pins_by_id["1"]
        assert xu1["eda"]["symbol"] == STM32, xu1["eda"]
        assert xu1["eda"]["footprint"] == "Package_QFP:LQFP-48_7x7mm_P0.5mm", xu1["eda"]
        assert xu1["eda"]["refdes"] == "XU1", xu1["eda"]
        assert xu1["position"] == {"x": 300.0, "y": 200.0}, xu1["position"]
        # BLOCK geometry: every pin carries a valid side, orders are unique
        # per side, and the body size passes module validation bounds.
        sides = {"left": [], "right": [], "top": [], "bottom": []}
        for pin in xu1["pins"]:
            assert pin["side"] in sides, pin
            assert isinstance(pin["order"], int), pin
            sides[pin["side"]].append(pin["order"])
        for side, orders in sides.items():
            assert len(orders) == len(set(orders)), f"duplicate order on {side}: {orders}"
        assert sides["left"] and sides["right"] and sides["top"] and sides["bottom"], sides.keys()
        assert 40 <= xu1["block"]["width"] <= 1000, xu1["block"]
        assert 40 <= xu1["block"]["height"] <= 1000, xu1["block"]

        xu2 = components["xu2"]
        assert xu2["type"] == "BLOCK" and len(xu2["pins"]) == 3
        assert xu2["eda"]["footprint"] == "Package_TO_SOT_SMD:SOT-223-3_TabPin2", xu2["eda"]

        # Device:R/C/LED map onto native primitives (classic glyphs, netlist
        # pin idiom) instead of BLOCK boxes.  Device:R also has a blank KiCad
        # default footprint; the fallback must resolve to a bundled 0603 SMD.
        r2 = components["r2"]
        assert r2["type"] == "R", r2["type"]
        assert "block" not in r2, "primitive placements must not carry block geometry"
        assert r2["rotation"] == 0, r2["rotation"]
        assert [(pin["id"], pin["name"], pin["net"]) for pin in r2["pins"]] == [
            ("a", "1", "vdd_3v3"),
            ("b", "2", "led_user"),
        ], r2["pins"]
        assert r2["eda"]["symbol"] == DEVICE_R, r2["eda"]
        assert r2["eda"]["footprint"].startswith("Resistor_SMD:R_0603"), r2["eda"]
        assert r2["eda"]["refdes"] == "R2", r2["eda"]

        c9 = components["c9"]
        assert c9["type"] == "C", c9["type"]
        assert [(pin["id"], pin["name"], pin["net"]) for pin in c9["pins"]] == [
            ("a", "1", "vdd_3v3"),
            ("b", "2", "gnd"),
        ], c9["pins"]
        assert c9["eda"]["footprint"].startswith("Capacitor_SMD:C_0603"), c9["eda"]

        # KiCad Device:LED numbers the cathode pin 1 / anode pin 2; the
        # internal D keeps a=anode / b=cathode like a netlist-created diode.
        d1 = components["d1"]
        assert d1["type"] == "D", d1["type"]
        assert [(pin["id"], pin["name"], pin["net"]) for pin in d1["pins"]] == [
            ("a", "A", "led_user"),
            ("b", "K", "gnd"),
        ], d1["pins"]
        assert d1["eda"]["footprint"].startswith("LED_SMD:LED_0805"), d1["eda"]

        # Idempotent re-placement: same name updates in place, keeps the id,
        # and honors the new position.
        reapply = command(project, revision, "place-library-replace", [
            {
                "op": "place_library_component",
                "module_id": "mcu_core",
                "name": "XU1",
                "value": "STM32F103C8T6",
                "symbol": STM32,
                "pin_nets": pin_nets_for(stm32, stm32_net),
                "position": {"x": 420, "y": 260},
            },
        ])
        reapplied = cp.apply_command(root, reapply)
        assert reapplied["ok"] is True, reapplied
        revision = reapplied["revision"]
        module = json.loads(
            (root / "modules" / "mcu_core" / "module.circuit.json").read_text(encoding="utf-8")
        )
        xu1_again = [c for c in module["components"] if c["id"] == "xu1"]
        assert len(xu1_again) == 1, "re-placement must update, not duplicate"
        assert xu1_again[0]["position"] == {"x": 420.0, "y": 260.0}, xu1_again[0]["position"]
        assert len(xu1_again[0]["pins"]) == 48

        # pin_nets must cover exactly the symbol's pins.
        short_nets = pin_nets_for(stm32, stm32_net)
        del short_nets["34"]
        expect_apply_failure(
            root,
            command(project, revision, "place-library-missing-pin", [
                {
                    "op": "place_library_component",
                    "module_id": "mcu_core",
                    "name": "XU9",
                    "value": "STM32F103C8T6",
                    "symbol": STM32,
                    "pin_nets": short_nets,
                },
            ]),
            "exactly the 48 pins",
            "missing pins: 34",
        )
        extra_nets = {**pin_nets_for(stm32, stm32_net), "99": "bogus"}
        expect_apply_failure(
            root,
            command(project, revision, "place-library-extra-pin", [
                {
                    "op": "place_library_component",
                    "module_id": "mcu_core",
                    "name": "XU9",
                    "value": "STM32F103C8T6",
                    "symbol": STM32,
                    "pin_nets": extra_nets,
                },
            ]),
            "unknown pins: 99",
        )

        # Unknown symbol must fail clearly.
        expect_apply_failure(
            root,
            command(project, revision, "place-library-unknown-symbol", [
                {
                    "op": "place_library_component",
                    "module_id": "mcu_core",
                    "name": "XU9",
                    "value": "nope",
                    "symbol": "Device:NoSuchPart",
                    "pin_nets": {"1": "a", "2": "b"},
                },
            ]),
            "unknown library symbol: Device:NoSuchPart",
        )

        # Unknown module must fail clearly (failed applies stay transactional,
        # so the revision never advanced).
        expect_apply_failure(
            root,
            command(project, revision, "place-library-unknown-module", [
                {
                    "op": "place_library_component",
                    "module_id": "no_such_module",
                    "name": "XU9",
                    "value": "x",
                    "symbol": DEVICE_R,
                    "pin_nets": r_nets,
                },
            ]),
            "unknown module: no_such_module",
        )
        project_now, _ = cp.load_project(root)
        assert project_now["revision"] == revision, "failed applies must not advance the revision"

        # place_library_component is pcb_schematic-only.
        other_root = cp.initialize_project(
            Path(tmp) / "other-projects", "sim kind gate", None, False,
            project_kind="simulation",
        )
        other_project, _ = cp.load_project(other_root)
        cp.apply_command(other_root, command(other_project, other_project["revision"], "seed-sim", [
            {
                "op": "upsert_module_netlist",
                "module_id": "core",
                "name": "core",
                "netlist_notebook": "* seeded\nR1 in 0 1k\nV1 in 0 1\n",
            },
        ]))
        expect_apply_failure(
            other_root,
            command(other_project, other_project["revision"] + 1, "sim-kind-gate", [
                {
                    "op": "place_library_component",
                    "module_id": "core",
                    "name": "R2",
                    "value": "10k",
                    "symbol": DEVICE_R,
                    "pin_nets": r_nets,
                },
            ]),
            "project_kind=pcb_schematic",
        )

        # PCB readiness: library-placed components resolve symbol + footprint;
        # the netlist-seeded R1 lands in missing_symbol / missing_footprint.
        project_now, modules_now = cp.load_project(root)
        readiness = cp.pcb_export_readiness(project_now, modules_now)
        flagged_symbol = {entry["component_id"] for entry in readiness["missing_symbol"]}
        flagged_footprint = {entry["component_id"] for entry in readiness["missing_footprint"]}
        assert "r1" in flagged_symbol, readiness["missing_symbol"]
        assert "r1" in flagged_footprint, readiness["missing_footprint"]
        assert not {"xu1", "xu2", "r2", "c9", "d1"} & flagged_symbol, readiness["missing_symbol"]
        assert not {"xu1", "xu2", "r2", "c9", "d1"} & flagged_footprint, readiness["missing_footprint"]
        assert not readiness["unknown_library_part"], readiness["unknown_library_part"]
        assert readiness["ready"] is False, "missing lcsc bindings must keep ready=False"

        # A component bound to a bogus library part is reported.
        bogus = command(project, revision, "place-library-bogus-readiness", [
            {
                "op": "add_component",
                "module_id": "mcu_core",
                "component": {
                    "id": "u9",
                    "type": "U",
                    "name": "U9",
                    "value": "mystery",
                    "pins": [{"id": "1", "name": "1", "net": "vdd_3v3"}],
                    "eda": {"symbol": "Device:NoSuchPart", "footprint": "Resistor_SMD:Nope"},
                },
            },
        ])
        cp.apply_command(root, bogus)
        project_now, modules_now = cp.load_project(root)
        readiness = cp.pcb_export_readiness(project_now, modules_now)
        unknown = readiness["unknown_library_part"]
        assert any(entry.get("symbol") == "Device:NoSuchPart" for entry in unknown), unknown
        assert any(entry.get("footprint") == "Resistor_SMD:Nope" for entry in unknown), unknown

        # Export-level: a low-fanout module of library-placed primitives must
        # export the real Device:* symbols with role-based pin mapping, and
        # the package must pass structural validation.
        project_now, _ = cp.load_project(root)
        passives = command(project_now, project_now["revision"], "place-library-passives", [
            {
                "op": "upsert_module_netlist",
                "module_id": "passives",
                "name": "Passives",
                "netlist_notebook": "* seeded\nR1 vdd_3v3 led_user 10k\n",
            },
            {
                "op": "place_library_component",
                "module_id": "passives",
                "name": "R2",
                "value": "10k",
                "symbol": DEVICE_R,
                "pin_nets": {"1": "led_user", "2": "gnd"},
            },
            {
                "op": "place_library_component",
                "module_id": "passives",
                "name": "C1",
                "value": "100n",
                "symbol": DEVICE_C,
                "pin_nets": {"1": "vdd_3v3", "2": "gnd"},
            },
            {
                "op": "place_library_component",
                "module_id": "passives",
                "name": "D1",
                "value": "LED",
                "symbol": DEVICE_LED,
                "pin_nets": {"1": "gnd", "2": "led_user"},
            },
        ])
        cp.apply_command(root, passives)
        project_now, modules_now = cp.load_project(root)

        # Binding-level: role-based pin_map for native primitives.
        pages = [{"id": "passives", "components": modules_now["passives"]["components"]}]
        symbol_map = resolve_symbol_map(None, pages, ["kicad"], SYMBOL_MAP_SCHEMA)
        bindings = symbol_map["targets"]["kicad"]["components"]
        assert bindings["passives:r2"]["pin_map"] == {"a": "1", "b": "2"}, bindings["passives:r2"]
        assert bindings["passives:c1"]["pin_map"] == {"a": "1", "b": "2"}, bindings["passives:c1"]
        assert bindings["passives:d1"]["pin_map"] == {"a": "2", "b": "1"}, bindings["passives:d1"]
        assert bindings["passives:r2"].get("library_symbol") == DEVICE_R
        # The netlist-seeded R1 keeps the generated standard symbol.
        assert not bindings["passives:r1"].get("library_symbol"), bindings["passives:r1"]

        result = export_eda(
            Path(tmp) / "export",
            project_now,
            modules_now,
            {"blocking": False, "summary": {"errors": 0}},
            "c" * 64,
            scope="module",
            module_id="passives",
            targets=["kicad"],
            view="design",
            mapping_file="",
            native_convert="auto",
            strict_layout=False,
            source_revision=project_now["revision"],
        )
        assert result["ok"], result
        export_root = Path(result["export_root"])
        kicad_dir = export_root / "kicad"
        schematic = next(kicad_dir.glob("*.kicad_sch")).read_text(encoding="utf-8")

        # eda.symbol components force net-label routing (routed wires anchor
        # at generated glyph geometry, which real library pins do not share).
        ir = json.loads((export_root / "ir" / "project.eda.json").read_text(encoding="utf-8"))
        page = ir["pages"][0]
        assert page["nets"] and all(net.get("connection") == "label" for net in page["nets"]), (
            "library-symbol module must select net-label routing"
        )

        # Real Device:* symbols are embedded and instantiated.
        for lib_id in (DEVICE_R, DEVICE_C, DEVICE_LED):
            assert f'(symbol "{lib_id}"' in schematic, f"embedded {lib_id} missing"
            assert f'(lib_id "{lib_id}")' in schematic, f"instance of {lib_id} missing"
        assert '(property "Footprint" "Resistor_SMD:R_0603_1608Metric"' in schematic
        assert '(property "Footprint" "Capacitor_SMD:C_0603_1608Metric"' in schematic
        assert '(property "Footprint" "LED_SMD:LED_0805_2012Metric"' in schematic

        # Instance pin uuids prove the a/b -> package pin translation.
        assert f'(pin "1" (uuid {_stable_uuid("passives", "r2", "a")}))' in schematic
        assert f'(pin "2" (uuid {_stable_uuid("passives", "r2", "b")}))' in schematic
        assert f'(pin "1" (uuid {_stable_uuid("passives", "c1", "a")}))' in schematic
        assert f'(pin "2" (uuid {_stable_uuid("passives", "c1", "b")}))' in schematic
        # LED: internal anode (a) lands on KiCad pin 2, cathode (b) on pin 1.
        assert f'(pin "2" (uuid {_stable_uuid("passives", "d1", "a")}))' in schematic
        assert f'(pin "1" (uuid {_stable_uuid("passives", "d1", "b")}))' in schematic

        resolved_map = json.loads(
            (export_root / "ir" / "symbol-map.resolved.json").read_text(encoding="utf-8")
        )
        report = validate_kicad_package(kicad_dir, ir, resolved_map)
        assert report["passed"], report

        # Auto-placement: a full board set (48-pin MCU BLOCK, LDO, crystals,
        # switch, 20 passives, plus a netlist-seeded resistor) must never
        # overlap — every pair of component bounds stays disjoint with at
        # least the placement margin between edges.
        full_ops: list[dict] = [
            {
                "op": "upsert_module_netlist",
                "module_id": "full_board",
                "name": "Full board",
                "netlist_notebook": "* seeded\nR1 vdd_3v3 gnd 10k\n",
            },
            {
                "op": "place_library_component",
                "module_id": "full_board",
                "name": "XU1",
                "value": "STM32F103C8T6",
                "symbol": STM32,
                "pin_nets": pin_nets_for(stm32, stm32_net),
            },
            {
                "op": "place_library_component",
                "module_id": "full_board",
                "name": "XU2",
                "value": "AMS1117-3.3",
                "symbol": AMS1117,
                "pin_nets": ams_nets,
            },
            {
                "op": "place_library_component",
                "module_id": "full_board",
                "name": "XX1",
                "value": "8MHz",
                "symbol": "Device:Crystal",
                "footprint": "Crystal:Crystal_SMD_3225-4Pin_3.2x2.5mm",
                "pin_nets": {"1": "osc_in", "2": "gnd"},
            },
            {
                "op": "place_library_component",
                "module_id": "full_board",
                "name": "XX2",
                "value": "32.768kHz",
                "symbol": "Device:Crystal",
                "footprint": "Crystal:Crystal_SMD_3225-4Pin_3.2x2.5mm",
                "pin_nets": {"1": "osc32_in", "2": "gnd"},
            },
            {
                "op": "place_library_component",
                "module_id": "full_board",
                "name": "SW1",
                "value": "reset",
                "symbol": "Switch:SW_Push",
                "footprint": "Button_Switch_SMD:SW_SPST_TL3342",
                "pin_nets": {"1": "nrst", "2": "gnd"},
            },
        ]
        for index in range(8):
            full_ops.append({
                "op": "place_library_component",
                "module_id": "full_board",
                "name": f"R1{index}",
                "value": "10k",
                "symbol": DEVICE_R,
                "pin_nets": {"1": f"r{index}_a", "2": f"r{index}_b"},
            })
            full_ops.append({
                "op": "place_library_component",
                "module_id": "full_board",
                "name": f"C1{index}",
                "value": "100n",
                "symbol": DEVICE_C,
                "pin_nets": {"1": f"c{index}_a", "2": "gnd"},
            })
        for index in range(4):
            full_ops.append({
                "op": "place_library_component",
                "module_id": "full_board",
                "name": f"D1{index}",
                "value": "LED",
                "symbol": DEVICE_LED,
                "pin_nets": {"1": "gnd", "2": f"led{index}"},
            })
        project_now, _ = cp.load_project(root)
        cp.apply_command(root, command(project_now, project_now["revision"], "place-library-full-board", full_ops))
        full_module = json.loads(
            (root / "modules" / "full_board" / "module.circuit.json").read_text(encoding="utf-8")
        )
        full_components = full_module["components"]
        assert len(full_components) == 1 + 2 + 2 + 1 + 8 + 8 + 4, len(full_components)
        bounds = {
            component["id"]: _component_bounds(component)
            for component in full_components
        }
        ids = sorted(bounds)
        min_separation = float("inf")
        for left_index, left_id in enumerate(ids):
            for right_id in ids[left_index + 1:]:
                left, right = bounds[left_id], bounds[right_id]
                intersects = (
                    left["min_x"] < right["max_x"] and right["min_x"] < left["max_x"]
                    and left["min_y"] < right["max_y"] and right["min_y"] < left["max_y"]
                )
                assert not intersects, f"components overlap: {left_id} {left} vs {right_id} {right}"
                separation = max(
                    right["min_x"] - left["max_x"],
                    left["min_x"] - right["max_x"],
                    right["min_y"] - left["max_y"],
                    left["min_y"] - right["max_y"],
                )
                min_separation = min(min_separation, separation)
        assert min_separation >= 60.0 - 1e-9, f"edge clearance below margin: {min_separation}"
        # Positions stay on the 20-unit editor grid.
        for component in full_components:
            assert component["position"]["x"] % 20 == 0, component["position"]
            assert component["position"]["y"] % 20 == 0, component["position"]

    print("place-library-component regression ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
