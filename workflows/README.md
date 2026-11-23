# Workflows that ship with EasyTrade Insights

AppEngine apps cannot bundle workflows inside the app package, so they are kept beside it as files and deployed with one command.

```
DYNATRACE_API_KEY=<platform token with automation:workflows:read/write>
DT_APP_ENVIRONMENT_URL=https://<env>.apps.dynatrace.com
node workflows/deploy.mjs --ns <namespace>                 # ready workflows only
node workflows/deploy.mjs --ns <namespace> --include-scaffolds
node workflows/deploy.mjs --dry-run                        # build and print, change nothing
```

Workflows are matched by title, so re-running updates in place. `manifest.json` holds the variables (`NAMESPACE`, `APP_TITLE`, `NOTIFY_EMAIL`) and each workflow's status. Scripts live beside each `workflow.json` and are inlined at deploy time.

| Workflow | Status | What it does |
|---|---|---|
| `recommendation-lifecycle` | **ready, deployed** | Every 15 min: checks log level, INFO noise and CPU throttling, asks Davis whether the throttling is unusual for the container, opens recommendations and resolves them after two clean runs. State is stored as business events and shown in the app. |
| `problem-triage` | scaffold | When Davis opens a problem, collects error logs for the app boundary and builds a plain-language summary; the e-mail step is disabled until recipients are set. |
| `weekly-risk-digest` | scaffold | Mondays: sends the open and resolved recommendations so risks that do not page anyone still reach the owners; e-mail step disabled. |

Scaffolds were created once in the tenant to confirm Dynatrace accepts their definitions, then deleted. They have not been run.

## What a real "act on it" workflow would add
- **Routing:** map `owner` tags (the app already recommends adding them) to a team, and notify that team through Slack, e-mail or ServiceNow.
- **Evidence:** reuse the app's queries so the message carries the likely cause (for example "pricing is waiting on db-adapter's slow Pricing SQL"), not just the Davis title.
- **Remediation, with approval:** raise a CPU limit, scale a deployment or roll back a rollout through a Kubernetes connection, behind a manual approval step. Not scaffolded: it changes production and needs a connection and an approval policy decided per customer.
- **Namespace filter:** Davis problem triggers filter on entity tags; the scaffold relies on the DQL step to scope to the namespace, which still needs a tag or entity filter for large tenants.

## Remediation scaffolds (approval required)

| Folder | Trigger | What it proposes |
|---|---|---|
| `remediate-cpu-throttling` | bizevent from the lifecycle workflow (rule `cpu-throttled`, status `NEW`) | Raises the container CPU limit in 50m steps to 1.25x the p95 of demand (CPU use plus throttled time), at most 2x. Proposes nothing when the limit already covers demand. |
| `remediate-unstable-pods` | Davis problem (availability or resource contention) | Raises the memory limit on OOM kills, proposes a rollback when a recent rollout precedes the restarts, otherwise escalates with no change. |

Shape: `target`/`evidence` (read-only DQL) -> `plan` (read-only JS, returns a proposal and summary) -> `approve` -> `apply` -> `verify`.

Safe by default: triggers, `approve`, `apply` and `verify` ship **inactive**. Deploying, or running with them inactive, changes nothing; only an operator who activates `apply` lets a run change production. Approval times out after 24 hours and the run then fails without applying.

Before activating:
- The `approve` and `apply` action ids (`dynatrace.automations:request-approval`, `dynatrace.kubernetes.connector:patch-resource`) are **unverified placeholders**; the API accepts any id. Confirm them in the workflow editor.
- A Kubernetes connection (EdgeConnect) and a named approver are required.
- Manual test: `POST /workflows/{id}/run` with `{"params":{"container":"<name>"}}` for the CPU workflow.

Validated read-only against the sandbox: the plan steps run and return sensible no-change proposals for `pricing-service`, `broker-service`, `frontend`, and for pods (no restarts in 2h). A positive proposal has not been exercised.
