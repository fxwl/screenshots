import { Badge, Button } from '@sessionmesh/ui';
import { ArrowRight, BookOpen, Globe, Laptop, Sparkles, Users, X } from 'lucide-react';
import { useState } from 'react';

interface PopupQuickTourProps {
  onFinish: () => void;
  onOpenFullTutorials: () => void;
  onOpenPairing: () => void;
}

const TOUR_SLIDES = [
  {
    id: 1,
    icon: Globe,
    title: '只同步你点开的网站',
    body: '打开想多端共享登录的网站（如 GitHub、B 站），点击下方「开启此网站自动同步」即可。没开启的网页绝不上传。',
  },
  {
    id: 2,
    icon: Users,
    title: '同一网站可存多个账号秒切',
    body: '点击「+ 存新号 → 新建空白小号」可直接登录第 2 个号且原账号不会掉线；平时按 Alt+Shift+. 即可一键轮换账号！',
  },
  {
    id: 3,
    icon: Laptop,
    title: '10 秒连入第 2 台电脑',
    body: '点击底部「连接新电脑」生成配对码，在另一台电脑粘贴即可自动互通。关闭网页时后台会自动合并加密上传。',
  },
] as const;

export function PopupQuickTour({ onFinish, onOpenFullTutorials, onOpenPairing }: PopupQuickTourProps) {
  const [idx, setIdx] = useState(0);
  const current = TOUR_SLIDES[idx] ?? TOUR_SLIDES[0];
  const Icon = current.icon;
  const isLast = idx === TOUR_SLIDES.length - 1;

  return (
    <section
      aria-label="新手快速引导"
      className="rounded-xl border border-primary/40 bg-primary/[0.06] p-3 text-xs space-y-2.5 shadow-2xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-semibold text-primary">
          <Sparkles className="h-3.5 w-3.5" />
          <span>30 秒快速上手</span>
          <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
            {idx + 1} / {TOUR_SLIDES.length}
          </Badge>
        </div>
        <button
          type="button"
          onClick={onFinish}
          aria-label="跳过新手引导"
          className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-background/70 hover:text-foreground">
          跳过
          <X className="h-3 w-3" />
        </button>
      </div>

      <div className="flex items-start gap-2.5 rounded-lg border border-border/70 bg-background/90 p-2.5">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <Icon className="h-4 w-4" />
        </div>
        <div className="space-y-1">
          <div className="font-bold text-foreground">{current.title}</div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">{current.body}</p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onOpenFullTutorials}
          className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-primary">
          <BookOpen className="h-3 w-3" />
          完整图文教程
        </button>

        <div className="flex items-center gap-1.5">
          {isLast ? (
            <Button type="button" size="sm" variant="outline" onClick={onOpenPairing} className="h-6 px-2 text-[11px]">
              生成配对码
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            onClick={() => {
              if (isLast) {
                onFinish();
              } else {
                setIdx(prev => prev + 1);
              }
            }}
            className="h-6 px-2.5 text-[11px]">
            {isLast ? '知道了，开始使用' : '下一步'}
            {!isLast ? <ArrowRight className="ml-1 h-3 w-3" /> : null}
          </Button>
        </div>
      </div>
    </section>
  );
}
