import { SHARED_CHAT_UI_COPY } from './copy.js';

export type DateFormatter = (date: Date) => string;

export interface TimestampViewModel {
  value: number;
  relativeLabel: string;
  title: string;
}

export interface ContextChipViewModel {
  primaryText: string;
  secondaryText?: string;
  tooltip: string;
  host: string;
  pageTitle?: string;
  pageUrl?: string;
}

export interface EmptyStateViewModel {
  title: string;
  subtitle?: string;
  context: ContextChipViewModel | null;
}

export interface ContextChipInput {
  pageTitle?: string;
  pageUrl?: string;
  fallbackTitle?: string;
}

function defaultTimestampFormatter(date: Date): string {
  try {
    return date.toLocaleString();
  } catch {
    return '';
  }
}

export function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export function formatRelativeTime(createdAt: number, now: number): string {
  const diffMs = Math.max(0, now - createdAt);
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 45) return 'just now';

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;

  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}d ago`;

  try {
    return new Date(createdAt).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '';
  }
}

export function formatTimestampTitle(
  createdAt: number,
  formatter: DateFormatter = defaultTimestampFormatter,
): string {
  try {
    return formatter(new Date(createdAt));
  } catch {
    return '';
  }
}

export function buildTimestampViewModel(
  createdAt: number,
  now: number,
  formatter?: DateFormatter,
): TimestampViewModel {
  return {
    value: createdAt,
    relativeLabel: formatRelativeTime(createdAt, now),
    title: formatTimestampTitle(createdAt, formatter),
  };
}

export function buildContextChipViewModel(
  input: ContextChipInput,
): ContextChipViewModel | null {
  const host = input.pageUrl ? hostFromUrl(input.pageUrl) : '';
  const primaryText = input.pageTitle || host || input.pageUrl || input.fallbackTitle || '';
  if (!primaryText) {
    return null;
  }

  const secondaryText =
    input.pageUrl && input.pageUrl !== primaryText ? input.pageUrl : undefined;
  const tooltip = input.pageUrl || input.pageTitle || input.fallbackTitle || primaryText;

  return {
    primaryText,
    ...(secondaryText ? { secondaryText } : {}),
    tooltip,
    host,
    ...(input.pageTitle ? { pageTitle: input.pageTitle } : {}),
    ...(input.pageUrl ? { pageUrl: input.pageUrl } : {}),
  };
}

export function buildEmptyStateViewModel(input: {
  subtitle?: string;
  pageTitle?: string;
  pageUrl?: string;
  fallbackContextTitle?: string;
} = {}): EmptyStateViewModel {
  return {
    title: SHARED_CHAT_UI_COPY.emptyStateTitle,
    ...(input.subtitle ? { subtitle: input.subtitle } : {}),
    context: buildContextChipViewModel({
      ...(input.pageTitle ? { pageTitle: input.pageTitle } : {}),
      ...(input.pageUrl ? { pageUrl: input.pageUrl } : {}),
      ...(input.fallbackContextTitle ? { fallbackTitle: input.fallbackContextTitle } : {}),
    }),
  };
}
