import {Flags} from '@oclif/core';
import {execFileSync} from 'node:child_process';
import {hostname, platform, arch} from 'node:os';
import {BaseCommand, DEFAULT_API_URL} from '../../../lib/base-command.js';
import {
  assertEndpointStorageImplementation,
  buildEnvironmentEndpointEnrollmentRequest,
  ENVIRONMENT_ENDPOINT_CLASSES,
  ENVIRONMENT_ENDPOINT_STORAGE_TIERS,
  environmentEndpointPendingResult,
  type EnvironmentEndpointClass,
  type EnvironmentEndpointStorageTier,
  signEnvironmentEndpointEnrollmentRequest,
} from '../../../lib/environmentEndpointContract.js';
import {loadOrCreateMaterializerDeviceIdentity} from '../../../lib/materializerDeviceIdentity.js';
import {
  systemdCredentialStoreAvailable,
  systemdManagedKeyringIdentityStore,
} from '../../../lib/systemdKeyringIdentityStore.js';
import {
  secretServiceKeyringAvailable,
  secretServiceKeyringIdentityStore,
} from '../../../lib/secretServiceKeyringIdentityStore.js';
import {unprotectedEnvironmentIdentityStore} from '../../../lib/unprotectedEnvIdentityStore.js';

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function openBrowser(url: string): void {
  try {
    const command = process.platform === 'darwin' ? '/usr/bin/open' : '/usr/bin/xdg-open';
    execFileSync(command, [url], {stdio: 'ignore', env: {PATH: '/usr/bin:/bin'}});
  } catch {
    // The exact URL remains visible for headless and failed-open environments.
  }
}

export default class EnvEndpointEnroll extends BaseCommand {
  static description = 'Enroll a public endpoint identity without granting Vault access';

  static flags = {
    ...BaseCommand.baseFlags,
    'endpoint-class': Flags.string({
      required: true,
      options: [...ENVIRONMENT_ENDPOINT_CLASSES],
      description: 'Explicit endpoint policy class',
    }),
    'storage-tier': Flags.string({
      required: true,
      options: [...ENVIRONMENT_ENDPOINT_STORAGE_TIERS],
      description: 'Actual endpoint key storage tier; convenience_keyring is not hardware-backed',
    }),
    owner: Flags.string({default: 'personal', description: 'personal or workspace:<uuid>'}),
    dedicated: Flags.boolean({default: false, description: 'Endpoint is a dedicated runner'}),
    'kill-switch': Flags.boolean({default: false, description: 'Runner has an enforced kill switch'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(EnvEndpointEnroll);
    const storageTier = flags['storage-tier'] as EnvironmentEndpointStorageTier;
    const systemdAvailable = await systemdCredentialStoreAvailable();
    const secretServiceAvailable = await secretServiceKeyringAvailable();
    assertEndpointStorageImplementation({
      platform: process.platform,
      storageTier,
      systemdCredentialStoreAvailable: systemdAvailable,
      secretServiceKeyringAvailable: secretServiceAvailable,
    });
    const apiUrl = flags['api-url'] || process.env.SIFT_API_URL || DEFAULT_API_URL;
    const identityStore = process.platform === 'linux'
      ? storageTier === 'systemd_managed'
        ? systemdManagedKeyringIdentityStore
        : storageTier === 'convenience_keyring'
          ? secretServiceKeyringIdentityStore
          : unprotectedEnvironmentIdentityStore
      : storageTier === 'none'
        ? unprotectedEnvironmentIdentityStore
        : undefined;
    const identity = await loadOrCreateMaterializerDeviceIdentity({
      apiUrl,
      store: identityStore,
    });
    const enrollment = signEnvironmentEndpointEnrollmentRequest(buildEnvironmentEndpointEnrollmentRequest({
      publicKey: identity.publicKeyPem,
      fingerprint: identity.fingerprint,
      endpointClass: flags['endpoint-class'] as EnvironmentEndpointClass,
      storageTier,
      owner: flags.owner,
      host: {
        hostname: hostname(),
        os: platform(),
        arch: arch(),
        agentVersion: this.config.version,
      },
      dedicated: flags.dedicated,
      killSwitchEnabled: flags['kill-switch'],
    }), identity.privateKey);
    const issued = await fetch(`${apiUrl}/auth/device/endpoint`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(enrollment),
    });
    if (!issued.ok) this.error(`Failed to start endpoint enrollment (HTTP ${issued.status}).`);
    const device = await issued.json() as {
      verification_uri: string;
      device_code: string; user_code: string; verification_uri_complete: string;
      expires_in: number; interval: number;
    };
    if (this.jsonEnabled()) {
      return environmentEndpointPendingResult({
        endpointFingerprint: identity.fingerprint,
        deviceCode: device.device_code,
        userCode: device.user_code,
        verificationUri: device.verification_uri,
        verificationUriComplete: device.verification_uri_complete,
        expiresIn: device.expires_in,
        interval: device.interval,
      });
    }
    this.log(`Endpoint fingerprint: ${identity.fingerprint}`);
    this.log(`Verification code: ${device.user_code}`);
    this.log(`Review the exact endpoint details: ${device.verification_uri_complete}`);
    if (!flags['no-input']) openBrowser(device.verification_uri_complete);
    let interval = device.interval * 1000;
    const deadline = Date.now() + device.expires_in * 1000;
    while (Date.now() < deadline) {
      await sleep(interval);
      const response = await fetch(`${apiUrl}/auth/device/token`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({device_code: device.device_code, grant_type: GRANT_TYPE}),
      });
      const result = await response.json() as {
        enrollment?: {id: string; publicKeyFingerprint: string}; error?: string;
      };
      if (response.ok && result.enrollment) {
        if (result.enrollment.publicKeyFingerprint !== identity.fingerprint) {
          this.error('The approved enrollment fingerprint did not match this endpoint.');
        }
        this.log('Endpoint identity enrolled. No Vault authority was granted.');
        return {enrollment: result.enrollment};
      }
      if (result.error === 'slow_down') interval += 5000;
      else if (result.error !== 'authorization_pending') {
        this.error(`Endpoint enrollment failed: ${result.error ?? `HTTP ${response.status}`}`);
      }
    }
    this.error('Endpoint enrollment expired. Run the command again.');
  }
}
