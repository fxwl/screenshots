import { ACCOUNT_COLOR_PRESETS, formatRemainingDuration } from '@console/lib/format';
import type { SiteTrack } from '@sessionmesh/shared';
import { Input, Label } from '@sessionmesh/ui';
import { Clock, X } from 'lucide-react';
import type React from 'react';

/**
 * Slice a track badge string by Unicode code points (stripping unpaired surrogates)
 * so multi-byte emoji glyphs are never torn in half by UTF-16 `.slice()`.
 */
export function sliceBadgeCodePoints(raw: string, maxCodePoints = 4): string {
  const codePoints: string[] = [];
  for (const ch of raw) {
    const cp = ch.codePointAt(0);
    if (cp === undefined || (cp >= 0xd800 && cp <= 0xdfff)) continue;
    codePoints.push(ch);
    if (codePoints.length >= maxCodePoints) break;
  }
  return codePoints.join('');
}

export interface TrackColorDotProps {
  color?: string;
  ephemeral?: boolean;
  className?: string;
}

export const TrackColorDot: React.FC<TrackColorDotProps> = ({ color, ephemeral, className = '' }) => {
  const effectiveColor = color || (ephemeral ? '#7c3aed' : '');
  if (!effectiveColor) return null;
  return (
    <span
      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-black/15 dark:border-white/25 ${className}`}
      style={{ backgroundColor: effectiveColor }}
      title={color ? `标识色 ${color}` : '临时分享账号'}
    />
  );
};

export interface TrackBadgesProps {
  track?: SiteTrack | null;
  showDot?: boolean;
  showEphemeralCountdown?: boolean;
}

export const TrackBadges: React.FC<TrackBadgesProps> = ({ track, showDot = true, showEphemeralCountdown = true }) => {
  if (!track) return null;
  const hasEphemeral = Boolean(track.ephemeral);
  const badgeText = track.badgeText?.trim();
  const showCustomBadge = Boolean(badgeText && (!hasEphemeral || badgeText.toUpperCase() !== 'TEMP'));

  return (
    <>
      {showDot ? <TrackColorDot color={track.color} ephemeral={hasEphemeral} /> : null}
      {showCustomBadge && badgeText ? (
        <span
          className={`inline-flex items-center rounded border px-1.5 py-0 text-[10px] font-bold leading-4 whitespace-nowrap ${
            track.color ? '' : 'border-primary/30 bg-primary/10 text-primary'
          }`}
          style={
            track.color
              ? {
                  backgroundColor: `${track.color}1a`,
                  borderColor: `${track.color}55`,
                  color: track.color,
                }
              : undefined
          }>
          {badgeText}
        </span>
      ) : null}
      {hasEphemeral && track.ephemeral ? (
        <span
          className="inline-flex items-center gap-1 rounded-full border border-purple-500/35 bg-purple-500/15 px-1.5 py-0 text-[10px] font-semibold leading-4 text-purple-700 dark:bg-purple-500/20 dark:text-purple-300 whitespace-nowrap"
          title={
            track.ephemeral.note ||
            (track.ephemeral.sharedBy ? `由 ${track.ephemeral.sharedBy} 分享` : '本机临时隔离账号')
          }>
          <Clock className="h-2.5 w-2.5 shrink-0" />
          {showEphemeralCountdown
            ? `临时分享 · ${formatRemainingDuration(track.ephemeral.expiresAt - Date.now())}`
            : 'TEMP'}
        </span>
      ) : null}
    </>
  );
};

export interface AccountAppearanceFieldsProps {
  idPrefix: string;
  color: string;
  onColorChange: (color: string) => void;
  badgeText: string;
  onBadgeTextChange: (badgeText: string) => void;
}

export const AccountAppearanceFields: React.FC<AccountAppearanceFieldsProps> = ({
  idPrefix,
  color,
  onColorChange,
  badgeText,
  onBadgeTextChange,
}) => {
  const trimmedBadge = sliceBadgeCodePoints(badgeText.trim(), 4);

  return (
    <div className="space-y-2.5 rounded-lg border border-border bg-muted/20 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-foreground">颜色标识与角标（最多 4 字）</span>
        {color || trimmedBadge ? (
          <span className="inline-flex items-center gap-1 rounded bg-background px-1.5 py-0.5 text-[10px] border border-border">
            <span className="text-muted-foreground">预览：</span>
            <TrackColorDot color={color} />
            {trimmedBadge ? (
              <span
                className={`inline-flex items-center rounded border px-1 py-0 text-[10px] font-bold leading-4 ${
                  color ? '' : 'border-primary/30 bg-primary/10 text-primary'
                }`}
                style={
                  color
                    ? {
                        backgroundColor: `${color}1a`,
                        borderColor: `${color}55`,
                        color,
                      }
                    : undefined
                }>
                {trimmedBadge}
              </span>
            ) : (
              <span className="text-muted-foreground">无角标</span>
            )}
          </span>
        ) : null}
      </div>

      {/* Swatch Picker */}
      <div className="flex flex-wrap items-center gap-1.5">
        {ACCOUNT_COLOR_PRESETS.map(preset => {
          const selected = color.toLowerCase() === preset.value.toLowerCase();
          return (
            <button
              key={preset.value}
              type="button"
              onClick={() => onColorChange(selected ? '' : preset.value)}
              title={`${preset.label} (${preset.value})`}
              aria-label={`${preset.label} ${preset.value}`}
              className={`flex h-6 w-6 items-center justify-center rounded-full border transition-transform ${
                selected
                  ? 'scale-110 ring-2 ring-primary ring-offset-1 ring-offset-background border-white'
                  : 'border-black/15 hover:scale-105'
              }`}
              style={{ backgroundColor: preset.value }}>
              {selected ? <span className="h-1.5 w-1.5 rounded-full bg-white shadow" /> : null}
            </button>
          );
        })}

        <label
          htmlFor={`${idPrefix}-custom-color`}
          className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border border-input bg-background px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
          title="自定义颜色">
          <input
            id={`${idPrefix}-custom-color`}
            type="color"
            value={color || '#2563eb'}
            onChange={e => onColorChange(e.target.value)}
            className="h-3.5 w-3.5 cursor-pointer border-0 bg-transparent p-0"
          />
          自定义
        </label>

        {color ? (
          <button
            type="button"
            onClick={() => onColorChange('')}
            className="inline-flex h-6 items-center gap-0.5 rounded-md border border-border bg-background px-1.5 text-[10px] text-muted-foreground hover:text-foreground">
            <X className="h-3 w-3" />
            清除颜色
          </button>
        ) : null}
      </div>

      {/* Badge Text Input */}
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-badge-text`} className="text-[11px] text-muted-foreground">
          短角标文本（如 PROD、DEV、#1、主）
        </Label>
        <Input
          id={`${idPrefix}-badge-text`}
          value={badgeText}
          onChange={e => onBadgeTextChange(sliceBadgeCodePoints(e.target.value, 4))}
          placeholder="最多 4 个字符（可选）"
          className="h-7 bg-background text-xs"
        />
      </div>
    </div>
  );
};
