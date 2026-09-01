import {
  createHadamardModelApi,
  createOpenaiModelApi,
  resolveRuntimeConfig,
  type CreateAgentSdkOptions,
  type ModelApi,
  type ModelRequest,
  type ModelStreamHandle,
} from 'actoviq-agent-sdk';

function sanitizeThrownError(error: unknown): unknown {
  if (error instanceof Error) {
    const sanitized = new Error(sanitizeProviderErrorText(error.message));
    sanitized.name = error.name;
    return sanitized;
  }
  return error;
}

/**
 * Provider error bodies can echo request credentials (proxies commonly repeat
 * the Authorization header in 4xx text). The SDK persists raw run errors into
 * its on-disk agent-execution audit store, so credentials must be redacted at
 * the ModelApi boundary before the runtime ever sees them.
 */
export function sanitizeProviderErrorText(message: string): string {
  return message
    .replace(/\b(?:sk|ark|ak)-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[redacted]')
    .replace(/((?:api[_ -]?key|auth[_ -]?token)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]');
}

class SanitizedModelStream implements AsyncIterable<unknown> {
  private readonly inner: AsyncIterable<unknown> & { finalMessage(): Promise<unknown> };

  constructor(inner: AsyncIterable<unknown> & { finalMessage(): Promise<unknown> }) {
    this.inner = inner;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    try {
      yield* this.inner;
    } catch (error) {
      throw sanitizeThrownError(error);
    }
  }

  async finalMessage(): Promise<unknown> {
    try {
      return await this.inner.finalMessage();
    } catch (error) {
      throw sanitizeThrownError(error);
    }
  }
}

export function createSanitizedModelApi(base: ModelApi): ModelApi {
  return {
    createMessage: async (request: ModelRequest) => {
      try {
        return await base.createMessage(request);
      } catch (error) {
        throw sanitizeThrownError(error);
      }
    },
    streamMessage: (request: ModelRequest): ModelStreamHandle =>
      new SanitizedModelStream(
        base.streamMessage(request) as unknown as AsyncIterable<unknown> & { finalMessage(): Promise<unknown> },
      ) as unknown as ModelStreamHandle,
  };
}

/**
 * Build the provider ModelApi for a desktop agent config with provider error
 * redaction applied. Mirrors the runtime's own provider selection.
 */
export async function createSanitizedProviderModelApi(
  sdkOptions: CreateAgentSdkOptions,
): Promise<ModelApi> {
  const config = await resolveRuntimeConfig(sdkOptions);
  const base = config.provider === 'openai'
    ? createOpenaiModelApi(config)
    : createHadamardModelApi(config);
  return createSanitizedModelApi(base);
}
