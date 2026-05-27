import type {
  DemoContentRole,
  DemoPath,
  DemoSearchResponse,
  DemoSourceRef
} from "../types/demo.types.js";

interface QueryGroundingContext {
  focus: string;
  terms: string[];
  scenario: string;
}

export interface DemoPathGroundingResult {
  paths: DemoPath[];
  warnings: string[];
  removedPathIds: string[];
}

export interface DemoPathGroundingOptions {
  query: string;
  paths: DemoPath[];
  sourceTextByRef: Map<string, string>;
  minPathCount?: number;
}

const FORBIDDEN_TEMPLATE_FRAGMENTS = [
  "不上班后的真实日常",
  "过渡型路径：先解决现金流",
  "辞职后复盘",
  "待业中的拉扯",
  "有人先拉开距离",
  "有人把边界说清",
  "有人选择断联"
];

const PUBLIC_SIGNAL_BLOCKLIST = [
  "真实经历",
  "公开经验",
  "公开内容",
  "来源片段",
  "相关",
  "当前问题",
  "用户",
  "问题",
  "样本",
  "本地回放",
  "fixture",
  "非真实召回"
];

export function groundDemoPaths(options: DemoPathGroundingOptions): DemoPathGroundingResult {
  const context = buildQueryGroundingContext(options.query);
  const warnings: string[] = [];
  const removedPathIds: string[] = [];
  const grounded: DemoPath[] = [];

  for (const path of options.paths) {
    const result = groundSinglePath(path, context, options.sourceTextByRef, options.query);
    if (result.path) {
      grounded.push(result.path);
    } else {
      removedPathIds.push(path.id);
    }

    warnings.push(...result.warnings);
  }

  const minPathCount = options.minPathCount ?? 1;
  if (grounded.length === 0 && minPathCount > 0 && options.paths[0]?.sourceRefs.length > 0) {
    const fallback = forceGroundSinglePath(
      options.paths[0],
      context,
      options.sourceTextByRef,
      options.query
    );
    grounded.push(fallback.path);
    warnings.push(...fallback.warnings);
    removedPathIds.splice(removedPathIds.indexOf(options.paths[0].id), 1);
  }

  return {
    paths: grounded,
    warnings,
    removedPathIds
  };
}

export function applyGroundedPathCopyToResponse(
  response: DemoSearchResponse,
  query: string
): string[] {
  const experienceWarnings = enforceExperienceSourcesForNonViewpointPaths(response);
  const sourceTextByRef = buildSourceTextByRef(response);
  const result = groundDemoPaths({
    query,
    paths: response.paths,
    sourceTextByRef,
    minPathCount: 1
  });
  const removed = new Set(result.removedPathIds);

  response.paths = result.paths;
  if (removed.size > 0 && response.paths.length > 0) {
    for (const person of response.people) {
      if (!removed.has(person.pathId)) {
        const currentPath = response.paths.find((path) => path.id === person.pathId);
        if (currentPath) {
          person.matchedPathTitle = currentPath.title;
        }
        continue;
      }

      const replacement =
        response.paths.find((path) =>
          path.sourceRefs.some((sourceRef) => person.sourceRefs.includes(sourceRef))
        ) ?? response.paths[0];
      person.pathId = replacement.id;
      person.matchedPathTitle = replacement.title;
    }
  }

  for (const person of response.people) {
    const path = response.paths.find((item) => item.id === person.pathId);
    if (path) {
      person.matchedPathTitle = path.title;
    }
  }

  return [...experienceWarnings, ...result.warnings];
}

function enforceExperienceSourcesForNonViewpointPaths(response: DemoSearchResponse): string[] {
  const warnings: string[] = [];
  const experiencePeople = response.people.filter((person) => person.sampleType === "experience_sample");
  const experienceSourceRefs = new Set(experiencePeople.flatMap((person) => person.sourceRefs));
  const experiencePersonIds = new Set(experiencePeople.map((person) => person.id));
  const evidenceIdsBySourceRef = new Map(response.meta.sourceRefs.map((sourceRef) => [
    sourceRef.id,
    sourceRef.evidenceIds
  ]));

  for (const path of response.paths) {
    const role = readContentRole(path.contentRole ?? stanceToContentRole(path.stance));
    if (role === "viewpoint") {
      path.stance = "viewpoint";
      path.personRefs = [];
      continue;
    }

    path.stance = role === "decision_conflict" ? "mixed" : "experience";
    const before = path.sourceRefs.length;
    path.sourceRefs = path.sourceRefs.filter((sourceRef) => experienceSourceRefs.has(sourceRef));
    path.personRefs = (path.personRefs ?? []).filter((personRef) => experiencePersonIds.has(personRef));

    const allowedEvidenceIds = new Set(
      path.sourceRefs.flatMap((sourceRef) => evidenceIdsBySourceRef.get(sourceRef) ?? [])
    );
    path.evidenceIds = path.evidenceIds.filter((evidenceId) => allowedEvidenceIds.has(evidenceId));
    if (path.evidenceIds.length === 0) {
      path.evidenceIds = Array.from(allowedEvidenceIds);
    }

    if (path.sourceRefs.length < before) {
      warnings.push(`path_grounding_removed_non_experience_sources:${path.id}`);
    }
  }

  return warnings;
}

