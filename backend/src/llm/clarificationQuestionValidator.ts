import type {
  DemoClarificationCandidateQuestion,
  DemoClarificationKnownFact,
  DemoClarificationScoringDetail,
  DemoDebugRejectedClarificationQuestion,
  DemoDebugSelectedClarificationQuestion
} from "../types/demo.types.js";

export interface ClarificationValidationResult {
  accepted: DemoClarificationCandidateQuestion[];
  rejected: DemoDebugRejectedClarificationQuestion[];
}

export interface ClarificationScoringResult {
  selectedQuestions: DemoDebugSelectedClarificationQuestion[];
  scoringDetails: DemoClarificationScoringDetail[];
}

const FORBIDDEN_PATTERNS: Array<{
  reason: string;
  pattern: RegExp;
}> = [
  {
    reason: "content_preference_not_similarity_fact",
    pattern: /更想看|想看.*案例|想看.*样本|哪类样本|哪类真实经历|成功案例|失败复盘/
  },
  {
    reason: "value_preference_not_similarity_fact",
    pattern: /更看重|最吸引|更想要什么生活|更在意|稳定还是成长|优先满足什么|生活方式/
  },
  {
    reason: "future_prediction",
    pattern: /预计|预期|打算多久|多久做出结果|未来收入|收入是多少|能接受多久|承受多久|没有收入|没有稳定收入|求职空窗多久/
  },
  {
    reason: "risk_tolerance",
    pattern: /愿意承担|能不能接受失败|能接受失败|怕不怕|多大风险|冒险|后悔/
  },
  {
    reason: "generic_constraint_not_similarity_fact",
    pattern: /最大顾虑|最担心|最影响判断|最核心的约束|最大.*约束|现实约束是什么|最卡你|最困扰|压力主要来自/
  }
];

export function validateClarificationQuestions(
  candidates: DemoClarificationCandidateQuestion[],
  knownFacts: DemoClarificationKnownFact[]
): ClarificationValidationResult {
  const knownSlots = buildKnownSlotSet(knownFacts);
  const accepted: DemoClarificationCandidateQuestion[] = [];
  const rejected: DemoDebugRejectedClarificationQuestion[] = [];
  const seenSlots = new Set<string>();

  for (const candidate of candidates) {
    const rejectionReason = readRejectionReason(candidate, knownSlots, seenSlots);
    if (rejectionReason) {
      rejected.push(toRejectedQuestion(candidate, rejectionReason));
      continue;
    }

    accepted.push({
      ...candidate,
      queryTokens: unique(candidate.queryTokens.map(normalizeToken))
    });
    for (const slot of expandSlotAliases(candidate.slot)) {
      seenSlots.add(slot);
    }
  }

  return {
    accepted,
    rejected
  };
}

export function scoreClarificationQuestions(
  candidates: DemoClarificationCandidateQuestion[],
  knownFacts: DemoClarificationKnownFact[],
  limit = 3
): ClarificationScoringResult {
  const knownSlots = buildKnownSlotSet(knownFacts);
  const scored = candidates.map((candidate) => {
    const penalties = scorePenalties(candidate, knownSlots);
    const targetRelevance = clampScore(candidate.targetRelevance ?? 0.65);
    const similarityPower = clampScore(candidate.similarityPower);
    const queryUtility = clampScore(candidate.queryUtility);
    const answerability = clampScore(candidate.answerability);
    const score = clampScore(
      similarityPower * 0.35 +
        queryUtility * 0.3 +
        answerability * 0.2 +
        targetRelevance * 0.15 -
        penalties.knownPenalty -
        penalties.futurePenalty -
        penalties.preferencePenalty
    );

    return {
      candidate,
      detail: {
        slot: candidate.slot,
        question: candidate.question,
        score,
        similarityPower,
        queryUtility,
        answerability,
        targetRelevance,
        knownPenalty: penalties.knownPenalty,
        futurePenalty: penalties.futurePenalty,
        preferencePenalty: penalties.preferencePenalty,
        selected: false
      } satisfies DemoClarificationScoringDetail
    };
  });

  const selected = scored
    .sort((left, right) => {
      if (right.detail.score !== left.detail.score) {
        return right.detail.score - left.detail.score;
      }

      return right.detail.queryUtility - left.detail.queryUtility;
    })
    .slice(0, limit);
  const selectedSlots = new Set(selected.map((item) => item.candidate.slot));
  const scoringDetails = scored.map((item) => ({
    ...item.detail,
    selected: selectedSlots.has(item.candidate.slot)
  }));

  return {
    selectedQuestions: selected.map(({ candidate, detail }) => ({
      slot: candidate.slot,
      question: candidate.question,
      selectedReason: candidate.whyUseful,
      queryTokens: candidate.queryTokens,
      score: detail.score
    })),
    scoringDetails
  };
}

