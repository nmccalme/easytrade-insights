import { HealthConfig } from "./config";
import { RawData, Row } from "./types";
import { idsOf, num, str } from "./util";
import { QueryKey } from "./queries";

export interface SvcMetrics {
  baseN: number;
  baseF: number;
  baseRtSum: number;
  nowN: number;
  nowF: number;
  nowRtSum: number;
  n30: number;
}

export interface Indexed {
  cfg: HealthConfig;
  raw: RawData;
  containers: string[];
  by: (key: QueryKey) => Map<string, Row[]>;
  first: (key: QueryKey, c: string) => Row | undefined;
  up: Map<string, Set<string>>;
  down: Map<string, Set<string>>;
  svc: Map<string, SvcMetrics>;
  securityBy: Map<string, Row[]>;
  tagsBy: Map<string, string[]>;
  /** Map a call target / workload string such as "easytrade-pricing-service:8080" to a container name. */
  toContainer: (s: string) => string | undefined;
}

export const indexData = (raw: RawData, cfg: HealthConfig): Indexed => {
  const cache = new Map<QueryKey, Map<string, Row[]>>();
  const by = (key: QueryKey) => {
    let m = cache.get(key);
    if (!m) {
      m = new Map<string, Row[]>();
      raw[key].forEach((r) => {
        const c = str(r.container);
        if (!c) return;
        if (!m!.has(c)) m!.set(c, []);
        m!.get(c)!.push(r);
      });
      cache.set(key, m);
    }
    return m;
  };
  const first = (key: QueryKey, c: string) => by(key).get(c)?.[0];

  const names = new Set<string>();
  (["throttle", "events", "spans", "logs", "memory", "endpointLatency"] as QueryKey[]).forEach((k) =>
    by(k).forEach((_v, c) => names.add(c)),
  );
  cfg.syntheticContainers.forEach((c) => names.delete(c));
  const containers = [...names];

  const toContainer = (s: string): string | undefined => {
    if (!s) return undefined;
    let t = s.toLowerCase().replace(/:\d+$/, "").replace(/\.svc.*$/, "").replace(new RegExp(`\\.${cfg.namespace}$`), "");
    if (t.startsWith(`${cfg.namespace}-`)) t = t.slice(cfg.namespace.length + 1);
    const all = [...names, ...cfg.syntheticContainers];
    const exact = all.find((c) => c.toLowerCase() === t);
    if (exact) return exact;
    return all.filter((c) => t.endsWith(`-${c.toLowerCase()}`) || c.toLowerCase().endsWith(`-${t}`)).sort((a, b) => b.length - a.length)[0];
  };

  // ---- service entity <-> container, and call edges
  const svcToContainer = new Map<string, string>();
  raw.serviceContainers.forEach((r) => svcToContainer.set(str(r.svc), str(r.container)));
  const up = new Map<string, Set<string>>();
  const down = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, k: string, v: string) => {
    if (!k || !v || k === v) return;
    if (!m.has(k)) m.set(k, new Set());
    m.get(k)!.add(v);
  };
  raw.serviceEdges.forEach((r) => {
    const self = svcToContainer.get(str(r.id));
    if (!self) return;
    idsOf(r.calls).forEach((id) => {
      const other = svcToContainer.get(id);
      if (other) {
        add(down, self, other);
        add(up, other, self);
      }
    });
    idsOf(r.called_by).forEach((id) => {
      const other = svcToContainer.get(id);
      if (other) {
        add(up, self, other);
        add(down, other, self);
      }
    });
  });

  // ---- service-level metrics rolled up to containers (baseline vs now vs last 30 min)
  const svc = new Map<string, SvcMetrics>();
  const acc = (c: string) => {
    if (!svc.has(c)) svc.set(c, { baseN: 0, baseF: 0, baseRtSum: 0, nowN: 0, nowF: 0, nowRtSum: 0, n30: 0 });
    return svc.get(c)!;
  };
  raw.svcBaseline.forEach((r) => {
    const c = svcToContainer.get(str(r.svc));
    if (!c) return;
    const m = acc(c);
    m.baseN += num(r.n);
    m.baseF += num(r.f);
    m.baseRtSum += num(r.rtAvg) * num(r.n);
  });
  raw.svcNow.forEach((r) => {
    const c = svcToContainer.get(str(r.svc));
    if (!c) return;
    const m = acc(c);
    m.nowN += num(r.n);
    m.nowF += num(r.f);
    m.nowRtSum += num(r.rtAvg) * num(r.n);
  });
  raw.svcRecent.forEach((r) => {
    const c = svcToContainer.get(str(r.svc));
    if (c) acc(c).n30 += num(r.n30);
  });

  const securityBy = new Map<string, Row[]>();
  raw.security.forEach((r) => {
    const c = toContainer(str(r.workload));
    if (!c) return;
    if (!securityBy.has(c)) securityBy.set(c, []);
    securityBy.get(c)!.push(r);
  });

  const tagsBy = new Map<string, string[]>();
  raw.tags.forEach((r) => {
    const c = toContainer(str(r.name));
    if (c) tagsBy.set(c, idsOf(r.tags).map((t) => t.split(":")[0].toLowerCase()));
  });

  return { cfg, raw, containers, by, first, up, down, svc, securityBy, tagsBy, toContainer };
};
