import '@siftable/mcp-server/dist/exfClient.js';

declare module '@siftable/mcp-server/dist/exfClient.js' {
  interface SiftClient {
    listVaultAudit(options?: {
      limit?: number;
      offset?: number;
      action?: string;
      from?: string;
      to?: string;
    }): Promise<{
      data?: { events?: unknown[] };
      error?: string;
      statusCode: number;
      warnings?: string[];
    }>;
  }
}
