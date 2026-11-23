import { execution } from "@dynatrace-sdk/automation-utils";
import { analyzersClient } from "@dynatrace-sdk/client-davis-analyzers";
import { businessEventsClient } from "@dynatrace-sdk/client-classic-environment-v2";

const NS = "{{NAMESPACE}}";
const ANALYZER = "dt.statistics.ui.anomaly_detection.AutoAdaptiveAnomalyDetectionAnalyzer";
const EVENT_TYPE = "easytrade.insights.recommendation";
const CLEAN_RUNS_TO_RESOLVE = 2;
const SYNTHETIC = ["loadgen"];

const RULES = {
  "no-log-level": (r) => r.logs >= 50 && r.noLevelPct >= 50,
  "info-noise": (r) => r.logs >= 50 && r.infoPct >= 80,
  "cpu-throttled": (r) => r.throttlePct >= 5,
};
const TEXT = {
  "no-log-level": (r) => `${r.noLevelPct}% of ${r.container}'s logs carry no log level, so errors cannot be filtered or alerted on.`,
  "info-noise": (r) => `${r.infoPct}% of ${r.container}'s logs are INFO; consider sampling or dropping the low-value ones.`,
  "cpu-throttled": (r, davis) => `${r.container} was CPU-throttled ${r.throttlePct}% of the time in the last hour; its CPU limit is too low for its load. ${davis ? "Davis: this is worse than its own recent baseline." : "Davis: this is its normal level, a chronic condition."}`,
};

async function davisConfirms(container) {
  const query = `timeseries thr=sum(dt.kubernetes.container.cpu_throttled), by:{k8s.container.name}, filter: k8s.namespace.name=="${NS}" and k8s.container.name=="${container}", from:now()-6h, interval:5m`;
  let res = await analyzersClient.executeAnalyzer({
    analyzerName: ANALYZER,
    body: { query, numberOfSignalFluctuations: 1, alertCondition: "ABOVE", alertOnMissingData: false, violatingSamples: 3, slidingWindow: 5, dealertingSamples: 3 },
    timeoutSeconds: 20,
  });
  for (let i = 0; i < 10 && res.result.executionStatus === "RUNNING"; i++) {
    res = await analyzersClient.pollAnalyzerExecution({ analyzerName: ANALYZER, requestToken: res.requestToken, timeoutSeconds: 10 });
  }
  // Davis flags throttling that is unusual against the container's own learned baseline;
  // constant throttling is chronic, not anomalous, so false here means "chronic" rather than "fine".
  const outs = res.result?.output ?? [];
  return outs.some((o) => o.analysisStatus === "SUCCESS" && Number(o.potentialAlerts) > 0);
}

export default async function ({ executionId }) {
  const ex = await execution(executionId);
  const thr = (await ex.result("throttle")).records;
  const lg = (await ex.result("logs")).records;
  const prev = (await ex.result("previous")).records;

  const byC = new Map();
  const get = (c) => byC.get(c) ?? byC.set(c, { container: c, logs: 0, noLevelPct: 0, infoPct: 0, throttlePct: 0 }).get(c);
  lg.forEach((r) => Object.assign(get(r.container), { logs: Number(r.logs), noLevelPct: Number(r.noLevelPct), infoPct: Number(r.infoPct) }));
  thr.forEach((r) => get(r.container).throttlePct = Number(r.throttlePct));
  SYNTHETIC.forEach((c) => byC.delete(c));

  const state = new Map(prev.map((p) => [`${p.container}|${p.rule}`, p]));
  const out = [];
  const events = [];
  const keys = new Set([...state.keys()]);
  for (const r of byC.values()) for (const rule of Object.keys(RULES)) keys.add(`${r.container}|${rule}`);

  for (const key of keys) {
    const [container, rule] = key.split("|");
    const r = byC.get(container);
    if (!RULES[rule]) continue;
    const firing = !!r && RULES[rule](r);
    const before = state.get(key);
    const wasOpen = before && before.status !== "RESOLVED";
    let status, cleanRuns = 0, davis = before?.davis === "true";
    if (firing) {
      status = wasOpen ? "OPEN" : "NEW";
      if (rule === "cpu-throttled") davis = await davisConfirms(container).catch(() => false);
    } else if (wasOpen) {
      cleanRuns = Number(before.cleanRuns ?? 0) + 1;
      status = cleanRuns >= CLEAN_RUNS_TO_RESOLVE ? "RESOLVED" : "OPEN";
    } else continue;
    const changed = !before || before.status !== status || (before.davis === "true") !== davis || Number(before.cleanRuns ?? 0) !== cleanRuns;
    out.push({ container, rule, status, cleanRuns, davis, changed });
    if (changed) events.push({
      specversion: "1.0", id: `${Date.now()}-${key}`, source: "easytrade-insights", type: EVENT_TYPE,
      data: { namespace: NS, container, rule, status, cleanRuns, davis, summary: firing ? TEXT[rule](r, davis) : `${container}: ${rule} no longer applies.` },
    });
  }
  if (events.length) {
    await businessEventsClient.ingest({ body: events, type: "application/cloudevent-batch+json" });
  }
  return { evaluated: byC.size, written: events.length, changes: out.filter((o) => o.changed) };
}
