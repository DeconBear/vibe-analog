#!/usr/bin/env python3
"""Regression coverage for the bundled KiCad library indexer."""

from __future__ import annotations

import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SKILL_SCRIPTS = REPO / "skills" / "circuit-design-ngspice" / "scripts"
sys.path.insert(0, str(SKILL_SCRIPTS))

from kicad_library import (  # noqa: E402
    get_footprint,
    get_symbol,
    load_index,
    resolve_lib_root,
    search_symbols,
)


def main() -> int:
    lib_root = resolve_lib_root()
    assert (lib_root / "symbols").is_dir(), f"missing symbols dir under {lib_root}"

    with tempfile.TemporaryDirectory(prefix="kicad-lib-cache-") as tmp:
        cache_path = Path(tmp) / "index.json"
        index = load_index(lib_root, cache_path=cache_path)
        assert index["cache_hit"] is False, "first load must build the index"
        assert cache_path.is_file(), "cache file was not written"

        # Second load must come from the cache (no re-parse).
        start = time.perf_counter()
        cached = load_index(lib_root, cache_path=cache_path)
        elapsed = time.perf_counter() - start
        assert cached["cache_hit"] is True, "second load must hit the cache"
        assert elapsed < 2.0, f"cached load too slow: {elapsed:.3f}s"
        assert cached["symbols"] == index["symbols"], "cached symbols differ"

        # Forced rebuild re-parses.
        forced = load_index(lib_root, cache_path=cache_path, force=True)
        assert forced["cache_hit"] is False, "forced load must rebuild"

    stm32 = get_symbol(index, "MCU_ST_STM32F1:STM32F103C8Tx")
    assert stm32 is not None, "STM32F103C8Tx missing"
    assert len(stm32["pins"]) == 48, f"STM32F103C8Tx pin count: {len(stm32['pins'])}"
    by_number = {pin["number"]: pin for pin in stm32["pins"]}
    assert by_number["1"]["name"] == "VBAT", f"pin 1: {by_number['1']['name']}"
    assert "PA13" in by_number["34"]["name"], f"pin 34: {by_number['34']['name']}"
    assert "LQFP-48" in stm32["default_footprint"], stm32["default_footprint"]
    assert stm32["raw"], "raw field empty"
    assert stm32["raw"].startswith('(symbol "STM32F103C8Tx"'), stm32["raw"][:80]
    assert "_0_1" in stm32["raw"], "raw must include sub-unit definitions"

    ams = get_symbol(index, "Regulator_Linear:AMS1117-3.3")
    assert ams is not None, "AMS1117-3.3 missing"
    assert len(ams["pins"]) == 3, f"AMS1117-3.3 pin count: {len(ams['pins'])}"

    assert get_symbol(index, "Device:C") is not None, "Device:C missing"
    conn = get_symbol(index, "Connector:Conn_01x04_Pin")
    assert conn is not None, "Conn_01x04_Pin missing"
    assert len(conn["pins"]) == 4, f"Conn_01x04_Pin pin count: {len(conn['pins'])}"
    assert get_symbol(index, "Switch:SW_Push") is not None, "SW_Push missing"

    lqfp = get_footprint(index, "Package_QFP:LQFP-48_7x7mm_P0.5mm")
    assert lqfp is not None, "LQFP-48 footprint missing"
    assert len(lqfp["pads"]) == 48, f"LQFP-48 pad count: {len(lqfp['pads'])}"
    assert lqfp["pads"][0]["number"] == "1", lqfp["pads"][0]
    assert get_footprint(index, "Package_TO_SOT_SMD:SOT-223-3_TabPin2") is not None, (
        "SOT-223-3_TabPin2 missing"
    )

    hits = search_symbols(index, "stm32f103")
    assert any(hit["name"] == "STM32F103C8Tx" for hit in hits), "search stm32f103 missed"
    hits = search_symbols(index, "1x04")
    assert any(hit["name"].startswith("Conn_01x04") for hit in hits), "search 1x04 missed"
    hits = search_symbols(index, "STM32F103C8")
    assert hits and hits[0]["name"].startswith("STM32F103C8"), "prefix ranking broken"

    # Unit-variant symbols must not be indexed.
    assert get_symbol(index, "MCU_ST_STM32F1:STM32F103C8Tx_0_1") is None
    assert get_symbol(index, "MCU_ST_STM32F1:STM32F103C8Tx_1_1") is None

    print("kicad-library regression ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
