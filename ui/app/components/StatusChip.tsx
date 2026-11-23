import React from "react";
import { Chip } from "@dynatrace/strato-components/content";
import { Status } from "../lib/types";

const LABEL: Record<Status, string> = { problem: "Problem", risk: "Risk", healthy: "Healthy" };
const COLOR: Record<Status, "critical" | "warning" | "success"> = {
  problem: "critical",
  risk: "warning",
  healthy: "success",
};

export const StatusChip = ({ status }: { status: Status }) => (
  <Chip color={COLOR[status]} variant="emphasized">
    {LABEL[status]}
  </Chip>
);
