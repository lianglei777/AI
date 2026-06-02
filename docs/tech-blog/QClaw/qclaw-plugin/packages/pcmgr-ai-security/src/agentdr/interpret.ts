/**
 * Parse AgentDR Pipeline HTTP response into block verdict and reason.
 */

import type { AgentdrVerdict, PipelineResponse } from "./types.js";

/** allow / require_approval => pass; deny => block */
export function interpretPipelineResponse(resp: PipelineResponse): AgentdrVerdict {
  const pd = resp.policy_decision;
  if (!pd || pd.decision === "allow" || pd.decision === "require_approval") {
    return { block: false, decision: pd?.decision };
  }
  return { block: true, blockReason: `[AgentDR] ${pd.reason}`, decision: pd.decision };
}
