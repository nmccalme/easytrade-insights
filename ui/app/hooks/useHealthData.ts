import { useMemo } from "react";
import { useDql } from "@dynatrace-sdk/react-hooks";
import { DEFAULT_CONFIG, HealthConfig } from "../lib/config";
import { buildQueries, QueryKey } from "../lib/queries";
import { buildObservabilityRecommendations } from "../lib/recommendations";
import { buildHealth } from "../lib/scoring";
import { DetectorCoverage, RawData, Recommendation, Row, ServiceHealth } from "../lib/types";

interface HealthData {
  services: ServiceHealth[];
  coverage: DetectorCoverage[];
  recommendations: Recommendation[];
  namespaces: Row[];
  lifecycle: Row[];
  isLoading: boolean;
  errors: string[];
  refetch: () => void;
}

// The key list is fixed, so calling useDql once per key keeps the hook order stable.
const KEYS = Object.keys(buildQueries(DEFAULT_CONFIG)) as QueryKey[];

/** Runs every signal query once and derives service health + observability recommendations. */
export const useHealthData = (cfg: HealthConfig): HealthData => {
  const q = useMemo(() => buildQueries(cfg), [cfg]);

  /* eslint-disable react-hooks/rules-of-hooks */
  const results = KEYS.map((k) => ({ key: k, res: useDql({ query: q[k] }) }));
  /* eslint-enable react-hooks/rules-of-hooks */

  const isLoading = results.some(({ res }) => res.isLoading);
  const errors = results
    .filter(({ res }) => res.error)
    .map(({ key, res }) => `${key}: ${res.error?.message ?? "query failed"}`);

  const loadedKey = results.map(({ res }) => (res.data ? 1 : 0)).join("");
  const derived = useMemo(() => {
    const raw = {} as RawData;
    results.forEach(({ key, res }) => {
      raw[key] = res.data?.records ?? [];
    });
    const health = buildHealth(raw, cfg);
    return {
      services: health.services,
      coverage: health.coverage,
      recommendations: buildObservabilityRecommendations(raw, cfg),
      namespaces: raw.namespaces,
      lifecycle: raw.lifecycle,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedKey, cfg]);

  const refetch = () => results.forEach(({ res }) => void res.refetch());

  return { ...derived, isLoading, errors, refetch };
};
