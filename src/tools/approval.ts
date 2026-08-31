import type { ApprovalCategory, ApprovalPolicy, ApprovalRequest } from "../core/index.js";

export type ApprovalDecision = "approved" | "denied";
export type ApprovalRule = ApprovalDecision | ((request: ApprovalRequest) => ApprovalDecision | Promise<ApprovalDecision>);
export type ApprovalRuleEffect = "deny" | "ask" | "allow";

export interface ScopedApprovalRule {
  id: string;
  effect: ApprovalRuleEffect;
  categories?: readonly ApprovalCategory[];
  toolNames?: readonly string[];
  projectIds?: readonly string[];
  principalIds?: readonly string[];
  expiresAt?: string;
}

export interface ScopedApprovalPolicyOptions {
  rules?: readonly ScopedApprovalRule[];
  /** Called only when no matching allow/deny rule settles the request. */
  requestDecision?: (request: ApprovalRequest) => ApprovalDecision | Promise<ApprovalDecision>;
  defaultEffect?: Exclude<ApprovalRuleEffect, "allow">;
  now?: () => Date;
}

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
  effect?: ApprovalRuleEffect;
  ruleId?: string;
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

function matchesRule(rule: ScopedApprovalRule, request: ApprovalRequest, now: Date): boolean {
  if (!rule.id.trim()) return false;
  if (rule.expiresAt && new Date(rule.expiresAt).getTime() <= now.getTime()) return false;
  const category = request.category ?? "other";
  if (rule.categories?.length && !rule.categories.includes(category)) return false;
  if (rule.toolNames?.length && !rule.toolNames.includes(request.toolName)) return false;
  if (rule.projectIds?.length && !rule.projectIds.includes(request.scope.projectId)) return false;
  if (rule.principalIds?.length && !rule.principalIds.includes(request.scope.principalId)) return false;
  return true;
}

/**
 * Provider-neutral deny/ask/allow evaluation. Matching deny rules always win;
 * the host still owns persistence, UX, and the callback that asks a person.
 */
export class ScopedApprovalPolicy implements ApprovalPolicy {
  readonly history: ApprovalDecisionRecord[] = [];

  constructor(private readonly options: ScopedApprovalPolicyOptions = {}) {}

  async decide(request: ApprovalRequest): Promise<ApprovalDecision> {
    const matches = (this.options.rules ?? []).filter((rule) => matchesRule(rule, request, (this.options.now ?? (() => new Date()))()));
    const rule = matches.find((item) => item.effect === "deny")
      ?? matches.find((item) => item.effect === "allow")
      ?? matches.find((item) => item.effect === "ask");
    const effect = rule?.effect ?? this.options.defaultEffect ?? "ask";
    const decision = effect === "deny"
      ? "denied"
      : effect === "allow"
        ? "approved"
        : this.options.requestDecision
          ? await this.options.requestDecision(request)
          : "denied";
    this.history.push({
      id: request.id,
      runId: request.runId,
      toolName: request.toolName,
      category: request.category ?? "other",
      decision,
      effect,
      ...(rule ? { ruleId: rule.id } : {}),
    });
    return decision;
  }
}

export function denyAllApprovals(): StandardApprovalPolicy {
  return new StandardApprovalPolicy();
}

export function createStandardApprovalPolicy(options: StandardApprovalPolicyOptions): StandardApprovalPolicy {
  return new StandardApprovalPolicy(options);
}

export function createScopedApprovalPolicy(options: ScopedApprovalPolicyOptions): ScopedApprovalPolicy {
  return new ScopedApprovalPolicy(options);
}
