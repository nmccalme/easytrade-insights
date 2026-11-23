import type { Finding } from "./types";

/** Plain-language categories shown as icons on the service list and in the legend. */
export type Glyph =
  | "crash"
  | "silent"
  | "error"
  | "resources"
  | "security"
  | "flaky"
  | "slow"
  | "spiky"
  | "deps"
  | "deploys"
  | "headroom"
  | "safeguards"
  | "trend"
  | "retries"
  | "vulns";

export interface Category {
  id: string;
  kind: "problem" | "risk";
  /** Short code that matches the ranking in the brief, e.g. P1 or R4. */
  code: string;
  glyph: Glyph;
  label: string;
  hint: string;
}

/** Ordered: problems by rank, then risks by rank. The legend renders in this order. */
export const CATEGORIES: Category[] = [
  { id: "P1", kind: "problem", code: "P1", glyph: "crash", label: "Down or crashing", hint: "Pods are crashing or can't start, or the service has stopped receiving traffic or logging." },
  { id: "P2", kind: "problem", code: "P2", glyph: "error", label: "Erroring", hint: "Requests are failing for reasons that won't fix themselves, or a new kind of error has appeared." },
  { id: "P3-res", kind: "problem", code: "P3", glyph: "resources", label: "Out of resources", hint: "CPU is throttled or memory is nearly full." },
  { id: "P3-sec", kind: "problem", code: "P3", glyph: "security", label: "Active security risk", hint: "A serious vulnerability is reachable from outside." },
  { id: "P4", kind: "problem", code: "P4", glyph: "flaky", label: "Intermittent failures", hint: "Timeouts and other errors that usually clear on retry." },
  { id: "P5", kind: "problem", code: "P5", glyph: "slow", label: "Consistently slow", hint: "Responses are slow all the time, not just occasionally." },
  { id: "P6", kind: "problem", code: "P6", glyph: "spiky", label: "Occasionally very slow", hint: "Most responses are fine, but the slowest ones are far worse than usual." },
  { id: "R1", kind: "risk", code: "R1", glyph: "deps", label: "Many dependencies", hint: "Lots of services depend on this one, or it depends on many others." },
  { id: "R2", kind: "risk", code: "R2", glyph: "deploys", label: "Shaky deployments", hint: "Past deployments or restarts have gone wrong." },
  { id: "R3", kind: "risk", code: "R3", glyph: "headroom", label: "Little headroom", hint: "Performance or infrastructure numbers are marginal, or have been bad recently." },
  { id: "R4", kind: "risk", code: "R4", glyph: "safeguards", label: "Missing safeguards", hint: "No resource limits or requests, or no health checks." },
  { id: "R5", kind: "risk", code: "R5", glyph: "trend", label: "Running out of room", hint: "Memory is growing, CPU headroom is shrinking, or load is growing against capacity." },
  { id: "R6", kind: "risk", code: "R6", glyph: "retries", label: "Retries add load", hint: "Retries are multiplying traffic and can turn a blip into an outage." },
  { id: "R7", kind: "risk", code: "R7", glyph: "vulns", label: "Known vulnerabilities", hint: "Open vulnerabilities that are not currently reachable from outside." },
];

export const categoryOf = (f: Finding): Category => {
  const id = f.kind === "problem" && f.rank === 3 ? (f.code === "VULN_EXPOSED" ? "P3-sec" : "P3-res") : `${f.kind === "problem" ? "P" : "R"}${f.rank}`;
  return CATEGORIES.find((c) => c.id === id) ?? CATEGORIES[0];
};

/** Distinct categories for one service, in legend order. */
export const categoriesOf = (findings: Finding[]): Category[] => {
  const ids = new Set(findings.map((f) => categoryOf(f).id));
  return CATEGORIES.filter((c) => ids.has(c.id));
};
