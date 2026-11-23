import { execution } from "@dynatrace-sdk/automation-utils";

// SCAFFOLD: turns the Davis problem and the evidence query into a short message a non-engineer can read.
export default async function ({ executionId }) {
  const ex = await execution(executionId);
  const problem = ex.params?.event ?? {};
  const evidence = (await ex.result("evidence")).records ?? [];
  const top = evidence.slice(0, 3).map((r) => `${r.container} (${r.errors} warnings/errors, e.g. "${String(r.sample).slice(0, 120)}")`);
  return {
    subject: `[{{NAMESPACE}}] ${problem["event.name"] ?? "Problem detected"}`,
    body: [
      `Davis reports: ${problem["event.name"] ?? "a problem"} (${problem["event.category"] ?? "unknown category"}).`,
      top.length ? `Most affected services right now: ${top.join("; ")}.` : "No error logs found in the last 30 minutes.",
      "Open the EasyTrade Insights app for the likely cause and evidence.",
    ].join("\n\n"),
  };
}
