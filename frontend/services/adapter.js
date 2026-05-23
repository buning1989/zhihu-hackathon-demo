(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.adapters = App.adapters || {};

  const productionSchemaVersions = new Set([
    "agent.production_final_result.v1",
    "agent.production_final_result.v2"
  ]);

  function normalizeNeedInput(needInput) {
    if (!needInput) {
      return null;
    }

    const cards = normalizeNeedInputCards(needInput.cards);
    const legacyQuestions = Array.isArray(needInput.questions) ? needInput.questions : [];
    const questions = cards.length
      ? cards.map((card) => ({
        id: card.id,
        key: card.id,
        title: card.title,
        text: card.question || card.title || "补充一点信息",
        type: card.type,
        options: card.options
      }))
      : legacyQuestions.slice(0, 3).map((question) => {
        const key = String(question.key || question.id || "");
        return {
          id: key,
          key,
          text: String(question.label || question.text || key || "补充一点信息"),
          type: String(question.type || "single_select"),
          options: normalizeOptions(question.options).slice(0, 5)
        };
      }).filter((question) => question.id && question.options.length > 0);

    if (questions.length === 0) {
      return null;
    }

    return {
      reason: String(needInput.reason || ""),
      cards,
      questions
    };
  }

  function normalizeAgentResult(raw, context = {}) {
    const source = unwrapResult(raw);
    const finalResult = readProductionFinalResult(source);
    const result = finalResult
      ? normalizeProductionResult(finalResult, context)
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
      emptyResult: result.paths.length === 0 && result.people.length === 0,
      emptyPaths: result.paths.length === 0,
      emptyPeople: result.people.length === 0
    };

    return result;
  }

  function isDisplayableAgentResult(result) {
    if (!result || typeof result !== "object") {
      return false;
    }

    if (Array.isArray(result.paths) && result.paths.length > 0) {
      return true;
    }

    if (Array.isArray(result.people) && result.people.length > 0) {
      return true;
    }

    return isRecord(result.evidenceMap) && Object.keys(result.evidenceMap).length > 0;
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
    const evidenceSamples = Array.isArray(finalResult.evidenceSamples) ? finalResult.evidenceSamples : [];
    const personas = Array.isArray(finalResult.personas) ? finalResult.personas : [];
    const rawPaths = Array.isArray(finalResult.paths) ? finalResult.paths : [];
    const sourceByCandidateId = new Map(sources.map((source) => [sourceCandidateIdOf(source), source]));
    const evidenceByCandidateId = groupEvidenceByCandidateId(evidenceMap);
    const displayPaths = rawPaths
      .filter((path) => hasProductionPathRefs(path, evidenceMap))
      .map((path, index) => normalizeProductionPath(path, index, evidenceMap));

    let people = evidenceSamples.length
      ? evidenceSamples.map((sample, index) => normalizeProductionEvidenceSample({
        sample,
        index,
        rawPaths,
        sourceByCandidateId,
        evidenceMap
      })).filter(Boolean)
      : [];

    if (people.length === 0) {
      people = personas.length
        ? personas.map((persona, index) => normalizeProductionPersona({
          persona,
          index,
          rawPaths,
          sources,
          sourceByCandidateId,
          evidenceMap
        })).filter(Boolean)
        : [];
    }

    if (people.length === 0) {
      people = sources
        .filter((source) => evidenceItemsForCandidate(sourceCandidateIdOf(source), evidenceByCandidateId).length > 0)
        .map((source, index) => normalizeEvidenceSample({
          source,
          index,
          rawPaths,
          evidenceItems: evidenceItemsForCandidate(sourceCandidateIdOf(source), evidenceByCandidateId)
        }));
    }

    const unmatchedPeople = [];
    people.forEach((person) => {
      if (!person.pathId || !displayPaths.some((path) => path.id === person.pathId)) {
        unmatchedPeople.push(person);
      }
    });

    if (unmatchedPeople.length > 0) {
      const fallbackPath = buildEvidenceFallbackPath({
        people: unmatchedPeople,
        evidenceMap,
        summary: finalResult.summary,
        hasBackendPaths: displayPaths.length > 0
      });
      displayPaths.push(fallbackPath);
      unmatchedPeople.forEach((person) => {
        person.pathId = fallbackPath.id;
      });
    }

    displayPaths.forEach((path) => {
      const linkedPeople = people.filter((person) => person.pathId === path.id);
      path.personRefs = linkedPeople.map((person) => person.id);
      path.peopleIds = path.personRefs;
    });

    return {
      schemaVersion: "frontend-agent-production-v1",
      queryId: stringOf(finalResult.taskId || context.task?.taskId || `query-${Date.now()}`),
      query: stringOf(finalResult.query || context.query || ""),
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
        sourcePolicy: "系统只负责组织公开内容与证据，不作为事实来源。",
        resultShape: "production_final_result",
        groundingReport: finalResult.groundingReport || null,
        suggestedQuestions: Array.isArray(finalResult.suggestedQuestions) ? finalResult.suggestedQuestions : [],
        warnings: Array.isArray(finalResult.warnings) ? finalResult.warnings : [],
        evidenceSampleCount: people.length,
        backendEvidenceSampleCount: evidenceSamples.length,
        sourceCount: sources.length,
        evidenceCount: Object.keys(evidenceMap).length,
        hasEvidenceSamples: evidenceSamples.length > 0 || people.length > 0,
        evidenceOnly: rawPaths.length === 0 && people.length > 0
      },
      sourceRefs: sources,
      evidenceMap,
      degraded: Boolean(finalResult.degraded),
      degradedReason: finalResult.degradedReason || null
    };
  }

  function normalizeProductionPath(path, index, evidenceMap) {
    const id = stringOf(path.id || `path_${index + 1}`);
    const sourceRefs = deriveProductionSourceRefs(path, evidenceMap);
    const quote = firstEvidenceText(sourceRefs, evidenceMap);
    const title = stringOf(path.title || `样本方向 ${index + 1}`);
    const summary = stringOf(path.summary || "");
    const whyRelevant = stringOf(path.angle || path.suitableContext || path.tradeoffs || summary);

    return {
      ...path,
      id,
      title,
      shortTitle: stringOf(path.shortTitle || path.displayLabel || title).slice(0, 18),
      summary,
      whyRelevant,
      representativeQuote: quote,
      sourceRefs,
      evidenceIds: normalizeStringArray(path.evidenceIds || sourceRefs.flatMap((sourceRef) => sourceRef.evidenceItemIds)),
      sourceIds: normalizeStringArray(path.sourceIds || sourceRefs.map((sourceRef) => sourceRef.sourceCandidateId)),
      confidence: numberOr(path.confidence, average(sourceRefs.flatMap((sourceRef) =>
        normalizeStringArray(sourceRef.evidenceItemIds).map((id) => evidenceMap[id]?.confidence)
      ).filter(isNumber))),
      personRefs: [],
      peopleIds: [],
      isProductionPath: true,
      isWeaklyGrounded: sourceRefs.length === 0
    };
  }

  function normalizeProductionEvidenceSample(input) {
    const sample = isRecord(input.sample) ? input.sample : {};
    const candidateId = stringOf(sample.sourceId || sample.sourceCandidateId);
    const evidenceItemId = stringOf(sample.evidenceId || sample.evidenceItemId);
    const evidenceItem = isRecord(input.evidenceMap[evidenceItemId]) ? input.evidenceMap[evidenceItemId] : {};
    const source = input.sourceByCandidateId.get(candidateId) || {};
    const sourceUrl = stringOf(sample.sourceUrl || source.url || evidenceItem.sourceUrl);
    const title = stringOf(sample.title || source.title || evidenceItem.title || "知乎公开内容");
    const author = stringOf(sample.author || source.author || evidenceItem.author || "知乎公开样本");
    const quote = stringOf(sample.snippet || evidenceDisplayText(evidenceItem) || source.excerpt || "");
    const summary = stringOf(sample.whyRelevant || evidenceClaimText(evidenceItem) || quote);
    const evidenceIds = evidenceItemId ? [evidenceItemId] : [];
    const sourceRefs = candidateId && evidenceIds.length
      ? [{ sourceCandidateId: candidateId, evidenceItemIds: evidenceIds }]
      : [];
    const articleEvidence = {
      id: evidenceItemId || stringOf(sample.id),
      label: stringOf(sample.evidenceType || sample.sampleType || evidenceItem.supportType || "证据片段"),
      text: quote,
      sourceUrl
    };
    const paragraphs = normalizeParagraphs([quote, summary].filter(Boolean));

    if (!quote && !summary) {
      return null;
    }

    return {
      id: stringOf(sample.id || `sample_${candidateId || input.index + 1}`),
      name: author,
      displayName: author,
      sampleType: stringOf(sample.evidenceType || sample.sampleType || "evidence"),
      evidenceType: stringOf(sample.evidenceType || sample.sampleType || ""),
      isProductionSample: true,
      pathId: findPathIdForCandidate(input.rawPaths, candidateId),
      avatar: "",
      role: "知乎公开内容样本",
      badge: title,
      displayTier: input.index < 3 ? "core" : "supplement",
      evidenceStatus: "llm_extracted",
      evidenceIds,
      sourceRefs,
      confidence: numberOr(sample.confidence, numberOr(evidenceItem.confidence, numberOr(source.qualityScore, 0))),
      representativeQuote: quote,
      experienceSummary: summary || quote,
      oneLine: summary || quote,
      angle: stringOf(sample.angle || sample.evidenceType || sample.sampleType || ""),
      source: {
        title,
        evidence: quote || summary,
        url: sourceUrl
      },
      article: {
        id: `article_${candidateId || stringOf(sample.id || input.index + 1)}`,
        title,
        author,
        sourceName: "知乎公开内容",
        sourceUrl,
        lead: quote || summary,
        summary: summary || quote,
        paragraphs,
        evidence: [articleEvidence]
      },
      timeline: [],
      aiPersona: {
        enabled: false,
        canChat: false,
        personaId: "",
        boundary: "基于知乎公开内容整理，不代表作者本人。",
        suggestions: []
      },
      displayCanChat: false,
      chatDisabledReason: "当前只展示来源片段，不开放对话。"
    };
  }

  function normalizeProductionPersona(input) {
    const sourceRefs = normalizeProductionSourceRefs(input.persona.sourceRefs);
    const evidenceItems = collectEvidenceItems(sourceRefs, input.evidenceMap);
    const source = firstSourceForRefs(sourceRefs, input.sourceByCandidateId) || input.sources[input.index] || {};
    const sourceUrl = stringOf(source.url || evidenceItems[0]?.sourceUrl);
    const title = stringOf(source.title || evidenceItems[0]?.title || input.persona.displayLabel || "知乎公开内容");
    const quote = evidenceDisplayText(evidenceItems[0]) || stringOf(input.persona.summary || source.excerpt || "");
    const summary = stringOf(input.persona.summary || evidenceClaimText(evidenceItems[0]) || source.excerpt || quote);
    const name = stringOf(input.persona.displayLabel || source.author || "知乎公开样本");

    if (!summary && !quote) {
      return null;
    }

    return {
      id: stringOf(input.persona.id || `persona_${input.index + 1}`),
      name,
      displayName: name,
      sampleType: "persona",
      isProductionSample: true,
      pathId: findPathIdForSourceRefs(input.rawPaths, sourceRefs),
      avatar: "",
      role: "知乎公开内容样本",
      badge: title,
      displayTier: "core",
      evidenceStatus: "llm_extracted",
      evidenceIds: evidenceItems.map((item) => item.id),
      sourceRefs,
      confidence: numberOr(input.persona.confidence, evidenceItems[0]?.confidence || 0),
      representativeQuote: quote,
      experienceSummary: summary,
      oneLine: summary,
      source: {
        title,
        evidence: quote || summary,
        url: sourceUrl
      },
      article: {
        id: `article_${stringOf(input.persona.id || input.index + 1)}`,
        title,
        author: stringOf(source.author || name),
        sourceName: "知乎公开内容",
        sourceUrl,
        lead: quote || summary,
        summary,
        paragraphs: [],
        evidence: evidenceItems.map(toArticleEvidence)
      },
      timeline: [],
      aiPersona: {
        enabled: false,
        canChat: false,
        backendChatEnabled: Boolean(input.persona.chatEnabled && sourceRefs.length > 0),
        personaId: stringOf(input.persona.id || `persona_${input.index + 1}`),
        boundary: stringOf(input.persona.boundary || "基于知乎公开内容整理，不代表作者本人。"),
        suggestions: []
      },
      displayCanChat: false,
      chatDisabledReason: "当前只展示来源片段，不开放对话。"
    };
  }

  function normalizeEvidenceSample(input) {
    const candidateId = sourceCandidateIdOf(input.source);
    const evidenceItems = input.evidenceItems;
    const firstEvidence = evidenceItems[0] || {};
    const evidenceIds = evidenceItems.map((item) => item.id).filter(Boolean);
    const sourceRefs = candidateId && evidenceIds.length
      ? [{ sourceCandidateId: candidateId, evidenceItemIds: evidenceIds }]
      : [];
    const title = stringOf(input.source.title || firstEvidence.title || "知乎公开内容");
    const sourceUrl = stringOf(input.source.url || firstEvidence.sourceUrl);
    const quote = evidenceDisplayText(firstEvidence) || stringOf(input.source.excerpt || "");
    const summary = evidenceClaimText(firstEvidence) || quote || stringOf(input.source.excerpt || "");
    const author = stringOf(input.source.author || firstEvidence.author || "知乎公开样本");

    return {
      id: `sample_${candidateId || input.index + 1}`,
      name: author,
      displayName: author,
      sampleType: "evidence",
      isProductionSample: true,
      pathId: findPathIdForCandidate(input.rawPaths, candidateId),
      avatar: "",
      role: "知乎公开内容样本",
      badge: title,
      displayTier: "supplement",
      evidenceStatus: "llm_extracted",
      evidenceIds,
      sourceRefs,
      confidence: numberOr(firstEvidence.confidence, numberOr(input.source.qualityScore, 0)),
      representativeQuote: quote,
      experienceSummary: summary || "这条来源只有片段证据，适合回到来源核对。",
      oneLine: summary || quote,
      source: {
        title,
        evidence: quote || summary,
        url: sourceUrl
      },
      article: {
        id: `article_${candidateId || input.index + 1}`,
        title,
        author,
        sourceName: "知乎公开内容",
        sourceUrl,
        lead: quote || summary,
        summary: summary || quote,
        paragraphs: [],
        evidence: evidenceItems.map(toArticleEvidence)
      },
      timeline: [],
      aiPersona: {
        enabled: false,
        canChat: false,
        personaId: "",
        boundary: "基于知乎公开内容整理，不代表作者本人。",
        suggestions: []
      },
      displayCanChat: false,
      chatDisabledReason: "当前只展示来源片段，不开放对话。"
    };
  }

  function buildEvidenceFallbackPath(input) {
    const sourceRefs = input.people.flatMap((person) => person.sourceRefs || []);
    const quote = firstEvidenceText(sourceRefs, input.evidenceMap);
    const title = input.hasBackendPaths ? "其他可追溯来源片段" : "来源片段（暂未形成样本方向）";
    const summary = input.hasBackendPaths
      ? "这些来源有可追溯证据，但没有被归入某个样本方向。"
      : "证据不足，暂时没有可展示样本方向；下面只展示可追溯的来源片段。";

    return {
      id: input.hasBackendPaths ? "production_extra_evidence_samples" : "production_evidence_samples",
      title,
      shortTitle: input.hasBackendPaths ? "其他来源" : "来源片段",
      summary: summary || stringOf(input.summary),
      whyRelevant: summary,
      representativeQuote: quote,
      sourceRefs,
      evidenceIds: sourceRefs.flatMap((sourceRef) => normalizeStringArray(sourceRef.evidenceItemIds)),
      confidence: average(input.people.map((person) => person.confidence).filter(isNumber)),
      personRefs: [],
      peopleIds: [],
      isProductionPath: true,
      isEvidenceFallbackPath: true,
      isWeaklyGrounded: false
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
    const title = stringOf(path.title || path.name || `样本方向 ${index + 1}`);
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
      "这条样本目前只有较短公开内容，适合先查看来源片段。"
    );
    const aiPersona = normalizePersona(person.aiPersona, id);

    return {
      ...person,
      id,
      name,
      avatar: stringOf(person.avatar || article.avatar || ""),
      pathId: stringOf(person.pathId || ""),
      experienceSummary,
      source,
      article,
      aiPersona,
      displayCanChat: Boolean(aiPersona.enabled && aiPersona.canChat),
      chatDisabledReason: aiPersona.enabled ? "" : "当前只展示来源片段，不开放对话。"
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
      avatar: stringOf(raw.avatar || ""),
      lead: stringOf(raw.lead || raw.summary || raw.text || firstEvidence?.text || paragraphs[0] || ""),
      paragraphs: paragraphs.length ? paragraphs : [stringOf(raw.summary || firstEvidence?.text || "当前只展示可追溯公开内容片段。")],
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

  function readProductionFinalResult(source) {
    if (productionSchemaVersions.has(source?.final_result?.schemaVersion)) {
      return source.final_result;
    }

    if (productionSchemaVersions.has(source?.schemaVersion)) {
      return source;
    }

    return null;
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
          label: stringOf(option.label || option.text || id),
          refineHint: stringOf(option.refineHint || option.hint || option.label || id)
        };
      }

      const text = stringOf(option);
      return {
        id: text,
        label: text,
        refineHint: text
      };
    }).filter((option) => option.id && option.label);
  }

  function normalizeNeedInputCards(cards) {
    if (!Array.isArray(cards)) {
      return [];
    }

    return cards.slice(0, 3).map((card) => {
      if (!isRecord(card)) {
        return null;
      }

      const id = stringOf(card.id || card.key || card.title);
      const title = stringOf(card.title || card.question || "补充一点信息");
      const question = stringOf(card.question || card.label || title);
      const type = stringOf(card.type || "single_choice");
      const options = normalizeOptions(card.options).map((option) => ({
        ...option,
        refineHint: stringOf(option.refineHint || option.label)
      }));

      return {
        id,
        title,
        question,
        type,
        options
      };
    }).filter((card) => card && card.id && card.options.length > 0);
  }

  function groupEvidenceByCandidateId(evidenceMap) {
    const result = new Map();
    Object.values(evidenceMap).filter(isRecord).forEach((item) => {
      const candidateId = stringOf(item.sourceCandidateId || item.candidateId);
      if (!candidateId) {
        return;
      }
      const group = result.get(candidateId) || [];
      group.push(item);
      result.set(candidateId, group);
    });
    return result;
  }

  function evidenceItemsForCandidate(candidateId, evidenceByCandidateId) {
    return candidateId ? evidenceByCandidateId.get(candidateId) || [] : [];
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
    return evidenceDisplayText(item) || "";
  }

  function firstSourceForRefs(sourceRefs, sourceByCandidateId) {
    const firstCandidateId = sourceRefs.map((ref) => stringOf(ref.sourceCandidateId)).find(Boolean);
    return firstCandidateId ? sourceByCandidateId.get(firstCandidateId) : null;
  }

  function findPathIdForSourceRefs(paths, sourceRefs) {
    const candidateIds = new Set(sourceRefs.map((ref) => stringOf(ref.sourceCandidateId)).filter(Boolean));
    const path = paths.find((item) =>
      normalizeStringArray(item.sourceIds).some((sourceId) => candidateIds.has(sourceId)) ||
      (item.sourceRefs || []).some((ref) => candidateIds.has(stringOf(ref.sourceCandidateId)))
    );
    return stringOf(path?.id || "");
  }

  function findPathIdForCandidate(paths, candidateId) {
    if (!candidateId) {
      return "";
    }
    const path = paths.find((item) =>
      normalizeStringArray(item.sourceIds).includes(candidateId) ||
      (item.sourceRefs || []).some((ref) => stringOf(ref.sourceCandidateId) === candidateId)
    );
    return stringOf(path?.id || "");
  }

  function deriveProductionSourceRefs(path, evidenceMap) {
    const sourceRefs = normalizeProductionSourceRefs(path.sourceRefs);
    if (sourceRefs.length > 0) {
      return sourceRefs;
    }

    const sourceIds = normalizeStringArray(path.sourceIds);
    const evidenceIds = normalizeStringArray(path.evidenceIds);
    if (sourceIds.length === 0 || evidenceIds.length === 0) {
      return [];
    }

    return sourceIds.map((sourceId) => {
      const evidenceItemIds = evidenceIds.filter((evidenceId) =>
        stringOf(evidenceMap[evidenceId]?.sourceCandidateId || evidenceMap[evidenceId]?.sourceId) === sourceId
      );
      return {
        sourceCandidateId: sourceId,
        evidenceItemIds
      };
    }).filter((ref) => ref.sourceCandidateId && ref.evidenceItemIds.length > 0);
  }

  function normalizeProductionSourceRefs(sourceRefs) {
    if (!Array.isArray(sourceRefs)) {
      return [];
    }

    return sourceRefs.map((ref) => ({
      sourceCandidateId: stringOf(ref.sourceCandidateId),
      evidenceItemIds: normalizeStringArray(ref.evidenceItemIds)
    })).filter((ref) => ref.sourceCandidateId && ref.evidenceItemIds.length > 0);
  }

  function hasSourceRefs(sourceRefs) {
    return Array.isArray(sourceRefs) && sourceRefs.some((ref) =>
      stringOf(ref.sourceCandidateId) && Array.isArray(ref.evidenceItemIds) && ref.evidenceItemIds.length > 0
    );
  }

  function hasProductionPathRefs(path, evidenceMap) {
    return hasSourceRefs(path?.sourceRefs) || deriveProductionSourceRefs(path || {}, evidenceMap).length > 0;
  }

  function sourceCandidateIdOf(source) {
    return stringOf(source?.sourceCandidateId || source?.id);
  }

  function evidenceDisplayText(item) {
    return stringOf(item?.excerpt || item?.evidenceText || item?.normalizedClaim);
  }

  function evidenceClaimText(item) {
    return stringOf(item?.normalizedClaim || item?.reason || item?.excerpt || item?.evidenceText);
  }

  function toArticleEvidence(item) {
    return {
      id: stringOf(item.id),
      label: stringOf(item.reason || item.supportType || "证据片段"),
      text: evidenceDisplayText(item),
      sourceUrl: stringOf(item.sourceUrl)
    };
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

  function average(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  }

  function numberOr(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }

  function isNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function stringOf(value) {
    return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  }

  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  App.adapters.normalizeNeedInput = normalizeNeedInput;
  App.adapters.normalizeAgentResult = normalizeAgentResult;
  App.adapters.isDisplayableAgentResult = isDisplayableAgentResult;
})();
