import React, { useState } from "react";
import { Container, Flex } from "@dynatrace/strato-components/layouts";
import { Button } from "@dynatrace/strato-components/buttons";
import { Heading, Paragraph, Strong, Text } from "@dynatrace/strato-components/typography";
import { Chip } from "@dynatrace/strato-components/content";
import { Finding, ServiceHealth } from "../lib/types";
import { StatusChip } from "./StatusChip";

const label = (f: Finding) => `${f.kind === "problem" ? "P" : "R"}${f.rank}`;

const FindingView = ({ f }: { f: Finding }) => {
  const [open, setOpen] = useState(false);
  const hasDetail = !!(f.rootCause || f.details.length || f.changes?.length || f.query);
  return (
    <Flex flexDirection="column" gap={4}>
      <Flex alignItems="center" gap={8}>
        <Chip color={f.kind === "problem" ? "critical" : "warning"}>{label(f)}</Chip>
        <Strong>{f.title}</Strong>
      </Flex>
      <Text>{f.summary}</Text>
      {hasDetail && (
        <Button variant="default" size="condensed" onClick={() => setOpen(!open)}>
          {open ? "Hide details" : "Details for responders"}
        </Button>
      )}
      {open && (
        <Flex flexDirection="column" gap={4}>
          {f.rootCause && (
            <Paragraph>
              <Strong>Likely cause: </Strong>
              {f.rootCause}
            </Paragraph>
          )}
          {f.details.map((d) => (
            <Text key={d}>• {d}</Text>
          ))}
          {f.changes?.map((c) => (
            <Text key={c}>Recent change: {c}</Text>
          ))}
          {f.query && <pre style={{ whiteSpace: "pre-wrap", fontSize: 11, margin: 0 }}>{f.query}</pre>}
        </Flex>
      )}
    </Flex>
  );
};

export const ServiceCard = ({ service }: { service: ServiceHealth }) => {
  const { name, status, findings, stats, upstream, downstream } = service;
  return (
    <Container variant="default" style={{ width: 400 }}>
      <Flex flexDirection="column" gap={12}>
        <Flex justifyContent="space-between" alignItems="center">
          <Heading level={4}>{name}</Heading>
          <StatusChip status={status} />
        </Flex>
        {findings.length === 0 && <Paragraph>No problems or risk signals in the current window.</Paragraph>}
        {findings.map((f) => (
          <FindingView key={f.code} f={f} />
        ))}
        <Text>
          {stats.requests ? `${stats.requests.toLocaleString()} requests · ` : ""}
          {stats.logs.toLocaleString()} logs · {upstream.length} up / {downstream.length} down
        </Text>
      </Flex>
    </Container>
  );
};
