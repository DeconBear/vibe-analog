# vibe-analog

[English](./README.md) | [简体中文](./README-zh.md)

AI Agent 原生的、基于 ngspice 的电路设计工作台。

本项目把自然语言电路需求转换为面向 SPICE 的原理图设计产物：原理图级设计、网表生成、ngspice 仿真、netlistsvg 电路图渲染和工程报告。它还不是 PCB layout、IC layout、signoff 或生产级硬件验证工具。后续会继续开发更实用的设计自动化能力、更丰富的器件库、更高质量的原理图布局，以及更深入的验证流程。

共有三种使用方式：

- **桌面 GUI（推荐）**——一个 Electron 工作台，首页就是模块化原理图画布。Claude Code / Codex 通过可移植 skill 驱动设计，结果实时显示在 GUI 中。这条路径无需 API Key。
- **可移植 skill**——`skills/circuit-design-ngspice/` 可在 Claude Code、OpenAI Codex、Cursor，或任何能读取 Markdown 提示并执行 shell 命令的 Agent 中运行。
- **内置 CLI / TUI**——自带的对话 / 斜杠命令 Agent，通过 Anthropic 兼容 API 工作（需要 Provider Token）。

## 功能概览

- 在终端中接收自然语言电路需求。
- 默认启动轻量 TUI，支持对话、斜杠命令、设计和修改工作流。
- 实时流式输出每个 Agent 阶段。
- 支持 `/allow manual`、`/allow execution` 和 `/allow all` 三种确认策略。
- 即使用户用中文描述需求，也会生成英文安全的 job slug。
- 生成 primitive-oriented SPICE 网表，调用 ngspice 验证，并渲染 netlistsvg 原理图。
- 内置电路模板、Python 辅助脚本和渲染资源。

## 桌面 GUI（AI Agent 原生工作台）

Electron 桌面应用是一个“结果优先”的工作台：首页是模块化原理图画布，聊天面板只是可选抽屉。只有内置对话工作流才需要 API Key——打开 GUI、管理工作空间、展示 Claude Code / Codex 生成的结果都无需 Key。

从源码启动：

```bash
npm install
python3 -m pip install --requirement requirements-circuit.txt
npm run electron:dev
```

Windows（PowerShell）可用同样的 npm 命令：

```powershell
npm install
npm run electron:dev
```

该命令会先编译 Electron 主进程，启动 Vite，并打开窗口。Linux 需要图形会话（`DISPLAY` / Wayland）才能显示 Electron 窗口。

**Linux 运行前置（桌面 GUI + ngspice）**

- Node.js 22+、npm、Python 3.10+
- `PATH` 中可调用 `ngspice`（Debian/Ubuntu：`sudo apt-get install -y ngspice`）
- 可选开源 IC 探测工具：`iverilog`、`yosys`、`xschem`、`klayout`、`magic`、`netgen-lvs`
- 完整 native IC 资格仍锁定原生 Ubuntu 22.04（非 WSL），以及 ngspice/Xyce/OpenVAF/Xschem 与固定 IHP revision；详见 `plan/actoviq-ic-platform-implementation-plan.md`

不含 Vite 开发服务器的生产构建启动：

```bash
npm run build:all
npm run electron:start
```

`electron:start` 会设置 `ACTOVIQ_USE_BUILT_RENDERER=1`，让未打包的 Electron 进程加载 `dist-renderer/`，而不是 `http://127.0.0.1:5173`。

**应用图标**

- 正式资源：`assets/icon.png`（全平台）与 `assets/icon.ico`（Windows 多尺寸）。
- 开发与打包：Windows 窗口/任务栏优先使用 `.ico`，并设置 `AppUserModelId` 为 `com.vibeanalog.app`；macOS/Linux 打包使用 `assets/icon.png`（`electron-builder.yml` 的 `linux.icon`）。
- 更换品牌图时请同时更新这两个文件，并保持 `electron-builder.yml` 的 `win.icon` / `mac.icon` / `linux.icon` 指向它们。不要用 `assets/icon-scheme-*.png` 候选稿作为打包图标。

**标签页**

