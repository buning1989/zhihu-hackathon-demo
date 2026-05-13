import type { UserContext } from "../auth/session.js";
import type { DemoContextUsed } from "../types/demo.types.js";

const PROFILE_SIGNAL_ALLOWLIST = [
  "AI",
  "人工智能",
  "产品经理",
  "产品",
  "程序员",
  "开发",
  "工程师",
  "设计师",
  "运营",
  "内容",
  "自媒体",
  "新媒体",
  "市场",
  "销售",
  "咨询",
  "教师",
  "教育",
  "学生",
  "医生",
  "律师",
  "金融",
  "投资",
  "创业",
  "创业者",
  "自由职业",
  "写作",
  "摄影",
  "旅行",
  "心理",
  "城市",
  "生活方式"
];

const SENSITIVE_PROFILE_FRAGMENTS = [
  "身份证",
  "手机号",
  "电话",
  "住址",
  "地址",
  "收入",
  "资产",
  "存款",
  "负债",
  "民族",
  "宗教",
  "政治",
  "党员",
  "病",
  "抑郁",
  "焦虑症",
  "怀孕",
  "离异",
  "单亲",
  "同性恋",
  "性取向"
];

export function createAnonymousUserContext(): UserContext {
  return {
    provider: "zhihu",
    isLoggedIn: false
  };
}

export function normalizeUserContext(userContext?: UserContext): UserContext {
  return userContext ?? createAnonymousUserContext();
}

export function getProfileSignals(userContext?: UserContext): string[] {
  const context = normalizeUserContext(userContext);
  if (!context.isLoggedIn) {
    return [];
  }

  const profileText = normalizeText([context.headline, context.displayName].filter(Boolean).join(" "));
  if (!profileText || containsSensitiveProfileFragment(profileText)) {
    return [];
  }

  return unique(
    PROFILE_SIGNAL_ALLOWLIST.filter((signal) => profileText.includes(signal))
  ).slice(0, 4);
}

export function createDemoContextUsed(
  userContext: UserContext | undefined,
  usedFor: DemoContextUsed["usedFor"] = []
): DemoContextUsed {
  const context = normalizeUserContext(userContext);
  const profileSignals = getProfileSignals(context);

  return {
    provider: "zhihu",
    loggedIn: context.isLoggedIn,
    zhihuProfileUsed: context.isLoggedIn && profileSignals.length > 0 && usedFor.length > 0,
    profileSignals,
    usedFor: unique(usedFor)
  };
}

export function buildPromptUserContext(userContext?: UserContext): Record<string, unknown> {
  const context = normalizeUserContext(userContext);
  const profileSignals = getProfileSignals(context);

  return {
    provider: "zhihu",
    isLoggedIn: context.isLoggedIn,
    ...(context.displayName ? { displayName: truncateText(context.displayName, 24) } : {}),
    ...(context.headline ? { headline: truncateText(context.headline, 80) } : {}),
    profileSignals
  };
}

export function buildContextAwareSearchQueries(
  originalQuery: string,
  plannedQueries: string[],
  userContext?: UserContext
): string[] {
  const normalizedOriginalQuery = normalizeText(originalQuery);
  const profileSignals = getProfileSignals(userContext);
  const profileQueries = profileSignals.map((signal) => `${normalizedOriginalQuery} ${signal}`);

  return unique([
    normalizedOriginalQuery,
    ...plannedQueries.map(normalizeText).filter((query) => query && query !== normalizedOriginalQuery),
    ...profileQueries
  ]);
}

export function buildContextFitReason(
  userQuery: string,
  userContext: UserContext | undefined,
  contentFocus: string
): string {
  const profileSignals = getProfileSignals(userContext);
  const profilePart =
    profileSignals.length > 0
      ? `和资料里的「${profileSignals.slice(0, 2).join("、")}」线索`
      : "";
  const basis = profilePart ? `结合你的问题${profilePart}` : "结合你的问题";

  return `${basis}，这条匹配只说明公开内容可用来对照「${truncateText(contentFocus, 18)}」，判断仍以来源片段为准。`;
}

function containsSensitiveProfileFragment(value: string): boolean {
  return SENSITIVE_PROFILE_FRAGMENTS.some((fragment) => value.includes(fragment));
}

function truncateText(value: string, maxLength: number): string {
  const normalized = normalizeText(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}
