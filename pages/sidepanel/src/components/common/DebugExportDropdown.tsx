import { extractErrorMessage, sidePanelApi } from '@console/lib/api';
import {
  copyToClipboard,
  DEBUG_EXPORT_FORMAT_OPTIONS,
  downloadJsonFile,
  downloadTextFile,
  SENSITIVE_CLIPBOARD_WARNING,
} from '@console/lib/format';
import type { DebugExportFormat } from '@sessionmesh/shared';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@sessionmesh/ui';
import { ChevronDown, Copy, Download, FileJson, Loader2, Terminal } from 'lucide-react';
import type React from 'react';
import { useState } from 'react';
import { toast } from 'sonner';

export interface DebugExportMenuItemsProps {
  siteKey: string;
  trackId?: string;
  trackLabel?: string;
  targetUrl?: string;
  includeRawCookiesJson?: boolean;
  onBusyChange?: (busy: boolean) => void;
}

function resolveMimeType(format: DebugExportFormat): string {
  switch (format) {
    case 'headers_json':
    case 'playwright_storage_state':
    case 'postman_apifox':
      return 'application/json;charset=utf-8';
    default:
      return 'text/plain;charset=utf-8';
  }
}

export const DebugExportMenuItems: React.FC<DebugExportMenuItemsProps> = ({
  siteKey,
  trackId,
  trackLabel,
  targetUrl,
  includeRawCookiesJson = false,
  onBusyChange,
}) => {
  const runDebugExport = async (format: DebugExportFormat, mode: 'copy' | 'download') => {
    onBusyChange?.(true);
    try {
      const res = await sidePanelApi.exportDebugState({
        siteKey,
        trackId,
        targetUrl,
        format,
        filterNoise: true,
        includeLocalStorage: true,
        includeSessionStorage: true,
      });
      if (res.cookieCount === 0 && res.originCount === 0) {
        toast.warning('该账号轨道暂无可导出的有效 Cookie');
        return;
      }
      if (mode === 'copy') {
        const ok = await copyToClipboard(res.content);
        if (ok) {
          toast.success(SENSITIVE_CLIPBOARD_WARNING);
        } else {
          toast.error('复制到剪贴板失败');
        }
      } else {
        downloadTextFile(res.suggestedFilename, res.content, resolveMimeType(format));
        toast.success(`已下载 ${res.suggestedFilename}`);
      }
    } catch (err) {
      toast.error(`导出调试态失败：${extractErrorMessage(err)}`);
    } finally {
      onBusyChange?.(false);
    }
  };

  const runRawJsonExport = async (mode: 'copy' | 'download') => {
    onBusyChange?.(true);
    try {
      const cookies = await sidePanelApi.exportCookiesJson(siteKey, trackId);
      if (cookies.length === 0) {
        toast.warning('该账号轨道暂无 Cookie');
        return;
      }
      if (mode === 'copy') {
        const ok = await copyToClipboard(JSON.stringify(cookies, null, 2));
        if (ok) {
          toast.success(SENSITIVE_CLIPBOARD_WARNING);
        } else {
          toast.error('复制到剪贴板失败');
        }
      } else {
        const suffix = trackLabel ? `-${trackLabel.replace(/[^\w\u4e00-\u9fa5-]+/g, '_')}` : '';
        downloadJsonFile(`sessionmesh-cookies-${siteKey}${suffix}.json`, cookies);
        toast.success(`已导出 ${cookies.length} 条 Raw Cookies JSON`);
      }
    } catch (err) {
      toast.error(`导出 Raw JSON 失败：${extractErrorMessage(err)}`);
    } finally {
      onBusyChange?.(false);
    }
  };

  return (
    <>
      <DropdownMenuLabel className="text-[10px] font-medium text-muted-foreground py-1">
        复制到剪贴板（一键调试态）
      </DropdownMenuLabel>
      {DEBUG_EXPORT_FORMAT_OPTIONS.map(opt => (
        <DropdownMenuItem key={`copy-${opt.format}`} onClick={() => void runDebugExport(opt.format, 'copy')}>
          <Copy className="mr-2 h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs">{opt.label}</div>
            <div className="truncate text-[10px] text-muted-foreground">{opt.hint}</div>
          </div>
        </DropdownMenuItem>
      ))}
      {includeRawCookiesJson ? (
        <DropdownMenuItem onClick={() => void runRawJsonExport('copy')}>
          <FileJson className="mr-2 h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs">Raw Cookies JSON</div>
            <div className="truncate text-[10px] text-muted-foreground">完整原始数组（含 HttpOnly）</div>
          </div>
        </DropdownMenuItem>
      ) : null}

      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="text-xs">
          <Download className="mr-2 h-3.5 w-3.5 shrink-0" />
          下载为文件...
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-52">
          {DEBUG_EXPORT_FORMAT_OPTIONS.map(opt => (
            <DropdownMenuItem key={`dl-${opt.format}`} onClick={() => void runDebugExport(opt.format, 'download')}>
              <Download className="mr-2 h-3.5 w-3.5 shrink-0" />
              <span className="truncate text-xs">{opt.shortLabel}</span>
            </DropdownMenuItem>
          ))}
          {includeRawCookiesJson ? (
            <DropdownMenuItem onClick={() => void runRawJsonExport('download')}>
              <Download className="mr-2 h-3.5 w-3.5 shrink-0" />
              <span className="truncate text-xs">Raw Cookies (.json)</span>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
};

export interface DebugExportDropdownProps {
  siteKey: string;
  trackId?: string;
  trackLabel?: string;
  targetUrl?: string;
  includeRawCookiesJson?: boolean;
  disabled?: boolean;
  label?: string;
}

export const DebugExportDropdown: React.FC<DebugExportDropdownProps> = ({
  siteKey,
  trackId,
  trackLabel,
  targetUrl,
  includeRawCookiesJson = true,
  disabled = false,
  label = '导出调试态',
}) => {
  const [busy, setBusy] = useState(false);

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || busy}
          className="h-7 px-2 text-[11px]"
          title="导出 curl / fetch / Playwright / Postman / cookies.txt 等调试格式">
          {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Terminal className="mr-1 h-3 w-3" />}
          {label}
          <ChevronDown className="ml-0.5 h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DebugExportMenuItems
          siteKey={siteKey}
          trackId={trackId}
          trackLabel={trackLabel}
          targetUrl={targetUrl}
          includeRawCookiesJson={includeRawCookiesJson}
          onBusyChange={setBusy}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