- **Design**——每个模块都可在基于 `actoviq.module.v2` 的网格原理图编辑器中打开。工具：选择 (`S`)、连线 (`W`)、剪线 (`K`)、拉伸移动 (`F8`) / 自由移动 (`F7`)，放置 R/C/L/D/M/Q/V/I 或自定义引脚 Block，以及 `analog_ic` 下的绑定 PDK 器件。支持正交布线、结点/折点拓扑、即时 ERC、层级导航、仿真探针映射，以及 Agent 事务审阅。编辑留在本地草稿；**Apply**（`Ctrl+S`）写入 `actoviq.command.v2` 并后台重建预览。模块软租约与 revision 冲突时会阻止保存。引脚/端口引用稳定 `net_id`；网络名、别名与标签是显式属性。完整快捷键与保存路径见 [schematic-editor-guide.md](./skills/circuit-design-ngspice/references/schematic-editor-guide.md)。
- **Design memory**——*Save template* 和 *Save flow* 会在 `references/design-memory/` 中保存来源 revision、文档哈希、电路族、仿真覆盖和验证状态。Agent 优先复用已验证记录，但仍会重新执行 ERC 和仿真。
- **Netlist**——每个模块一份可编辑的 Markdown 笔记本：`spice` 代码块是网表，代码块之外是说明。受支持器件会映射为原生可编辑符号；符合当前项目类型的 `.model`、`.param`、分析、测量及 opaque 语句会被保留，禁止的前缀/指令会在解析前失败。保存会提交统一文档并从同一 revision 重建预览。
- **SVG**——当前模块的 `SchematicDocument` 预览，与 Design 编辑器使用完全相同的几何结果。
- **统一原理图真源**——Design 和 SVG 都渲染 `actoviq.module.v2` 投影出的 `actoviq.schematic-document.v1`。MOS `D/G/S/B` 等语义引脚锚点、显式导线、标签和布局完全共享。netlistsvg 继续用于兼容导出和独立几何质量检查，但不再是第二份可编辑模型。
- **Sim**——按 revision 运行 ngspice，支持 OP、DC Sweep、AC、Transient、S 参数、Noise、Pole-Zero、FFT、参数扫描和 Monte Carlo。工作台分别显示执行、测量和规格状态，并提供 Cartesian、Bode、Polar、Smith 和表格视图；在原理图中选中引脚/导线或器件，可添加经 source-map 映射的节点电压或真实器件电流 trace；长波形通过限制点数且支持视口范围的 IPC 读取。
- **Report**——自动生成包含来源 revision/hash、ERC、模型、分析条件、指标、规格结果、失败诊断和系统网表的 Markdown 报告。

**工作空间**——可创建多个相互隔离的工作空间，每个都有独立的 `projects/`、`jobs/` 和 `references/`。工作空间根目录可由用户选择，默认在仓库内 `workspace/`（已被 git 忽略）。把参考 PDF / 图片放进 `references/`，可选地通过可配置的云知声兼容 OCR 接口识别（在设置中配置）。

**项目生命周期**——删除项目默认移动到 `.trash/projects/`，可在回收站视图中恢复或永久清理；项目列表支持右键删除和批量选择。用户或 Agent 的每个事务都会生成可恢复 revision，记录 actor、父版本、内容哈希、规范化网表、文档快照、构建来源和网表 diff。

**Agent 如何驱动**——Claude Code / Codex 使用 `circuit-design-ngspice` skill 在当前工作空间下创建和修改项目；GUI 监听这些文件并刷新对应卡片。原理图拓扑编辑优先使用 `actoviq.command.v2`，并遵守模块软租约。详见 [SKILL.md](./skills/circuit-design-ngspice/SKILL.md) 与 [schematic-editor-guide.md](./skills/circuit-design-ngspice/references/schematic-editor-guide.md)。

### 项目类型、EDA Bridge 与立创商城

创建空白/演示项目时可选择 **项目类型**（旧项目默认 `simulation`）：

| 类型 | 用途 | 默认闭环 |
| --- | --- | --- |
| 仿真验证 (`simulation`) | 仅原语 SPICE 验证 | 类型门禁 → ERC → 编译 → ngspice |
| PCB 原理图 (`pcb_schematic`) | 外部 PCB EDA 交接 + 立创商城元数据 | ERC → 器件/位号就绪 → 已验证 KiCad 交接 / 实验性嘉立创交换；仿真可选 |
| 模拟 IC (`analog_ic`) | 绑定 PDK 的晶体管尺寸设计 | PDK/W/L 审计 → ERC → 编译 → ngspice → Virtuoso 包 |

**推荐联合用法（PCB 原理图）**