export function buildSourceTextByRefFromItems(
  items: Array<{
    sourceRef: DemoSourceRef;
    title?: string;
    text?: string;
    evidenceText?: string;
    summary?: string;
  }>
): Map<string, string> {
  const result = new Map<string, string>();
  for (const item of items) {
    result.set(
      item.sourceRef.id,
      normalizeText([
        item.sourceRef.title,
        item.sourceRef.author,
        item.title,
        item.evidenceText,
        item.text,
        item.summary
      ].filter(Boolean).join("\n"))
    );
  }

  return result;
}

export function isTemplatePathText(value: string): boolean {
  return FORBIDDEN_TEMPLATE_FRAGMENTS.some((fragment) => value.includes(fragment));
}

function groundSinglePath(
  path: DemoPath,
  context: QueryGroundingContext,
  sourceTextByRef: Map<string, string>,
  query: string
): { path?: DemoPath; warnings: string[] } {
  const warnings: string[] = [];
  if (path.sourceRefs.length === 0) {
    return {
      warnings: [`path_grounding_removed_missing_source_refs:${path.id}`]
    };
  }

  const sourceText = getPathSourceText(path, sourceTextByRef);
  const supportSignals = selectGroundedSignals(context, path, sourceText);
  if (supportSignals.length === 0) {
    return {
      warnings: [`path_grounding_removed_unsupported:${path.id}`]
    };
  }

  if (isTemplatePathText([path.title, path.summary, path.displayLabel ?? ""].join(" "))) {
    warnings.push(`path_grounding_rewrote_template:${path.id}`);
  }

  const copy = buildGroundedCopy(path, context, supportSignals, sourceText, query);
  return {
    path: {
      ...path,
      title: copy.title,
      summary: copy.summary,
      whyRelevant: copy.whyRelevant,
      tradeoff: copy.tradeoff,
      displayLabel: copy.title,
      displayTradeoff: copy.tradeoff
    },
    warnings
  };
}

function forceGroundSinglePath(
  path: DemoPath,
  context: QueryGroundingContext,
  sourceTextByRef: Map<string, string>,
  query: string
): { path: DemoPath; warnings: string[] } {
  const sourceText = getPathSourceText(path, sourceTextByRef);
  const supportSignals =
    selectGroundedSignals(context, path, sourceText).length > 0
      ? selectGroundedSignals(context, path, sourceText)
      : selectFallbackSignals(path, sourceText, context);
  const copy = buildGroundedCopy(path, context, supportSignals, sourceText, query);

  return {
    path: {
      ...path,
      title: copy.title,
      summary: copy.summary,
      whyRelevant: copy.whyRelevant,
      tradeoff: copy.tradeoff,
      displayLabel: copy.title,
      displayTradeoff: copy.tradeoff
    },
    warnings: [`path_grounding_forced_minimum_path:${path.id}`]
  };
}

function buildGroundedCopy(
  path: DemoPath,
  context: QueryGroundingContext,
  supportSignals: string[],
  sourceText: string,
  query: string
): {
  title: string;
  summary: string;
  whyRelevant: string;
  tradeoff: string;
} {
  const role = readContentRole(path.contentRole ?? stanceToContentRole(path.stance));
  const signal = supportSignals[0] ?? context.focus;
  const secondSignal = supportSignals.find((item) => item !== signal);
  const evidencePhrase = selectEvidencePhrase(sourceText, [...context.terms, ...supportSignals]);
  const signalPhrase = secondSignal ? `${signal}、${secondSignal}` : signal;
  const roleLabel = roleToDisplayLabel(role);
  const title = truncateText(`「${context.focus}」的${roleLabel}：${signalPhrase}`, 46);
  const summary = role === "viewpoint"
    ? truncateText(
        `这些来源把「${context.focus}」落在${signalPhrase}上；可追溯片段集中在「${evidencePhrase}」，所以这里只作为观点参考。`,
        150
      )
    : truncateText(
        `可追溯经历片段直接写到「${evidencePhrase}」。这条路径只保留这些来源里能看到具体过程的${context.focus}样本。`,
        150
      );
  const whyRelevant = truncateText(
    `它回应「${truncateText(query, 30)}」里关于${context.focus}的具体卡点，支撑线索来自${signalPhrase}。`,
    120
  );
  const tradeoff = truncateText(
    `它只能说明这些来源里的${signalPhrase}，不能外推成普遍结论；仍要回到原文核对过程和结果。`,
    120
  );

  return {
    title,
    summary,
    whyRelevant,
    tradeoff
  };
}

