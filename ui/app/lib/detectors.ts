import { Indexed } from "./indexing";
import { QueryKey } from "./queries";
import { Finding, FindingKind } from "./types";
import { bytes, fmt, isTransientText, ms, num, pct, str } from "./util";

export interface Detector {
  id: string;
  kind: FindingKind;
  rank: number;
  name: string;
  /** Queries that must return rows for the detector to be able to fire; otherwise it is reported as "no data". */
  requires: QueryKey[];
  detect: (c: string, ix: Indexed) => Finding | undefined;
}

const safe = (s: string) => /^[A-Za-z0-9._-]+$/.test(s);
const nsOf = (ix: Indexed) => ix.cfg.namespace;
const hours = (ix: Indexed) => ix.cfg.windowHours;

const logQuery = (ix: Indexed, c: string, filter: string, by = "content") =>
  safe(c)
    ? `fetch logs, from:now()-${hours(ix)}h\n| filter k8s.namespace.name=="${nsOf(ix)}" and k8s.container.name=="${c}" and ${filter}\n| summarize n=count(), by:{${by}}\n| sort n desc | limit 20`
    : undefined;
const spanQuery = (ix: Indexed, c: string, filter: string) =>
  safe(c)
    ? `fetch spans, from:now()-${hours(ix)}h\n| filter k8s.namespace.name=="${nsOf(ix)}" and k8s.container.name=="${c}" and ${filter}\n| summarize n=count(), p95=percentile(toDouble(duration)/1000000.0, 95), by:{span.name}\n| sort n desc | limit 20`
    : undefined;

const ev = (ix: Indexed, c: string, kind: string) => (ix.by("events").get(c) ?? []).find((r) => str(r.kind) === kind);

const recentIso = (iso: unknown, ix: Indexed): boolean => {
  const t = Date.parse(str(iso));
  return Number.isFinite(t) && t >= Date.now() - hours(ix) * 3600e3;
};

// ---------------------------------------------------------------------------------------------
// PROBLEMS  (rank 1 = most severe)
// ---------------------------------------------------------------------------------------------

const unstable: Detector = {
  id: "pods.unstable",
  kind: "problem",
  rank: 1,
  name: "Failed deployment or pods crashing (any cause)",
  requires: ["events"],
  detect: (c, ix) => {
    const restarts = num(ev(ix, c, "restart")?.inWindow);
    const probes = num(ev(ix, c, "probe")?.last24h);
    const fails = ev(ix, c, "deployfail");
    const deployFails = num(fails?.inWindow);
    const oom = num(ix.first("oom", c)?.oomMax);
    if (!(restarts >= ix.cfg.restartProblemCount || deployFails > 0 || probes >= 3)) return undefined;
    const sample = str(fails?.sample || ev(ix, c, "probe")?.sample);
    const cause =
      oom > 0 && restarts + deployFails > 0
        ? "Out of memory: the container was killed for exceeding its memory limit."
        : /mount|volume/i.test(sample)
          ? "Failed to start: a volume could not be mounted."
          : /image|pull/i.test(sample)
            ? "Failed to start: the container image could not be pulled."
            : restarts >= ix.cfg.restartProblemCount
              ? "The process keeps restarting."
              : "Health checks are failing, so Kubernetes is marking the pod unhealthy.";
    return {
      kind: "problem",
      rank: 1,
      code: "UNSTABLE_PODS",
      title: "Service is unstable or failing to start",
      summary: "This service restarted, was killed, or failed health checks recently, so users may see interruptions.",
      rootCause: cause,
      details: [
        restarts ? `${restarts} process restarts in the last ${hours(ix)}h` : "",
        deployFails ? `${deployFails} kill / back-off / mount / scheduling events in the last ${hours(ix)}h` : "",
        probes ? `${probes} failed health probes in the last 24h` : "",
        oom ? `OOM kills recorded in the last 7 days` : "",
        sample ? `Latest event: ${sample}` : "",
      ].filter(Boolean),
    };
  },
};