1. 新建项目，选择「PCB 原理图」。
2. 用 AI 或手工完成原理图。
3. （可选）Settings →「立创商城 (LCSC)」填 API Key/Secret；无密钥时可开 fallback 做离线演示搜料。
4. 打开 **Export EDA** 对话框：在 **EDA Bridge** 区 Link KiCad / 嘉立创 EDA 文件夹，Push 写出、Pull 拉回（按 `stable_id`/`ACTOVIQ_ID` 对齐，不覆盖 peer 侧 PCB）。嘉立创 JSON 路径目前是实验性交换格式，尚未经过厂商应用导入验证。
5. 在外部 EDA 继续改图 / 画板。Pull 只对齐已知器件（按 `stable_id` 匹配）的布局/属性（位置、旋转、value、symbol、refdes）；peer 侧连线（wire/label）修改一律不会重建。Pull 通过与上次 Push 的连通性哈希比对检测这类修改，标记为 `connectivity_drift`（并置 `requires_review`），跳过自动落盘——请在 Actoviq 侧重做连线修改后重新 Push。
6. 一次性 zip 导出继续用于受控交接以及 Altium-via-KiCad。

**模拟 IC**：配置用户自备的 PDK/模型库与 corner，要求 MOS 明确给出 W/L/M/NF，先运行 `analog-ic-audit` 和 ngspice，再导出绑定 revision/hash 的 SPICE/CDL、映射、manifest 与 SKILL Virtuoso 包；foundry 模型只引用、不打包。Razavi-Bench 的评测材料许可证要求第三方评测套件先取得书面许可，因此当前只提供来源/revision/LICENSE 预检，题目读取与评分执行保持禁用。

**明确不做**：PCB 布局、足迹自动生成、DFM、嘉立创下单。

细节与 CLI：

- [schematic-editor-guide.md](./skills/circuit-design-ngspice/references/schematic-editor-guide.md)
- [eda-bridge-lcsc.md](./skills/circuit-design-ngspice/references/eda-bridge-lcsc.md)
- [SKILL.md](./skills/circuit-design-ngspice/SKILL.md)
- [project-agent-protocol.md](./skills/circuit-design-ngspice/references/project-agent-protocol.md)

## 快速开始（CLI / TUI）

### 1. 安装 CLI

