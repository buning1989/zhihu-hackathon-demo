(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.adapters = App.adapters || {};

  const defaultAvatar = () => App.mockData?.people?.[0]?.avatar || "";

  function normalizeNeedInput(needInput) {
    if (!needInput || !Array.isArray(needInput.questions)) {
      return null;
    }

    return {
      reason: String(needInput.reason || ""),
      questions: needInput.questions.slice(0, 3).map((question) => {
        const key = String(question.key || question.id || "");
        return {
          id: key,
          key,
          text: String(question.label || question.text || key || "补充一点信息"),
          options: normalizeOptions(question.options).slice(0, 5)
        };
      }).filter((question) => question.id && question.options.length > 0)
    };
  }

  function normalizeAgentResult(raw, context = {}) {
    const source = unwrapResult(raw);
    const result = source?.final_result
      ? normalizeProductionResult(source.final_result, context)
      : normalizeDisplayResult(source || {}, context);
    const degraded = Boolean(context.task?.degraded || source?.degraded || result.degraded);
    const degradedReason = context.task?.degradedReason || source?.degradedReason || result.degradedReason || null;
    const cacheHit = Boolean(context.task?.cacheHit || context.start?.cacheHit);
    const reused = Boolean(context.task?.reused || context.start?.reused);

    result.degraded = degraded;
    result.degradedReason = degradedReason;
    result.meta = {
      ...(result.meta || {}),
      taskId: context.task?.taskId || result.meta?.taskId || result.queryId,
      taskStatus: context.task?.status || result.meta?.taskStatus || "",
      degraded,
      degradedReason,
      cacheHit,
      reused,
      emptyResult: result.paths.length === 0 || result.people.length === 0
    };

    return result;
  }

  function normalizeDisplayResult(raw, context = {}) {
    const result = raw?.result && isRecord(raw.result) ? raw.result : raw;
    const queryId = stringOf(result.queryId || result.taskId || context.task?.taskId || raw?.taskId || `query-${Date.now()}`);
    const rawPeople = Array.isArray(result.people) ? result.people : [];
    const people = rawPeople.map((person, index) => normalizePerson(person, index));
    const paths = normalizePaths(Array.isArray(result.paths) ? result.paths : [], people, result);

    ensurePeoplePathIds(people, paths);

    return {
      schemaVersion: stringOf(result.schemaVersion || "frontend-agent-adapter-v1"),
      queryId,
      query: stringOf(result.query || context.query || ""),
      dataMode: stringOf(result.dataMode || result.meta?.mode || "agent"),
      contextUsed: result.contextUsed || {},
      features: result.features || {},
      analysis: normalizeAnalysis(result.analysis, result.summary),
      paths,
      people,
      personas: Array.isArray(result.personas) ? result.personas : [],
      sections: Array.isArray(result.sections) ? result.sections : [],
      meta: isRecord(result.meta) ? { ...result.meta } : {},
      sourceRefs: result.sourceRefs || result.sources || [],
      evidenceMap: result.evidenceMap || {}
    };
  }

  function normalizeProductionResult(finalResult, context = {}) {
    const sources = Array.isArray(finalResult.sources) ? finalResult.sources : [];
    const evidenceMap = isRecord(finalResult.evidenceMap) ? finalResult.evidenceMap : {};
    const personas = Array.isArray(finalResult.personas) ? finalResult.personas : [];
    const paths = Array.isArray(finalResult.paths) ? finalResult.paths : [];
    const sourceByCandidateId = new Map(sources.map((source) => [stringOf(source.sourceCandidateId), source]));

    const people = personas.map((persona, index) => {
      const evidenceItems = collectEvidenceItems(persona.sourceRefs, evidenceMap);
      const source = sourceByCandidateId.get(stringOf(persona.sourceRefs?.[0]?.sourceCandidateId)) || sources[index] || {};
      const article = normalizeArticle({
        title: source.title || persona.displayLabel,
        author: source.author || persona.displayLabel,
        sourceUrl: source.url,
        summary: persona.summary,
        evidence: evidenceItems.map((item) => ({
          id: item.id,
          label: item.reason || item.supportType || "证据片段",
          text: item.evidenceText || item.excerpt || item.normalizedClaim || "",
          sourceUrl: item.sourceUrl || source.url || ""
        })),
        body: evidenceItems.map((item) => item.evidenceText || item.excerpt || item.normalizedClaim).filter(Boolean)
      }, index);

      return normalizePerson({
        id: persona.id || `persona_${index + 1}`,
        name: persona.displayLabel || source.author || `公开样本 ${index + 1}`,
        pathId: findPathIdForPersona(paths, persona),
        avatar: defaultAvatar(),
        experienceSummary: persona.summary,
        oneLine: persona.summary,
        sourceRefs: persona.sourceRefs,
        evidenceIds: evidenceItems.map((item) => item.id),
        aiPersona: {
          enabled: Boolean(persona.chatEnabled),
          canChat: Boolean(persona.chatEnabled),
          personaId: persona.id,
          boundary: persona.boundary || "基于知乎公开内容整理，不代表作者本人。"
        },
        articles: [article]
      }, index);
    });

    const displayPaths = paths
      .filter((path) => hasSourceRefs(path.sourceRefs))
      .map((path, index) => normalizePath({
        ...path,
        personRefs: people
          .filter((person) => person.pathId === path.id)
          .map((person) => person.id),
        representativeQuote: firstEvidenceText(path.sourceRefs, evidenceMap)
      }, people, index, false));

    return {
      schemaVersion: "frontend-agent-production-v1",
      queryId: stringOf(finalResult.taskId || context.task?.taskId || `query-${Date.now()}`),
      query: stringOf(context.query || ""),
      dataMode: "agent",
      contextUsed: {},
      features: {
        aiPersona: false,
        personaChat: "off",
        sourceEvidenceRequired: true
      },
      analysis: normalizeAnalysis(null, finalResult.summary),
      paths: displayPaths,
      people,
      personas,
      sections: [],
      meta: {
        taskId: finalResult.taskId,
        generatedAt: finalResult.meta?.generatedAt || new Date().toISOString(),
        sourcePolicy: "AI 只负责组织公开内容与证据，不作为事实来源。"
      },
      sourceRefs: sources,
      evidenceMap,
      degraded: Boolean(finalResult.degraded),
      degradedReason: finalResult.degradedReason || null
    };
  }

  function normalizeAnalysis(analysis, summary) {
    if (isRecord(analysis)) {
      return {
        ...analysis,
        title: stringOf(analysis.title || analysis.summary || summary || "已整理出可对照的公开样本"),
        summary: stringOf(analysis.summary || summary || analysis.title || "")
      };
    }

    return {
      title: stringOf(summary || "已整理出可对照的公开样本"),
      summary: stringOf(summary || ""),
      steps: [],
      focusTags: [],
      openQuestions: []
    };
  }

  function normalizePaths(paths, people, result) {
    const isMock = stringOf(result.schemaVersion).includes("frontend-v2-mock") || result.dataMode === "mock";
    return paths
      .map((path, index) => normalizePath(path, people, index, isMock))
      .filter((path) => isMock || path.sourceRefs.length > 0 || path.evidenceIds.length > 0);
  }

  function normalizePath(path, people, index, isMock) {
    const id = stringOf(path.id || `path_${index + 1}`);
    const personRefs = normalizeStringArray(path.personRefs || path.peopleIds);
    const linkedPeople = people.filter((person) => person.pathId === id || personRefs.includes(person.id));
    const sourceRefs = Array.isArray(path.sourceRefs) ? path.sourceRefs : [];
    const evidenceIds = normalizeStringArray(path.evidenceIds);
    const title = stringOf(path.title || path.name || `路径 ${index + 1}`);
    const summary = stringOf(path.summary || path.desc || path.short || "");
    const quote = stringOf(
      path.representativeQuote ||
      linkedPeople[0]?.source?.evidence ||
      linkedPeople[0]?.article?.lead ||
      summary
    );

    return {
      ...path,
      id,
      title,
      shortTitle: stringOf(path.shortTitle || path.displayLabel || title).slice(0, 18),
      summary,
      whyRelevant: stringOf(path.whyRelevant || path.fitReason || summary),
      representativeQuote: isMock || sourceRefs.length || evidenceIds.length || linkedPeople.length ? quote : "",
      personRefs: personRefs.length ? personRefs : linkedPeople.map((person) => person.id),
      peopleIds: personRefs.length ? personRefs : linkedPeople.map((person) => person.id),
      evidenceIds,
      sourceRefs,
      isWeaklyGrounded: !isMock && sourceRefs.length === 0 && evidenceIds.length === 0
    };
  }

  function normalizePerson(person, index) {
    const article = normalizeArticle(Array.isArray(person.articles) ? person.articles[0] : person.article, index);
    const source = normalizeSource(person.source, article, person);
    const id = stringOf(person.id || person.personId || `person_${index + 1}`);
    const name = stringOf(person.name || person.displayName || person.displayLabel || article.author || "知乎用户");
    const experienceSummary = stringOf(
      person.experienceSummary ||
      person.oneLine ||
      person.lesson ||
      article.lead ||
      source.evidence ||
      "这条样本的公开证据有限，建议先查看来源片段。"
    );
    const aiPersona = normalizePersona(person.aiPersona, id);

    return {
      ...person,
      id,
      name,
      avatar: stringOf(person.avatar || article.avatar || defaultAvatar()),
      pathId: stringOf(person.pathId || ""),
      experienceSummary,
      source,
      article,
      aiPersona,
      displayCanChat: Boolean(aiPersona.enabled && aiPersona.canChat),
      chatDisabledReason: aiPersona.enabled ? "" : "当前证据不足，暂不开放追问。"
    };
  }

  function normalizeArticle(article, index) {
    const raw = isRecord(article) ? article : {};
    const evidence = Array.isArray(raw.evidence) ? raw.evidence : [];
    const paragraphs = normalizeParagraphs(raw.body || raw.paragraphs || raw.text || raw.summary);
    const firstEvidence = evidence.find((item) => stringOf(item.text || item.evidenceText));

    return {
      ...raw,
      id: stringOf(raw.id || `article_${index + 1}`),
      title: stringOf(raw.title || raw.sourceName || "知乎公开内容"),
      author: stringOf(raw.author || "知乎用户"),
      avatar: stringOf(raw.avatar || defaultAvatar()),
      lead: stringOf(raw.lead || raw.summary || raw.text || firstEvidence?.text || paragraphs[0] || ""),
      paragraphs: paragraphs.length ? paragraphs : [stringOf(raw.summary || firstEvidence?.text || "暂无更完整原文，只展示当前证据片段。")],
      sourceUrl: stringOf(raw.sourceUrl || raw.url || firstEvidence?.sourceUrl || ""),
      evidence
    };
  }

  function normalizeSource(source, article, person) {
    const raw = isRecord(source) ? source : {};
    const firstEvidence = Array.isArray(article.evidence) ? article.evidence[0] : null;
    return {
      title: stringOf(raw.title || article.title || person.badge || "知乎公开内容"),
      evidence: stringOf(raw.evidence || firstEvidence?.text || article.lead || person.oneLine || person.experienceSummary || ""),
      url: stringOf(raw.url || article.sourceUrl || firstEvidence?.sourceUrl || "")
    };
  }

  function normalizePersona(aiPersona, personId) {
    const raw = isRecord(aiPersona) ? aiPersona : {};
    return {
      ...raw,
      enabled: Boolean(raw.enabled || raw.canChat),
      canChat: Boolean(raw.canChat || raw.enabled),
      personaId: stringOf(raw.personaId || raw.id || `persona_${personId}`),
      boundary: stringOf(raw.boundary || raw.boundaryNotice || "基于知乎公开内容整理，不代表作者本人。"),
      suggestions: normalizeStringArray(raw.suggestions || raw.suggestedQuestions)
    };
  }

  function ensurePeoplePathIds(people, paths) {
    if (!paths.length) {
      return;
    }

    people.forEach((person, index) => {
      if (!person.pathId || !paths.some((path) => path.id === person.pathId)) {
        person.pathId = paths[index % paths.length]?.id || "";
      }
    });
  }

  function normalizeOptions(options) {
    if (!Array.isArray(options)) {
      return [];
    }

    return options.map((option) => {
      if (isRecord(option)) {
        const id = stringOf(option.id || option.value || option.label);
        return {
          id,
          label: stringOf(option.label || option.text || id)
        };
      }

      const text = stringOf(option);
      return {
        id: text,
        label: text
      };
    }).filter((option) => option.id && option.label);
  }

  function collectEvidenceItems(sourceRefs, evidenceMap) {
    if (!Array.isArray(sourceRefs)) {
      return [];
    }

    return sourceRefs.flatMap((ref) => normalizeStringArray(ref.evidenceItemIds)
      .map((id) => evidenceMap[id])
      .filter(isRecord));
  }

  function firstEvidenceText(sourceRefs, evidenceMap) {
    const item = collectEvidenceItems(sourceRefs, evidenceMap)[0];
    return stringOf(item?.evidenceText || item?.excerpt || item?.normalizedClaim || "");
  }

  function findPathIdForPersona(paths, persona) {
    const personaCandidateIds = new Set(
      (persona.sourceRefs || []).map((ref) => stringOf(ref.sourceCandidateId)).filter(Boolean)
    );
    const path = paths.find((item) =>
      (item.sourceRefs || []).some((ref) => personaCandidateIds.has(stringOf(ref.sourceCandidateId)))
    );
    return stringOf(path?.id || "");
  }

  function hasSourceRefs(sourceRefs) {
    return Array.isArray(sourceRefs) && sourceRefs.some((ref) =>
      stringOf(ref.sourceCandidateId) && Array.isArray(ref.evidenceItemIds) && ref.evidenceItemIds.length > 0
    );
  }

  function normalizeParagraphs(value) {
    if (Array.isArray(value)) {
      return value.map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (isRecord(item)) {
          return stringOf(item.content || item.text || item.value);
        }
        return "";
      }).filter(Boolean);
    }

    const text = stringOf(value);
    if (!text) {
      return [];
    }

    return text.split(/\n{2,}|。/).map((item) => item.trim()).filter(Boolean).slice(0, 6);
  }

  function unwrapResult(raw) {
    if (raw?.success === true && raw.data !== undefined) {
      return raw.data;
    }
    return raw;
  }

  function normalizeStringArray(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.map(stringOf).filter(Boolean);
  }

  function stringOf(value) {
    return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  }

  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  App.adapters.normalizeNeedInput = normalizeNeedInput;
  App.adapters.normalizeAgentResult = normalizeAgentResult;
})();