const silent: Detector = {
  id: "traffic.silent",
  kind: "problem",
  rank: 1,
  name: "Service stopped receiving traffic",
  requires: ["svcNow", "svcRecent", "serviceContainers"],
  detect: (c, ix) => {
    const m = ix.svc.get(c);
    if (!m) return undefined;
    const base = m.nowN / (hours(ix) * 60);
    const recent = m.n30 / 30;
    if (base < ix.cfg.minBaselineReqPerMin || recent >= base * ix.cfg.silenceFraction) return undefined;
    const callers = [...(ix.up.get(c) ?? [])];
    return {
      kind: "problem",
      rank: 1,
      code: "TRAFFIC_SILENT",
      title: "Service has stopped receiving requests",
      summary: "Traffic to this service has nearly stopped. That usually means it crashed, was disconnected, or its callers are failing — not that demand disappeared.",
      rootCause: callers.length ? `Check its callers first: ${callers.join(", ")}.` : "No upstream callers are known; check ingress and the service itself.",
      details: [`${fmt(base, 1)} requests/min over the last ${hours(ix)}h, ${fmt(recent, 1)} requests/min over the last 30 minutes`],
    };
  },
};

const nonTransient: Detector = {
  id: "errors.nontransient",
  kind: "problem",
  rank: 2,
  name: "Non-transient errors (bad request, failure to parse, server faults)",
  requires: ["spans", "logErrors", "failureReasons"],
  detect: (c, ix) => {
    const sp = ix.first("spans", c);
    const total = num(sp?.total);
    const hardSpan = Math.max(0, num(sp?.failed) - num(sp?.transient));
    const significantSpan = hardSpan > 0 && (hardSpan / Math.max(total, 1)) * 100 >= ix.cfg.errorMinRatePct;
    const hardLogs = (ix.by("logErrors").get(c) ?? []).filter((r) => str(r.loglevel) === "ERROR" && !isTransientText(str(r.sample)));
    if (!significantSpan && !hardLogs.length) return undefined;
    const reasons = (ix.by("failureReasons").get(c) ?? []).filter((r) => !isTransientText(str(r.exMsg)));
    const failingCalls = (ix.by("clientCalls").get(c) ?? []).filter((r) => num(r.failed) > 0);
    const top = hardLogs[0];
    const reason = reasons[0];
    const rootCause = reason && str(reason.exMsg) ? `Most common failure: "${str(reason.exMsg)}"${num(reason.status) ? ` (HTTP ${num(reason.status)})` : ""}, ${fmt(num(reason.n))} requests.`
      : top ? `Most common error: "${str(top.sample)}" (${str(top.pattern)}).`
      : failingCalls[0] ? `Failing calls to ${str(failingCalls[0].target)}.` : undefined;
    return {
      kind: "problem",
      rank: 2,
      code: "NON_TRANSIENT_ERRORS",
      title: "Requests are failing for a reason that won't fix itself",
      summary: "Some requests fail repeatedly (for example malformed data or a server fault), so retrying will not help.",
      rootCause,
      details: [
        significantSpan ? `${fmt(hardSpan)} failed requests of ${fmt(total)} (${pct((hardSpan / Math.max(total, 1)) * 100)})` : "",
        ...reasons.slice(0, 3).filter((r) => str(r.exMsg)).map((r) => `${fmt(num(r.n))}× "${str(r.exMsg)}"${num(r.status) ? ` (HTTP ${num(r.status)})` : ""}`),
        ...hardLogs.slice(0, 3).map((r) => `${fmt(num(r.n))}× ERROR log "${str(r.sample)}" at ${str(r.pattern)}`),
        ...failingCalls.slice(0, 2).map((r) => `${fmt(num(r.failed))} failed outgoing calls to ${str(r.target)}`),
      ].filter(Boolean),
      query: logQuery(ix, c, `loglevel=="ERROR"`, "content=substring(content, from:0, to:160)") ?? spanQuery(ix, c, "request.is_failed==true"),
    };
  },
};

