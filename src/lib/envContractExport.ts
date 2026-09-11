import type {EnvironmentManifest, EnvironmentMember} from './environmentManifest.js';

export const CONTRACT_EXPORT_SCHEMA_VERSION = 1;
export const CONTRACT_EXPORT_KIND = 'sift.vault.environment-contract-export' as const;

export type ContractMemberKind = 'vault_field' | 'public';
export type ContractMemberSensitivity = 'secret' | 'confidential' | 'public';

/**
 * A contract-only export member. The type has no value, ciphertext,
 * envelope, base64, or destination-bound field, and no flag can add one:
 * contract exports are incapable of carrying secret material by
 * construction.
 */
export interface ContractExportMember {
  name: string;
  kind: ContractMemberKind;
  sensitivity: ContractMemberSensitivity;
  reference: string;
  publicDefault: string;
  documentation: string;
}

export interface ContractExportDocument {
  schemaVersion: 1;
  kind: typeof CONTRACT_EXPORT_KIND;
  members: ContractExportMember[];
}

function codepointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function singleLine(value: string | undefined): string {
  return (value ?? '').replace(/[\r\n]+/g, ' ');
}

export function buildContractExportMembers(manifest: EnvironmentManifest): ContractExportMember[] {
  const members = manifest.members.map((member: EnvironmentMember) => {
    if (member.kind === 'public') {
      return {
        name: member.name,
        kind: 'public' as const,
        sensitivity: 'public' as const,
        reference: `public/${member.name}`,
        publicDefault: member.placeholder,
        documentation: singleLine(member.documentation),
      };
    }
    return {
      name: member.name,
      kind: 'vault_field' as const,
      sensitivity: member.sensitivity,
      reference: `${member.owner}/${member.entry_id}#${member.field}`,
      publicDefault: '',
      documentation: singleLine(member.documentation),
    };
  });
  members.sort((left, right) => codepointCompare(left.name, right.name));
  return members;
}

export function renderContractExportJson(members: ContractExportMember[]): string {
  const document: ContractExportDocument = {
    schemaVersion: CONTRACT_EXPORT_SCHEMA_VERSION,
    kind: CONTRACT_EXPORT_KIND,
    members,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

function guardCsvField(value: string): string {
  // Spreadsheet formula-trigger guard: quote every field and prefix values
  // that a spreadsheet would execute. Control characters are stripped.
  // Encoding: UTF-8 without BOM, LF line endings, comma delimiter.
  const stripped = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  const guarded = /^[=+\-@\t\r]/.test(stripped) ? `'${stripped}` : stripped;
  return `"${guarded.replace(/"/g, '""')}"`;
}

export function renderContractExportCsv(members: ContractExportMember[]): string {
  const lines = ['Name,Kind,Sensitivity,Reference,PublicDefault,Documentation'];
  for (const member of members) {
    lines.push([
      guardCsvField(member.name),
      guardCsvField(member.kind),
      guardCsvField(member.sensitivity),
      guardCsvField(member.reference),
      guardCsvField(member.publicDefault),
      guardCsvField(member.documentation),
    ].join(','));
  }
  return `${lines.join('\n')}\n`;
}

export function renderContractExport(
  manifest: EnvironmentManifest,
  format: 'json' | 'csv',
): {rendered: string; memberCount: number} {
  const members = buildContractExportMembers(manifest);
  const rendered = format === 'csv' ? renderContractExportCsv(members) : renderContractExportJson(members);
  return {rendered, memberCount: members.length};
}
