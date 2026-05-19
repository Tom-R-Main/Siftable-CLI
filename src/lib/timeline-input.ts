import {parseEntityRef, ParsedEntityRef} from './entity-ref.js';

export function parseEntityRefs(values: string[] | undefined): ParsedEntityRef[] {
  return (values ?? []).map((value) => parseEntityRef(value));
}

export function timelineProvenance(flags: {
  'source-label'?: string;
  'source-url'?: string;
  'source-note'?: string;
}): Record<string, unknown> | undefined {
  if (!flags['source-label'] && !flags['source-url'] && !flags['source-note']) {
    return undefined;
  }
  return {
    label: flags['source-label'],
    url: flags['source-url'],
    note: flags['source-note'],
  };
}

export function eventEntityRefs(flags: {
  person?: string[];
  org?: string[];
  organization?: string[];
  place?: string[];
  source?: string[];
  entity?: string[];
}): ParsedEntityRef[] {
  const refs: ParsedEntityRef[] = [];
  refs.push(...parseEntityRefs(flags.entity));
  for (const value of flags.person ?? []) {
    refs.push({entityType: 'person', entityId: value, role: 'subject'});
  }
  for (const value of [...(flags.org ?? []), ...(flags.organization ?? [])]) {
    refs.push({entityType: 'organization', entityId: value, role: 'counterparty'});
  }
  for (const value of flags.place ?? []) {
    refs.push({entityType: 'place', entityId: value, role: 'location'});
  }
  for (const value of flags.source ?? []) {
    refs.push(parseEntityRef(value));
  }
  return refs;
}
