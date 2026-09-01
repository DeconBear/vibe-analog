"""Canonical component semantics and deterministic EDA symbol bindings."""

from __future__ import annotations

import hashlib
import json
import re
from copy import deepcopy
from pathlib import Path
from typing import Any, Iterable


_TARGETS = {"kicad", "altium", "orcad", "virtuoso"}
_SIDES = {"left", "right", "top", "bottom"}

_DEVICE_SPECS: dict[str, tuple[str, str, str, tuple[str, ...]]] = {
    "R": ("resistor", "resistor", "R", ("terminal_1", "terminal_2")),
    "C": ("capacitor", "capacitor", "C", ("terminal_1", "terminal_2")),
    "L": ("inductor", "inductor", "L", ("terminal_1", "terminal_2")),
    "D": ("diode", "diode", "D", ("anode", "cathode")),
    "M": ("mosfet", "nmos", "M", ("drain", "gate", "source", "bulk")),
    "Q": ("bjt", "npn", "Q", ("collector", "base", "emitter")),
    "V": ("voltage_source", "voltage_source", "V", ("positive", "negative")),
    "I": ("current_source", "current_source", "I", ("positive", "negative")),
    "E": ("vcvs", "vcvs", "E", ("positive", "negative", "control_p", "control_n")),
    "U": ("ic", "ic", "U", ()),
    "X": ("subcircuit", "subcircuit", "X", ()),
    "BLOCK": ("block", "block", "U", ()),
}

_ROLE_ALIASES: dict[str, dict[str, str]] = {
    "R": {"a": "terminal_1", "1": "terminal_1", "b": "terminal_2", "2": "terminal_2"},
    "C": {"a": "terminal_1", "1": "terminal_1", "b": "terminal_2", "2": "terminal_2"},
    "L": {"a": "terminal_1", "1": "terminal_1", "b": "terminal_2", "2": "terminal_2"},
    "D": {"a": "anode", "anode": "anode", "k": "cathode", "cathode": "cathode"},
    "M": {"d": "drain", "drain": "drain", "g": "gate", "gate": "gate", "s": "source", "source": "source", "b": "bulk", "bulk": "bulk", "body": "bulk"},
    "Q": {"c": "collector", "collector": "collector", "b": "base", "base": "base", "e": "emitter", "emitter": "emitter"},
    "V": {"p": "positive", "plus": "positive", "positive": "positive", "n": "negative", "minus": "negative", "negative": "negative"},
    "I": {"p": "positive", "plus": "positive", "positive": "positive", "n": "negative", "minus": "negative", "negative": "negative"},
}

_ROLE_SIDES = {
    "terminal_1": "left", "terminal_2": "right", "anode": "left", "cathode": "right",
    "positive": "left", "negative": "right", "drain": "top", "gate": "left",
    "source": "bottom", "bulk": "right", "collector": "top", "base": "left", "emitter": "bottom",
}

_STANDARD_CELLS = {
    "resistor": "R", "capacitor": "C", "inductor": "L", "diode": "Diode",
    "pmos": "PMOS_4PIN", "nmos": "NMOS_4PIN", "pnp": "PNP", "npn": "NPN",
    "voltage_source": "Voltage_Source", "current_source": "Current_Source",
}

_TARGET_PIN_IDS = {
    "terminal_1": "1", "terminal_2": "2", "anode": "A", "cathode": "K",
    "drain": "D", "gate": "G", "source": "S", "bulk": "B",
    "collector": "C", "base": "B", "emitter": "E",
    "positive": "PLUS", "negative": "MINUS",
}

# Native primitives placed from the bundled KiCad library (eda.symbol) keep
# the internal pin ids (a/b), so their pin_map must translate the canonical
# pin role onto the KiCad package pin number.  KiCad Device diodes/LEDs
# number the cathode as pin 1 and the anode as pin 2.
KICAD_LIBRARY_ROLE_PIN_NUMBERS = {
    "terminal_1": "1",
    "terminal_2": "2",
    "anode": "2",
    "cathode": "1",
}

