import {describe, expect, it} from 'vitest';
import {buildLocalAdapterInvocation} from './localExecutionRunner.js';

describe('Terraform bounded-only adapter', () => {
  it('uses fixed apply arguments and states that child code can observe the short-lived credential', () => {
    const invocation = buildLocalAdapterInvocation({
      adapterId: 'terraform_apply',
      operation: 'apply',
      executablePath: '/usr/local/bin/terraform',
      executableDigest: 'a'.repeat(64),
      requestedScope: {role: 'migration-role'},
      workingDirectory: '/workspace/infrastructure',
      credential: {
        kind: 'aws_sts',
        fields: {
          accessKeyId: 'SENTINEL_ACCESS',
          secretAccessKey: 'SENTINEL_SECRET',
          sessionToken: 'SENTINEL_SESSION',
        },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(invocation.tier).toBe('bounded_only');
    expect(invocation.args).toEqual(['apply', '-input=false', '-auto-approve']);
    expect(invocation.threatDisclosure).toMatch(/providers.*plugins.*local-exec.*external/i);
    expect(JSON.stringify(invocation.args)).not.toContain('SENTINEL_');
  });
});
