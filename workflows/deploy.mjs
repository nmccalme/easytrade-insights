#!/usr/bin/env node
// Packages and deploys the workflows that ship with the app.
//   node workflows/deploy.mjs [--ns <namespace>] [--include-scaffolds] [--dry-run]
// Needs DYNATRACE_API_KEY (platform token with automation:workflows:read/write) and DT_APP_ENVIRONMENT_URL.
// Workflows are created or updated by title, so re-running is safe.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const vars = { ...manifest.variables, ...(opt("--ns") ? { NAMESPACE: opt("--ns") } : {}) };
if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(vars.NAMESPACE)) throw new Error(`Invalid namespace: ${vars.NAMESPACE}`);
const sub = (s) => s.replace(/\{\{(NAMESPACE|APP_TITLE|NOTIFY_EMAIL)\}\}/g, (_, k) => vars[k]);

const base = (process.env.DT_APP_ENVIRONMENT_URL ?? "").replace(/\/$/, "");
const token = process.env.DYNATRACE_API_KEY;
const call = async (method, path, body) => {
  const r = await fetch(`${base}/platform/automation/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json();
};

const build = (dir) => {
  // Substitute variables in the whole definition (the Jinja `{{ ... }}` expressions are left alone), then inline scripts.
  const wf = JSON.parse(sub(readFileSync(join(root, dir, "workflow.json"), "utf8")));
  for (const t of Object.values(wf.tasks)) {
    const s = t.input?.script;
    if (typeof s === "string" && s.startsWith("@file:")) t.input.script = sub(readFileSync(join(root, dir, s.slice(6)), "utf8"));
  }
  return wf;
};

const existing = flag("--dry-run") ? { results: [] } : await call("GET", "/workflows?limit=500");
for (const { dir, status } of manifest.workflows) {
  if (status === "scaffold" && !flag("--include-scaffolds")) {
    console.log(`skip     ${dir} (scaffold; use --include-scaffolds)`);
    continue;
  }
  const wf = build(dir);
  if (flag("--dry-run")) {
    console.log(`dry-run  ${wf.title} (${Object.keys(wf.tasks).length} tasks)`);
    continue;
  }
  const found = existing.results.find((w) => w.title === wf.title);
  const res = found ? await call("PUT", `/workflows/${found.id}`, wf) : await call("POST", "/workflows", wf);
  console.log(`${found ? "updated " : "created "} ${wf.title} -> ${res.id}`);
}
