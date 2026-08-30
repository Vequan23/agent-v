import type { ApprovalCategory, ApprovalPolicy, ApprovalRequest } from "../core/index.js";

export type ApprovalDecision = "approved" | "denied";
export type ApprovalRule = ApprovalDecision | ((request: ApprovalRequest) => ApprovalDecision | Promise<ApprovalDecision>);

export interface StandardApprovalPolicyOptions {
  /** Missing categories always use this decision. Defaults to denied. */
  defaultDecision?: ApprovalDecision;
  categories?: Partial<Record<ApprovalCategory, ApprovalRule>>;
}

export interface ApprovalDecisionRecord {
  id: string;
  runId: string;
  toolName: string;
  category: ApprovalCategory;
  decision: ApprovalDecision;
}

/** A small deny-by-default policy for host-owned approval UX and tests. */
export class StandardApprovalPolicy implements ApprovalPolicy {
  /** Redacted history; tool inputs and metadata are deliberately not retained. */
  readonly history: ApprovalDecisionRecord[] = [];

  constructor(private readonly options: StandardApprovalPolicyOptions = {}) {}

  async decide(request: ApprovalRequest): Promise<ApprovalDecision> {
    const category = request.category ?? "other";
    const rule = this.options.categories?.[category] ?? this.options.defaultDecision ?? "denied";
    const decision = typeof rule === "function" ? await rule(request) : rule;
    this.history.push({ id: request.id, runId: request.runId, toolName: request.toolName, category, decision });
    return decision;
  }
}

export function denyAllApprovals(): StandardApprovalPolicy {
  return new StandardApprovalPolicy();
}

export function createStandardApprovalPolicy(options: StandardApprovalPolicyOptions): StandardApprovalPolicy {
  return new StandardApprovalPolicy(options);
}
