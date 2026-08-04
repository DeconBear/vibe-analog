---
name: circuit-design-ngspice
description: >
  Design, simulate, and render kind-scoped SPICE/PCB/analog-IC schematics with
  ngspice and netlistsvg for the Vibe Analog project canvas. Use when designing circuits,
  creating or simulating SPICE netlists, rendering schematics, optimizing
  automatic schematic placement/routing with a vision-only model, checking
  layout quality/connectivity, or exporting editable KiCad, Altium, OrCAD, and
  Virtuoso schematic packages. Supports single-block and module-composed projects
  on `actoviq.module.v2` / `actoviq.schematic-document.v1`.
---

# Circuit Design Ngspice

## Overview

This skill turns natural-language circuit requirements into verified SPICE
designs and schematic artifacts. It wraps portable Python CLI scripts that any
AI coding agent can execute.

**Scope**: schematic-level SPICE design, waveform/sweep simulation, and SVG
rendering. Not for PCB layout, IC mask layout, or production signoff.

**Default path**: Vibe Analog desktop project canvas (`projects/<id>/`).  
**Compatibility path**: one-shot `jobs/<id>/` workflow.

Read detail files only when needed — keep this page as the map.

## Hard Constraints

Constraints are **kind-scoped** via `project.project_kind`:

| Kind | Netlist / devices | Default validation loop |
| --- | --- | --- |
| `simulation` (default / legacy migrate) | Primitive-only prefixes `R C L Q M D V I`. Forbidden: `X E F G H B A U`, `.subckt/.ends/.include/.lib` | ERC → compile → ngspice |
| `pcb_schematic` | Packaged devices / `U` / `BLOCK` / `X`, LCSC binding, controlled KiCad handoff, experimental JLCEDA exchange JSON | ERC → part/refdes readiness → handoff (simulation optional) |
| `analog_ic` | PDK/model binding, explicit MOS W/L/M/NF, module composition / controlled sources | analog audit → ERC → compile → ngspice → Virtuoso package |

- No standalone net-label lines (nodes only as component terminals).
- Never edit generated `build/` artifacts.
- PCB layout / footprint generation / DFM / LCSC ordering are **out of scope**.
- Identity for EDA round-trip: persistent `stable_id` written as peer property `ACTOVIQ_ID`.

## Protocol Loop (Desktop Projects)

Implements `actoviq.project-agent.v2`. Before changing a desktop project, read
[references/project-agent-protocol.md](references/project-agent-protocol.md)
and `skill-version.json`.

1. Run `agent-context`; use exact `project_id` and `base_revision`.
2. Submit one transaction (`actor: "agent"`):
   - Prefer `actoviq.command.v2` for schematic topology edits on one module
     (`expected_module_revision` required).
   - Use `actoviq.command.v1` for project-canvas ops (`connect_ports`,
     `upsert_module_netlist`, …) and for compatibility batch
     `set_module_schematic`.
3. Respect module soft leases (`module-lease-acquire` / `release`) when the GUI
   editor holds a module.
4. Read returned ERC; fix blocking errors.
5. Run `compile`, then required simulations for the current revision.
6. Never invent a new revision number to retry a stale command — reread context.

Editable truth: `modules/<id>/module.circuit.json` (`actoviq.module.v2`).  
Design/SVG: shared `actoviq.schematic-document.v1` projection.  
netlistsvg / `schematic.overrides.json`: export / legacy placement only.  
Desktop editor tutorial:
[references/schematic-editor-guide.md](references/schematic-editor-guide.md).

## Desktop Canvas — Quick Start

Full contract:
[references/gui-project-canvas.md](references/gui-project-canvas.md)

**Always resolve the GUI workspace before creating projects** — do not invent
`workspace/projects/` paths. The Electron app reads
`~/.actoviq/vibe-analog-workspaces.json` and defaults to
`<repo>/workspace/workspaces/default/projects/`.

