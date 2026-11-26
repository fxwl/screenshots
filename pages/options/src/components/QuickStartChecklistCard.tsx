import type { Device, SiteSummaryView } from '@sessionmesh/core';
import { unwrapCommand } from '@sessionmesh/shared';
import { Badge, Button, Card, CardContent } from '@sessionmesh/ui';
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  Globe,
  Laptop,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useUxOnboardingPrefs } from '../utils/helpers';

export interface QuickStartChecklistCardProps {
  refreshSignal: number;
  onJumpToSites: () => void;
  onJumpToPairing: () => void;
  onJumpToTutorials: (topic?: string) => void;
}

export function QuickStartChecklistCard({
  refreshSignal,
  onJumpToSites,
  onJumpToPairing,
  onJumpToTutorials,
}: QuickStartChecklistCardProps) {
  const { prefs, updatePrefs, markGuideTaskDone } = useUxOnboardingPrefs();
  const [managedCount, setManagedCount] = useState(0);
  const [multiAcctCount, setMultiAcctCount] = useState(0);
  const [deviceCount, setDeviceCount] = useState(1);

  useEffect(() => {
    let active = true;
    void Promise.all([
      unwrapCommand<SiteSummaryView[]>({ type: 'GET_SITES_OVERVIEW' }).catch(() => [] as SiteSummaryView[]),
      unwrapCommand<Device[]>({ type: 'GET_DEVICES' }).catch(() => [] as Device[]),
    ]).then(([sites, devices]) => {
      if (!active) return;
      const validManaged = (sites || []).filter(
        s => s.binding.state !== 'UNMANAGED' && s.binding.state !== 'BLACKLISTED',
      );
      const multiAcct = validManaged.filter(s => (s.allTracks?.length ?? 0) > 1);
      const activeDevs = (devices || []).filter(d => d.state === 'active' || d.state === 'paused');
      setManagedCount(validManaged.length);
      setMultiAcctCount(multiAcct.length);
      setDeviceCount(Math.max(1, activeDevs.length));
    });
    return () => {
      active = false;
    };
  }, [refreshSignal]);

  if (prefs.checklistDismissed) {
    return null;
  }

  const step1Done = true;
  const step2Done = managedCount > 0 || Boolean(prefs.completedGuideTasks.first_site);
  const step3Done = deviceCount > 1 || Boolean(prefs.completedGuideTasks.second_device);
  const step4Done = multiAcctCount > 0 || Boolean(prefs.completedGuideTasks.multi_account);

  const items = [
    {
      id: 'storage',
      done: step1Done,
      icon: Sparkles,
      title: '1. 连接加密存储空间',
      desc: '已完成本地端到端加密初始化',
      actionLabel: null as string | null,
      onAction: undefined as (() => void) | undefined,
    },
    {
      id: 'first_site',
      done: step2Done,
      icon: Globe,
      title: '2. 开启第 1 个网站的自动同步',
      desc: managedCount > 0 ? `已开启 ${managedCount} 个网站的自动同步` : '挑出需要多台电脑共享登录的网站',
      actionLabel: step2Done ? '管理网站' : '去添加网站',
      onAction: onJumpToSites,
    },
    {
      id: 'second_device',
      done: step3Done,
      icon: Laptop,
      title: '3. 连接第 2 台电脑',
      desc: deviceCount > 1 ? `当前空间已接入 ${deviceCount} 台设备` : '一键生成配对码，10 秒免填密钥接入新电脑',
      actionLabel: '生成配对码',
      onAction: onJumpToPairing,
    },
    {
      id: 'multi_account',
      done: step4Done,
      icon: Users,
      title: '4. 了解同网站多账号秒切',
      desc: '原账号不掉线新建空白小号，支持 Alt+Shift+. 一键切号',
      actionLabel: '看 30 秒图解',
      onAction: () => {
        void markGuideTaskDone('multi_account');
        onJumpToTutorials('multi_account');
      },
    },
  ];

  const doneCount = items.filter(i => i.done).length;
  const allDone = doneCount === items.length;

  return (
    <Card className="mb-5 border-primary/35 bg-primary/[0.03]">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <button
          type="button"
          onClick={() => void updatePrefs({ checklistCollapsed: !prefs.checklistCollapsed })}
          className="flex items-center gap-2.5 text-left">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <Sparkles className="h-4 w-4" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-bold text-foreground">
                {allDone ? '🎉 你已掌握 SessionMesh 核心操作！' : '新手 3 分钟快速上手清单'}
              </span>
              <Badge variant={allDone ? 'success' : 'info'} className="px-1.5 py-0 text-[10px]">
                进度 {doneCount} / {items.length}
              </Badge>
            </div>
          </div>
          {prefs.checklistCollapsed ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          )}
        </button>

        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-primary"
            onClick={() => onJumpToTutorials()}>
            <BookOpen className="mr-1 h-3.5 w-3.5" />
            打开完整教程
          </Button>
          <button
            type="button"
            onClick={() => void updatePrefs({ checklistDismissed: true })}
            aria-label="关闭新手上手清单"
            className="inline-flex items-center gap-0.5 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
            不再显示
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {!prefs.checklistCollapsed ? (
        <CardContent className="border-t border-border/60 pt-3.5 pb-4">
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
            {items.map(item => (
              <div
                key={item.id}
                className={`flex flex-col justify-between gap-2.5 rounded-xl border p-3 text-xs transition-colors ${
                  item.done ? 'border-emerald-500/30 bg-emerald-500/[0.04]' : 'border-border bg-background'
                }`}>
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5 font-semibold text-foreground">
                    {item.done ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    ) : (
                      <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate">{item.title}</span>
                  </div>
                  <p className="pl-5.5 text-[11px] leading-relaxed text-muted-foreground">{item.desc}</p>
                </div>

                {item.actionLabel && item.onAction ? (
                  <div className="pl-5.5">
                    <Button
                      type="button"
                      size="sm"
                      variant={item.done ? 'outline' : 'default'}
                      onClick={item.onAction}
                      className="h-7 w-full text-[11px]">
                      {item.actionLabel}
                      <ArrowRight className="ml-1 h-3 w-3" />
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </CardContent>
      ) : null}
    </Card>
  );
}
