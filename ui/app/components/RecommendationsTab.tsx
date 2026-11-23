import React from "react";
import { Container, Flex } from "@dynatrace/strato-components/layouts";
import { Chip } from "@dynatrace/strato-components/content";
import { Heading, Paragraph, Strong, Text } from "@dynatrace/strato-components/typography";
import { Recommendation, Row } from "../lib/types";
import { str } from "../lib/util";

const SEV_COLOR = { high: "critical", medium: "warning", low: "neutral" } as const;
const SEV_ORDER = { high: 0, medium: 1, low: 2 } as const;

const group = (recs: Recommendation[]) => {
  const byTitle = new Map<string, Recommendation[]>();
  recs.forEach((r) => byTitle.set(r.title, [...(byTitle.get(r.title) ?? []), r]));
  return [...byTitle.entries()]
    .map(([title, items]) => ({ title, items, severity: items[0].severity, action: items[0].action }))
    .sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || b.items.length - a.items.length);
};

export const RecommendationsTab = ({ recommendations, lifecycle }: { recommendations: Recommendation[]; lifecycle: Row[] }) => {
  const groups = group(recommendations);
  return (
    <Flex flexDirection="column" gap={12} paddingTop={12}>
      <Paragraph>
        Ways to make this app easier to diagnose, found by looking at its logs and traces. Each one lists the services it affects, the evidence, and what to change.
      </Paragraph>

      {groups.length === 0 && <Text>No observability recommendations for this app right now.</Text>}
      {groups.map((g) => (
        <Container key={g.title} variant="default">
          <Flex flexDirection="column" gap={8}>
            <Flex alignItems="center" gap={8} flexWrap="wrap">
              <Chip color={SEV_COLOR[g.severity]} variant="emphasized">
                {g.severity}
              </Chip>
              <Heading level={4}>{g.title}</Heading>
              <Text>
                {g.items.length} {g.items.length === 1 ? "service" : "services"}
              </Text>
            </Flex>
            <Text>
              <Strong>What to do: </Strong>
              {g.action}
            </Text>
            {g.items.map((r) => (
              <Flex key={r.id} gap={8} alignItems="baseline">
                <span style={{ minWidth: 190 }}>
                  <Strong>{r.container}</Strong>
                </span>
                <Text>{r.evidence}</Text>
              </Flex>
            ))}
          </Flex>
        </Container>
      ))}

      <Heading level={3}>Tracked over time</Heading>
      <Paragraph>
        A scheduled workflow re-checks log level, INFO noise and CPU throttling every 15 minutes, asks Davis whether the signal is unusual for the service, and resolves each item after it stays clean for two runs.
      </Paragraph>
      {lifecycle.length === 0 && <Text>No tracked recommendations yet for this app.</Text>}
      {lifecycle.map((l) => (
        <Flex key={`${str(l.container)}|${str(l.rule)}`} alignItems="center" gap={8} flexWrap="wrap">
          <Chip color={str(l.status) === "RESOLVED" ? "success" : "primary"}>{str(l.status).toLowerCase()}</Chip>
          <Strong>{str(l.container)}</Strong>
          <Text>{str(l.summary)}</Text>
        </Flex>
      ))}
    </Flex>
  );
};
