import {Flags} from '@oclif/core';
import {execSync} from 'node:child_process';
import {BaseCommand, DEFAULT_API_URL} from '../../lib/base-command.js';
import {storeToken} from '../../lib/auth.js';
import {getConfigDir} from '../../lib/config.js';

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

interface DeviceResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
  scopes: string[];
}

interface TokenResponse {
  access_token: string;
  token_type: string;
}

interface ErrorResponse {
  error: string;
  error_description?: string;
}

function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    if (platform === 'darwin') {
      execSync(`open ${JSON.stringify(url)}`, {stdio: 'ignore'});
    } else if (platform === 'win32') {
      execSync(`start "" ${JSON.stringify(url)}`, {stdio: 'ignore'});
    } else {
      execSync(`xdg-open ${JSON.stringify(url)}`, {stdio: 'ignore'});
    }
  } catch {
    // Browser open failed — user can manually navigate to the URL
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default class AuthLogin extends BaseCommand {
  static description = 'Authenticate with Siftable';

  static examples = [
    '<%= config.bin %> auth login',
    '<%= config.bin %> auth login --scope vault:metadata:read',
    '<%= config.bin %> auth login --scope vault:metadata:read --scope vault:audit:read',
    '<%= config.bin %> auth login --token sift_pat_xxx',
    'SIFT_TOKEN=sift_pat_xxx <%= config.bin %> auth status',
    'EXF_TOKEN=exf_pat_xxx <%= config.bin %> auth status',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    token: Flags.string({
      description: 'Personal access token (skips device flow)',
    }),
    scope: Flags.string({
      description: 'Incremental Vault scope to request (repeatable; never grants plaintext reveal)',
      options: ['vault:metadata:read', 'vault:manage', 'vault:audit:read'],
      multiple: true,
    }),
  };

  async run(): Promise<{stored: boolean; scopes?: string[]}> {
    const {flags} = await this.parse(AuthLogin);
    const token = flags.token || process.env.SIFT_TOKEN || process.env.EXF_TOKEN;
    const requestedScopes = flags.scope ?? [];

    // Direct token mode: existing behavior
    if (token) {
      if (requestedScopes.length > 0) {
        this.error('--scope applies only to device authorization; it cannot change an existing token.');
      }
      storeToken(token);
      if (!this.jsonEnabled()) {
        this.log(`Token stored in ${getConfigDir()}/auth.json`);
      }

      return {stored: true};
    }

    // Device flow
    const apiUrl = flags['api-url'] || process.env.SIFT_API_URL || process.env.EXF_API_URL || DEFAULT_API_URL;
    return this.deviceFlow(apiUrl, flags['no-input'] ?? false, requestedScopes);
  }

  private async deviceFlow(
    apiUrl: string,
    noInput: boolean,
    scopes: string[],
  ): Promise<{stored: boolean; scopes: string[]}> {
    // Step 1: Request device code
    const deviceRes = await fetch(`${apiUrl}/auth/device`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({scopes}),
    });

    if (!deviceRes.ok) {
      this.error(`Failed to start device flow (HTTP ${deviceRes.status}). Is the API reachable at ${apiUrl}?`);
    }

    const device: DeviceResponse = await deviceRes.json() as DeviceResponse;

    // Step 2: Show code and open browser
    if (!this.jsonEnabled()) {
      this.log('');
      this.log(`  Your verification code: ${device.user_code}`);
      this.log(`  Requested scopes: ${device.scopes.join(', ')}`);
      if (scopes.length > 0) {
        this.log('  Review these incremental scopes in the browser before authorizing.');
      }
      this.log('');

      if (noInput) {
        this.log(`  Open this URL to authorize:`);
        this.log(`  ${device.verification_uri_complete}`);
      } else {
        this.log('  Opening browser...');
        openBrowser(device.verification_uri_complete);
        this.log(`  If the browser didn't open, visit: ${device.verification_uri_complete}`);
      }

      this.log('');
      this.log('  Waiting for authorization...');
    }

    // Step 3: Poll for token
    let interval = device.interval * 1000;
    const deadline = Date.now() + device.expires_in * 1000;

    while (Date.now() < deadline) {
      await sleep(interval);

      const tokenRes = await fetch(`${apiUrl}/auth/device/token`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          device_code: device.device_code,
          grant_type: GRANT_TYPE,
        }),
      });

      let body: string;
      try {
        body = await tokenRes.text();
      } catch {
        // Network error during read — retry
        continue;
      }

      let parsed: TokenResponse | ErrorResponse | undefined;
      try {
        parsed = JSON.parse(body);
      } catch {
        // Non-JSON response (e.g. HTML error page) — server issue
        this.error(`Server error (HTTP ${tokenRes.status}). The API may be updating — try again in a minute.`);
      }

      if (tokenRes.ok && parsed && 'access_token' in parsed) {
        storeToken(parsed.access_token);
        if (!this.jsonEnabled()) {
          this.log(`  Logged in successfully! Token stored in ${getConfigDir()}/auth.json`);
        }

        return {stored: true, scopes: device.scopes};
      }

      const errorData = parsed as ErrorResponse | undefined;

      switch (errorData?.error) {
        case 'authorization_pending':
          // Keep polling
          break;

        case 'slow_down':
          interval += 5000;
          break;

        case 'expired_token':
          this.error('Session expired. Run `sift auth login` again.');
          break;

        case 'access_denied':
          this.error('Authorization denied.');
          break;

        default:
          this.error(`Unexpected error: ${errorData?.error ?? `HTTP ${tokenRes.status}`}`);
      }
    }

    this.error('Session expired. Run `sift auth login` again.');
  }
}