const newPattern: Detector = {
  id: "errors.newpattern",
  kind: "problem",
  rank: 2,
  name: "A new kind of error appeared (not seen in the previous 7 days)",
  requires: ["logErrors", "logErrorsBaseline"],
  detect: (c, ix) => {
    if (!ix.raw.logErrorsBaseline.length) return undefined;
    const known = new Set((ix.by("logErrorsBaseline").get(c) ?? []).map((r) => str(r.pattern)));
    const fresh = (ix.by("logErrors").get(c) ?? []).filter((r) => str(r.loglevel) === "ERROR" && !known.has(str(r.pattern)));
    if (!fresh.length) return undefined;
    return {
      kind: "problem",
      rank: 2,
      code: "NEW_ERROR_PATTERN",
      title: "A new kind of error has started",
      summary: "The service is logging an error it has not logged in the past week, which usually points to a recent change or a new fault.",
      rootCause: `"${str(fresh[0].sample)}" at ${str(fresh[0].pattern)}.`,
      details: fresh.slice(0, 4).map((r) => `${fmt(num(r.n))}× "${str(r.sample)}" (${str(r.pattern)}) — first seen in the last ${hours(ix)}h`),
    };
  },
};

const errorRate: Detector = {
  id: "errors.rate",
  kind: "problem",
  rank: 2,
  name: "Error rate far above its own 7-day baseline",
  requires: ["svcBaseline", "svcNow", "serviceContainers"],
  detect: (c, ix) => {
    const m = ix.svc.get(c);
    if (!m || m.nowN < 100 || m.baseN < 100) return undefined;
    const now = (m.nowF / m.nowN) * 100;
    const base = (m.baseF / m.baseN) * 100;
    if (now < ix.cfg.errorRateMinPct || now < ix.cfg.errorRateFactor * Math.max(base, 0.01)) return undefined;
    return {
      kind: "problem",
      rank: 2,
      code: "ERROR_RATE_JUMP",
      title: "Failure rate has jumped",
      summary: "A much larger share of requests is failing than this service normally sees.",
      rootCause: `Failure rate is ${pct(now)} versus a normal ${pct(base)}.`,
      details: [`${fmt(m.nowF)} failures of ${fmt(m.nowN)} requests in the last ${hours(ix)}h`, `Baseline: ${fmt(m.baseF)} of ${fmt(m.baseN)} over the previous 7 days`],
      query: spanQuery(ix, c, "request.is_failed==true"),
    };
  },
};

const throttling: Detector = {
  id: "cpu.throttling",
  kind: "problem",
  rank: 3,
  name: "CPU throttling",
  requires: ["throttle"],
  detect: (c, ix) => {
    const t = ix.first("throttle", c);
    const p = num(t?.throttlePct);
    if (p < ix.cfg.throttleProblemPct) return undefined;
    const lim = num(ix.first("resources", c)?.cpuLimit);
    return {
      kind: "problem",
      rank: 3,
      code: "CPU_THROTTLING",
      title: "Service is being held back by its CPU limit",
      summary: "The service wants more processor time than it is allowed, so work queues up and everything it does slows down.",
      rootCause: lim ? `CPU limit is ${fmt(lim)} millicores; raise it or reduce load.` : "Raise the CPU limit or reduce load.",
      details: [`${pct(p)} of CPU demand was throttled over the last ${hours(ix)}h`, `Average usage ${fmt(num(t?.useAvg), 0)} millicores`],
    };
  },
};

const memoryPressure: Detector = {
  id: "memory.pressure",
  kind: "problem",
  rank: 3,
  name: "Memory close to its limit",
  requires: ["memory"],
  detect: (c, ix) => {
    const m = ix.first("memory", c);
    const lim = num(m?.memLimit);
    const now = num(m?.memNow);
    if (!lim || (now / lim) * 100 < ix.cfg.memoryProblemPct) return undefined;
    return {
      kind: "problem",
      rank: 3,
      code: "MEMORY_PRESSURE",
      title: "Service is almost out of memory",
      summary: "The service is using nearly all the memory it is allowed. If it goes over, it will be killed and restart.",
      rootCause: "Raise the memory limit, or look for a leak if usage keeps climbing.",
      details: [`${bytes(now)} used of ${bytes(lim)} (${pct((now / lim) * 100)})`],
    };
  },
};

