import React from "react";
import {
  BugReportIcon,
  ClockIcon,
  CriticalFailedIcon,
  DataCenterIcon,
  LinkBrokenIcon,
  LinkIcon,
  LockIcon,
  NetworkIcon,
  ProcessIcon,
  SecurityCriticalIcon,
  SecurityHighIcon,
  WarningFailedIcon,
  WarningIcon,
} from "@dynatrace/strato-icons";
import { Category, Glyph } from "../lib/categories";

const ICONS: Record<Glyph, React.ComponentType> = {
  crash: CriticalFailedIcon,
  silent: LinkBrokenIcon,
  error: BugReportIcon,
  resources: DataCenterIcon,
  security: SecurityCriticalIcon,
  flaky: WarningFailedIcon,
  slow: ClockIcon,
  spiky: WarningIcon,
  deps: NetworkIcon,
  deploys: ProcessIcon,
  headroom: WarningIcon,
  safeguards: LockIcon,
  trend: DataCenterIcon,
  retries: LinkIcon,
  vulns: SecurityHighIcon,
};

/** An icon plus its short code (P1, R4, ...) in the colour of its kind. The text keeps it readable without colour. */
export const CategoryBadge = ({ category, showLabel = false }: { category: Category; showLabel?: boolean }) => {
  const Icon = ICONS[category.glyph];
  const tone = category.kind === "problem" ? "critical" : "warning";
  return (
    <span
      title={`${category.code}: ${category.label}. ${category.hint}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        borderRadius: 12,
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: "nowrap",
        color: `var(--dt-colors-text-${tone}-default)`,
        background: `var(--dt-colors-background-container-${tone}-default)`,
        border: `1px solid var(--dt-colors-border-${tone}-default)`,
      }}
    >
      <Icon />
      {category.code}
      {showLabel ? ` ${category.label}` : ""}
    </span>
  );
};