本项目**不**发布到 npm。请从源码安装（桌面版也可从 [GitHub Releases](https://github.com/DeconBear/vibe-analog/releases) 下载）：

```powershell
git clone https://github.com/DeconBear/vibe-analog.git
cd vibe-analog
npm install
python -m pip install schemdraw
npm run build
npm link
```

### 2. 安装并配置 ngspice

`vibe-analog` 不内置 ngspice。请单独安装 ngspice，然后通过 `NGSPICE_BIN` 或系统 `PATH` 配置。

Windows 推荐方式：

```powershell
[Environment]::SetEnvironmentVariable(
  'NGSPICE_BIN',
  'C:\path\to\ngspice.exe',
  'User'
)
```

设置永久环境变量后，需要重新打开终端。

仅当前 PowerShell 会话生效：

```powershell
$env:NGSPICE_BIN='C:\path\to\ngspice.exe'
```

macOS/Linux：

```bash
export NGSPICE_BIN=/usr/local/bin/ngspice
```

也可以直接把 `ngspice` 加入系统 `PATH`。

ngspice 路径解析优先级：

1. Python 脚本参数 `--ngspice-bin`
2. 环境变量 `NGSPICE_BIN`
3. 包内 `embedded/circuit-design/tool_paths.json`
4. 系统 `PATH` 中的 `ngspice`

推荐使用 `NGSPICE_BIN` 或 `PATH`，不要直接改包内的 `tool_paths.json`。

### 3. 关于红色报错信息

Agent 运行过程中终端可能会出现红色报错信息。这些是由 Agent 工具调用产生的，用于监看 Agent 是否能够检测并自我修正错误，**并不**影响设计流程。Agent 通常会尝试其他方案并继续正常执行。只要工作流抵达了最终汇总阶段，设计就是完整的，与中间工具调用报错无关。

### 4. 配置 Vibe Analog Provider

`vibe-analog` 通过 Anthropic 兼容接口调用模型（与 `https://api.anthropic.com/v1/messages` 相同的请求/响应格式）。任何暴露该接口的 provider——Anthropic 官方、企业网关或自建代理——只要接受 Anthropic 风格的鉴权头并返回 Anthropic 风格的流式响应，都可以使用。

在运行 CLI 的目录中创建 Vibe Analog 配置，或者使用 `~/.actoviq/settings.json`。

```powershell
mkdir my-circuit-workspace
cd my-circuit-workspace
copy C:\path\to\agent.settings.example.json .\actoviq.settings.json
```

编辑 `actoviq.settings.json`，填入 provider endpoint、token 和模型名称。不要提交真实 API key。

### 5. 启动 Agent

在你希望作为 workspace 的目录中运行：

```powershell
vibe-analog
```

当前目录会作为 workspace。输出文件会写入：

```text
./jobs/<job-id>/
./sessions/
```

TUI 中可以输入：

```text
/help
/allow execution
/design 设计一个运放增益级，后接 RC 滤波器，并输出有效低比较器告警信号。
```

使用 `/allow all` 可以自动通过所有阶段切换；使用 `/allow manual` 则每个阶段都需要确认。

> 内置 TUI 驱动的是旧的多阶段 workflow。对话式使用推荐下面的 `vibe-analog chat`，它运行与桌面端相同的 CodeAct 引擎。

### 6. Chat 模式（CodeAct）

```powershell
vibe-analog chat
```

在终端里运行与桌面端相同的 CodeAct agent：电路、模块与产物仍然以文件形式写入 workspace。模型配置通过 `ACTOVIQ_API_KEY` / `ACTOVIQ_BASE_URL` / `ACTOVIQ_MODEL` 环境变量（例如智谱 coding plan 端点 `https://open.bigmodel.cn/api/coding/paas/v4`，模型 `glm-5.3-flash`），或通过 `--settings <path>` 传入 `agent.settings.json` 的 `env` 块。会话内命令：`/new` 新建会话，`/approval manual|execution|all` 设置审批策略，`/exit` 退出。

### 7. 单次任务运行

```powershell
vibe-analog --approval-policy execution --job-name rc-demo --requirement "Design a 1 kHz RC low-pass filter and output the netlist, simulation report, and SVG schematic."
```

如果从源码目录运行，把 `vibe-analog` 替换为：

```powershell
npm run dev -- --approval-policy execution --job-name rc-demo --requirement "Design a 1 kHz RC low-pass filter and output the netlist, simulation report, and SVG schematic."
```

## 从源码运行

```powershell
npm run dev
```

默认入口会打开 TUI。你可以直接提问，也可以使用斜杠命令：

```text
/help
/allow execution
/design Design a 1 kHz RC low-pass filter
/modify Increase the output drive and redraw the schematic
```

使用旧版一次性需求输入模式：

```powershell
npm run dev -- --legacy-cli
```

源码 smoke run：

```powershell
npm run dev -- --auto-approve --job-name rc-demo --requirement "Design a 1 kHz RC low-pass filter and output the netlist, simulation report, and netlistsvg schematic."
```

原理图编辑器相关改动必须通过文档、Playwright 与兼容渲染回归：

```powershell
npm run test:schematic-document
npm run test:e2e:schematic-editor
npm run test:e2e:electron
npm test
npm run test:schematic-quality
npm run test:simulation-regression
```

## 本地可编辑 CLI

本地可编辑安装：

```powershell
npm link
vibe-analog --help
```

使用 `npm link` 后，命令会把你运行它的目录作为 workspace root。输出路径为：

```text
./jobs/<job-id>/
./sessions/
```

可以通过环境变量覆盖 workspace root：

```powershell
$env:ACTOVIQ_CIRCUIT_AGENT_WORKSPACE_ROOT='C:\path\to\workspace'
```

## 配置加载顺序

Vibe Analog 配置按以下顺序加载：

1. `--config <path>` 或 `ACTOVIQ_AGENT_CONFIG_PATH`
2. 当前运行目录中的 `./agent.settings.local.json`
3. 当前运行目录中的 `./actoviq.settings.json`
4. 包源码目录中的 `agent.settings.local.json`
5. `~/.actoviq/settings.json`

不要提交真实 API key。请使用 `agent.settings.example.json` 作为模板。

## 大型电路分块

大型设计会在设计阶段按功能分块。工作流会写入 `planning/module-plan.json` 和 `design/module-manifest.json`，并在渲染阶段复用这些模块边界。最终 netlistsvg 输出是单张 SVG 图纸，包含带标签的模块/子模块区域；跨模块连接通过匹配的网络标签和可见端口表达，而不是使用很长的跨图纸连线。

## 渲染

桌面项目使用同一份语义文档进行编辑和 SVG 显示：

- `modules/<id>/module.circuit.json` 是带 revision 的电气与可编辑真源；稳定网络 ID 表达连接，标签和别名不会改变拓扑。
- Design 与 SVG 创建相同的 `SchematicDocument`，共享符号、引脚锚点、正交导线、结点、显式标签和视图边界。
- `render/netlistsvg.svg` 和模块兼容构建继续保留成熟的 AI/netlist 到 netlistsvg 导出链路，并校验相同拓扑，但不会再反向解析为编辑器模型。
- 在 schematic view 中，测试台专用的电压源/电流源会被隐藏，以保持图面清晰。当这些隐藏源驱动可见的非电源控制或偏置节点时，渲染器会暴露 `GATE`、`VREF`、`ITAIL`、`VB` 等命名端子，并把它们作为真实网络连接进行布线。
- 用户的电气和布局修改通过一个事务提交到模块文档。旧 `schematic.overrides.json` 仍可读取，用于兼容历史项目和仅影响 netlistsvg 的摆位。
- GUI 保存的可复用项目模板和设计流程位于当前工作空间的 `references/design-memory/` 目录下。Agent 的资产复用阶段会把这些模板和流程与内置 starter template 一起列出。
- 渲染会在 SVG 旁写入 geometry/readability 报告，检查缺失引脚连接、导线交叉、器件重叠、导线穿过器件本体和过近间距。
- `npm run test:schematic-quality` 会在 `output/schematic-quality/` 下生成一组小型回归样例（RC、RLC、整流、BJT、MOS 和 LDO），应用初始 `schematic.overrides.json` 摆位，渲染 SVG，并在任何硬几何检查退化时失败。

`netlistsvg` 是一个渲染必需的 Node.js 包，请全局安装：

```powershell
npm install -g netlistsvg
```

## 独立 Skill（Claude Code / Codex / Cursor）

`skills/circuit-design-ngspice/` 目录包含一个可移植的、与 agent 运行时无关的
skill，封装了相同的电路设计工作流，不依赖 `actoviq-agent-sdk`。可在 Claude
Code、OpenAI Codex、Cursor 等任何可读取 Markdown prompt 并执行 shell 命令的
AI 编程工具中直接使用。

### 安装 Skill

```powershell
# 将同一份 skill 安装到 Codex 和 Claude Code
python skills\circuit-design-ngspice\scripts\install_skill.py --agent all --scope user
```

项目级安装：

```powershell
python skills\circuit-design-ngspice\scripts\install_skill.py `
  --agent all `
  --scope project `
  --project-root C:\path\to\project
```

安装器会将同一份可移植 skill 复制到 `.codex/skills/` 与
`.claude/skills/`。已有安装需要更新时使用 `--force`。

**在任意 agent 中手动使用**：

将 `SKILL.md` 加载到 agent 上下文中，让它按说明执行。所有 Python 脚本位于
`skills/circuit-design-ngspice/scripts/`，接受标准 `argparse` 参数。

### 为 Skill 配置 ngspice

Skill 按以下顺序解析 ngspice 路径：

1. 传递给 Python 脚本的 `--ngspice-bin` 参数
2. `NGSPICE_BIN` 环境变量
3. skill 根目录下的 `tool_paths.json`
4. 系统 `PATH`

永久配置：既可以设置环境变量（见上面第 2 节），也可以编辑 skill 的
`tool_paths.json`：

```json
{
  "ngspice_bin": "E:/Program/ngspice-45.2_64/Spice64/bin/ngspice.exe"
}
```

Skill 从自身目录读取 `tool_paths.json`，因此每份 skill 副本可以指向不同的
ngspice 安装位置。

### 为 Skill 安装 netlistsvg

`render_netlistsvg.py` 脚本需要系统 PATH 中有 `netlistsvg` CLI：

```powershell
npm install -g netlistsvg
```

验证是否可用：

```powershell
netlistsvg --help
```

### 使用 Skill 运行设计

让 agent 加载 `SKILL.md` 并提供电路需求：

```text
请按照 skills/circuit-design-ngspice/SKILL.md 中的 circuit-design-ngspice skill 执行。
设计一个 1 kHz RC 低通滤波器并渲染原理图。
```

Agent 会创建工作目录，执行 8 步工作流，产出所有设计文件，包括
`design/design.final.cir`、`render/netlistsvg.svg` 和 `reports/final-summary.md`。

**画布项目模型（配合桌面 GUI 使用）。** 当 GUI 打开时，Agent 操作的是可编辑的项目模型，而非一次性的 job 工作流：`scripts/circuit_project.py` 在 `<workspace>/projects/<id>/` 下创建并修订项目（一份 `project.circuit.json`，以及每个模块的 `modules/<id>/module.circuit.json` 和 `netlist-notebook.md`），随后编译和仿真。GUI 监听这些文件，实时刷新画布、Netlist、SVG、Sim 和 Report 各标签页。完整的命令与操作约定见 [SKILL.md](./skills/circuit-design-ngspice/SKILL.md) 的 *GUI Project Canvas Contract* 一节。

## 验证

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
