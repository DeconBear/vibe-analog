# vibe-analog

[English](./README.md) | [简体中文](./README-zh.md)

Agent-native ngspice circuit-design workbench. It turns natural-language requirements into SPICE-oriented schematic design artifacts: principle schematic design, netlist generation, ngspice simulation, netlistsvg schematic rendering, and engineering reports. It is not yet a PCB layout, IC layout, signoff, or production-hardware validation tool. Future work will add more practical design automation, richer component libraries, stronger schematic layout quality, and deeper verification flows.

There are three ways to use it:

- **Desktop GUI (recommended)** — an Electron workbench whose home screen is a modular schematic canvas. Claude Code / Codex drive the design through the portable skill, and results appear live in the GUI. No API key is required for this path.
- **Portable skill** — `skills/circuit-design-ngspice/` runs inside Claude Code, OpenAI Codex, Cursor, or any agent that can read a Markdown prompt and run shell commands.
- **Built-in CLI/TUI** — a self-contained chat/slash-command agent that talks to an Anthropic-compatible API (requires a provider token).

## What It Does

- Accepts natural-language circuit requirements from the terminal.
- Starts in a lightweight TUI by default for chat, slash commands, design, and revision workflows.
- Streams each agent stage in real time.
- Supports `/allow manual`, `/allow execution`, and `/allow all` confirmation policies.
- Generates English-safe job slugs even when the requirement is written in Chinese.
- Designs primitive-oriented SPICE netlists, runs ngspice verification, and renders netlistsvg schematics.
- Bundles circuit templates, Python helpers, and render assets inside this package.

## Desktop GUI (Agent-Native Workbench)

The Electron desktop app is a result-first workbench: the home screen is a modular schematic canvas, and the chat panel is an optional drawer. The API key is only needed for the built-in chat workflow — opening the GUI, managing workspaces, and displaying results produced by Claude Code / Codex all work without one.

Launch it from a source checkout:

```bash
npm install
python3 -m pip install --requirement requirements-circuit.txt
npm run electron:dev
```

Windows (PowerShell) uses the same npm commands:

```powershell
npm install
npm run electron:dev
```

This compiles the Electron main process, starts Vite, and opens the window. On Linux, a graphical session (`DISPLAY` / Wayland) is required for the Electron window.

**Linux runtime prerequisites (desktop GUI + ngspice)**

- Node.js 22+, npm, Python 3.10+
- `ngspice` on `PATH` for simulation (`sudo apt-get install -y ngspice` on Debian/Ubuntu)
- Optional open IC tools for local probes: `iverilog`, `yosys`, `xschem`, `klayout`, `magic`, `netgen-lvs`
- Full native IC qualification still locks to native Ubuntu 22.04 (non-WSL) plus ngspice/Xyce/OpenVAF/Xschem and the pinned IHP revision; see `plan/actoviq-ic-platform-implementation-plan.md`

Production build without the Vite dev server:

```bash
npm run build:all
npm run electron:start
```

`electron:start` sets `ACTOVIQ_USE_BUILT_RENDERER=1` so the unpackaged Electron process loads `dist-renderer/` instead of `http://127.0.0.1:5173`.

**App icon**

- Canonical assets: `assets/icon.png` (cross-platform) and `assets/icon.ico` (Windows multi-size).
- Runtime/packaging: Windows window/taskbar prefers `.ico` and sets `AppUserModelId` to `com.vibeanalog.app`; macOS/Linux packaging uses `assets/icon.png` (`electron-builder.yml` `linux.icon`).
- When replacing branding, update both files and keep `electron-builder.yml` `win.icon` / `mac.icon` / `linux.icon` pointed at them. Do not ship draft `assets/icon-scheme-*.png` candidates as the packaged icon.

**Tabs**

