import { randomUUID } from 'node:crypto';

import { createAgentSdk, type HadamardAgentClient, type AgentRunResult, type AgentSession } from 'actoviq-agent-sdk';

import { jobSluggerAgent } from '../agents/jobSluggerAgent.js';
import { PROJECT_ROOT, WORKSPACE_ROOT } from '../config/projectPaths.js';
import { ACTOVIQ_CIRCUIT_AGENT_VERSION } from '../config/version.js';
import { createJobSlugSkill } from '../skills/jobSlugSkill.js';

export interface GeneratedJobNaming {
  slug: string;
  title: string;
  source: 'llm' | 'fallback';
}

function slugifyAscii(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 32);
}

function defaultFallbackSlug(requirement: string, explicitName?: string): GeneratedJobNaming {
  const seed = slugifyAscii(explicitName?.trim() || '');
  if (seed) {
    return {
      slug: seed,
      title: explicitName!.trim().slice(0, 64) || 'Circuit Design Job',
      source: 'fallback',
    };
  }

  const englishHint = slugifyAscii(requirement);
  return {
    slug: englishHint || 'circuit-design-job',
    title: 'Circuit Design Job',
    source: 'fallback',
  };
}

function parseSlugResponse(text: string): GeneratedJobNaming | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as { slug?: string; title?: string };
    const slug = slugifyAscii(parsed.slug ?? '');
    const title = String(parsed.title ?? '').trim().slice(0, 80);
    if (!slug) {
      return null;
    }
    return {
      slug,
      title: title || 'Circuit Design Job',
      source: 'llm',
    };
  } catch {
    const inlineSlug = slugifyAscii(trimmed.split(/\s+/).slice(0, 8).join('-'));
    if (!inlineSlug) {
      return null;
    }
    return {
      slug: inlineSlug,
      title: 'Circuit Design Job',
      source: 'llm',
    };
  }
}

async function drainQuietly(stream: AsyncIterable<unknown> & { result: Promise<AgentRunResult> }): Promise<AgentRunResult> {
  const guardedResult = stream.result;
  for await (const _event of stream) {
    // intentionally drain without printing
  }
  return guardedResult;
}

async function createNamingSdk(sessionDirectory: string): Promise<HadamardAgentClient> {
  return createAgentSdk({
    workDir: WORKSPACE_ROOT,
    sessionDirectory,
    clientName: 'vibe-analog-namer',
    clientVersion: ACTOVIQ_CIRCUIT_AGENT_VERSION,
    systemPrompt: [
      'You are a preflight naming helper for vibe-analog.',
      'Generate short filesystem-safe English names only.',
      'Never call tools. Never emit prose around the requested JSON.',
      `Project root: ${PROJECT_ROOT}`,
    ].join('\n'),
    maxToolIterations: 4,
    tools: [],
    agents: [jobSluggerAgent],
    skills: [createJobSlugSkill()],
    disableDefaultSkills: true,
    loadDefaultSkillDirectories: false,
  });
}

export async function generateSafeJobNaming(options: {
  requirement: string;
  explicitName?: string;
  sessionDirectory: string;
}): Promise<GeneratedJobNaming> {
  const fallback = defaultFallbackSlug(options.requirement, options.explicitName);
  let sdk: HadamardAgentClient | null = null;

  try {
    sdk = await createNamingSdk(options.sessionDirectory);
    const session: AgentSession = await sdk.createAgentSession('job-slugger', {
      title: `preflight-job-slug-${randomUUID().slice(0, 8)}`,
      metadata: {
        stage: 'preflight-job-slug',
      },
    });

    const prompt = [
      `Original requirement: ${options.requirement.trim()}`,
      `Explicit job label: ${options.explicitName?.trim() || '(none)'}`,
      '',
      'Generate a short English filesystem-safe name for this job.',
    ].join('\n');

    const result = await drainQuietly(
      session.streamSkill('generate-safe-job-slug', prompt, {
        metadata: {
          stage: 'preflight-job-slug',
        },
      }),
    );

    return parseSlugResponse(result.text) ?? fallback;
  } catch {
    return fallback;
  } finally {
    if (sdk) {
      await sdk.close();
    }
  }
}
