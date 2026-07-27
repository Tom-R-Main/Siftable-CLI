export interface AiModelSummary {
  connectionId: string;
  connectionName: string;
  provider: string;
  model: string;
  status: 'available';
}

export interface AiConnectionStatus {
  connectionId: string;
  connectionName: string;
  provider: string;
  lifecycleStatus: string;
  validationStatus: string;
  availableModelCount: number;
}

export interface AiGenerateResponse {
  connectionId: string;
  model: string;
  text: string;
  finishReason: string;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
  };
}

interface AiApiResponse<T> {
  data?: T;
  error?: string;
  statusCode: number;
}

export interface AiTransport {
  listAiModels(): Promise<AiApiResponse<{models: AiModelSummary[]}>>;
  getAiConnectionStatus(
    connectionId?: string,
  ): Promise<AiApiResponse<{connections: AiConnectionStatus[]}>>;
  generateAi(input: {
    connectionId: string;
    model: string;
    prompt: string;
    maxOutputTokens?: number;
  }): Promise<AiApiResponse<{response: AiGenerateResponse}>>;
  getAiUsage(input?: {
    from?: string;
    to?: string;
  }): Promise<AiApiResponse<{usage: {
    periodStart: string;
    periodEnd: string;
    invocationCount: number;
    inputTokens: string;
    outputTokens: string;
    siftableModelChargeMicros: string;
    externalProviderCostMicros: string | null;
  }}>>;
}
