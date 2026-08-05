/**
 * L2 准入裁决。规则只有三条，全部在这里：
 *
 *   need ∈ supports          → 放行
 *   need ∈ lossy             → 放行 + 强制记一条 degraded loss
 *   need ∉ supports ∪ lossy  → 该出口不可用；多出口时换一家，单出口时 422 并带上 paths
 *
 * 关键在于**先裁决再发请求**：把表达不了的请求硬塞给上游，得到的是一个语义模糊的
 * 4xx/5xx，客户端无从知道是哪个字段的问题。这里返回的 unsupported 带着精确 IR 路径。
 */
import type { IRCapabilityNeed, IROutboxProfile, IRLoss, IRRequest } from "./types.ts";

export interface OutboxSupportCheck {
  readonly admitted: boolean;
  readonly unsupported: readonly IRCapabilityNeed[];
  readonly losses: readonly IRLoss[];
}

export function checkOutboxSupport(
  request: IRRequest, profile: IROutboxProfile, outbox: string | null = null,
): OutboxSupportCheck {
  const unsupported: IRCapabilityNeed[] = [];
  const losses: IRLoss[] = [];
  for (const need of request.requires) {
    if (profile.supports.has(need.capability)) continue;
    if (profile.lossy.has(need.capability)) {
      losses.push({
        stage: "outbox",
        outbox,
        path: need.paths[0] ?? "$",
        kind: "degraded",
        detail: `selected outbox carries '${need.capability}' only with loss of fidelity`,
      });
      continue;
    }
    unsupported.push(need);
  }
  return { admitted: unsupported.length === 0, unsupported, losses };
}

export function describeUnsupportedCapabilities(unsupported: readonly IRCapabilityNeed[]): string {
  return unsupported
    .map((need) => `${need.capability} (${need.paths.slice(0, 3).join(", ")})`)
    .join("; ");
}
