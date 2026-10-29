/** `sift machine status`: what the supervisor state holds, without ever reading out the credential. */
import {promises as fs} from 'node:fs';
import {inspectMachineState, MachineStateError, readCredential} from './machineState.js';

export interface MachineStatusSummary {
  state: 'not_enrolled' | 'pending' | 'enrolled' | 'partial' | 'invalid';
  enrollmentId?: string;
  runnerId?: string;
  fingerprint?: string;
  apiUrl?: string;
  credentialPresent?: boolean;
  pendingState?: string;
  problem?: string;
}

export async function describeMachineState(root: string): Promise<{summary: MachineStatusSummary; lines: string[]}> {
  let owner: {uid: number; gid: number};
  try {
    const directory = await fs.lstat(root);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      return {summary: {state: 'invalid', problem: `${root} is not a directory`}, lines: [`${root} is not a directory.`]};
    }
    owner = {uid: directory.uid, gid: directory.gid};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {summary: {state: 'not_enrolled'}, lines: ['This machine is not enrolled. Run `sudo sift machine enroll`.']};
    }
    throw error;
  }
  try {
    const state = await inspectMachineState({root, owner});
    switch (state.kind) {
      case 'empty':
        return {summary: {state: 'not_enrolled'}, lines: ['This machine is not enrolled. Run `sudo sift machine enroll`.']};
      case 'partial':
        return {summary: {state: 'partial', problem: `present: ${state.present.join(', ')}`},
          lines: [`The enrollment state is incomplete (${state.present.join(', ')}). Run \`sudo sift machine enroll --replace\`.`]};
      case 'delivered':
        return {summary: {state: 'pending', runnerId: state.pending.runnerId, enrollmentId: state.pending.enrollmentId,
          fingerprint: state.pending.fingerprint, apiUrl: state.pending.apiUrl, credentialPresent: true, pendingState: 'delivered'},
        lines: [`Enrollment ${state.pending.enrollmentId} was received but not committed. Run \`sudo sift machine enroll\` to finish it.`]};
      case 'pending':
        return {summary: {state: 'pending', runnerId: state.pending.runnerId, fingerprint: state.pending.fingerprint,
          apiUrl: state.pending.apiUrl, pendingState: state.pending.state},
        lines: [`Enrollment in progress for runner ${state.pending.runnerId} (${state.pending.state}).`]};
      case 'enrolled': {
        const credentialPresent = (await readCredential({root, owner})) !== null;
        const {machine} = state;
        return {summary: {state: 'enrolled', enrollmentId: machine.enrollmentId, runnerId: machine.runnerId,
          fingerprint: machine.fingerprint, apiUrl: machine.apiUrl, credentialPresent},
        lines: [
          `Enrolled with ${machine.apiUrl}: enrollment ${machine.enrollmentId}, runner ${machine.runnerId}.`,
          `Key fingerprint ${machine.fingerprint}. Credential ${credentialPresent ? 'present' : 'missing'}.`,
        ]};
      }
    }
  } catch (error) {
    if (error instanceof MachineStateError) return {summary: {state: 'invalid', problem: error.message}, lines: [error.message]};
    throw error;
  }
}
