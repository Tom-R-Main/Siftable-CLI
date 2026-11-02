import type {EnvironmentManifest} from './environmentManifest.js';
import {sanitizeTerminalText} from './output.js';

function codepointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function renderEnvExample(manifest: EnvironmentManifest): string {
  const lines = [
    `# Generated from .sift/environment.yaml (schema ${manifest.schema_version}).`,
    '# Names and documentation-safe placeholders only. Do not put secrets here.',
  ];
  const members = [...manifest.members].sort((left, right) => codepointCompare(left.name, right.name));
  for (const member of members) {
    lines.push('');
    if (member.documentation) {
      lines.push(`# ${sanitizeTerminalText(member.documentation).replace(/[\r\n]+/g, ' ')}`);
    }
    const placeholder = member.kind === 'public'
      ? `<public:${member.placeholder}>`
      : `<${member.sensitivity}>`;
    lines.push(`${member.name}=${placeholder}`);
  }
  return `${lines.join('\n')}\n`;
}

export function diffEnvExample(manifest: EnvironmentManifest, existingText: string | null): {
  current: boolean;
  reason: 'current' | 'missing' | 'drift';
} {
  if (existingText === null) return {current: false, reason: 'missing'};
  return existingText === renderEnvExample(manifest)
    ? {current: true, reason: 'current'}
    : {current: false, reason: 'drift'};
}
