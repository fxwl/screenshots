import type { CapabilityCheckResult, CapabilityReport } from '@sessionmesh/core';
import { Badge, Button } from '@sessionmesh/ui';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  HardDrive,
  HelpCircle,
  ShieldCheck,
  X,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';
import { formatBytes, formatDateTime, getConsistencyMeta, useUiBannerPrefs } from '../utils/helpers';

interface CapabilityReportViewProps {
  report: CapabilityReport;
  defaultExpanded?: boolean;
}

function renderCheckState(check: CapabilityCheckResult) {
  switch (check.state) {
    case 'supported':
      return (
        <Badge variant="success" className="text-[11px]">
          <CheckCircle2 className="h-3 w-3" />
          支持
        </Badge>
      );
    case 'unsupported':
      return (
        <Badge variant="destructive" className="text-[11px]">
          <XCircle className="h-3 w-3" />
          不支持
        </Badge>
      );
    case 'unverified':
    default:
      return (
        <Badge variant="warning" className="text-[11px]">
          <HelpCircle className="h-3 w-3" />
          未能验证
        </Badge>
      );
  }
}

export function CapabilityReportView({ report, defaultExpanded = false }: CapabilityReportViewProps) {
  const { isBannerVisible, dismissBanner } = useUiBannerPrefs();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const consistency = getConsistencyMeta(report.consistencyLevel);

  const supportedCount = report.checks.filter(c => c.state === 'supported').length;
  const unsupportedCount = report.checks.filter(c => c.state === 'unsupported').length;
  const unverifiedCount = report.checks.filter(c => c.state === 'unverified').length;

  return (
    <div
      className={`rounded-xl border p-4 transition-colors ${
        report.overallOk
          ? report.consistencyLevel === 'strong_cas'
            ? 'border-emerald-500/35 bg-emerald-500/5'
            : 'border-amber-500/35 bg-amber-500/5'
          : 'border-destructive/40 bg-destructive/5'
      }`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            {report.overallOk ? (
              <ShieldCheck className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <AlertTriangle className="h-5 w-5 text-destructive" />
            )}
            <span className="font-semibold text-sm">
              {report.overallOk ? '存储连接能力检测通过' : '存储连接能力检测未通过'}
            </span>
            <Badge variant={consistency.variant}>{consistency.shortLabel}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">{report.summaryMessage || consistency.description}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1 rounded-md border border-border bg-background/80 px-2 py-1">
            <Clock className="h-3.5 w-3.5" />
            耗时 {report.totalLatencyMs} ms
          </span>
          {report.quotaAvailableBytes !== undefined || report.quotaUsedBytes !== undefined ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-border bg-background/80 px-2 py-1">
              <HardDrive className="h-3.5 w-3.5" />
              已用 {formatBytes(report.quotaUsedBytes)} / 可用 {formatBytes(report.quotaAvailableBytes)}
            </span>
          ) : null}
        </div>
      </div>

      {report.consistencyLevel === 'append_only_degraded' &&
      isBannerVisible('webdav_degraded_consistency', 'degraded') ? (
        <div className="relative mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 pr-24 text-xs text-amber-900 dark:text-amber-200">
          <strong>并发保护降级提示：</strong>
          {consistency.description}
          <div className="absolute right-2 top-1.5 flex items-center gap-1">
            <button
              type="button"
              onClick={() => void dismissBanner('webdav_degraded_consistency')}
              className="rounded px-1.5 py-0.5 text-[11px] hover:bg-amber-500/20">
              不再提示
            </button>
            <button
              type="button"
              aria-label="关闭降级提示"
              onClick={() => void dismissBanner('webdav_degraded_consistency')}
              className="rounded p-1 hover:bg-amber-500/20">
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="text-emerald-700 dark:text-emerald-400 font-medium">支持：{supportedCount}</span>
          <span className="text-destructive font-medium">不支持：{unsupportedCount}</span>
          <span className="text-amber-700 dark:text-amber-400 font-medium">未能验证：{unverifiedCount}</span>
          <span className="text-muted-foreground">检测时间：{formatDateTime(report.testedAt)}</span>
        </div>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => setExpanded(prev => !prev)}>
          {expanded ? (
            <>
              收起 {report.checks.length} 项能力清单
              <ChevronUp className="ml-1 h-3.5 w-3.5" />
            </>
          ) : (
            <>
              展开查看全部 {report.checks.length} 项能力检测
              <ChevronDown className="ml-1 h-3.5 w-3.5" />
            </>
          )}
        </Button>
      </div>

      {expanded ? (
        <div className="mt-3 overflow-hidden rounded-lg border border-border bg-background">
          <div className="max-h-72 overflow-y-auto divide-y divide-border/70">
            {report.checks.map(check => (
              <div
                key={`${check.step}-${check.id}`}
                className="flex items-start justify-between gap-3 px-3 py-2 text-xs">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-[10px] font-semibold">
                      {check.step}
                    </span>
                    <span className="font-medium text-foreground">{check.name}</span>
                  </div>
                  {check.detail ? (
                    <p className="mt-0.5 pl-7 text-[11px] text-muted-foreground break-all">{check.detail}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {check.latencyMs !== undefined ? (
                    <span className="font-mono text-[11px] text-muted-foreground">{check.latencyMs}ms</span>
                  ) : null}
                  {renderCheckState(check)}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
