# Schematic Editor Guide

User and agent tutorial for the Vibe Analog desktop schematic editor.
Editable truth remains `modules/<id>/module.circuit.json`
(`actoviq.module.v2`). Design and SVG both render the shared
`actoviq.schematic-document.v1` projection. Architecture decisions are in
`docs/adr/`.

## Open a module

1. Start the desktop app (`npm run electron:dev` from source).
2. Open or create a project under the active workspace `projects/`.
3. On the Design canvas, open a module card to enter the schematic editor.
4. Edits stay in a local draft until you **Apply** (`Ctrl+S`). Apply writes a
   revisioned transaction and rebuilds the affected module preview in the
   background.

Do not treat `build/` SVG, netlistsvg exports, or legacy
`schematic.overrides.json` as the primary edit path.

## Tools and shortcuts

| Action | Shortcut / control |
| --- | --- |
| Select | `S` |
| Wire | `W` |
| Cut wire once | `K` |
| Stretch move (keep connected wires) | `F8` |
| Free move (detach external wires) | `F7` |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Y` |
| Delete selection | `Delete` / `Backspace` |
| Apply + rebuild preview | `Ctrl+S` |
| Fit view | `F` |
| Cancel drag / in-progress gesture | `Esc` (does not clear place/wire/PDK mode) |
| Place primitives | palette: R / C / L / D / M / Q / V / I / Block |
| Bound PDK device (`analog_ic`) | PDK place control when a profile is active |

Pan with middle-drag or space+drag; zoom with wheel / `+` `-` / `Home`.

## Editing model

- One completed gesture becomes one local undo step. Apply packages the dirty
  draft as `actoviq.command.v2` operations (preferred) against
  `expected_module_revision`.
- Undo/redo history survives Apply so you can reverse post-save mistakes in the
  editor session.
- Inline ERC diagnostics update as you edit; blocking ERC must be fixed before
  treating a design as verified.
- If another actor holds a soft lease on the module, or the on-disk module
  revision advanced while your draft was open, Apply is blocked until you
  reload or resolve the conflict. Do not force-overwrite.

### Move policies

- **Stretch**: moving a symbol keeps attached wire endpoints connected and
  re-routes orthogonal segments.
- **Free**: moving a symbol detaches external wires; reconnect explicitly.

### Wires and topology

- Orthogonal routing with pin snap and priority snap points.
- Cut (`K`) splits a wire once at the click point and creates unique junction
  ids.
- Junction upsert / bend-vertex split are first-class topology ops; existing
  bend vertices may be split without throwing.
- Rename net updates pin/port/wire nets and the module `nets[]` table together.

### Label placement

- Net labels, port names, and component Reference/Value texts share one
  deterministic collision pass in the projection. When default anchors
  overlap, labels try a fixed order of grid-step offsets (along their stub,
  flipped across it, then perpendicular); wire-attached labels never leave
  their stub. Resolved overrides are stored on the document as
  `labelPlacements` (`netlabel:<id>`, `port:<id>`,
  `component:<id>:name|value`); labels absent there render at their default
  anchor. Same module input always yields the same placement.

### Hierarchy and search

- Navigate into `module_ref` / hierarchy targets from the editor chrome.
- Project search and probe mapping bind schematic selections to simulation
  vectors after a current-revision simulate.
- Agent transaction review can accept or reject proposed `command.v2`
  operation batches before they hit disk.

## Persistence path (GUI)

```text
editor draft
  → diff to actoviq.command.v2 operations
  → apply (lease + project/module revision checks)
  → modules/<id>/module.circuit.json updated
  → projectSchematicArtifact(draft stamped to post-apply revision)
  → compile-module / background preview rebuild
  → build/modules/<id>/schematic-document.json + SVG
```

After Apply, the editor draft may still carry the pre-apply module revision for
one compile hop. The write path allows that single-step lag when entity and wire
ids still match, then stamps the disk revision onto the artifact. Older
revision lags or mismatched entity/wire ids are rejected as stale.

## Agent / CLI path

Prefer fine-grained `actoviq.command.v2` for schematic topology edits.
Keep `actoviq.command.v1` for project-canvas ops (`connect_ports`,
`upsert_module_netlist`, …) and for compatibility batch import via
`set_module_schematic`.

```bash
# Inspect before editing
python scripts/circuit_project.py agent-context --project-root <project>

# Soft lease (GUI holds this while a module editor is open)
python scripts/circuit_project.py module-lease-acquire \
  --project-root <project> --module-id <id> --actor agent
python scripts/circuit_project.py module-lease-release \
  --project-root <project> --module-id <id> --actor agent

# Apply a v2 transaction file
python scripts/circuit_project.py apply \
  --project-root <project> \
  --command-file <command.v2.json>

python scripts/circuit_project.py compile-module \
  --project-root <project> --module-id <id>
```

Minimal `actoviq.command.v2` shape:

```json
{
  "schema": "actoviq.command.v2",
  "command_id": "agent-wire-001",
  "actor": "agent",
  "project_id": "demo",
  "module_id": "buck_core",
  "base_revision": 3,
  "expected_module_revision": 5,
  "message": "Create net between R1.2 and C1.1",
  "source": "agent",
  "operations": [
    {
      "op": "create_wire",
      "wire": {
        "id": "w_r1_c1",
        "net": "vout",
        "points": [
          { "x": 120, "y": 80 },
          { "x": 200, "y": 80 }
        ]
      }
    }
  ]
}
```

Supported v2 operations: `place_component`, `update_component`,
`move_entities`, `delete_entities`, `create_wire`, `edit_wire_path`,
`split_wire`, `join_wires`, `upsert_junction`, `rename_net`, `upsert_port`,
`place_module_instance`, `set_module_metadata`.

Schema: `schemas/command.v2.schema.json`. See ADR-0003 / ADR-0004.

## Kind-scoped parameters

The inspector form follows `project_kind`:

| Kind | Typical fields |
| --- | --- |
| `simulation` | Primitive value, model hints for D/Q/M |
| `pcb_schematic` | Value, LCSC / refdes readiness fields |
| `analog_ic` | Device binding, W/L/M/NF, PDK-aware MOS placement |

Changing MOS name/value polarity (NMOS ↔ PMOS) invalidates pin geometry caches;
the projection facade rebuilds drain/source anchors so wires stay aligned.

## Verification checklist

After meaningful schematic edits:

1. Apply succeeds (no lease / revision conflict).
2. Inline ERC has no blocking errors.
3. `compile-module` (or project `compile`) matches the current revision/hash.
4. Run required simulations when the kind requires them.
5. For GUI changes in this repository, also run:
   - `npm run test:schematic-document`
   - `npm run test:e2e:schematic-editor`

## Related docs

- [gui-project-canvas.md](gui-project-canvas.md) — workspace and canvas contract
- [project-agent-protocol.md](project-agent-protocol.md) — revisioned agent loop
- [modular-project-design.md](modular-project-design.md) — multi-module defaults
- [analog-ic-design.md](analog-ic-design.md) — PDK / sizing loop
- `docs/adr/0001`–`0005` — frozen architecture decisions
