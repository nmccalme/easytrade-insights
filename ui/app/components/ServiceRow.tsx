import React from "react";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Strong } from "@dynatrace/strato-components/typography";
import { categoriesOf } from "../lib/categories";
import { ServiceHealth } from "../lib/types";
import { CategoryBadge } from "./CategoryBadge";
import { StatusChip } from "./StatusChip";

/** One compact line per service: name, status and one badge per kind of trouble. Click to open the detail. */
export const ServiceRow = ({ service, selected, onSelect }: { service: ServiceHealth; selected: boolean; onSelect: () => void }) => (
  <button
    type="button"
    aria-expanded={selected}
    onClick={onSelect}
    style={{
      all: "unset",
      boxSizing: "border-box",
      cursor: "pointer",
      width: "100%",
      padding: "10px 12px",
      borderRadius: 8,
      border: `1px solid var(--dt-colors-border-${selected ? "primary" : "neutral"}-default)`,
      background: selected ? "var(--dt-colors-background-container-primary-default)" : "var(--dt-colors-background-container-neutral-subdued)",
    }}
  >
    <Flex alignItems="center" gap={12} flexWrap="wrap">
      <span style={{ minWidth: 190 }}>
        <Strong>{service.name}</Strong>
      </span>
      <span style={{ minWidth: 80 }}>
        <StatusChip status={service.status} />
      </span>
      <Flex gap={6} flexWrap="wrap">
        {categoriesOf(service.findings).map((c) => (
          <CategoryBadge key={c.id} category={c} />
        ))}
      </Flex>
    </Flex>
  </button>
);
