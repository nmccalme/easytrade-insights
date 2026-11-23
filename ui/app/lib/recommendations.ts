import { HealthConfig } from "./config";
import { indexData, Indexed } from "./indexing";
import { RawData, Recommendation } from "./types";
import { bytes, fmt, num, str } from "./util";

type Rule = (c: string, ix: Indexed, add: (r: Omit<Recommendation, "status" | "source">) => void) => void;

const W = (ix: Indexed) => ix.cfg.windowHours;

const RULES: Rule[] = [
  // --- log hygiene -------------------------------------------------------------------------------
  (c, ix, add) => {
    const r = ix.first("logs", c);
    if (!r || num(r.total) < ix.cfg.minLogsForRule) return;
    const total = num(r.total);
    const unlabeled = num(r.unlabeled);
    const pctU = (unlabeled / total) * 100;
    const slow = (ix.by("slowSql").get(c) ?? []).sort((a, b) => num(b.n) - num(a.n))[0];
    if (pctU >= ix.cfg.noLevelSharePct) {
      add({
        id: `OBS-LOGLEVEL-${c}`,
        container: c,
        severity: slow ? "high" : pctU > 90 ? "medium" : "low",
        title: slow ? "Give SLOW SQL logs a log level and structured fields" : "Logs have no log level",
        evidence:
          `${fmt(unlabeled)} of ${fmt(total)} logs (${pctU.toFixed(0)}%) in ${W(ix)}h have no level.` +
          (slow ? ` Includes ${fmt(num(slow.n))} SLOW SQL records on ${str(slow.tbl)} (p95 ${fmt(num(slow.p95))} ms) that alerting cannot filter on.` : ""),
        action: slow
          ? "Add an OpenPipeline logs rule: match `SLOW SQL`, set loglevel=WARN, and extract duration_ms, rows and table as attributes. Alternatively emit levelled, structured logs from the application."
          : "Emit a level from the application logger, or add an OpenPipeline processor that parses the level (or HTTP status for access logs) into loglevel.",
      });
    }
    if (num(r.hiddenErrors) > 0) {
      add({
        id: `OBS-HIDDENERR-${c}`,
        container: c,
        severity: "high",
        title: "Unlabeled logs contain error text",
        evidence: `${fmt(num(r.hiddenErrors))} logs without a level mention error/exception/failed in ${W(ix)}h, so level-based alerts miss them.`,
        action: "Map these messages to loglevel=ERROR via an OpenPipeline rule, then alert on the level.",
      });
    }
    const labeled = total - unlabeled;
    const info = num(r.info);
    if (labeled >= ix.cfg.minLogsForRule && (info / labeled) * 100 >= ix.cfg.infoNoiseSharePct && info >= 1000) {
      add({
        id: `OBS-INFONOISE-${c}`,
        container: c,
        severity: "low",
        title: "INFO logs dominate and add little diagnostic value",
        evidence: `${fmt(info)} INFO logs (${((info / labeled) * 100).toFixed(0)}% of levelled logs) in ${W(ix)}h versus ${fmt(num(r.errors))} errors and ${fmt(num(r.warns))} warnings.`,
        action: "Lower verbosity at the source, or drop/sample repetitive INFO lines in OpenPipeline before storage. Keep INFO that carries identifiers needed to debug.",
      });
    }
    if (num(r.sensitive) > 0) {
      add({
        id: `OBS-SENSITIVE-${c}`,
        container: c,
        severity: "high",
        title: "Logs may contain passwords, keys or tokens",
        evidence: `${fmt(num(r.sensitive))} log lines in ${W(ix)}h contain text such as password=, secret=, api_key= or a bearer token.`,
        action: "Mask these values at the source or with an OpenPipeline masking processor, and rotate anything that may have been exposed.",
      });
    }
    const hl = num(r.healthLines);
    if (hl / total >= ix.cfg.healthNoisePct / 100 && hl >= 100) {
      add({
        id: `OBS-HEALTHLOGS-${c}`,
        container: c,
        severity: "low",
        title: "Health-check requests fill the logs",
        evidence: `${fmt(hl)} of ${fmt(total)} log lines (${((hl / total) * 100).toFixed(0)}%) in ${W(ix)}h are health or readiness probe requests.`,
        action: "Stop logging probe endpoints in the web framework, or drop them in OpenPipeline.",
      });
    }
    const totalBytes = ix.raw.logs.reduce((s, x) => s + num(x.bytes), 0);
    const share = totalBytes ? (num(r.bytes) / totalBytes) * 100 : 0;
    if (share >= ix.cfg.logVolumeSharePct && (pctU >= ix.cfg.noLevelSharePct || (info / Math.max(labeled, 1)) * 100 >= ix.cfg.infoNoiseSharePct)) {
      add({
        id: `OBS-LOGCOST-${c}`,
        container: c,
        severity: "medium",
        title: "One service drives most of the log volume, and most of it is low value",
        evidence: `${c} produces ${share.toFixed(0)}% of the boundary's log volume (${bytes(num(r.bytes))} in ${W(ix)}h), mostly unlabeled or INFO.`,
        action: "Sample or drop low-value lines in OpenPipeline; this is the cheapest way to cut ingest cost without losing diagnostics.",
      });
    }
  },
  // --- traces -------------------------------------------------------------------------------------
  (c, ix, add) => {
    const lg = ix.first("logs", c);
    const sp = ix.first("spans", c);
    const spans = num(sp?.total);
    if (lg && spans > 0 && num(lg.total) >= ix.cfg.minLogsForRule && num(lg.withTrace) === 0) {
      add({
        id: `OBS-NOTRACEID-${c}`,
        container: c,
        severity: "medium",
        title: "Logs are not correlated with traces",
        evidence: `${fmt(num(lg.total))} logs and ${fmt(spans)} spans in ${W(ix)}h, but none of the logs carry a trace_id.`,
        action: "Enable log enrichment / inject trace context (trace_id, span_id) into log lines so a failing request links to its logs.",
      });
    }
    if (spans === 0 && lg && num(lg.total) >= ix.cfg.minLogsForRule && (num(lg.errors) > 0 || num(lg.warns) > 0)) {
      add({
        id: `OBS-NOSPANS-${c}`,
        container: c,
        severity: "high",
        title: "Service emits no trace data",
        evidence: `${fmt(num(lg.total))} logs including ${fmt(num(lg.errors))} errors and ${fmt(num(lg.warns))} warnings, but no spans in ${W(ix)}h — failures calling other services are only visible in logs.`,
        action: "Instrument this workload (OneAgent code module or OpenTelemetry) so outgoing calls produce failed-request spans and appear in the service topology.",
      });
    }
    if (sp && spans >= 100 && num(sp.roots) / spans >= 0.1 && (ix.up.get(c)?.size ?? 0) > 0) {
      add({
        id: `OBS-TRACEBREAK-${c}`,
        container: c,
        severity: "medium",
        title: "Traces start here instead of continuing from the caller",
        evidence: `${fmt(num(sp.roots))} of ${fmt(spans)} requests (${((num(sp.roots) / spans) * 100).toFixed(0)}%) in ${W(ix)}h arrive with no parent trace even though other services call it.`,
        action: "Find the caller that does not propagate trace context (often an uninstrumented service or a client that drops the W3C traceparent header) and instrument it.",
      });
    }
    if (sp && spans >= 100 && (num(sp.health) / spans) * 100 >= ix.cfg.healthNoisePct) {
      add({
        id: `OBS-HEALTHSPANS-${c}`,
        container: c,
        severity: "low",
        title: "Health checks make up a large share of traces",
        evidence: `${fmt(num(sp.health))} of ${fmt(spans)} requests (${((num(sp.health) / spans) * 100).toFixed(0)}%) in ${W(ix)}h are probe endpoints, which dilutes latency and error statistics and costs ingest.`,
        action: "Exclude health endpoints from tracing (OneAgent request-naming / exclusion rules) so dashboards describe real user traffic.",
      });
    }
  },
  // --- ownership ----------------------------------------------------------------------------------
  (c, ix, add) => {
    const need = ix.cfg.requiredTags;
    if (!need.length) return;
    const have = ix.tagsBy.get(c) ?? [];
    const missing = need.filter((t) => !have.includes(t.toLowerCase()));
    if (!missing.length) return;
    add({
      id: `OBS-NOOWNER-${c}`,
      container: c,
      severity: "medium",
      title: "No owner on this workload",
      evidence: `The workload has no ${missing.join(", ")} tag, so an alert or recommendation has no one to route to.`,
      action: "Add ownership labels in Kubernetes and map them to Dynatrace tags / security context, so problems are routed to the right team automatically.",
    });
  },
];

/**
 * Observability recommendations derived from the data itself. A rule is "open" while its condition holds.
 * (Davis-proposed recommendations and persisted open/resolved history are layered on top by the workflow.)
 */
export const buildObservabilityRecommendations = (raw: RawData, cfg: HealthConfig): Recommendation[] => {
  const ix = indexData(raw, cfg);
  const recs: Recommendation[] = [];
  const names = new Set<string>([...ix.containers]);
  ix.by("logs").forEach((_v, c) => names.add(c));
  cfg.syntheticContainers.forEach((c) => names.delete(c));
  names.forEach((c) => {
    RULES.forEach((rule) => {
      try {
        rule(c, ix, (r) => recs.push({ ...r, status: "open", source: "rule" }));
      } catch {
        /* skip a failing rule */
      }
    });
  });
  const sev = { high: 0, medium: 1, low: 2 } as const;
  return recs.sort((a, b) => sev[a.severity] - sev[b.severity] || a.container.localeCompare(b.container));
};
