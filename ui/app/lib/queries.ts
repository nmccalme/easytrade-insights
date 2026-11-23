/* eslint-disable noSecrets/no-secrets -- DQL text, not credentials */
import { HealthConfig, safeNamespace } from "./config";

/**
 * One DQL query per signal family. Each returns one row per `container` (or per entity / pod for the
 * topology queries). Detectors in detectors.ts consume these rows; nothing else touches Grail.
 */
export const buildQueries = (cfg: HealthConfig) => {
  const ns = safeNamespace(cfg.namespace);
  const h = Math.max(1, Math.floor(cfg.windowHours));

  return {
    /** CPU throttling: throttled / (throttled + used), averaged over the window. */
    throttle: `
timeseries { thr=avg(dt.kubernetes.container.cpu_throttled), use=avg(dt.kubernetes.container.cpu_usage) },
  by:{k8s.container.name, k8s.namespace.name}, from:now()-${h}h, interval:5m
| filter k8s.namespace.name=="${ns}"
| fieldsAdd thrAvg=arrayAvg(thr), useAvg=arrayAvg(use), thrMax=arrayMax(thr)
| fieldsAdd throttlePct = if(thrAvg + useAvg > 0, thrAvg / (thrAvg + useAvg) * 100, else:0)
| fields container=k8s.container.name, throttlePct, thrMax, useAvg`,

    /** Memory working set vs limit, smoothed, 24h: pressure and growth trend. */
    memory: `
timeseries { mem=avg(dt.kubernetes.container.memory_working_set), lim=avg(dt.kubernetes.container.limits_memory) },
  by:{k8s.container.name, k8s.namespace.name}, from:now()-24h, interval:1h
| filter k8s.namespace.name=="${ns}"
| fieldsAdd smooth=arrayMovingAvg(mem, 4)
| fieldsAdd memNow=arrayLast(smooth), memStart=arrayFirst(arrayRemoveNulls(smooth)), memLimit=arrayAvg(lim)
| fields container=k8s.container.name, memNow, memStart, memLimit`,

    /** Configured CPU limit/request (millicores); missing values mean "not set". */
    resources: `
timeseries { cpuLim=avg(dt.kubernetes.container.limits_cpu), cpuReq=avg(dt.kubernetes.container.requests_cpu) },
  by:{k8s.container.name, k8s.namespace.name}, from:now()-1h
| filter k8s.namespace.name=="${ns}"
| fieldsAdd cpuLimit=arrayAvg(cpuLim), cpuRequest=arrayAvg(cpuReq)
| fields container=k8s.container.name, cpuLimit, cpuRequest`,

    oom: `
timeseries oom=max(dt.kubernetes.container.oom_kills), by:{k8s.container.name, k8s.namespace.name}, from:now()-7d, interval:1h
| filter k8s.namespace.name=="${ns}"
| fieldsAdd oomMax=arrayMax(oom)
| fields container=k8s.container.name, oomMax`,

    /** Kubernetes / OneAgent events over 7d: restarts, failed probes, kills, back-offs, failed mounts, spec changes. */
    events: `
fetch events, from:now()-7d
| filter k8s.namespace.name=="${ns}" and event.kind=="DAVIS_EVENT"
| fieldsAdd wl = coalesce(container.name, replaceString(k8s.workload.name, "${ns}-", ""), k8s.deployment.name)
| fieldsAdd kind = if(event.type=="PROCESS_RESTART", "restart",
    else: if(dt.kubernetes.event.reason=="Unhealthy", "probe",
    else: if(in(dt.kubernetes.event.reason, array("Killing","BackOff","Failed","FailedMount","FailedScheduling","FailedCreate","ErrImagePull","ImagePullBackOff","Evicted","OOMKilling")), "deployfail",
    else: if(contains(event.name,"spec change") or in(dt.kubernetes.event.reason, array("ScalingReplicaSet","SuccessfulCreate")), "change",
    else: "other"))))
| filter kind!="other" and isNotNull(wl)
| summarize { total7d=count(), inWindow=countIf(timestamp>=now()-${h}h), last24h=countIf(timestamp>=now()-24h), lastAt=max(timestamp), sample=takeFirst(substring(event.name, from:0, to:140)) }, by:{container=wl, kind}`,

    /** First/last seen per pod over 7d: rollouts show up as new pod names. */
    pods: `
fetch logs, from:now()-7d
| filter k8s.namespace.name=="${ns}"
| summarize { first=min(timestamp), last=max(timestamp) }, by:{container=k8s.container.name, pod=k8s.pod.name}
| sort first desc | limit 60`,

    /** Writes to feature-flag / config endpoints (PUT/POST/PATCH on a span whose name mentions flag or config). */
    flagChanges: `
fetch spans, from:now()-7d
| filter k8s.namespace.name=="${ns}" and span.kind=="server" and in(http.request.method, array("PUT","POST","PATCH")) and (contains(lower(span.name),"flag") or contains(lower(span.name),"config"))
| summarize { n=count(), lastAt=max(start_time) }, by:{container=k8s.container.name, endpoint=span.name}
| limit 20`,

    /** Server-side request outcome + latency, with failure classification. */
    spans: `
fetch spans, from:now()-${h}h
| filter k8s.namespace.name=="${ns}" and span.kind=="server"
| fieldsAdd failed = request.is_failed==true, ms = toDouble(duration)/1000000.0
| fieldsAdd msg = if(failed, lower(coalesce(toString(span.events), "")), else:"")
| fieldsAdd status = toLong(http.response.status_code)
| fieldsAdd transient = failed and (status==408 or status==429 or status==502 or status==503 or status==504
    or contains(msg,"timeout") or contains(msg,"timed out") or contains(msg,"deadline") or contains(msg,"connection refused")
    or contains(msg,"connection reset") or contains(msg,"unavailable"))
| fieldsAdd isHealth = contains(span.name,"health") or contains(span.name,"livez") or contains(span.name,"readyz") or contains(span.name,"ping")
| summarize { total=count(), failed=countIf(failed), transient=countIf(transient), sumMs=sum(ms), p50=percentile(ms,50), p95=percentile(ms,95), p99=percentile(ms,99),
    health=countIf(isHealth), roots=countIf(isNull(span.parent_id) and not isHealth) },
    by:{container=k8s.container.name}`,

    /** Why requests fail: the exception message on failed server spans. */
    failureReasons: `
fetch spans, from:now()-${h}h
| filter k8s.namespace.name=="${ns}" and span.kind=="server" and request.is_failed==true
| fieldsAdd exMsg=span.events[0][exception.message], status=toLong(http.response.status_code)
| summarize n=count(), by:{container=k8s.container.name, exMsg, status}
| sort n desc | limit 60`,

    /** Outgoing calls: time spent waiting on each target, failures, and call volume (latency attribution, retries). */
    clientCalls: `
fetch spans, from:now()-${h}h
| filter k8s.namespace.name=="${ns}" and span.kind=="client"
| fieldsAdd ms=toDouble(duration)/1000000.0
| summarize { calls=count(), totalMs=sum(ms), p95=percentile(ms,95), failed=countIf(request.is_failed==true) }, by:{container=k8s.container.name, target=coalesce(server.address, "unknown")}
| sort totalMs desc | limit 80`,

    /** Hourly p95 per endpoint over 24h: consistent-high vs spike detection at endpoint granularity. */
    endpointLatency: `
fetch spans, from:now()-24h
| filter k8s.namespace.name=="${ns}" and span.kind=="server"
| fieldsAdd ms = toDouble(duration)/1000000.0
| makeTimeseries { p95=percentile(ms,95), n=count() }, by:{container=k8s.container.name, endpoint=span.name}, interval:1h
| fieldsAdd calls=arraySum(n), p95Median=arrayMedian(p95), p95Max=arrayMax(p95)
| filter calls > 100
| fields container, endpoint, calls, p95Median, p95Max
| sort p95Median desc | limit 60`,

    /** Service-level request/failure/latency: the 7d baseline (excluding the window) and the current window. */
    svcBaseline: `
timeseries { req=sum(dt.service.request.count), fail=sum(dt.service.request.failure_count), rt=avg(dt.service.request.response_time) },
  by:{dt.entity.service}, from:now()-7d, to:now()-${h}h, interval:1h
| fieldsAdd n=arraySum(req), f=arraySum(fail), rtAvg=arrayAvg(rt)
| fields svc=dt.entity.service, n, f, rtAvg`,

    svcNow: `
timeseries { req=sum(dt.service.request.count), fail=sum(dt.service.request.failure_count), rt=avg(dt.service.request.response_time) },
  by:{dt.entity.service}, from:now()-${h}h, interval:1h
| fieldsAdd n=arraySum(req), f=arraySum(fail), rtAvg=arrayAvg(rt)
| fields svc=dt.entity.service, n, f, rtAvg`,

    /** Requests in the last 30 minutes, for silence detection. */
    svcRecent: `
timeseries req=sum(dt.service.request.count), by:{dt.entity.service}, from:now()-30m, interval:5m
| fieldsAdd n30=arraySum(req)
| fields svc=dt.entity.service, n30`,

    /** Slow SQL emitted by db-adapter (logged with no level): parsed duration per table. */
    slowSql: `
fetch logs, from:now()-${h}h
| filter k8s.namespace.name=="${ns}" and contains(content,"SLOW SQL")
| parse content, "DATA '[' DOUBLE:ms 'ms] [rows:' LONG:rows '] ' DATA:sql"
| fieldsAdd tbl = if(contains(sql,"\\"Pricing\\""),"Pricing", else: if(contains(sql,"\\"Trades\\""),"Trades", else: if(contains(sql,"\\"Instruments\\""),"Instruments", else:"other")))
| summarize { n=count(), p95=percentile(ms,95), maxMs=max(ms) }, by:{container=k8s.container.name, tbl}`,

    /** ERROR/WARN log patterns in the window, grouped by emitting call site (structured JSON logs carry `caller`). */
    logErrors: `
fetch logs, from:now()-${h}h
| filter k8s.namespace.name=="${ns}" and (loglevel=="ERROR" or loglevel=="WARN")
| parse content, "JSON:j"
| fieldsAdd caller=j[caller], msg=coalesce(j[msg], content)
| fieldsAdd pattern=coalesce(caller, substring(content, from:0, to:80))
| summarize { n=count(), sample=takeFirst(substring(msg, from:0, to:160)) }, by:{container=k8s.container.name, loglevel, pattern}
| sort n desc | limit 40`,

    /** Same patterns in the 7 days before the window: a pattern absent here is NEW. */
    logErrorsBaseline: `
fetch logs, from:now()-7d, to:now()-${h}h
| filter k8s.namespace.name=="${ns}" and (loglevel=="ERROR" or loglevel=="WARN")
| parse content, "JSON:j"
| fieldsAdd caller=j[caller]
| fieldsAdd pattern=coalesce(caller, substring(content, from:0, to:80))
| summarize n=count(), by:{container=k8s.container.name, pattern}
| limit 300`,

    /** Log volume over 24h in 30-minute buckets: error spikes and log silence. */
    logSeries: `
fetch logs, from:now()-24h
| filter k8s.namespace.name=="${ns}"
| makeTimeseries { total=count(), errs=countIf(loglevel=="ERROR") }, by:{container=k8s.container.name}, interval:30m
| fieldsAdd totalPrev=total[-2], totalBase=arrayAvg(total), errsPrev=errs[-2], errsBase=arrayAvg(errs), errsMax=arrayMax(errs)
| fields container, totalPrev, totalBase, errsPrev, errsBase, errsMax`,

    /** Logs: level hygiene, noise, correlation, slow-SQL, sensitive text, volume. */
    logs: `
fetch logs, from:now()-${h}h
| filter k8s.namespace.name=="${ns}"
| fieldsAdd unlabeled = isNull(loglevel) or loglevel=="NONE" or loglevel=="UNKNOWN"
| fieldsAdd lc = lower(content)
| summarize { total=count(), bytes=sum(stringLength(content)), unlabeled=countIf(unlabeled), errors=countIf(loglevel=="ERROR"), warns=countIf(loglevel=="WARN"), info=countIf(loglevel=="INFO"),
    slowSql=countIf(contains(content,"SLOW SQL")), withTrace=countIf(isNotNull(trace_id)),
    healthLines=countIf(contains(lc,"/health") or contains(lc,"/livez") or contains(lc,"/readyz")),
    sensitive=countIf(contains(lc,"password=") or contains(lc,"passwd=") or contains(lc,"api_key=") or contains(lc,"apikey=") or contains(lc,"secret=") or contains(lc,"authorization: bearer")),
    hiddenErrors=countIf(unlabeled and (contains(lc,"error") or contains(lc,"exception") or contains(lc,"fatal") or contains(lc," failed"))) },
    by:{container=k8s.container.name}`,

    /**
     * Open, un-muted vulnerabilities with Davis's assessed level and exposure, per Kubernetes workload.
     * These events carry no namespace, so rows are attached to containers by workload name in the app.
     */
    security: `
fetch security.events, from:now()-3h
| filter event.type=="VULNERABILITY_STATE_REPORT_EVENT" and vulnerability.resolution.status=="OPEN" and vulnerability.mute.status=="NOT_MUTED"
| expand workload=related_entities.kubernetes_workloads.names
| fieldsAdd exposedId=if(vulnerability.davis_assessment.exposure_status=="PUBLIC_NETWORK", vulnerability.id)
| summarize { n=countDistinct(vulnerability.id), exposed=countDistinct(exposedId), maxScore=max(vulnerability.davis_assessment.score), top=takeFirst(vulnerability.title) },
    by:{workload, level=vulnerability.davis_assessment.level}
| filter level=="CRITICAL" or level=="HIGH"
| sort maxScore desc | limit 500`,

    /** Ownership tags on workloads. */
    tags: `
fetch dt.entity.cloud_application
| fieldsAdd namespaceName, tags
| filter namespaceName=="${ns}"
| fields name=entity.name, tags`,

    /** Service topology: service id <-> container, and call edges. */
    serviceContainers: `
fetch spans, from:now()-2h
| filter k8s.namespace.name=="${ns}"
| summarize c=count(), by:{svc=dt.entity.service, container=k8s.container.name}
| fields svc, container`,

    serviceEdges: `
fetch dt.entity.service
| fieldsAdd calls, called_by
| fields id, name=entity.name, calls, called_by`,

    /** Recommendation lifecycle written by the "recommendation lifecycle" workflow: latest state per container and rule. */
    lifecycle: `
fetch bizevents, from:now()-30d
| filter event.type=="easytrade.insights.recommendation" and namespace=="${ns}"
| sort timestamp desc
| summarize status=takeFirst(status), davis=takeFirst(davis), summary=takeFirst(summary), since=min(timestamp), updated=takeFirst(timestamp), by:{container, rule}
| sort updated desc | limit 200`,

    /** Namespaces that have logs: powers the app-boundary selector. */
    namespaces: `
fetch logs, from:now()-1h
| filter isNotNull(k8s.namespace.name)
| summarize c=count(), by:{ns=k8s.namespace.name}
| sort c desc | limit 40`,
  };
};

export type QueryKey = keyof ReturnType<typeof buildQueries>;
