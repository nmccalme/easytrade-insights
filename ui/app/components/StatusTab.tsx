import React, { useState } from "react";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Button } from "@dynatrace/strato-components/buttons";
import { Heading, Text } from "@dynatrace/strato-components/typography";
import { DetectorCoverage, ServiceHealth, Status } from "../lib/types";
import { Legend } from "./Legend";
import { ServiceCard } from "./ServiceCard";
import { ServiceRow } from "./ServiceRow";

const count = (services: ServiceHealth[], s: Status) => services.filter((x) => x.status === s).length;

export const StatusTab = ({ services, coverage }: { services: ServiceHealth[]; coverage: DetectorCoverage[] }) => {
  const [selected, setSelected] = useState<string | undefined>();
  const [showLegend, setShowLegend] = useState(true);
  const current = services.find((s) => s.name === selected);
  const noData = coverage.filter((c) => c.state === "no-data");

  return (
    <Flex flexDirection="column" gap={12} paddingTop={12}>
      <Flex justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={8}>
        <Text>
          {count(services, "problem")} with current problems · {count(services, "risk")} at risk · {count(services, "healthy")} healthy
        </Text>
        <Button variant="default" size="condensed" onClick={() => setShowLegend(!showLegend)}>
          {showLegend ? "Hide legend" : "Show legend"}
        </Button>
      </Flex>
      {showLegend && <Legend />}

      <Flex flexDirection="column" gap={6} role="list">
        {services.map((s) => (
          <ServiceRow key={s.name} service={s} selected={s.name === selected} onSelect={() => setSelected(s.name === selected ? undefined : s.name)} />
        ))}
      </Flex>

      {current ? (
        <ServiceCard service={current} />
      ) : (
        <Text>Select a service to see what is wrong, the likely cause and the evidence.</Text>
      )}

      {noData.length > 0 && (
        <Flex flexDirection="column" gap={2}>
          <Heading level={6}>Checks with no data for this app</Heading>
          <Text>{noData.map((c) => c.name).join(" · ")}</Text>
        </Flex>
      )}
    </Flex>
  );
};
