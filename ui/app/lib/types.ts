import type { QueryKey } from "./queries";

export type Row = Record<string, unknown>;
export type RawData = Record<QueryKey, Row[]>;

export type FindingKind = "problem" | "risk";

/**
 * A finding is written twice: `title` + `summary` are plain language for anyone;
 * `rootCause` + `details` + `query` are the drill-down for whoever responds.
 */
export interface Finding {
  kind: FindingKind;
  /** Problems: 1 (worst) .. 6. Risks: 1 .. 7. */
  rank: number;
  code: string;
  title: string;
  summary: string;
  rootCause?: string;
  details: string[];
  /** DQL a responder can paste into a notebook. */
  query?: string;
  /** Container this service mostly waits on (latency root cause). */
  waitsOn?: string;
  /** Recent changes (rollout, spec change, flag write) that preceded the finding. */
  changes?: string[];
}

export type Status = "problem" | "risk" | "healthy";

export interface ServiceHealth {
  name: string;
  status: Status;
  findings: Finding[];
  upstream: string[];
  downstream: string[];
  stats: {
    throttlePct: number;
    requests: number;
    failed: number;
    transient: number;
    logs: number;
    unlabeledPct: number;
  };
}

export type CoverageState = "ok" | "no-data";

export interface DetectorCoverage {
  id: string;
  kind: FindingKind;
  rank: number;
  name: string;
  state: CoverageState;
  /** Why the detector is not producing results, or what it still needs. */
  note?: string;
}

export interface Recommendation {
  id: string;
  container: string;
  severity: "high" | "medium" | "low";
  title: string;
  evidence: string;
  action: string;
  /** Live rules are "open" while their condition holds; they flip to "resolved" when it stops holding. */
  status: "open" | "resolved";
  source: "rule" | "davis";
}
