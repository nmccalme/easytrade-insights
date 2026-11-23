import React, { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@dynatrace/strato-components/buttons";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Tab, Tabs } from "@dynatrace/strato-components/navigation";
import { Heading, Paragraph, Text } from "@dynatrace/strato-components/typography";
import { Container } from "@dynatrace/strato-components/layouts";
import { ProgressCircle } from "@dynatrace/strato-components/content";
import { DEFAULT_CONFIG, safeNamespace } from "../lib/config";
import { useHealthData } from "../hooks/useHealthData";
import { StatusTab } from "../components/StatusTab";
import { RecommendationsTab } from "../components/RecommendationsTab";
import { str } from "../lib/util";

export const Insights = () => {
  const [params, setParams] = useSearchParams();
  const ns = (() => {
    try {
      return safeNamespace(params.get("ns") ?? DEFAULT_CONFIG.namespace);
    } catch {
      return DEFAULT_CONFIG.namespace;
    }
  })();
  const cfg = useMemo(() => ({ ...DEFAULT_CONFIG, namespace: ns }), [ns]);
  const { services, coverage, recommendations, lifecycle, namespaces, isLoading, errors, refetch } = useHealthData(cfg);
  const nsNames = namespaces.map((r) => str(r.ns)).filter(Boolean);

  return (
    <Flex flexDirection="column" gap={12} padding={24}>
      <Flex justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={8}>
        <Flex flexDirection="column">
          <Heading level={1}>{ns}</Heading>
          <Paragraph>Which services need attention, and how to see them better.</Paragraph>
        </Flex>
        <Flex gap={8} alignItems="center">
          <select aria-label="App boundary (namespace)" value={ns} onChange={(e) => setParams({ ns: e.target.value })}>
            {[...new Set([ns, ...nsNames])].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <Button onClick={refetch} disabled={isLoading}>
            Refresh
          </Button>
        </Flex>
      </Flex>

      {errors.length > 0 && (
        <Container variant="default">
          <Heading level={5}>Some queries failed</Heading>
          {errors.map((e) => (
            <Text key={e}>{e}</Text>
          ))}
        </Container>
      )}

      {isLoading && services.length === 0 ? (
        <Flex alignItems="center" gap={8}>
          <ProgressCircle />
          <Text>Querying Grail…</Text>
        </Flex>
      ) : (
        <Tabs defaultIndex={0}>
          <Tab title="Service status">
            <StatusTab services={services} coverage={coverage} />
          </Tab>
          <Tab title={`Observability recommendations (${new Set(recommendations.map((r) => r.title)).size})`}>
            <RecommendationsTab recommendations={recommendations} lifecycle={lifecycle} />
          </Tab>
        </Tabs>
      )}
    </Flex>
  );
};