```bash
python scripts/circuit_project.py workspace-active
python scripts/circuit_project.py workspace-list
python scripts/circuit_project.py workspace-use --workspace-id default

# create uses the active workspace projectsDir when --projects-root is omitted
python scripts/circuit_project.py create --name "<project name>"

python scripts/circuit_project.py agent-context \
  --project-root <projectsDir>/<project-id>

python scripts/circuit_project.py apply \
  --project-root <projectsDir>/<project-id> \
  --command-file <command.json>

python scripts/circuit_project.py compile --project-root <project-root>
python scripts/circuit_project.py simulate --project-root <project-root>
python scripts/circuit_project.py export-eda --project-root <project-root> --source-revision <revision>

# PCB EDA handoff (pcb_schematic only; stable_id-based layout/property sync)
python scripts/circuit_project.py bridge-link --project-root <project-root> --peer-kind kicad --peer-root <dir>
python scripts/circuit_project.py bridge-push --project-root <project-root> --peer-kind kicad --source-revision <n>
python scripts/circuit_project.py bridge-pull --project-root <project-root> --peer-kind jlceda
python scripts/circuit_project.py bridge-import-cold --peer-kind kicad --peer-root <dir> --name <name>

# 立创商城 (Settings credentials or --use-fallback for offline demo)
python scripts/circuit_project.py lcsc-search --query "1k 0603" --use-fallback
python scripts/circuit_project.py lcsc-bind --project-root <project-root> --module-id <m> --component-id <c> --lcsc-id C21190 --use-fallback

# Bundled KiCad library (assets/kicad-lib, CC-BY-SA subset): search/bind real symbols
python scripts/circuit_project.py kicad-lib-search --query "stm32f103"
python scripts/circuit_project.py kicad-lib-get --symbol MCU_ST_STM32F1:STM32F103C8Tx
# place_library_component (command.v1 op): instantiate a library symbol as a
# named-pin BLOCK with eda.symbol/eda.footprint; pin_nets maps pin number -> net.

# Analog IC (external PDK remains licensed/user-supplied)
python scripts/circuit_project.py create --name "OTA" --project-kind analog_ic
python scripts/circuit_project.py analog-ic-audit --project-root <project-root>
python scripts/circuit_project.py simulate --project-root <project-root>

# Razavi-Bench provenance only; evaluation is blocked pending written permission
python scripts/razavi_bench.py --repo <canonical-upstream-checkout>
```

Prefer **functional modules** for new AI-generated desktop circuits: split
stimuli / cores / encode-load, then `connect_ports`. A single
`upsert_module_netlist` is only for trivial paths (about ≤8 devices, one
signal chain). See
[references/modular-project-design.md](references/modular-project-design.md).
Prefer validated entries under workspace `references/catalog/` and
`references/design-memory/`, then
built-in `assets/templates/`. Circuit references may be `.cir` / flattened
`.subckt` imports; schematic layout references require a matching
`connectivity_hash` before apply. See
[references/user-reference-assets.md](references/user-reference-assets.md).
still run fresh ERC + simulation. Ignore `.trash/projects/` as a normal
projects root.

Create projects with an explicit kind:

```bash
python scripts/circuit_project.py create --name "Board schematic" --project-kind pcb_schematic
```

## Jobs Workflow — Outline

Full steps, inputs, and required artifacts:
[references/jobs-workflow.md](references/jobs-workflow.md)

Use this path for one-shot job bundles. Do **not** use it as the edit model for
an open desktop canvas project.

1. Requirements → `inputs/` + normalized spec  
2. Technical solution + checklist  
3. Template selection from `assets/templates/`  
4. Architecture / module plan  
5. Primitive-only netlist design loop (max 3 iterations)  
6. Simulation & verification  
7. netlistsvg render (compat export; not desktop editor truth)  
8. Final summary + `publish_job.py`

## Tools Index

Command examples, output keys, ngspice resolution, convergence rules, and
error table:
[references/tool-contracts.md](references/tool-contracts.md)