function buildQueryGroundingContext(query: string): QueryGroundingContext {
  const normalized = normalizeText(query);
  if (/异地恋|长期异地|远距离恋爱/.test(normalized) && /工作|职业|事业|想做的事|追求/.test(normalized)) {
    return {
      focus: "工作与长期异地恋",
      scenario: "relationship_work",
      terms: [
        "异地恋",
        "长期异地",
        "工作",
        "职业",
        "事业",
        "想做的事",
        "追求",
        "见面",
        "团聚",
        "城市",
        "距离",
        "伴侣",
        "恋爱"
      ]
    };
  }

  if (/异地恋|长期异地|远距离恋爱/.test(normalized)) {
    return {
      focus: "长期异地恋",
      scenario: "relationship",
      terms: ["异地恋", "长期异地", "恋爱", "伴侣", "见面", "距离", "团聚", "城市", "值得", "坚持"]
    };
  }

  if (/转行|转岗|换行业|转产品/.test(normalized) && /产品经理|产品岗|PM/i.test(normalized)) {
    return {
      focus: "转行做产品经理",
      scenario: "product_manager_transition",
      terms: ["转行", "转岗", "产品经理", "产品岗", "PM", "门槛", "能力", "项目", "岗位", "现实"]
    };
  }

  if (/毕业|大城市|一线城市|回老家|老家|家乡/.test(normalized) && /大城市|一线城市|回老家|老家|家乡/.test(normalized)) {
    return {
      focus: "大城市还是回老家",
      scenario: "city_home",
      terms: ["毕业", "大城市", "一线城市", "城市", "回老家", "老家", "家乡", "机会", "成本", "选择"]
    };
  }

  if (/裸辞/.test(normalized)) {
    return {
      focus: "裸辞之后",
      scenario: "resign_after",
      terms: ["裸辞", "辞职", "离职", "后来", "后悔", "现金流", "节奏", "回到职场", "空窗"]
    };
  }

  if (/不工作|不上班|待业|失业/.test(normalized)) {
    return {
      focus: "不工作",
      scenario: "stop_work",
      terms: ["不工作", "不上班", "待业", "失业", "暂停工作", "工作", "生活", "现金流", "预算", "副业", "去哪"]
    };
  }

  if (/三十岁|30岁|重新开始/.test(normalized)) {
    return {
      focus: "三十岁重新开始",
      scenario: "restart_30",
      terms: ["三十岁", "30岁", "重新开始", "年龄", "转行", "学习", "现实", "试错", "收入"]
    };
  }

  if (/稳定|安稳|体制内|铁饭碗/.test(normalized) && /喜欢|热爱|兴趣|梦想|想做的事|追求/.test(normalized)) {
    return {
      focus: "稳定和喜欢的事",
      scenario: "stability_passion",
      terms: ["稳定", "稳定工作", "稳定收入", "喜欢的事", "热爱", "兴趣", "梦想", "放弃", "取舍", "后悔"]
    };
  }

  const focus = extractFallbackFocus(normalized);
  return {
    focus,
    scenario: "generic",
    terms: unique([focus, ...splitSignalText(focus), ...splitSignalText(normalized)]).slice(0, 12)
  };
}

function selectGroundedSignals(
  context: QueryGroundingContext,
  path: DemoPath,
  sourceText: string
): string[] {
  const normalizedSource = normalizeText(sourceText);
  const pathSignals = splitSignalText([
    path.diversityKey ?? "",
    path.whyRelevant ?? "",
    path.fitReason ?? "",
    path.title,
    path.summary
  ].join(" "));
  const signals = unique([...context.terms, ...pathSignals])
    .map(normalizeSignal)
    .filter((signal) => isPublicSignal(signal) && normalizedSource.includes(signal));

  return signals.slice(0, 5);
}

function selectFallbackSignals(
  path: DemoPath,
  sourceText: string,
  context: QueryGroundingContext
): string[] {
  const sourceSignals = splitSignalText(sourceText)
    .map(normalizeSignal)
    .filter(isPublicSignal)
    .slice(0, 4);
  return unique([...sourceSignals, context.focus, ...(path.diversityKey ? [path.diversityKey] : [])])
    .filter(isPublicSignal)
    .slice(0, 3);
}