- **Design** — each module opens in a grid-based schematic editor backed by `actoviq.module.v2`. Tools: select (`S`), wire (`W`), cut (`K`), stretch (`F8`) / free (`F7`) move, place R/C/L/D/M/Q/V/I or custom-pin blocks, plus bound PDK devices for `analog_ic`. Orthogonal routing, junction/bend topology, inline ERC, hierarchy navigation, simulation probe mapping, and Agent transaction review are first-class. Edits stay in a local draft; **Apply** (`Ctrl+S`) writes `actoviq.command.v2` and rebuilds the preview. Soft leases and revision conflicts block save until resolved. Pins/ports use stable `net_id` values; names, aliases, and labels are explicit. Full shortcuts and save path: [schematic-editor-guide.md](./skills/circuit-design-ngspice/references/schematic-editor-guide.md).
- **Design memory** — *Save template* and *Save flow* store revision, document hash, circuit family, simulation coverage, and validation status under `references/design-memory/`. Agent reuse prioritizes validated memories and still requires fresh ERC and simulation.
- **Netlist** — an editable Markdown notebook per module: fenced `spice` blocks are the netlist, prose around them is notes. Supported devices become native editable symbols; kind-valid `.model`, `.param`, analyses, measurements, and opaque statements survive round trips, while forbidden prefixes/directives fail before parsing. Saving commits the document and rebuilds previews from the same revision.
- **SVG** — the selected module's `SchematicDocument` preview, matching the editable module view.
- **Schematic document source of truth** — Design and SVG render the same `actoviq.schematic-document.v1` projection of `actoviq.module.v2`. Semantic pin anchors, including MOS `D/G/S/B`, explicit wires, labels, and layout are shared. The netlistsvg path remains a compatibility/export build with independent geometry checks, not a second editable model.
- **Sim** — revision-bound ngspice runs for OP, DC sweep, AC, transient, S-parameter, noise, pole-zero, FFT, parameter sweep, and Monte Carlo. The workbench separates execution, measurement, and specification status and displays Cartesian, Bode, polar, Smith, and table views. Select a schematic pin/wire or component to add its mapped voltage or real device-current trace. Large datasets are read through a bounded, viewport-aware IPC path.
- **Report** — a generated Markdown report containing source revision/hash, ERC, models, analyses, metrics, specification results, diagnostics, and the system netlist.

**Workspaces** — create multiple isolated workspaces, each with its own `projects/`, `jobs/`, and `references/`. The workspace root is user-selectable and defaults inside the repo under `workspace/` (git-ignored). Drop reference PDFs/images into `references/` and optionally run them through a configurable Yunzhisheng-compatible OCR endpoint (set in Settings).

**Project lifecycle** — project deletion moves items to `.trash/projects/`; the Trash view can restore or permanently purge them. The project list supports context-menu deletion and multi-select. Every user or Agent transaction produces a restorable revision with actor, parent, content hash, normalized netlist, document snapshot, build provenance, and netlist diff.

**How the agent drives it** — Claude Code / Codex use the `circuit-design-ngspice` skill to create and edit projects under the active workspace; the GUI watches those files and refreshes the affected card. Prefer `actoviq.command.v2` for schematic topology and honor module soft leases. See [SKILL.md](./skills/circuit-design-ngspice/SKILL.md) and [schematic-editor-guide.md](./skills/circuit-design-ngspice/references/schematic-editor-guide.md).

### Project kinds, EDA Bridge, and LCSC

When creating a blank/demo project, choose a **project kind** (legacy projects migrate to `simulation`):

| Kind | Purpose | Default loop |
| --- | --- | --- |
| Simulation (`simulation`) | Primitive-only SPICE verification | kind gate → ERC → compile → ngspice |
| PCB schematic (`pcb_schematic`) | External PCB EDA handoff + LCSC metadata | ERC → part/refdes readiness → validated KiCad handoff / experimental JLCEDA exchange; sim optional |
| Analog IC (`analog_ic`) | PDK-bound transistor sizing | PDK/W/L audit → ERC → compile → ngspice → Virtuoso package |
| Mixed-signal IC (`mixed_signal_ic`) | Analog modules plus HDL-owned digital blocks | Per-domain verification → explicit interface contract → qualified commercial AMS |

**Recommended joint workflow (PCB schematic)**

1. Create a project with kind **PCB schematic**.
2. Finish the schematic with AI or the manual editor.
3. Optionally configure LCSC API key/secret under Settings → 立创商城; enable fallback only for offline demo search.
4. Open **Export EDA**: link KiCad / 嘉立创 EDA folders, then Push / Pull (identity via `stable_id` / `ACTOVIQ_ID`; peer PCB files are never overwritten). The JLCEDA JSON path is experimental and has not yet been validated by the vendor application.
5. Continue edits / board layout in the external EDA. Pull reconciles ONLY component layout/properties (position, rotation, value, symbol, refdes) of known components matched by `stable_id`; peer connectivity edits (wires/labels) are never reconstructed. Pull detects such edits via a connectivity hash against the last push, flags them as `connectivity_drift` (with `requires_review`), and skips automatic persistence — redo connectivity changes on the Actoviq side and re-push.
6. One-shot zip export remains available for controlled handoff and Altium-via-KiCad.

