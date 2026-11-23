import { execution } from "@dynatrace-sdk/automation-utils";

// SCAFFOLD. Read-only: computes a proposal, changes nothing.
const STEP = 50;          // millicores; limits are rounded up to this
const HEADROOM = 1.25;    // proposed limit = 125% of the 95th percentile of observed demand
const MAX_FACTOR = 2;     // never more than double the current limit in one change

export default async function ({ executionId }) {
  const ex = await execution(executionId);
  const row = ((await ex.result("demand")).records ?? [])[0];
  if (!row) return { proposal: null, summary: "No CPU data found for this container; nothing to change." };

  const limit = Number(row.limit);
  const demand = Number(row.demandP95);
  if (!limit) return { proposal: null, summary: `${row.container} has no CPU limit, so it cannot be throttled by one; check for a LimitRange or node-level contention.` };

  const wanted = Math.ceil((demand * HEADROOM) / STEP) * STEP;
  const proposed = Math.min(wanted, limit * MAX_FACTOR);
  if (proposed <= limit) return { proposal: null, summary: `${row.container}: current limit ${limit}m already covers observed demand (${Math.round(demand)}m at p95).` };

  const capped = wanted > proposed;
  return {
    proposal: {
      container: row.container,
      workload: row.workload,
      from: limit,
      to: proposed,
      // Strategic merge patch addressed by container name.
      patch: JSON.stringify({ spec: { template: { spec: { containers: [{ name: row.container, resources: { limits: { cpu: `${proposed}m` } } }] } } } }),
    },
    summary: `Raise ${row.container}'s CPU limit from ${limit}m to ${proposed}m. Over the last 6 hours its demand peaked at ${Math.round(Number(row.demandMax))}m and was ${Math.round(demand)}m at p95.${capped ? " The change is capped at double the current limit; run again afterwards if throttling continues." : ""}`,
  };
}