function readRejectionReason(
  candidate: DemoClarificationCandidateQuestion,
  knownSlots: Set<string>,
  seenSlots: Set<string>
): string | null {
  const slotAliases = expandSlotAliases(candidate.slot);
  const text = [
    candidate.question,
    candidate.whyUseful,
    ...(candidate.options ?? []),
    ...(candidate.riskFlags ?? [])
  ].join(" ");

  if (!candidate.queryTokens?.map(normalizeToken).filter(Boolean).length) {
    return "no_query_utility";
  }

  if (
    slotAliases.some((slot) => knownSlots.has(slot)) ||
    slotAliases.some((slot) => seenSlots.has(slot))
  ) {
    return "duplicate_known_fact";
  }

  for (const rule of FORBIDDEN_PATTERNS) {
    if (rule.pattern.test(text)) {
      return rule.reason;
    }
  }

  if (candidate.riskFlags?.length) {
    const riskText = candidate.riskFlags.join(" ");
    for (const rule of FORBIDDEN_PATTERNS) {
      if (rule.pattern.test(riskText)) {
        return rule.reason;
      }
    }
  }

  return null;
}

function scorePenalties(
  candidate: DemoClarificationCandidateQuestion,
  knownSlots: Set<string>
): {
  knownPenalty: number;
  futurePenalty: number;
  preferencePenalty: number;
} {
  const slotAliases = expandSlotAliases(candidate.slot);
  const text = [candidate.question, candidate.whyUseful, ...candidate.options].join(" ");
  const knownPenalty = slotAliases.some((slot) => knownSlots.has(slot)) ? 0.5 : 0;
  const futurePenalty = /预计|预期|未来|能接受多久|承受多久|打算多久/.test(text) ? 0.4 : 0;
  const preferencePenalty = /更想看|更看重|更在意|最吸引|想看.*案例/.test(text) ? 0.4 : 0;

  return {
    knownPenalty,
    futurePenalty,
    preferencePenalty
  };
}

function toRejectedQuestion(
  candidate: DemoClarificationCandidateQuestion,
  reason: string
): DemoDebugRejectedClarificationQuestion {
  return {
    slot: candidate.slot,
    question: candidate.question,
    reason,
    queryTokens: candidate.queryTokens,
    riskFlags: candidate.riskFlags
  };
}

function normalizeSlot(value: string): string {
  return value.trim().toLowerCase();
}

function buildKnownSlotSet(knownFacts: DemoClarificationKnownFact[]): Set<string> {
  const knownSlots = new Set<string>();
  for (const fact of knownFacts) {
    for (const slot of expandSlotAliases(fact.slot, fact.value)) {
      knownSlots.add(slot);
    }
  }

  return knownSlots;
}

function expandSlotAliases(slot: string, value = ""): string[] {
  const normalizedSlot = normalizeSlot(slot);
  const normalizedValue = value.trim().toLowerCase();
  const aliases = new Set([normalizedSlot]);

  if (
    /education|degree|学历|教育/.test(normalizedSlot) ||
    /研究生|硕士|博士|本科|专科|应届|毕业|在读/.test(normalizedValue)
  ) {
    aliases.add("educationstage");
    aliases.add("degreestage");
    aliases.add("educationlevel");
    aliases.add("graduationstatus");
  }

  if (/major|专业/.test(normalizedSlot)) {
    aliases.add("major");
    aliases.add("majorbackground");
  }

  if (/role|岗位|function/.test(normalizedSlot)) {
    aliases.add("role");
    aliases.add("currentrole");
    aliases.add("targetfunction");
  }

  if (/industry|行业/.test(normalizedSlot)) {
    aliases.add("industry");
  }

  if (/schooltier|schoolbackground|学校/.test(normalizedSlot)) {
    aliases.add("schooltier");
    aliases.add("schoolbackground");
  }

  return [...aliases];
}

function normalizeToken(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.round(Math.min(Math.max(value, 0), 1) * 1000) / 1000;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
