/** Tunable thresholds. Everything the detectors need lives here so it can be changed in one place. */
export interface HealthConfig {
  /** App boundary: Kubernetes namespace to analyse (the only boundary kind in the demo). */
  namespace: string;
  /** Look-back window (hours) for "current" signals. */
  windowHours: number;
  /** Containers excluded from ranking (e.g. synthetic load generators). */
  syntheticContainers: string[];
  /** % of CPU demand that was throttled (throttled / (throttled + used)). */
  throttleProblemPct: number;
  throttleRiskPct: number;
  /** Process restarts / probe failures that count as "unstable". */
  restartProblemCount: number;
  /** Memory working set as % of limit that counts as pressure. */
  memoryProblemPct: number;
  /** Hours until a growing memory footprint reaches its limit that counts as a risk. */
  memoryExhaustionHours: number;
  /** CPU usage as % of limit that leaves too little headroom. */
  cpuHeadroomPct: number;
  /** p95 latency (ms): consistently high when the median hourly p95 exceeds it. */
  highLatencyMs: number;
  /** Spike: hourly p95 above spikeFactor x the median hourly p95 and above spikeMinMs. */
  spikeFactor: number;
  spikeMinMs: number;
  /** Relative regressions versus the service's own 7-day baseline. */
  latencyRegressionFactor: number;
  errorRateFactor: number;
  errorRateMinPct: number;
  /** Minimum share of requests failing (non-transient) before it counts as a problem. */
  errorMinRatePct: number;
  /** Traffic: recent rate below this fraction of the 6h rate counts as silent. */
  silenceFraction: number;
  minBaselineReqPerMin: number;
  /** Client calls per server request at a target above which retries are suspected. */
  retryRatio: number;
  /** Distinct upstream+downstream neighbours at which a service is a dependency risk. */
  dependencyRiskCount: number;
  /** Observability rule thresholds. */
  noLevelSharePct: number;
  infoNoiseSharePct: number;
  healthNoisePct: number;
  logVolumeSharePct: number;
  minLogsForRule: number;
  /** Tag keys every workload should carry (ownership). Empty list disables the rule. */
  requiredTags: string[];
}

export const DEFAULT_CONFIG: HealthConfig = {
  namespace: "easytrade",
  windowHours: 6,
  syntheticContainers: ["loadgen"],
  throttleProblemPct: 5,
  throttleRiskPct: 1,
  restartProblemCount: 3,
  memoryProblemPct: 85,
  memoryExhaustionHours: 72,
  cpuHeadroomPct: 80,
  highLatencyMs: 500,
  spikeFactor: 3,
  spikeMinMs: 200,
  latencyRegressionFactor: 2,
  errorRateFactor: 3,
  errorRateMinPct: 1,
  errorMinRatePct: 0.1,
  silenceFraction: 0.1,
  minBaselineReqPerMin: 1,
  retryRatio: 1.5,
  dependencyRiskCount: 4,
  noLevelSharePct: 50,
  infoNoiseSharePct: 80,
  healthNoisePct: 15,
  logVolumeSharePct: 40,
  minLogsForRule: 50,
  requiredTags: ["owner"],
};

/** Namespaces are interpolated into DQL, so only allow Kubernetes-safe names. */
export const safeNamespace = (ns: string): string => {
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(ns)) {
    throw new Error(`Invalid namespace: ${ns}`);
  }
  return ns;
};
