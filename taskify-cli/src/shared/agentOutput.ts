export type AgentSuccess<T> = {
  version: 1;
  ok: true;
  command: string;
  data: T;
  meta: Record<string, unknown>;
};

export type AgentFailure = {
  version: 1;
  ok: false;
  command: string;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    retryable: boolean;
  };
};

export function agentSuccess<T>(
  command: string,
  data: T,
  meta: Record<string, unknown> = {},
): AgentSuccess<T> {
  return { version: 1, ok: true, command, data, meta };
}

export function agentFailure(
  command: string,
  code: string,
  message: string,
  options: { details?: Record<string, unknown>; retryable?: boolean } = {},
): AgentFailure {
  return {
    version: 1,
    ok: false,
    command,
    error: {
      code,
      message,
      ...(options.details ? { details: options.details } : {}),
      retryable: options.retryable ?? false,
    },
  };
}

export function writeAgentJson(value: AgentSuccess<unknown> | AgentFailure): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
