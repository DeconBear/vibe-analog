import path from 'node:path';
import type { Interface } from 'node:readline/promises';

import {
  createAgentSdk,
  type HadamardAgentClient,
  type HadamardAgentDefinition,
  type AgentSession,
} from 'actoviq-agent-sdk';

import { loadActoviqConfig } from '../config/loadActoviqConfig.js';
import { WORKSPACE_ROOT } from '../config/projectPaths.js';
import { ACTOVIQ_CIRCUIT_AGENT_VERSION } from '../config/version.js';
import { streamToConsole } from '../utils/streamUtils.js';
import { writeStdout } from '../utils/runtimeSupport.js';
import { createConversationToolGateway } from './agentToolGateway.js';
import { TuiStateStore } from './TuiState.js';

const conversationAgent: HadamardAgentDefinition = {
  name: 'conversation-agent',
  description: 'General interactive agent that can answer questions and call workflow tools when needed.',
  systemPrompt: [
    'You are the interactive front desk agent for vibe-analog.',
    'Behave like a general helpful engineering agent in Chinese by default.',
    'All non-slash natural-language inputs come to you first. Do not rely on local keyword routing.',
    'If the user is asking a normal question, answer directly using available context and tools only when useful.',
    'If the user is asking to design, generate, simulate, render, or substantially revise a circuit, explain your understanding briefly and call the appropriate workflow tool.',
    'Use start_design_workflow for new designs and start_revision_workflow for modifications of the active job.',
    'Approval policy semantics are fixed: manual means every stage transition asks for confirmation except the built-in closed-loop netlist-to-simulation handoff; execution means planning/document stages ask for confirmation while execution, simulation, rendering, and summary stages auto-advance; all means every stage auto-advances with no confirmation prompts.',
    'Never say that allowMode=all waits for user confirmation. It is fully automatic.',
    'Do not override the current allowMode when calling workflow tools; omit approvalPolicy unless the user explicitly asks to change it.',
    'If a tool result is an error, read the complete error text, fix the root cause before retrying, and tell the user the exact error reason if the request cannot continue.',
    'If the request is ambiguous or could accidentally launch a long workflow, ask one clarifying question instead of calling a workflow tool.',
    'Never expose API keys or secret config values.',
    'When a workflow finishes, tell the user the job path and recommend the detailed design report and netlistsvg SVG.',
  ].join('\n'),
};

export class TuiConversationAgent {
  private sdk: HadamardAgentClient | null = null;
  private session: AgentSession | null = null;

  constructor(
    private readonly stateStore: TuiStateStore,
    private readonly rl: Interface,
  ) {}

  async close(): Promise<void> {
    if (this.sdk) {
      await this.sdk.close();
      this.sdk = null;
      this.session = null;
    }
  }

  resetSession(): void {
    this.session = null;
  }

  async send(userInput: string): Promise<void> {
    await this.ensureSession();
    const state = this.stateStore.snapshot();
    const recent = await this.stateStore.recentTranscript(8);
    const context = [
      'TUI session context:',
      `- allowMode: ${state.allowMode}`,
      '- approvalPolicy semantics: manual=confirm stage transitions; execution=confirm planning/docs only and auto-run execution/rendering/summary; all=fully auto-run all stages.',
      '- If allowMode is all, do not claim that steps will wait for confirmation.',
      `- activeJobId: ${state.activeJobId ?? '(none)'}`,
      `- activeJobRoot: ${state.activeJobRoot ?? '(none)'}`,
      `- workspace: ${WORKSPACE_ROOT}`,
      '- recent transcript:',
      ...recent.map((entry) => `  - ${entry.role}: ${entry.content.replace(/\s+/g, ' ').slice(0, 240)}`),
      '',
      'User message:',
      userInput,
    ].join('\n');

    await this.stateStore.appendTranscript({ role: 'user', content: userInput });
    const result = await streamToConsole(this.session!.stream(context), 'Agent');
    await this.stateStore.appendTranscript({ role: 'agent', content: result.text.trim() });
  }

  private async ensureSession(): Promise<void> {
    if (!this.sdk) {
      const config = await loadActoviqConfig();
      writeStdout(`[actoviq-config] ${config.source}\n`);
      this.sdk = await createAgentSdk({
        workDir: WORKSPACE_ROOT,
        sessionDirectory: path.resolve(WORKSPACE_ROOT, 'actoviq-sessions'),
        clientName: 'vibe-analog-tui',
        clientVersion: ACTOVIQ_CIRCUIT_AGENT_VERSION,
        systemPrompt: [
          'You are running inside the vibe-analog TUI.',
          'Use tools for workflow actions and answer normal questions conversationally.',
        ].join('\n'),
        maxToolIterations: 120,
        tools: createConversationToolGateway({
          stateStore: this.stateStore,
          rl: this.rl,
        }),
        agents: [conversationAgent],
        skills: [],
        disableDefaultSkills: true,
        loadDefaultSkillDirectories: false,
      });
    }

    if (this.session) {
      return;
    }

    const state = this.stateStore.snapshot();
    if (state.conversationSessionId) {
      try {
        this.session = await this.sdk.resumeSession(state.conversationSessionId);
        return;
      } catch {
        // The stored SDK session can be missing after cleanup; create a new one.
      }
    }

    this.session = await this.sdk.createAgentSession('conversation-agent', {
      title: `tui:${this.stateStore.sessionId}`,
      metadata: {
        tuiSessionId: this.stateStore.sessionId,
        workspaceRoot: WORKSPACE_ROOT,
      },
    });
    await this.stateStore.setConversationSessionId(this.session.id);
  }
}