For **Analog IC**, configure the user-supplied PDK/model library and corner, require explicit MOS W/L/M/NF, run `analog-ic-audit` plus ngspice, then export the revision/hash-bound SPICE/CDL + mapping + SKILL Virtuoso package. Foundry models are referenced, not bundled. Razavi-Bench evaluation remains disabled pending the written permission required by its benchmark-material license; the included command performs provenance preflight only.

The open-PDK, Xschem, OpenVAF/Xyce, physical verification, HDL, OpenROAD, and
licensed EDA integration contracts are documented in
[IC Platform Integration](./skills/circuit-design-ngspice/references/ic-platform-integration.md).

**Out of scope**: PCB layout, footprint generation, DFM, LCSC ordering.

Details / CLI:

- [schematic-editor-guide.md](./skills/circuit-design-ngspice/references/schematic-editor-guide.md)
- [eda-bridge-lcsc.md](./skills/circuit-design-ngspice/references/eda-bridge-lcsc.md)
- [SKILL.md](./skills/circuit-design-ngspice/SKILL.md)
- [project-agent-protocol.md](./skills/circuit-design-ngspice/references/project-agent-protocol.md)

## Quick Start (CLI / TUI)

### 1. Install the CLI

This project is **not** published to npm. Use a source checkout (or install the desktop app from [GitHub Releases](https://github.com/DeconBear/vibe-analog/releases)):

```powershell
git clone https://github.com/DeconBear/vibe-analog.git
cd vibe-analog
npm install
python -m pip install schemdraw
npm run build
npm link
```

### 2. Install and Configure ngspice

`vibe-analog` does not bundle ngspice. Install ngspice separately, then configure it with either `NGSPICE_BIN` or your system `PATH`.

Recommended on Windows:

```powershell
[Environment]::SetEnvironmentVariable(
  'NGSPICE_BIN',
  'C:\path\to\ngspice.exe',
  'User'
)
```

Open a new terminal after setting a permanent environment variable.

Temporary PowerShell session:

```powershell
$env:NGSPICE_BIN='C:\path\to\ngspice.exe'
```

macOS/Linux:

```bash
export NGSPICE_BIN=/usr/local/bin/ngspice
```

You can also add `ngspice` to your system `PATH`.

Resolution priority:

1. Python script argument `--ngspice-bin`
2. Environment variable `NGSPICE_BIN`
3. Packaged `embedded/circuit-design/tool_paths.json`
4. `ngspice` found on system `PATH`

Prefer `NGSPICE_BIN` or `PATH` over editing packaged `tool_paths.json`.

### 3. About Red Error Messages

During agent execution you may see red error messages in the terminal. These are produced by agent tool calls and exist to show whether the agent can detect and self-correct errors. They do **not** mean the workflow has failed. The agent often retries with alternative approaches and continues normally. If the workflow reaches the final summary stage, the design is complete regardless of intermediate tool errors.

### 4. Configure the Vibe Analog Provider

`vibe-analog` talks to the model through an Anthropic-compatible API (the same request/response format as `https://api.anthropic.com/v1/messages`). Any provider that exposes that interface — Anthropic itself, an enterprise gateway, or a self-hosted proxy — works as long as it accepts an Anthropic-style auth header and returns Anthropic-style streaming responses.

Create an Vibe Analog config in the directory where you will run the CLI, or use `~/.actoviq/settings.json`.

```powershell
mkdir my-circuit-workspace
cd my-circuit-workspace
copy C:\path\to\agent.settings.example.json .\actoviq.settings.json
```

Edit `actoviq.settings.json` and fill in your provider endpoint, token, and model names. Never commit real API keys.

### 5. Start the Agent

Run the CLI from the directory you want to use as the workspace:

```powershell
vibe-analog
```

The current directory becomes the workspace. Outputs are written to:

```text
./jobs/<job-id>/
./sessions/
```

Inside the TUI:

```text
/help
/allow execution
/design Design an op-amp gain stage followed by an RC filter and active-low comparator output.
```

Use `/allow all` for fully automatic stage transitions, or `/allow manual` to confirm every stage.

> The bundled TUI drives the legacy multi-stage workflow. For conversational work prefer `vibe-analog chat` (below), which runs the same CodeAct engine as the desktop chat.

### 6. Chat Mode (CodeAct)

```powershell
vibe-analog chat
```

Runs the same desktop CodeAct agent in the terminal: circuits, modules, and artifacts are still written to the workspace as files. Configure the model via `ACTOVIQ_API_KEY` / `ACTOVIQ_BASE_URL` / `ACTOVIQ_MODEL` env vars (e.g. the Zhipu coding plan endpoint `https://open.bigmodel.cn/api/coding/paas/v4` with model `glm-5.3-flash`), or via an `agent.settings.json` `env` block passed with `--settings <path>`. Inside the chat: `/new` starts a fresh conversation, `/approval manual|execution|all` sets the approval policy, `/exit` leaves.

### 7. One-Shot Run

```powershell
vibe-analog --approval-policy execution --job-name rc-demo --requirement "Design a 1 kHz RC low-pass filter and output the netlist, simulation report, and SVG schematic."
```

For source checkout development, replace `vibe-analog` with:

```powershell
npm run dev -- --approval-policy execution --job-name rc-demo --requirement "Design a 1 kHz RC low-pass filter and output the netlist, simulation report, and SVG schematic."
```

## Run From Source

```powershell
npm run dev
```

The default entry opens the TUI. Type normal questions to chat with the general agent, or use slash commands:

```text
/help
/allow execution
/design Design a 1 kHz RC low-pass filter
/modify Increase the output drive and redraw the schematic
```

Use the previous one-shot requirement prompt with:

```powershell
npm run dev -- --legacy-cli
```

Source smoke run:

```powershell
npm run dev -- --auto-approve --job-name rc-demo --requirement "Design a 1 kHz RC low-pass filter and output the netlist, simulation report, and netlistsvg schematic."
```

Schematic editor changes must pass the document, Playwright, and legacy render regressions:

```powershell
npm run test:schematic-document
npm run test:e2e:schematic-editor
npm run test:e2e:electron
npm test
npm run test:schematic-quality
npm run test:simulation-regression
```

## Linked Local CLI

For editable local installation:

```powershell
npm link
vibe-analog --help
```

When installed with `npm link`, the command uses the directory where you run it as the workspace root. Outputs go to:

```text
./jobs/<job-id>/
./sessions/
```

Override that behavior with:

```powershell
$env:ACTOVIQ_CIRCUIT_AGENT_WORKSPACE_ROOT='C:\path\to\workspace'
```

## Config Resolution

Vibe Analog config is loaded in this order:

1. `--config <path>` or `ACTOVIQ_AGENT_CONFIG_PATH`
2. `./agent.settings.local.json` in the current working directory
3. `./actoviq.settings.json` in the current working directory
4. `agent.settings.local.json` in the package checkout
5. `~/.actoviq/settings.json`

Do not commit real API keys. Use `agent.settings.example.json` as the template.

## Large Circuit Partitioning

Large designs are partitioned by function during the design stage. The workflow writes `planning/module-plan.json` and `design/module-manifest.json`, then reuses those module boundaries during rendering. The final netlistsvg output is a single SVG sheet with labelled module/submodule sections; cross-module connectivity is represented by matching net labels and visible ports instead of long cross-sheet wires.

## Rendering

Desktop projects use one semantic document for both editing and SVG display:

- `modules/<id>/module.circuit.json` is the revisioned electrical and editable source. Stable net IDs carry connectivity; labels and aliases do not alter topology.
- Design and SVG create the same `SchematicDocument`, including symbols, pin anchors, orthogonal routes, junctions, explicit labels, and view bounds.
- `render/netlistsvg.svg` and module compatibility builds preserve the established AI/netlist-to-netlistsvg export path. They are checked against the same topology but are not parsed back into the editor.
- In schematic view, bench-only voltage/current sources are hidden to keep the
  drawing readable. When one of those hidden sources drives a visible
  non-rail control or bias node, the renderer exposes a named terminal such as
  `GATE`, `VREF`, `ITAIL`, or `VB` and routes it as a real net connection.
- User electrical/layout edits are committed to the module document in one
  transaction. Legacy `schematic.overrides.json` files remain readable for
  compatibility and netlistsvg-only positioning.
- Reusable project templates and process notes saved from the GUI live under
  the active workspace's `references/design-memory/` folder. The Agent asset
  reuse stage lists those saved templates and flows alongside bundled starter
  templates.
- Rendering writes geometry/readability reports next to the SVG. These reports
  check missing pin connections, wire crossings, component overlaps, wire-body
  intrusions, and tight spacing.
- `npm run test:schematic-quality` generates a small regression corpus under
  `output/schematic-quality/` (RC, RLC, rectifier, BJT, MOS, and LDO examples),
  applies starter `schematic.overrides.json` placements, renders SVGs, and
  fails if any hard geometry check regresses.

`netlistsvg` is a Node.js package required for rendering. Install it once:

```powershell
npm install -g netlistsvg
```

## Standalone Skill (Claude Code / Codex / Cursor)

The `skills/circuit-design-ngspice/` directory contains a portable,
agent-runtime-agnostic skill that captures the same circuit-design workflow
without depending on `actoviq-agent-sdk`. It can be used directly inside
Claude Code, OpenAI Codex, Cursor, or any AI coding tool that can read a
Markdown prompt and execute shell commands.

### Installing the Skill

```powershell
# Install the same skill source for both Codex and Claude Code.
python skills\circuit-design-ngspice\scripts\install_skill.py --agent all --scope user
```

For a project-scoped install:

```powershell
python skills\circuit-design-ngspice\scripts\install_skill.py `
  --agent all `
  --scope project `
  --project-root C:\path\to\project
```

The installer copies one portable source into `.codex/skills/` and
`.claude/skills/`. Use `--force` to replace an existing installed copy.

**Manual use with any agent**:

Load `SKILL.md` into the agent's context and tell it to follow the
instructions. All Python scripts are under `skills/circuit-design-ngspice/scripts/`
and accept standard `argparse` arguments.

### Configuring ngspice for the Skill

The skill resolves ngspice in this order:

1. `--ngspice-bin` argument passed directly to Python scripts
2. `NGSPICE_BIN` environment variable
3. `tool_paths.json` in the skill root directory
4. system `PATH`

To configure it permanently, either set the environment variable (see
section 2 above) or edit the skill's `tool_paths.json`:

```json
{
  "ngspice_bin": "E:/Program/ngspice-45.2_64/Spice64/bin/ngspice.exe"
}
```

The skill reads `tool_paths.json` from its own directory, so each copy of
the skill can point to a different ngspice installation.

### Installing netlistsvg for the Skill

The `render_netlistsvg.py` script requires the `netlistsvg` CLI on your
system PATH:

```powershell
npm install -g netlistsvg
```

Verify it is reachable:

```powershell
netlistsvg --help
```

### Running a Design with the Skill

Tell the agent to load `SKILL.md` and provide a circuit requirement:

```
Please follow the circuit-design-ngspice skill in skills/circuit-design-ngspice/SKILL.md.
Design a 1 kHz RC low-pass filter and render the schematic.
```

The agent will create a workspace directory, run the 8-step workflow,
and produce all design artifacts including `design/design.final.cir`,
`render/netlistsvg.svg`, and `reports/final-summary.md`.

**Canvas project model (used with the desktop GUI).** When the GUI is open, the
agent works on the editable project model instead of the one-shot job workflow:
`scripts/circuit_project.py` creates and revises a project under
`<workspace>/projects/<id>/` (a `project.circuit.json` plus per-module
`modules/<id>/module.circuit.json` and `netlist-notebook.md`), then compiles and
simulates it. The GUI watches those files and refreshes the canvas, Netlist,
SVG, Sim, and Report tabs live. The full command and operation contract is in
[SKILL.md](./skills/circuit-design-ngspice/SKILL.md) under *GUI Project Canvas
Contract*.

## Validation

```powershell
npm test
npm run test:schematic-document
npm run test:schematic-quality
npm run test:simulation-regression
npm run test:e2e:schematic-editor
npm run test:e2e:electron
npm run build
npm run pack:dry-run
```
