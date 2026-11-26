import type { DebugExportFormat, DebugExportResult } from '@sessionmesh/core';
import { unwrapCommand } from '@sessionmesh/shared';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@sessionmesh/ui';
import { ChevronDown, Copy, Download, Loader2, Terminal } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  copyTextToClipboard,
  downloadTextFile,
  extractErrorMessage,
  SENSITIVE_CLIPBOARD_WARNING,
} from '../utils/helpers';

export interface DebugExportMenuProps {
  siteKey?: string;
  trackId?: string;
  targetUrl?: string;
  disabled?: boolean;
}

const COPY_OPTIONS: ReadonlyArray<{ format: DebugExportFormat; label: string; hint?: string }> = [
  { format: 'curl', label: '复制 curl 命令', hint: 'curl' },
  { format: 'fetch', label: '复制 fetch 请求片段', hint: 'Node.js' },
  { format: 'cookie_header', label: '复制 Cookie 请求头', hint: 'Header' },
  { format: 'headers_json', label: '复制 Headers JSON', hint: 'JSON' },
  { format: 'playwright_storage_state', label: '复制 Playwright storageState.json', hint: 'Playwright' },
  { format: 'postman_apifox', label: '复制 Postman / Apifox JSON', hint: 'Postman' },
  { format: 'netscape_cookies_txt', label: '复制 Netscape cookies.txt', hint: 'cookies.txt' },
];

export function DebugExportMenu({ siteKey, trackId, targetUrl, disabled = false }: DebugExportMenuProps) {
  const [busy, setBusy] = useState(false);

  const handleExport = async (format: DebugExportFormat, mode: 'copy' | 'download') => {
    setBusy(true);
    try {
      const res = await unwrapCommand<DebugExportResult>({
        type: 'EXPORT_DEBUG_STATE',
        request: {
          siteKey,
          trackId,
          targetUrl,
          format,
          filterNoise: true,
          includeLocalStorage: true,
          includeSessionStorage: true,
        },
      });

      if (res.cookieCount === 0 && res.originCount === 0) {
        toast.warning('未找到可导出的有效 Cookie（可能为空或已过滤噪声字段）');
        return;
      }

      if (mode === 'copy') {
        const ok = await copyTextToClipboard(res.content);
        if (ok) {
          toast.success(SENSITIVE_CLIPBOARD_WARNING);
        } else {
          toast.error('复制到剪贴板失败');
        }
      } else {
        const mime =
          format === 'playwright_storage_state' || format === 'postman_apifox' || format === 'headers_json'
            ? 'application/json;charset=utf-8'
            : 'text/plain;charset=utf-8';
        downloadTextFile(res.suggestedFilename, res.content, mime);
        toast.success(`已下载 ${res.suggestedFilename}`);
      }
    } catch (err) {
      toast.error(`导出调试态失败：${extractErrorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || busy}
          className="h-7 px-2 text-[11px]"
          title="一键导出 curl / fetch / Cookie / Playwright / Postman 等调试态">
          {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Terminal className="mr-1 h-3 w-3" />}
          导出调试态
          <ChevronDown className="ml-0.5 h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="py-1 text-[10px] font-medium text-muted-foreground">
          一键复制（含敏感登录态，注意保密）
        </DropdownMenuLabel>
        {COPY_OPTIONS.map(item => (
          <DropdownMenuItem
            key={item.format}
            className="flex items-center justify-between gap-2 text-xs"
            onClick={() => void handleExport(item.format, 'copy')}>
            <span className="flex min-w-0 items-center gap-1.5">
              <Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{item.label}</span>
            </span>
            {item.hint ? <span className="shrink-0 text-[10px] text-muted-foreground">{item.hint}</span> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="py-1 text-[10px] font-medium text-muted-foreground">下载为文件</DropdownMenuLabel>
        <DropdownMenuItem className="text-xs" onClick={() => void handleExport('playwright_storage_state', 'download')}>
          <Download className="mr-1.5 h-3.5 w-3.5 text-primary" />
          下载 Playwright storageState.json
        </DropdownMenuItem>
        <DropdownMenuItem className="text-xs" onClick={() => void handleExport('postman_apifox', 'download')}>
          <Download className="mr-1.5 h-3.5 w-3.5 text-muted-foreground" />
          下载 Postman / Apifox (.json)
        </DropdownMenuItem>
        <DropdownMenuItem className="text-xs" onClick={() => void handleExport('netscape_cookies_txt', 'download')}>
          <Download className="mr-1.5 h-3.5 w-3.5 text-muted-foreground" />
          下载 Netscape cookies.txt
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
