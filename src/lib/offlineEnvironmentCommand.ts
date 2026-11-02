import {Command, Flags} from '@oclif/core';
import path from 'node:path';
import {inspectEnvironmentContract, type EnvironmentInspectionReport} from './environmentCommand.js';
import {findCheckoutRoot} from './workspace-context.js';

export const checkoutRootFlag = Flags.string({
  description: 'Exact Git checkout root containing .sift/environment.yaml',
  helpValue: 'path',
});

export abstract class OfflineEnvironmentCommand extends Command {
  static enableJsonFlag = true;

  protected resolveCheckoutRoot(value?: string): string {
    const resolved = value ? path.resolve(value) : findCheckoutRoot() ?? process.cwd();
    return path.normalize(resolved);
  }

  protected printInspection(report: EnvironmentInspectionReport): void {
    if (this.jsonEnabled()) return;
    this.log(`Manifest: ${report.manifest}`);
    this.log(`Checkout: ${report.checkout}`);
    for (const member of report.members) {
      const owner = member.owner ? `\towner=${member.owner}\tauthorization=${member.authorization}` : '';
      this.log(`${member.name}\t${member.state}\t${member.destination}\t${member.mode}${owner}`);
    }
    for (const ignore of report.ignores) {
      this.log(`IGNORE ${ignore.strength} ${ignore.destination}: pattern=${JSON.stringify(ignore.rule.pattern)} source=${JSON.stringify(ignore.rule.source)} line=${ignore.rule.line}`);
    }
    for (const finding of report.findings) {
      this.log(`${finding.severity.toUpperCase()} ${finding.code}${finding.destination ? ` ${finding.destination}` : ''}: ${finding.message}`);
      if (finding.ignore_rule) {
        this.log(`IGNORE ${finding.destination ?? '<unknown>'}: pattern=${JSON.stringify(finding.ignore_rule.pattern)} source=${JSON.stringify(finding.ignore_rule.source)} line=${finding.ignore_rule.line}`);
      }
    }
  }

  protected inspect(checkoutRoot: string): Promise<EnvironmentInspectionReport> {
    return inspectEnvironmentContract(checkoutRoot);
  }
}