const exposedVulns: Detector = {
  id: "security.exposed",
  kind: "problem",
  rank: 3,
  name: "Critical/high vulnerability exposed to the public network",
  requires: ["security"],
  detect: (c, ix) => {
    const rows = (ix.securityBy.get(c) ?? []).filter((r) => ["CRITICAL", "HIGH"].includes(str(r.level)) && num(r.exposed) > 0);
    if (!rows.length) return undefined;
    return {
      kind: "problem",
      rank: 3,
      code: "VULN_EXPOSED",
      title: "A serious security hole is reachable from outside",
      summary: "This service contains a known critical or high-severity vulnerability and is reachable from the public network.",
      rootCause: `${str(rows[0].top)}.`,
      details: rows.map((r) => `${fmt(num(r.exposed))} exposed ${str(r.level)} vulnerabilities (highest score ${fmt(num(r.maxScore), 1)})`),
    };
  },
};

const logAnomaly: Detector = {
  id: "errors.logspike",
  kind: "problem",
  rank: 2,
  name: "Error-log spike or a service that stopped logging",
  requires: ["logSeries"],
  detect: (c, ix) => {
    const r = ix.first("logSeries", c);
    if (!r) return undefined;
    const prev = num(r.totalPrev);
    const base = num(r.totalBase);
    const errPrev = num(r.errsPrev);
    const errBase = num(r.errsBase);
    if (base >= 20 && prev === 0) {
      return {
        kind: "problem",
        rank: 1,
        code: "LOG_SILENCE",
        title: "Service has gone quiet",
        summary: "A service that normally writes logs all day has written nothing for the last half hour. That often means it stopped running.",
        rootCause: "Check whether the pod is running and whether log shipping is healthy.",
        details: [`Normally about ${fmt(base)} log lines per 30 minutes; the latest complete 30-minute period had none.`],
      };
    }
    if (errPrev >= 10 && errPrev >= 3 * Math.max(errBase, 1)) {
      return {
        kind: "problem",
        rank: 2,
        code: "ERROR_LOG_SPIKE",
        title: "Sudden burst of errors in the logs",
        summary: "The service logged far more errors than usual in the latest half hour.",
        details: [`${fmt(errPrev)} errors in the latest complete 30-minute period versus about ${fmt(errBase, 1)} normally (peak ${fmt(num(r.errsMax))})`],
        query: logQuery(ix, c, `loglevel=="ERROR"`, "content=substring(content, from:0, to:160)"),
      };
    }
    return undefined;
  },
};

const transient: Detector = {
  id: "errors.transient",
  kind: "problem",
  rank: 4,
  name: "Timeouts and other transient errors",
  requires: ["spans", "logErrors"],
  detect: (c, ix) => {
    const t = num(ix.first("spans", c)?.transient);
    const logs = (ix.by("logErrors").get(c) ?? []).filter((r) => str(r.loglevel) === "ERROR" && isTransientText(str(r.sample)));
    if (!t && !logs.length) return undefined;
    return {
      kind: "problem",
      rank: 4,
      code: "TRANSIENT_ERRORS",
      title: "Requests are timing out or briefly failing",
      summary: "Some requests fail temporarily (timeouts, dropped connections). Users may notice slowness or retries, but it may clear by itself.",
      details: [t ? `${fmt(t)} timeouts / transient failures in the last ${hours(ix)}h` : "", ...logs.slice(0, 2).map((r) => `"${str(r.sample)}" (${fmt(num(r.n))}×)`)].filter(Boolean),
    };
  },
};

