import '@siftable/mcp-server/dist/exfClient.js';
import type {AiTransport} from '../../../shared/dist/types/aiGateway.js';
import type {
  SiftClient as WorkspaceSiftClient,
} from '../../../exf-mcp-server/dist/exfClient.js';

declare module '@siftable/mcp-server/dist/exfClient.js' {
  // The CLI compiles against the published MCP declaration during isolated
  // workspace tests. This structural merge ensures command paths are checked
  // against the real SiftClient while its newly built declaration catches up.
  interface SiftClient extends WorkspaceSiftClient, AiTransport {}
}
