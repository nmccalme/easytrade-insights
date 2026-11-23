import { HealthConfig } from "./config";
import { DETECTORS, recentChanges } from "./detectors";
import { indexData } from "./indexing";
import { DetectorCoverage, Finding, RawData, ServiceHealth, Status } from "./types";
import { num } from "./util";

export { isTransientText, num, str } from "./util";

export interface HealthResult {
  services: ServiceHealth[];
  coverage: DetectorCoverage[];
}

export const buildHealth = (raw: RawData, cfg: HealthConfig): HealthResult => {
  const ix = indexData(raw, cfg);

  // 1) run every detector for every container
  const byService = new Map<string, Finding[]>();
  ix.containers.forEach((c) => {
    const findings: Finding[] = [];
    DETECTORS.forEach((d) => {
      try {
        const f = d.detect(c, ix);
        if (f) findings.push(f);
      } catch {
        /* a broken detector must never take the whole view down; it shows up in coverage instead */
      }
    });
    byService.set(c, findings);
  });

  // 2) link latency root causes: "slow because it waits on X, which is itself in trouble"
  byService.forEach((findings) => {
    findings.forEach((f) => {
      if (!f.waitsOn) return;
      const theirs = byService.get(f.waitsOn) ?? [];
      const why = theirs.find((o) => o.kind === "problem" && o.code !== "HIGH_LATENCY") ?? theirs.find((o) => o.code === "HIGH_LATENCY");
      if (why) {
        const reason = why.rootCause ?? why.title;
        f.details.push(`${f.waitsOn} is itself affected: ${why.title}${why.rootCause ? ` — ${why.rootCause}` : ""}`);
        f.rootCause = `${f.rootCause ?? ""} The cause is further down, in ${f.waitsOn}: ${reason}`.trim();
      }
    });
  });

  // 3) attach recent changes to problems
  const out: ServiceHealth[] = [];
  ix.containers.forEach((name) => {
    const findings = byService.get(name) ?? [];
    const changes = findings.some((f) => f.kind === "problem") ? recentChanges(name, ix) : [];
    if (changes.length) findings.filter((f) => f.kind === "problem").forEach((f) => (f.changes = changes));
    findings.sort((a, b) => (a.kind === b.kind ? a.rank - b.rank : a.kind === "problem" ? -1 : 1));
    const status: Status = findings.some((f) => f.kind === "problem") ? "problem" : findings.length ? "risk" : "healthy";
    const lg = ix.first("logs", name);
    const sp = ix.first("spans", name);
    out.push({
      name,
      status,
      findings,
      upstream: [...(ix.up.get(name) ?? [])].sort(),
      downstream: [...(ix.down.get(name) ?? [])].sort(),
      stats: {
        throttlePct: num(ix.first("throttle", name)?.throttlePct),
        requests: num(sp?.total),
        failed: num(sp?.failed),
        transient: num(sp?.transient),
        logs: num(lg?.total),
        unlabeledPct: lg && num(lg.total) ? (num(lg.unlabeled) / num(lg.total)) * 100 : 0,
      },
    });
  });

  const order: Record<Status, number> = { problem: 0, risk: 1, healthy: 2 };
  out.sort((a, b) => {
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
    const ra = a.findings[0]?.rank ?? 99;
    const rb = b.findings[0]?.rank ?? 99;
    if (ra !== rb) return ra - rb;
    return b.findings.length - a.findings.length || a.name.localeCompare(b.name);
  });

  // 4) capability check: which detectors can run on this tenant/boundary, which cannot (no data)
  const coverage: DetectorCoverage[] = [
    ...DETECTORS.map((d): DetectorCoverage => {
      const missing = d.requires.filter((k) => raw[k].length === 0);
      return missing.length
        ? { id: d.id, kind: d.kind, rank: d.rank, name: d.name, state: "no-data", note: `No data from: ${missing.join(", ")}` }
        : { id: d.id, kind: d.kind, rank: d.rank, name: d.name, state: "ok" };
    }),
  ];

  return { services: out, coverage };
};