const latency: Detector = {
  id: "latency.high",
  kind: "problem",
  rank: 5,
  name: "Consistently high latency (with root cause: slow database, downstream or external call)",
  requires: ["endpointLatency"],
  detect: (c, ix) => {
    const eps = (ix.by("endpointLatency").get(c) ?? []).filter((r) => num(r.p95Median) > ix.cfg.highLatencyMs);
    const slow = (ix.by("slowSql").get(c) ?? []).filter((r) => num(r.n) >= 10);
    const m = ix.svc.get(c);
    const nowRt = m && m.nowN ? m.nowRtSum / m.nowN / 1000 : 0;
    const baseRt = m && m.baseN ? m.baseRtSum / m.baseN / 1000 : 0;
    const regressed = nowRt > 100 && baseRt > 0 && nowRt >= ix.cfg.latencyRegressionFactor * baseRt;
    if (!eps.length && !slow.length && !regressed) return undefined;

    // Root cause: where does this service spend its time?
    const sumMs = num(ix.first("spans", c)?.sumMs);
    const calls = (ix.by("clientCalls").get(c) ?? []).filter((r) => str(r.target) !== "unknown" && str(r.target) !== "");
    const best = calls.sort((a, b) => num(b.totalMs) - num(a.totalMs))[0];
    const share = best && sumMs ? Math.min(1, num(best.totalMs) / sumMs) : 0;
    const target = best ? str(best.target) : "";
    const targetContainer = target ? ix.toContainer(target) : undefined;
    let rootCause: string | undefined;
    let waitsOn: string | undefined;
    const targetIsDb = !!targetContainer && !ix.first("spans", targetContainer);
    if (share >= 0.4 && best && !(slow[0] && targetIsDb)) {
      if (targetContainer && targetContainer !== c) {
        waitsOn = targetContainer;
        rootCause = `A large part of its time (${fmt(share * 100)}%) is spent waiting on ${targetContainer} (p95 ${ms(num(best.p95))} per call).`;
      } else if (!targetContainer) {
        rootCause = `A large part of its time (${fmt(share * 100)}%) is spent waiting on an external dependency: ${target} (p95 ${ms(num(best.p95))} per call).`;
      }
    }
    if (!rootCause && slow[0]) rootCause = `Slow database queries: ${fmt(num(slow[0].n))} statements over 200 ms on ${str(slow[0].tbl)} (p95 ${ms(num(slow[0].p95))}).`;

    return {
      kind: "problem",
      rank: 5,
      code: "HIGH_LATENCY",
      title: "Service is consistently slow",
      summary: "Responses take long enough that users will notice, and it is not a one-off.",
      rootCause,
      waitsOn,
      details: [
        ...eps.slice(0, 3).map((r) => `${str(r.endpoint)}: typical p95 ${ms(num(r.p95Median))} (${fmt(num(r.calls))} calls/24h)`),
        eps.length > 3 ? `+${eps.length - 3} more slow endpoints` : "",
        slow[0] ? `${fmt(num(slow[0].n))} slow SQL statements on ${str(slow[0].tbl)} in ${hours(ix)}h (p95 ${ms(num(slow[0].p95))}, worst ${ms(num(slow[0].maxMs))})` : "",
        regressed ? `Average response time ${ms(nowRt)} versus ${ms(baseRt)} over the previous 7 days (${fmt(nowRt / baseRt, 1)}×)` : "",
      ].filter(Boolean),
      query: spanQuery(ix, c, `span.kind=="server"`),
    };
  },
};

const spikes: Detector = {
  id: "latency.spikes",
  kind: "problem",
  rank: 6,
  name: "Latency spikes (tail latency)",
  requires: ["endpointLatency"],
  detect: (c, ix) => {
    const s = (ix.by("endpointLatency").get(c) ?? []).filter((r) => num(r.p95Max) > ix.cfg.spikeFactor * Math.max(num(r.p95Median), 1) && num(r.p95Max) > ix.cfg.spikeMinMs);
    if (!s.length) return undefined;
    return {
      kind: "problem",
      rank: 6,
      code: "LATENCY_SPIKES",
      title: "Occasional very slow responses",
      summary: "Most requests are fine, but some take far longer than usual. A minority of users are affected.",
      details: s.slice(0, 3).map((r) => `${str(r.endpoint)} peaked at ${ms(num(r.p95Max))} versus typical ${ms(num(r.p95Median))}`),
    };
  },
};

// ---------------------------------------------------------------------------------------------
// RISKS
// ---------------------------------------------------------------------------------------------

const dependencies: Detector = {
  id: "risk.dependencies",
  kind: "risk",
  rank: 1,
  name: "Many upstream / downstream dependencies",
  requires: ["serviceEdges", "serviceContainers"],
  detect: (c, ix) => {
    const up = [...(ix.up.get(c) ?? [])].sort();
    const down = [...(ix.down.get(c) ?? [])].sort();
    if (new Set([...up, ...down]).size < ix.cfg.dependencyRiskCount) return undefined;
    return {
      kind: "risk",
      rank: 1,
      code: "MANY_DEPENDENCIES",
      title: "Lots of other services depend on this, or on it",
      summary: "If this service has a bad day, many others are affected, so it deserves extra care.",
      details: [`Called by: ${up.join(", ") || "none"}`, `Calls: ${down.join(", ") || "none"}`],
    };
  },
};