| Script | Role |
|---|---|
| `circuit_project.py workspace-*` | Resolve GUI workspace / projectsDir |
| `normalize_spec.py` | Spec normalization |
| `validate_netlist_primitives.py` | Kind-scoped netlist gate (`--project-kind`) |
| `project_kinds.py` / `stable_ids.py` | Project kind gates + persistent `stable_id` |
| `eda_bridge.py` / `eda_kicad_import.py` / `eda_jlceda_*` | PCB layout/property handoff (KiCad + experimental, vendor-unverified JLCEDA exchange JSON); not lossless connectivity co-editing |
| `lcsc_search.py` | 立创商城 search / get / bind (`eda.lcsc_id`) |
| `kicad_library.py` | Bundled KiCad lib index (`assets/kicad-lib`): symbol/footprint search, pin maps, raw S-expr; `kicad-lib-search/get/reindex` CLI |
| `analog_ic.py` | PDK/model-path and MOS W/L/M/NF audit before analog simulation/export |
| `pdk_registry.py` / `open_sim_providers.py` / `physical_verification.py` | Local PDK registry, OpenVAF/Xyce, and KLayout/Magic/Netgen providers |
| `schematic_handoff.py` | Desktop Import/Export schematic (KiCad/JLCEDA/… + Virtuoso/Xschem) |
| `xschem_bridge.py` | `.sch` render/parse helpers used by handoff; legacy peer CLI still present |
| `hdl_flow.py` | Verilog/Icarus/Yosys/OpenROAD flows |
| `razavi_bench.py` | Read-only upstream provenance check; task/evaluator access remains license-blocked |
| `strict_param_check.py` | Parameter sanity |
| `run_dual_analysis.py` / `run_ngspice.py` | Simulation |
| `patch_netlist.py` | Parameter patches |
| `validate_module_interfaces.py` / `compose_modules.py` / `repair_module_interfaces.py` | Partitioned jobs |
| `netlist_to_json.py` / `render_netlistsvg.py` / `check_svg_geometry.py` | Compat SVG export |
| `view_schematic_for_layout` / `review-schematic-layout-vision` | Vision-only PNG review and constrained layout-patch proposals; text-only models must not call this tool |
| `circuit_project.py` | Desktop project transactions |
| `eda_export.py` / `circuit_project.py export-eda` | Connectivity-preserving EDA IR, layout scoring, and KiCad/Altium/OrCAD/Virtuoso packages |
| `eda_bridge.py` + Bridge/LCSC CLI | PCB stable-ID handoff; see [references/eda-bridge-lcsc.md](references/eda-bridge-lcsc.md) |

Ngspice path order: `--ngspice-bin` → `NGSPICE_BIN` → `tool_paths.json` → `PATH`.

## Installation

```bash
python scripts/install_skill.py --agent all --scope user
python scripts/install_skill.py --agent all --scope user --check
python scripts/install_skill.py --agent all --scope user --force
```

Use `--scope project --project-root <path>` for a repo-local install.

## References and Assets

- [references/vision-layout-review.md](references/vision-layout-review.md) - vision-only layout review contract

- [references/project-agent-protocol.md](references/project-agent-protocol.md) — revisioned project loop
- [references/gui-project-canvas.md](references/gui-project-canvas.md) — desktop GUI contract
- [references/schematic-editor-guide.md](references/schematic-editor-guide.md) — schematic editor tools, save path, command.v2
- [references/user-reference-assets.md](references/user-reference-assets.md) — catalog import (circuit + schematic layout)
- [references/modular-project-design.md](references/modular-project-design.md) — default multi-module canvas design
- [references/analog-ic-design.md](references/analog-ic-design.md) — PDK, transistor sizing, ngspice, Razavi-Bench license boundary, and Virtuoso handoff
- [references/ic-platform-integration.md](references/ic-platform-integration.md) — IC PDK/tool setup, support matrix, migration, and security boundaries
- [references/ic-project-qualification.md](references/ic-project-qualification.md) — native IC golden-chain evidence and release gates
- [references/eda-export.md](references/eda-export.md) — multi-EDA schematic export contract
- [references/jobs-workflow.md](references/jobs-workflow.md) — jobs 8-step workflow
- [references/tool-contracts.md](references/tool-contracts.md) — CLI contracts and errors
- [references/module-plan-schema.md](references/module-plan-schema.md) — module-plan schema
- [references/partitioned-design.md](references/partitioned-design.md) — large-circuit partitioning (jobs path)
- [references/modular-project-design.md](references/modular-project-design.md) — default desktop multi-module design
- [references/spec-schema.md](references/spec-schema.md) — specification JSON schema
- `schemas/` — project/module/command/ERC/simulation JSON schemas
- `assets/templates/` — starter SPICE netlists
- `assets/skins/analog.svg` — netlistsvg analog skin
- `tool_paths.json` — optional ngspice path override