_VIRTUOSO_CELLS = {
    "resistor": ("analogLib", "res"), "capacitor": ("analogLib", "cap"),
    "inductor": ("analogLib", "ind"), "diode": ("analogLib", "diode"),
    "pmos": ("analogLib", "pmos4"), "nmos": ("analogLib", "nmos4"),
    "pnp": ("analogLib", "pnp"), "npn": ("analogLib", "npn"),
    "voltage_source": ("analogLib", "vsource"), "current_source": ("analogLib", "isource"),
}


def _portable_symbol_variant(component: dict[str, Any], base_cell: str) -> str:
    """Return a stable local-cell name for non-canonical symbol geometry.

    KiCad/Altium/OrCAD local libraries share one definition for every cell
    name.  Reusing ``Block_3Pin`` (or ``R`` with custom pin sides) for two
    different pin arrangements makes one of the instances connect to the
    wrong graphical pin.  Canonical primitives keep their familiar cell
    names; arbitrary blocks and non-standard pin arrangements get a short,
    deterministic geometry suffix.
    """
    pins = component.get("pins") if isinstance(component.get("pins"), list) else []
    component_type = str(component.get("type", "BLOCK")).upper()
    canonical_roles = _DEVICE_SPECS.get(component_type, ("", "", "", ()))[3]
    pin_layout = [
        {
            "role": str((pin.get("eda") or {}).get("role", "")),
            "name": str(pin.get("name", "")),
            "side": str(pin.get("side", "")),
            "order": int(pin.get("order", 0)),
        }
        for pin in pins
    ]
    canonical = (
        component_type != "BLOCK"
        and len(pins) == len(canonical_roles)
        and all(
            entry["role"] == canonical_roles[index]
            and entry["side"] == _ROLE_SIDES.get(canonical_roles[index], entry["side"])
            for index, entry in enumerate(pin_layout)
        )
    )
    if canonical:
        return base_cell
    block = component.get("block") if isinstance(component.get("block"), dict) else {}
    payload = {
        "type": component_type,
        "subtype": str((component.get("eda") or {}).get("subtype", "")),
        "pins": pin_layout,
        "width": block.get("width"),
        "height": block.get("height"),
    }
    digest = hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:8]
    if component_type in {"M", "Q"}:
        base_cell = re.sub(r"_\d+PIN$", f"_{len(pins)}PIN", base_cell)
    return f"{base_cell}_{digest}"


def _normalized(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value).casefold())


def _model_name(component: dict[str, Any], component_type: str) -> str:
    eda = component.get("eda") if isinstance(component.get("eda"), dict) else {}
    spice = component.get("spice") if isinstance(component.get("spice"), dict) else {}
    for value in (component.get("model"), component.get("model_name"), spice.get("model"), eda.get("model")):
        if isinstance(value, str) and value.strip():
            return value.strip()
    if component_type in {"D", "M", "Q"}:
        tokens = str(component.get("value", "")).split()
        return tokens[0] if tokens else ""
    return ""


def _subtype(component: dict[str, Any], component_type: str, default: str, model: str) -> str:
    eda = component.get("eda") if isinstance(component.get("eda"), dict) else {}
    hints = " ".join(str(value) for value in (
        component.get("subtype"), component.get("device_subtype"), component.get("polarity"),
        eda.get("subtype"), model, component.get("value"), component.get("name"),
    ) if value)
    compact = _normalized(hints)
    if component_type == "M":
        if "pmos" in compact or "pfet" in compact or "pchannel" in compact:
            return "pmos"
        if "nmos" in compact or "nfet" in compact or "nchannel" in compact:
            return "nmos"
    if component_type == "Q":
        if "pnp" in compact:
            return "pnp"
        if "npn" in compact:
            return "npn"
    return default


def _pin_role(component_type: str, pin: dict[str, Any], index: int, defaults: tuple[str, ...]) -> str:
    aliases = _ROLE_ALIASES.get(component_type, {})
    raw_values = (pin.get("id"), pin.get("name"))
    for raw in raw_values:
        if raw in {"+", "-"} and component_type in {"V", "I"}:
            return "positive" if raw == "+" else "negative"
        role = aliases.get(_normalized(raw))
        if role:
            return role
    if index < len(defaults):
        return defaults[index]
    return f"pin_{index + 1}"