const deployHistory: Detector = {
  id: "risk.deployhistory",
  kind: "risk",
  rank: 2,
  name: "History of failed deployments or unhealthy pods",
  requires: ["events"],
  detect: (c, ix) => {
    const d = num(ev(ix, c, "deployfail")?.total7d);
    const p = num(ev(ix, c, "probe")?.total7d);
    if (!(d > 0 || p >= 5)) return undefined;
    return {
      kind: "risk",
      rank: 2,
      code: "DEPLOY_HISTORY",
      title: "Has had trouble starting or staying healthy before",
      summary: "This service has a record of failed starts or failed health checks in the past week.",
      details: [`${d} kill / back-off / mount events and ${p} failed probes in the last 7 days`],
    };
  },
};

const marginal: Detector = {
  id: "risk.marginal",
  kind: "risk",
  rank: 3,
  name: "Marginal performance or infrastructure, or problems in the past",
  requires: ["throttle", "events"],
  detect: (c, ix) => {
    const p = num(ix.first("throttle", c)?.throttlePct);
    const marginalThrottle = p >= ix.cfg.throttleRiskPct && p < ix.cfg.throttleProblemPct;
    const restartsNow = num(ev(ix, c, "restart")?.inWindow);
    const restartHist = num(ev(ix, c, "restart")?.total7d);
    const oom = num(ix.first("oom", c)?.oomMax);
    if (!(marginalThrottle || (restartHist > 0 && restartsNow < ix.cfg.restartProblemCount) || oom > 0)) return undefined;
    return {
      kind: "risk",
      rank: 3,
      code: "MARGINAL_METRICS",
      title: "Running close to its limits, or has shown problems before",
      summary: "Nothing is broken right now, but there is little slack, or it has misbehaved recently.",
      details: [marginalThrottle ? `${pct(p)} of CPU demand throttled` : "", restartHist ? `${restartHist} process restarts in the last 7 days` : "", oom ? "OOM kills recorded in the last 7 days" : ""].filter(Boolean),
    };
  },
};

const safeguards: Detector = {
  id: "risk.safeguards",
  kind: "risk",
  rank: 4,
  name: "Missing safeguards (no resource limits or requests, no health checks)",
  requires: ["resources"],
  detect: (c, ix) => {
    const gaps: string[] = [];
    const r = ix.first("resources", c);
    if (r && !num(r.cpuLimit)) gaps.push("No CPU limit: it can starve its neighbours.");
    if (r && !num(r.cpuRequest)) gaps.push("No CPU request: the scheduler cannot place it sensibly.");
    const mem = ix.first("memory", c);
    if (mem && !num(mem.memLimit)) gaps.push("No memory limit: a leak can take down the whole node.");
    const sp = ix.first("spans", c);
    if (sp && num(sp.total) >= 100 && num(sp.health) === 0) gaps.push("No health-check requests observed: readiness/liveness probes may be missing.");
    if (!gaps.length) return undefined;
    return {
      kind: "risk",
      rank: 4,
      code: "SAFEGUARDS_MISSING",
      title: "Missing basic safeguards",
      summary: "It runs without basic guard-rails, so a fault or a noisy neighbour can become an outage.",
      details: gaps,
    };
  },
};

const trend: Detector = {
  id: "risk.resourcetrend",
  kind: "risk",
  rank: 5,
  name: "Running out of room: memory growth, CPU headroom, growth against capacity",
  requires: ["memory", "resources", "throttle"],
  detect: (c, ix) => {
    const lines: string[] = [];
    const mem = ix.first("memory", c);
    const lim = num(mem?.memLimit);
    const now = num(mem?.memNow);
    const start = num(mem?.memStart);
    if (lim && start && now > start) {
      const growth = now - start;
      const perHour = growth / 20;
      const eta = (lim - now) / perHour;
      if (growth / lim >= 0.05 && eta <= ix.cfg.memoryExhaustionHours) {
        lines.push(`Memory grew by ${bytes(growth)} in 24h with no plateau; at this rate it reaches its ${bytes(lim)} limit in about ${fmt(eta)} hours (possible leak).`);
      }
    }
    const cpuLim = num(ix.first("resources", c)?.cpuLimit);
    const use = num(ix.first("throttle", c)?.useAvg);
    if (cpuLim && (use / cpuLim) * 100 >= ix.cfg.cpuHeadroomPct) lines.push(`CPU usage is ${pct((use / cpuLim) * 100)} of its limit: little headroom for a traffic increase.`);
    const m = ix.svc.get(c);
    if (m && m.baseN > 0 && m.nowN > 0) {
      const baseRate = m.baseN / (7 * 24 - hours(ix));
      const nowRate = m.nowN / hours(ix);
      const util = Math.max(cpuLim ? (use / cpuLim) * 100 : 0, lim ? (now / lim) * 100 : 0);
      if (nowRate >= 1.5 * baseRate && util >= 50) lines.push(`Traffic is ${fmt(nowRate / baseRate, 1)}× its 7-day average while resource use is already ${pct(util)} of limits.`);
    }
    if (!lines.length) return undefined;
    return {
      kind: "risk",
      rank: 5,
      code: "RESOURCE_TREND",
      title: "Heading toward running out of capacity",
      summary: "Nothing is wrong yet, but memory, CPU or traffic trends say it will run short if nothing changes.",
      details: lines,
    };
  },
};

