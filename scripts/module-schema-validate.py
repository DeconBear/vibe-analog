"""Focused module-schema regressions for structured editor-only fields."""

from __future__ import annotations

import copy
import json
from pathlib import Path

from jsonschema import Draft202012Validator


ROOT = Path(__file__).resolve().parents[1]
SCHEMA = json.loads(
    (ROOT / "skills" / "circuit-design-ngspice" / "schemas" / "module.schema.json").read_text(
        encoding="utf-8"
    )
)
VALIDATOR = Draft202012Validator(SCHEMA)

BASE_MODULE = {
    "schema": "actoviq.module.v2",
    "module_id": "no_connect_fixture",
    "name": "No-connect fixture",
    "revision": 0,
    "ports": [],
    "components": [
        {
            "id": "spare",
            "type": "BLOCK",
            "name": "SPARE",
            "value": "unused",
            "position": {"x": 0, "y": 0},
            "rotation": 0,
            "pins": [
                {
                    "id": "nc",
                    "name": "NC",
                    "net": "spare",
                    "no_connect": True,
                }
            ],
        }
    ],
}


def main() -> None:
    valid_errors = list(VALIDATOR.iter_errors(BASE_MODULE))
    assert not valid_errors, valid_errors
    print("PASS boolean pin no_connect")

    invalid = copy.deepcopy(BASE_MODULE)
    invalid["components"][0]["pins"][0]["no_connect"] = "yes"
    assert list(VALIDATOR.iter_errors(invalid))
    print("PASS non-boolean pin no_connect rejected")

    symbol_instance = copy.deepcopy(BASE_MODULE)
    symbol_instance["components"][0]["eda"] = {
        "symbol": "Device:D_Dual_CommonAnode_AKK_Split",
        "footprint": "Package_TO_SOT_SMD:SOT-223-3_TabPin2",
        "unit": 2,
        "symbol_variant": 1,
        "package_id": "pkg_d1",
    }
    assert not list(VALIDATOR.iter_errors(symbol_instance))
    print("PASS symbol unit/package metadata")

    for field, value in (("unit", 0), ("symbol_variant", 0), ("package_id", "")):
        invalid = copy.deepcopy(symbol_instance)
        invalid["components"][0]["eda"][field] = value
        assert list(VALIDATOR.iter_errors(invalid)), (field, value)
        print(f"PASS invalid {field} rejected")
    print(json.dumps({"ok": True, "passed": 6, "failed": 0, "total": 6}, indent=2))


if __name__ == "__main__":
    main()