def prepare_component(component: dict[str, Any]) -> dict[str, Any]:
    """Return a deep copy enriched with canonical device and pin semantics."""
    result = deepcopy(component)
    component_type = str(result.get("type", "BLOCK")).upper()
    device_class, default_subtype, prefix, default_roles = _DEVICE_SPECS.get(
        component_type, ("generic", "generic", "X", ()),
    )
    existing_eda = result.get("eda") if isinstance(result.get("eda"), dict) else {}
    model = _model_name(result, component_type)
    subtype = _subtype(result, component_type, default_subtype, model)
    footprint = result.get("footprint") or existing_eda.get("footprint")
    physical = component_type in {"R", "C", "L", "D", "M", "Q", "U"} or (
        component_type in {"BLOCK", "X"}
        and ((bool(footprint) and bool(str(footprint).strip())) or result.get("mount_policy") == "design_include")
    )
    side_counts = {side: 0 for side in _SIDES}
    pin_roles: dict[str, str] = {}
    used_roles: set[str] = set()
    pins = result.get("pins") if isinstance(result.get("pins"), list) else []
    for index, pin in enumerate(pins):
        pin_id = str(pin.get("id", ""))
        role = pin_id or f"pin_{index + 1}" if component_type == "BLOCK" else _pin_role(component_type, pin, index, default_roles)
        if role in used_roles:
            role = f"{role}_{index + 1}"
        used_roles.add(role)
        if pin.get("side") in _SIDES:
            side = str(pin["side"])
            order = pin.get("order") if isinstance(pin.get("order"), int) else side_counts[side]
        else:
            side = _ROLE_SIDES.get(role, "left" if index < (len(pins) + 1) // 2 else "right")
            order = side_counts[side]
        side_counts[side] += 1
        pin["side"], pin["order"] = side, order
        pin_eda = pin.get("eda") if isinstance(pin.get("eda"), dict) else {}
        pin["eda"] = {**pin_eda, "role": role, "side": side, "order": order}
        pin_roles[pin_id] = role
    result["eda"] = {
        **existing_eda,
        "device_class": device_class,
        "subtype": subtype,
        "model": model,
        "physical": physical,
        "refdes_prefix": prefix,
        "pin_roles": pin_roles,
    }
    return result


def assign_refdes(pages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Assign stable, export-wide reference designators in-place."""
    counters: dict[str, int] = {}
    ordered: list[tuple[str, str, int, dict[str, Any]]] = []
    for page in pages:
        page_id = str(page.get("id", ""))
        for index, component in enumerate(page.get("components", [])):
            ordered.append((page_id, str(component.get("id", "")), index, component))
    prepared_entries: list[tuple[str, str, int, dict[str, Any]]] = []
    for page_id, component_id, index, component in sorted(ordered, key=lambda item: item[:3]):
        prepared = prepare_component(component)
        component.clear()
        component.update(prepared)
        prepared_entries.append((page_id, component_id, index, component))

    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for page_id, component_id, _, component in prepared_entries:
        eda = component["eda"]
        package_id = str(eda.get("package_id") or "").strip()
        groups.setdefault((page_id, package_id or f"component:{component_id}"), []).append(component)

    explicit_refdes: dict[tuple[str, str], str] = {}
    used_refdes: dict[str, tuple[str, str]] = {}
    for group_key, members in sorted(groups.items()):
        explicit = {str(member["eda"].get("refdes") or "").strip() for member in members}
        explicit.discard("")
        if len(explicit) > 1:
            raise ValueError(f"package {group_key[1]} has conflicting refdes values")
        for field in ("symbol", "footprint", "lcsc_id", "mpn", "manufacturer"):
            values = {str(member["eda"].get(field) or "").strip() for member in members}
            values.discard("")
            if len(values) > 1:
                raise ValueError(f"package {group_key[1]} has conflicting {field} values")
        units = [int(member["eda"].get("unit") or 1) for member in members]
        if len(units) != len(set(units)):
            raise ValueError(f"package {group_key[1]} contains duplicate symbol units")
        if explicit:
            refdes = next(iter(explicit))
            owner = used_refdes.get(refdes.casefold())
            if owner is not None and owner != group_key:
                raise ValueError(f"duplicate refdes across physical packages: {refdes}")
            used_refdes[refdes.casefold()] = group_key
            explicit_refdes[group_key] = refdes

    for group_key, members in sorted(groups.items()):
        refdes = explicit_refdes.get(group_key)
        if refdes is None:
            prefix = str(members[0]["eda"]["refdes_prefix"])
            counters[prefix] = counters.get(prefix, 0)
            while True:
                counters[prefix] += 1
                refdes = f"{prefix}{counters[prefix]}"
                if refdes.casefold() not in used_refdes:
                    break
            used_refdes[refdes.casefold()] = group_key
        for member in members:
            member["eda"]["refdes"] = refdes
    return pages


def _default_binding(target: str, component: dict[str, Any]) -> dict[str, Any]:
    eda = component["eda"]
    subtype = str(eda["subtype"])
    pins = component.get("pins", [])
    if target == "kicad":
        eda_symbol = str(eda.get("symbol", "")).strip()
        if eda_symbol:
            library, separator, cell = eda_symbol.partition(":")
            if not separator or not library.strip() or not cell.strip():
                raise ValueError(f"eda.symbol must use the 'Library:Cell' form: {eda_symbol!r}")
            # Pin ids of BLOCK-style components are the package pin numbers,
            # which are exactly the target symbol pin numbers.  Native
            # primitives (R/C/D placed from Device:* symbols) keep internal
            # pin ids (a/b), so translate through the canonical pin role.
            pin_map = {}
            for pin in pins:
                pin_id = str(pin.get("id", ""))
                role = str((pin.get("eda") or {}).get("role", ""))
                pin_map[pin_id] = KICAD_LIBRARY_ROLE_PIN_NUMBERS.get(role, pin_id)
            return {
                "library": library.strip(),
                "cell": cell.strip(),
                "view": "symbol",
                "pin_map": pin_map,
                "library_symbol": eda_symbol,
            }
    if target == "virtuoso":
        library, cell = _VIRTUOSO_CELLS.get(subtype, ("ACTOVIQ", f"Block_{len(pins)}Pin"))
    else:
        library = "ACTOVIQ_STANDARD" if target == "orcad" else "Vibe Analog_Standard"
        base_cell = _STANDARD_CELLS.get(subtype, f"Block_{len(pins)}Pin")
        cell = _portable_symbol_variant(component, base_cell)
    pin_map: dict[str, str] = {}
    used: set[str] = set()
    for index, pin in enumerate(pins):
        pin_id = str(pin.get("id", ""))
        role = str((pin.get("eda") or {}).get("role", f"pin_{index + 1}"))
        target_pin = _TARGET_PIN_IDS.get(role, f"PIN{index + 1}")
        while target_pin.casefold() in used:
            target_pin = f"PIN{index + 1}"
        used.add(target_pin.casefold())
        pin_map[pin_id] = target_pin
    return {"library": library, "cell": cell, "view": "symbol", "pin_map": pin_map}


def _entry(table: Any, key: str) -> dict[str, Any] | None:
    if not key or table is None:
        return None
    if not isinstance(table, dict):
        raise ValueError("symbol-map tables must be objects")
    if key in table:
        value = table[key]
    else:
        matches = [value for candidate, value in table.items() if str(candidate).casefold() == key.casefold()]
        if len(matches) > 1:
            raise ValueError(f"ambiguous case-insensitive symbol-map key: {key}")
        value = matches[0] if matches else None
    if value is not None and not isinstance(value, dict):
        raise ValueError(f"symbol-map entry must be an object: {key}")
    return value


def _merge_binding(binding: dict[str, Any], override: dict[str, Any], source_pins: set[str]) -> None:
    original_identity = (binding.get("library"), binding.get("cell"))
    for field in ("library", "cell", "view"):
        if field in override:
            value = override[field]
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"symbol-map {field} must be a non-empty string")
            binding[field] = value.strip()
    if (binding.get("library"), binding.get("cell")) != original_identity:
        binding.pop("library_symbol", None)
    pin_map = override.get("pin_map")
    if not isinstance(pin_map, dict) or set(map(str, pin_map)) != source_pins:
        raise ValueError("explicit symbol-map pin map must contain every source pin exactly once")
    normalized: dict[str, str] = {}
    for source_pin, target_pin in pin_map.items():
        if not isinstance(target_pin, str) or not target_pin.strip():
            raise ValueError(f"empty target pin for source pin {source_pin}")
        normalized[str(source_pin)] = target_pin.strip()
    binding["pin_map"] = normalized


def _validate_binding(target: str, key: str, binding: dict[str, Any], source_pins: set[str]) -> None:
    for field in ("library", "cell", "view"):
        if not isinstance(binding.get(field), str) or not binding[field].strip():
            raise ValueError(f"missing {target} {field} for {key}")
    pin_map = binding.get("pin_map")
    if not isinstance(pin_map, dict) or set(pin_map) != source_pins:
        raise ValueError(f"incomplete {target} pin map for {key}")
    targets = [str(value).strip() for value in pin_map.values()]
    if any(not value for value in targets) or len({value.casefold() for value in targets}) != len(targets):
        raise ValueError(f"empty or duplicate {target} target pin for {key}")


def resolve_symbol_map(
    path: str | Path | None,
    pages: list[dict[str, Any]],
    targets: Iterable[str],
    schema: str,
) -> dict[str, Any]:
    """Merge defaults and mapping overrides into one binding per component."""
    raw = json.loads(Path(path).read_text(encoding="utf-8")) if path else {"schema": schema, "targets": {}}
    if not isinstance(raw, dict) or raw.get("schema") != schema:
        raise ValueError(f"mapping file schema must be {schema}")
    raw_targets = raw.get("targets", {})
    if not isinstance(raw_targets, dict):
        raise ValueError("symbol-map targets must be an object")
    requested = tuple(dict.fromkeys(str(target).casefold() for target in targets))
    unsupported = set(requested) - _TARGETS
    if unsupported:
        raise ValueError(f"unsupported EDA targets: {sorted(unsupported)}")
    resolved: dict[str, Any] = {"schema": schema, "targets": {}}
    for target in requested:
        target_map = _entry(raw_targets, target) or {}
        component_bindings: dict[str, Any] = {}
        for page in sorted(pages, key=lambda item: str(item.get("id", ""))):
            page_id = str(page.get("id", ""))
            for source in sorted(page.get("components", []), key=lambda item: str(item.get("id", ""))):
                component = prepare_component(source)
                component_id = str(component.get("id", ""))
                key = f"{page_id}:{component_id}"
                source_pins = {str(pin.get("id", "")) for pin in component.get("pins", [])}
                if "" in source_pins or len(source_pins) != len(component.get("pins", [])):
                    raise ValueError(f"component pins must have unique non-empty ids: {key}")
                binding = _default_binding(target, component)
                sources = ["default"]
                selectors = (
                    ("types", str(component.get("type", "")).upper()),
                    ("subtypes", str(component["eda"]["subtype"])),
                    ("models", str(component["eda"]["model"])),
                    ("components", component_id),
                    ("components", key),
                )
                for table_name, selector in selectors:
                    override = _entry(target_map.get(table_name), selector)
                    if override is not None:
                        _merge_binding(binding, override, source_pins)
                        sources.append(f"{table_name}:{selector}")
                _validate_binding(target, key, binding, source_pins)
                binding["source"] = sources[-1]
                binding["source_chain"] = sources
                component_bindings[key] = binding
        resolved["targets"][target] = {"components": component_bindings}
    return resolved


def binding_for(
    resolved: dict[str, Any], target: str, page_id: str, component: dict[str, Any],
) -> dict[str, Any]:
    """Return an isolated resolved binding for one component."""
    target_key = str(target).casefold()
    component_id = str(component.get("id", ""))
    key = f"{page_id}:{component_id}"
    try:
        bindings = resolved["targets"][target_key]["components"]
        return deepcopy(bindings[key] if key in bindings else bindings[component_id])
    except (KeyError, TypeError) as exc:
        raise KeyError(f"no resolved {target_key} symbol binding for {key}") from exc
