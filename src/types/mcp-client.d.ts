import '@siftable/mcp-server/dist/exfClient.js';
import type {
  SiftClient as WorkspaceSiftClient,
} from '../../../exf-mcp-server/dist/exfClient.js';

declare module '@siftable/mcp-server/dist/exfClient.js' {
  // Preserve workspace-client methods while the published declaration catches
  // up. The real class owns the separate AiTransport structural guarantee.
  interface SiftClient extends WorkspaceSiftClient {}
}
