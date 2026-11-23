import React from "react";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Heading, Text } from "@dynatrace/strato-components/typography";
import { CATEGORIES } from "../lib/categories";
import { CategoryBadge } from "./CategoryBadge";

const Group = ({ title, kind }: { title: string; kind: "problem" | "risk" }) => (
  <Flex flexDirection="column" gap={6} style={{ minWidth: 280, flex: 1 }}>
    <Heading level={6}>{title}</Heading>
    {CATEGORIES.filter((c) => c.kind === kind).map((c) => (
      <Flex key={c.id} alignItems="flex-start" gap={8}>
        <span style={{ minWidth: 64 }}>
          <CategoryBadge category={c} />
        </span>
        <Text>
          <strong>{c.label}.</strong> {c.hint}
        </Text>
      </Flex>
    ))}
  </Flex>
);

export const Legend = () => (
  <Flex gap={32} flexWrap="wrap" padding={12}>
    <Group title="Current problems (P1 is most urgent)" kind="problem" />
    <Group title="Potential risks" kind="risk" />
  </Flex>
);
