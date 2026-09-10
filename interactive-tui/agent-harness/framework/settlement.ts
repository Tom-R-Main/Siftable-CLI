/**
 * Noninteractive settlement (CLI-044).
 *
 * A headless `sift agent run` has no person reading the conversation during the
 * turn. Approval is decided by policy, not by a reader. A final answer that asks
 * that absent person to approve, confirm, choose, or run something is therefore
 * not a terminal result: nothing will ever answer it, and the task's deliverable
 * is left undone. The model-facing instruction below is the primary fix; the
 * detector is a backstop that costs one extra model round only when it fires.
 */

export type NoninteractiveApprovalPolicy = 'allow' | 'deny';

export interface NoninteractiveSettlement {
  approvalPolicy: NoninteractiveApprovalPolicy;
}

export interface UserDirectedRequest {
  /** The matched cue, bounded, for receipts and diagnostics. */
  cue: string;
}

/** Conservative cues: second-person requests for permission, confirmation, or action. */
const CUES: RegExp[] = [
  /\b(?:please\s+)?(?:approve|authori[sz]e|allow|grant)\b[^.\n]{0,40}\b(?:running|these|this|the following|me|access|permission)\b/i,
  /\bi\s+need\s+(?:your\s+)?(?:approval|permission|authori[sz]ation|(?:shell|terminal|write|file)\s+access)\b/i,
  /\b(?:do you want|would you like|do you wish)\s+(?:me\s+)?to\b/i,
  /\b(?:should|shall|may|can)\s+i\s+(?:proceed|continue|go ahead|run|execute|apply|write|edit|delete|start)\b/i,
  /\blet me know\s+(?:if|whether|when|which|how|and)\b/i,
  /\b(?:once|after|when)\s+you\s+(?:approve|confirm|authori[sz]e|give the go[- ]ahead|say so)\b/i,
  /\b(?:please\s+)?(?:confirm|reply|respond|tell me)\s+(?:that|whether|if|which|so|with|and|before)\b/i,
  /\b(?:please\s+)?run\s+(?:these|the following|this)\s+(?:commands?|steps?)\b[^.\n]{0,40}\b(?:yourself|manually|and (?:paste|share|send))\b/i,
  /\bawaiting\s+(?:your\s+)?(?:approval|confirmation|go[- ]ahead|input)\b/i,
];

/** Returns the first matched cue when `text` asks the (absent) user to act or decide. */
export function detectUserDirectedRequest(text: string): UserDirectedRequest | undefined {
  if (!text) return undefined;
  for (const cue of CUES) {
    const match = cue.exec(text);
    if (match) return {cue: match[0].slice(0, 120)};
  }
  return undefined;
}

/** System-prompt block for noninteractive runs. Kept short: it is sent on every request. */
export function noninteractivePromptBlock(policy: NoninteractiveApprovalPolicy): string {
  const approval = policy === 'allow'
    ? 'Tool use is pre-approved by policy: permitted tools run immediately without asking.'
    : 'Tools that need approval are denied by policy; a denial is final for this run.';
  return [
    '',
    '## Noninteractive run',
    'No person reads or answers this conversation while the turn runs. Nobody can approve, confirm, choose, or run anything for you.',
    approval,
    'Never ask the user for permission, confirmation, or a decision. Decide, act with tools, and finish.',
    'End the turn only when the requested result exists (files written, commands run, checks done). A final answer that asks the user to do something is treated as an incomplete run.',
    '',
  ].join('\n');
}

/** One bounded feedback message, appended as the user turn before the next model request. */
export function noninteractiveFeedback(policy: NoninteractiveApprovalPolicy, request: UserDirectedRequest): string {
  const approval = policy === 'allow'
    ? 'Approval policy is allow: permitted tools run immediately when you call them.'
    : 'Approval policy is deny: any tool that needs approval is refused, so work within the tools that succeed.';
  return [
    'noninteractive_run: your last answer asked the user to act or decide ("' + request.cue + '"), but no person can read or answer during this run.',
    approval,
    'Do not ask again. If the task still needs actions, take them now with tools, then give the final result. If the task is impossible with the available tools, say exactly what is missing and stop.',
  ].join(' ');
}

export const NONINTERACTIVE_UNSETTLED_ERROR = 'Final answer asked the user to act in a noninteractive run; the task was not completed';
