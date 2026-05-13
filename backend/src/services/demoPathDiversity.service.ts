import type { DemoPath, DemoPathDiversityCheck } from "../types/demo.types.js";

interface EnforcePathDiversityOptions {
  mergeCount?: number;
  notes?: string[];
}

export function enforceDemoPathDiversity(
  paths: DemoPath[],
  options: EnforcePathDiversityOptions = {}
): DemoPathDiversityCheck {
  const seenTitles = new Map<string, DemoPath>();
  const seenSummaryPrefixes = new Map<string, DemoPath>();
  const diversityKeyCounts = new Map<string, number>();
  let duplicateTitleCount = 0;
  let duplicateSummaryPrefixCount = 0;
  let rewriteCount = 0;

  for (const path of paths) {
    const titleKey = normalizeKey(path.title);
    if (titleKey && seenTitles.has(titleKey)) {
      duplicateTitleCount += 1;
      path.title = rewriteTitle(path, paths.indexOf(path));
      rewriteCount += 1;
    }
    seenTitles.set(normalizeKey(path.title), path);

    const summaryPrefix = normalizeKey(path.summary.slice(0, 20));
    if (summaryPrefix && seenSummaryPrefixes.has(summaryPrefix)) {
      duplicateSummaryPrefixCount += 1;
      path.summary = rewriteSummary(path);
      rewriteCount += 1;
    }
    seenSummaryPrefixes.set(normalizeKey(path.summary.slice(0, 20)), path);

    const diversityKey = normalizeKey(path.diversityKey ?? "");
    if (diversityKey) {
      diversityKeyCounts.set(diversityKey, (diversityKeyCounts.get(diversityKey) ?? 0) + 1);
    }
  }

  const duplicateDiversityKeys = Array.from(diversityKeyCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([key]) => key);
  const duplicateFound =
    duplicateTitleCount > 0 || duplicateSummaryPrefixCount > 0 || duplicateDiversityKeys.length > 0;
  const notes = [
    duplicateFound
      ? "path diversity check found similar titles, summary prefixes, or diversity keys"
      : "path diversity check passed with distinct titles, summaries, and diversity keys",
    ...(rewriteCount > 0 ? [`rewrote ${rewriteCount} path text field(s) to reduce repetition`] : []),
    ...(options.mergeCount && options.mergeCount > 0
      ? [`clustered ${options.mergeCount} additional source candidate(s) into existing paths`]
      : []),
    ...(options.notes ?? [])
  ];

  return {
    duplicateFound,
    duplicateTitleCount,
    duplicateSummaryPrefixCount,
    duplicateDiversityKeys,
    rewriteCount,
    mergeCount: options.mergeCount ?? 0,
    notes
  };
}

function rewriteTitle(path: DemoPath, index: number): string {
  const marker = truncateText(path.diversityKey || path.tradeoff || `第${index + 1}条路径`, 10);
  const base = path.title.includes(marker) ? path.title : `${path.title}，重点看${marker}`;
  return truncateText(base, 42);
}

function rewriteSummary(path: DemoPath): string {
  const marker = path.diversityKey || path.title;
  return truncateText(`${marker}：${path.summary}`, 150);
}

function normalizeKey(value: string): string {
  return value
    .replace(/\s+/g, "")
    .replace(/[，。！？、,.!?:：；;（）()《》"“”]/g, "")
    .toLowerCase();
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}