const retries: Detector = {
  id: "risk.retries",
  kind: "risk",
  rank: 6,
  name: "Retry amplification",
  requires: ["clientCalls", "spans"],
  detect: (c, ix) => {
    const served = num(ix.first("spans", c)?.total);
    let calls = 0;
    let failed = 0;
    ix.raw.clientCalls.forEach((r) => {
      if (str(r.container) !== c && ix.toContainer(str(r.target)) === c) {
        calls += num(r.calls);
        failed += num(r.failed);
      }
    });
    if (calls < 200 || served === 0 || calls / served < ix.cfg.retryRatio) return undefined;
    return {
      kind: "risk",
      rank: 6,
      code: "RETRY_AMPLIFICATION",
      title: "Callers may be hammering it with retries",
      summary: "Other services send noticeably more calls than this one successfully serves, which is the signature of retries piling extra load on a struggling service.",
      details: [`${fmt(calls)} calls sent to it versus ${fmt(served)} requests it served in ${hours(ix)}h (${fmt(calls / served, 1)}×)`, failed ? `${fmt(failed)} of those calls failed` : ""].filter(Boolean),
    };
  },
};

const vulnerable: Detector = {
  id: "risk.vulnerabilities",
  kind: "risk",
  rank: 7,
  name: "Known critical/high vulnerabilities (not exposed)",
  requires: ["security"],
  detect: (c, ix) => {
    const rows = (ix.securityBy.get(c) ?? []).filter((r) => ["CRITICAL", "HIGH"].includes(str(r.level)) && !num(r.exposed));
    if (!rows.length) return undefined;
    return {
      kind: "risk",
      rank: 7,
      code: "VULNERABLE",
      title: "Contains known security vulnerabilities",
      summary: "Serious vulnerabilities exist in this service's software, but nothing shows them reachable from outside right now.",
      rootCause: `${str(rows[0].top)}.`,
      details: rows.map((r) => `${fmt(num(r.n))} ${str(r.level)} vulnerabilities (highest score ${fmt(num(r.maxScore), 1)})`),
    };
  },
};

export const DETECTORS: Detector[] = [
  unstable, silent, nonTransient, newPattern, errorRate, logAnomaly, throttling, memoryPressure, exposedVulns, transient, latency, spikes,
  dependencies, deployHistory, marginal, safeguards, trend, retries, vulnerable,
];

/** Recent changes that may explain a new problem: rollouts, spec changes, flag/config writes. */
export const recentChanges = (c: string, ix: Indexed): string[] => {
  const out: string[] = [];
  (ix.by("pods").get(c) ?? []).forEach((r) => {
    if (recentIso(r.first, ix)) out.push(`New pod ${str(r.pod)} started ${str(r.first)} (rollout or restart)`);
  });
  const change = ev(ix, c, "change");
  if (change && num(change.inWindow) > 0) out.push(`Kubernetes change event: ${str(change.sample)}`);
  ix.raw.flagChanges.forEach((r) => {
    if (recentIso(r.lastAt, ix)) out.push(`Config / feature-flag write on ${str(r.container)}: ${str(r.endpoint)} at ${str(r.lastAt)}`);
  });
  return out;
};
