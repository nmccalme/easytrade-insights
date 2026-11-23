import { execution } from "@dynatrace-sdk/automation-utils";

// Which container is this run about? A bizevent from the lifecycle workflow carries it;
// a manual run passes it as the `container` run parameter.
export default async function ({ executionId }) {
  const ex = await execution(executionId);
  const p = ex.params ?? {};
  const container = p.event?.container ?? p.container;
  if (!container || !/^[A-Za-z0-9._-]+$/.test(String(container))) throw new Error("No valid container in the trigger event or run parameters.");
  return { container: String(container) };
}