function selectEvidencePhrase(sourceText: string, keywords: string[]): string {
  const normalized = normalizeText(sourceText)
    .replace(/本地回放\s*fixture（非真实召回）。?/g, "")
    .replace(/本地回放\s*fixture\s*\(非真实召回\)。?/gi, "")
    .replace(/本地回放样本[:：]?/g, "");
  const sentences = splitSentences(normalized);
  const scored = sentences
    .map((sentence, index) => ({
      sentence,
      index,
      score: keywords.reduce((total, keyword) => total + (sentence.includes(keyword) ? 4 : 0), 0) +
        (/我|本人|自己|有人|后来|后面|结果|决定|选择|后悔|成本|代价|现实|收入|见面|城市|岗位|回了|三年|辛苦|压力|崩溃/.test(sentence) ? 8 : 0) -
        (/它和「|来源里出现|可追溯线索|知乎用户| - 知乎/.test(sentence) ? 10 : 0) -
        (/[?？]$/.test(sentence) && sentence.length <= 32 ? 8 : 0)
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = scored.find((item) => item.score > 0)?.sentence ?? sentences[0] ?? normalized;

  return truncateText(selected, 58);
}

function getPathSourceText(path: DemoPath, sourceTextByRef: Map<string, string>): string {
  return normalizeText(
    path.sourceRefs.map((sourceRef) => sourceTextByRef.get(sourceRef) ?? "").join("\n")
  );
}

function buildSourceTextByRef(response: DemoSearchResponse): Map<string, string> {
  const result = new Map<string, string>();
  for (const sourceRef of response.meta.sourceRefs) {
    result.set(sourceRef.id, normalizeText([sourceRef.title, sourceRef.author].join("\n")));
  }

  for (const person of response.people) {
    for (const article of person.articles) {
      const text = normalizeText([
        article.title,
        article.summary,
        article.text,
        article.evidenceText,
        article.evidence.map((item) => item.text).join("\n")
      ].join("\n"));
      for (const sourceRef of article.sourceRefs.length ? article.sourceRefs : person.sourceRefs) {
        result.set(sourceRef, normalizeText([result.get(sourceRef) ?? "", text].join("\n")));
      }
    }
  }

  return result;
}

function roleToDisplayLabel(role: DemoContentRole): string {
  if (role === "viewpoint") return "观点型参考";
  if (role === "failure_review") return "复盘样本";
  if (role === "decision_conflict") return "取舍样本";
  if (role === "alternative_solution") return "备选路径";
  if (role === "real_experience") return "经历样本";
  return "行动路径";
}

function stanceToContentRole(stance: DemoPath["stance"]): DemoContentRole {
  if (stance === "viewpoint") return "viewpoint";
  if (stance === "experience") return "real_experience";
  return "life_path";
}

function readContentRole(value: unknown): DemoContentRole {
  if (
    value === "real_experience" ||
    value === "life_path" ||
    value === "failure_review" ||
    value === "decision_conflict" ||
    value === "alternative_solution" ||
    value === "viewpoint"
  ) {
    return value;
  }

  return "viewpoint";
}

function extractFallbackFocus(query: string): string {
  const normalized = normalizeText(query)
    .replace(/[？?！!。,.，]/g, "")
    .replace(/^(我想知道|想问|请问|关于)/, "");
  if (normalized.length > 0 && normalized.length <= 14) {
    return normalized;
  }

  const signals = splitSignalText(normalized).filter(isPublicSignal);
  return truncateText(signals[0] ?? normalized ?? "当前问题", 14);
}

function splitSentences(text: string): string[] {
  const normalized = normalizeText(text);
  const matches = normalized.match(/[^。！？!?；;]+[。！？!?；;]?/g) ?? [normalized];
  return matches.map(normalizeText).filter((item) => item.length >= 6);
}

function splitSignalText(value: string): string[] {
  return normalizeText(value)
    .split(/[，。！？、,.!?\s/|:：；;（）()《》"“”]+/)
    .map(normalizeSignal)
    .filter(Boolean);
}

function normalizeSignal(value: string): string {
  return normalizeText(value)
    .replace(/(真实经历|失败复盘|怎么选|怎么办|后来怎么样|有哪些路径|怎么开始|还有什么选择)$/g, "")
    .trim();
}

function isPublicSignal(value: string): boolean {
  return Boolean(
    value.length >= 2 &&
      value.length <= 14 &&
      !PUBLIC_SIGNAL_BLOCKLIST.some((blocked) => value.includes(blocked)) &&
      !/roughTier|roughScore|diversityKey|contentRole|keepReason|used_as_core_evidence|规则兜底/i.test(value)
  );
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxLength: number): string {
  const normalized = normalizeText(text);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values.filter(Boolean)));
}
