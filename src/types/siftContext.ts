/**
 * Compatibility declarations for ADR-012. The context fields mirror its
 * tenant-selection/local-checkout distinction, while the command map restates
 * capability-kind literals from the authoritative shared taxonomy. The
 * standalone CLI cannot consume that package yet; ADR-012 requires an explicit
 * parity mechanism as soon as the dependency boundary can be removed.
 */
export interface SiftCliContextSelection {
  selectedWorkspaceId: string | null;
  selectionSource: 'workspace_flag' | 'environment' | 'saved_selection' | 'none';
  checkoutRoot: string | null;
}

export type SiftCliPrincipalType =
  | 'personal_pat'
  | 'workspace_service_pat'
  | 'pat_unknown';

export interface SiftCliPrincipalDeclaration {
  type: SiftCliPrincipalType;
  principalId: string | null;
  authority: 'saved_login' | 'workspace_binding' | 'client_unresolved';
}

export const SIFT_CLI_CAPABILITY_SURFACES = {
  'sift capabilities': 'static_readiness',
  'sift capabilities list': 'executable_handle',
  'sift capabilities describe': 'executable_handle',
  'sift capabilities create': 'executable_handle',
  'sift capabilities execute': 'executable_handle',
  'sift capabilities revoke': 'executable_handle',
} as const;
