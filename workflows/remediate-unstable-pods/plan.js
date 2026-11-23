import { execution } from "@dynatrace-sdk/automation-utils";

// SCAFFOLD. Read-only: decides what to propose, changes nothing.
const STEP = 64 * 1024 * 1024; // memory limits are rounded up to 64 MiB
const HEADROOM = 1.25;
const MAX_FACTOR = 2;
const MiB = (b) => `${Math.round(b / 1048576)} MiB`;

export default async function ({ executionId }) {
  const ex = await execution(executionId);
  const rows = (await ex.result("evidence")).records ?? [];
  const rollouts = new Map(((await ex.result("rollouts")).records ?? []).map((r) => [r.workload, r]));
  if (!rows.length) return { proposal: null, summary: "No pod restarts or OOM kills in the last 2 hours; nothing to change." };

  const r = rows[0];
  const recentRollout = rollouts.get(r.workload);
  const limit = Number(r.memLimit);

  if (Number(r.oomMax) > 0 && limit) {
    const proposed = Math.min(Math.ceil((Number(r.memPeak) * HEADROOM) / STEP) * STEP, limit * MAX_FACTOR);
    if (proposed > limit) {
      return {
        proposal: { type: "memory-limit", container: r.container, workload: r.workload, from: limit, to: proposed,
          patch: JSON.stringify({ spec: { template: { spec: { containers: [{ name: r.container, resources: { limits: { memory: String(proposed) } } }] } } } }) },
        summary: `${r.container} was killed for running out of memory ${r.oomMax} time(s). Raise its memory limit from ${MiB(limit)} to ${MiB(proposed)} (peak use was ${MiB(Number(r.memPeak))}).`,
      };
    }
  }
  if (recentRollout) {
    return {
      proposal: { type: "rollback", container: r.container, workload: r.workload },
      summary: `${r.container} restarted ${r.restarts} time(s) after a change to ${r.workload} at ${recentRollout.lastChange}. Roll the workload back to its previous revision.`,
    };
  }
  return { proposal: null, summary: `${r.container} restarted ${r.restarts} time(s) with no memory kills or recent rollout; this needs a person to look at its logs. No automatic change proposed.` };
}
