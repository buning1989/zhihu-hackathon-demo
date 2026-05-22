(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});

  const avatarBase = "./assets/mirofish-character-svgs/";

  const paths = [
    {
      id: "path-reset",
      title: "先把工作降噪，再决定下一步",
      shortTitle: "工作降噪",
      summary: "适合还没有确定方向，但已经被原岗位耗空的人。先降低消耗，保留现金流和基本节奏，再观察真正想离开的是什么。",
      whyRelevant: "这些样本都没有把辞职当作第一步，而是先把生活里能控制的部分重新拿回来。",
      representativeQuote: "我不是突然找到热爱，是先把每天最痛的那一块拆小了。",
      peopleIds: ["person-ahe", "person-chengye"]
    },
    {
      id: "path-city",
      title: "把城市换成低成本试验场",
      shortTitle: "换个试验场",
      summary: "适合已经能远程或短期空档的人。用一个周期测试生活成本、社交密度、身体状态和工作边界。",
      whyRelevant: "路径里的原文都在讲迁移不是逃跑，而是用更小代价验证一种生活假设。",
      representativeQuote: "我给自己三个月，不负责证明一辈子，只负责看清一个季节。",
      peopleIds: ["person-linbai", "person-xiaolu"]
    },
    {
      id: "path-skill",
      title: "从技能和关系重新攒底气",
      shortTitle: "重新攒底气",
      summary: "适合暂时不能离开岗位，但想为未来选择做准备的人。重点不是马上转型，而是积累可迁移的作品、关系和试错记录。",
      whyRelevant: "这些内容更像长期路书，帮助你判断什么时候可以迈出下一步。",
      representativeQuote: "真正让我敢动的不是勇气，是我知道自己手里多了几张牌。",
      peopleIds: ["person-muyan", "person-qingzhou"]
    }
  ];

  const people = [
    {
      id: "person-ahe",
      pathId: "path-reset",
      name: "阿禾",
      avatar: `${avatarBase}openpeeps62.svg`,
      experienceSummary: "阿禾在连续加班后没有马上裸辞，而是先把项目边界、下班后的恢复时间和账本整理出来。两个月后，她发现自己最需要的不是换行业，而是换一种不会持续透支的协作关系。",
      source: {
        title: "Mock 知乎回答：我怎样从高压岗位里慢慢退一步",
        evidence: "来源片段提到她先记录每天最消耗的场景，再和主管确认交付边界。",
        url: "#"
      },
      article: {
        title: "从高压岗位里慢慢退一步",
        lead: "这篇 mock 原文记录了一个人在不确定是否辞职时，如何先找回生活的可控感。",
        paragraphs: [
          "我最开始以为答案只有辞职或继续忍。后来发现，真正让我崩掉的不是工作量本身，而是所有事情都没有边界。",
          "我做的第一件事是记账和记时。每天睡前写三行：今天最耗我的是什么，我能不能把它变成一个可讨论的问题，明天最小的修正是什么。",
          "那两个月没有戏剧性的转折，但我开始重新睡得着。等状态回来后，我才有力气判断，是岗位不合适，还是我一直在用错误的方式承担。"
        ]
      },
      aiPersona: {
        enabled: true,
        personaId: "persona-ahe",
        boundary: "这是基于知乎公开内容生成的经验回应，不代表作者本人。",
        suggestions: ["你当时怎么判断不是立刻辞职？", "怎么和主管谈边界？", "恢复状态用了多久？"]
      },
      chatReplies: [
        "按这段公开经历，关键不是一下子做大决定，而是先把最消耗人的场景具体化。能被写下来、拿出来谈的部分，才可能被改变。",
        "她的做法更像把生活重新校准：先保住睡眠、账本和交付边界，再决定要不要离开。",
        "如果你现在也很累，可以先选一个最小动作，比如连续三天记录下班后还在消耗你的具体事项。"
      ]
    },
    {
      id: "person-chengye",
      pathId: "path-reset",
      name: "程也",
      avatar: `${avatarBase}openpeeps76.svg`,
      experienceSummary: "程也曾把离职想象成唯一出口，后来先申请内部转组和短休。他的原文重点不是劝人留下，而是提醒自己在做决定前先恢复判断力。",
      source: {
        title: "Mock 知乎回答：决定离职前，我先让自己停下来",
        evidence: "来源片段写到短休、转组沟通和重新评估岗位消耗。",
        url: "#"
      },
      article: {
        title: "决定离职前，我先让自己停下来",
        lead: "这篇 mock 原文把一次离职冲动拆成了休息、沟通、试探和复盘。",
        paragraphs: [
          "我真正危险的时刻，是把所有问题都合并成一句话：我不想干了。",
          "后来我先请了五天假，不做职业规划，只睡觉、散步、把过去三个月让我失控的节点列出来。",
          "回来后我做了两件事：问是否可以转到节奏更稳定的项目，给自己设了一个月观察期。最后我还是离开了，但那是清醒后的决定，不是崩溃后的逃跑。"
        ]
      },
      aiPersona: {
        enabled: true,
        personaId: "persona-chengye",
        boundary: "这是基于知乎公开内容生成的经验回应，不代表作者本人。",
        suggestions: ["休息后怎么复盘？", "什么时候还是该离开？", "观察期怎么设？"]
      },
      chatReplies: [
        "这段经历里最有用的是把情绪高点和决策时刻分开。先休息，不等于放弃改变。",
        "他的观察期很短，只看几个具体信号：睡眠有没有回来，沟通是否有效，工作是否继续吞掉生活。",
        "如果一个月后信号都没有改善，离开就不再只是冲动，而是有证据支持的选择。"
      ]
    },
    {
      id: "person-linbai",
      pathId: "path-city",
      name: "林白",
      avatar: `${avatarBase}openpeeps88.svg`,
      experienceSummary: "林白把远程工作带到一个海边小城住了 90 天。他的重点是先做临时实验：预算、医疗、朋友距离、工作效率都可被记录，而不是一开始就把迁移包装成人生答案。",
      source: {
        title: "Mock 知乎回答：在小城住 90 天后，我知道自己要什么",
        evidence: "来源片段包含 90 天预算、远程工作节奏和回到大城市后的对比。",
        url: "#"
      },
      article: {
        title: "在小城住 90 天后，我知道自己要什么",
        lead: "这篇 mock 原文讲的是一次有边界的迁移实验。",
        paragraphs: [
          "我没有卖掉家具，也没有宣布人生重启。我只是租了三个月房，把每周工作时长、花销、身体状态和社交需求记下来。",
          "第一个月很新鲜，第二个月开始想朋友，第三个月才看见真实问题：我需要安静，但不能完全断掉同行交流。",
          "所以最后的答案不是永远住在小城，而是把城市选择变成可以来回调整的系统。"
        ]
      },
      aiPersona: {
        enabled: true,
        personaId: "persona-linbai",
        boundary: "这是基于知乎公开内容生成的经验回应，不代表作者本人。",
        suggestions: ["90 天要记录什么？", "小城最大的不适是什么？", "怎么判断要不要留下？"]
      },
      chatReplies: [
        "按公开内容看，他把迁移当成实验，而不是承诺。这样做能降低后悔成本。",
        "他记录的是很朴素的指标：钱、睡眠、工作效率、见朋友的频率，以及孤独感什么时候出现。",
        "如果你想试，可以先设一个期限和退出条件，让自己不用在第一天就回答一辈子的问题。"
      ]
    },
    {
      id: "person-xiaolu",
      pathId: "path-city",
      name: "小鹿",
      avatar: `${avatarBase}openpeeps75.svg`,
      experienceSummary: "小鹿去过三个城市短住，每次只验证一个问题：生活成本、行业机会或亲密关系。她的经历提醒人不要把换城市想成万能开关。",
      source: {
        title: "Mock 知乎回答：我试住过三个城市，才知道自己不是想逃",
        evidence: "来源片段记录三个城市分别承担的验证目标。",
        url: "#"
      },
      article: {
        title: "我试住过三个城市，才知道自己不是想逃",
        lead: "这篇 mock 原文把换城市拆成几个小实验。",
        paragraphs: [
          "第一座城市我只看生活成本，第二座城市我看行业机会，第三座城市我看自己在亲密关系里的距离感。",
          "以前我总觉得只要换地方，问题就会消失。后来发现，换地方只是把问题照得更清楚。",
          "真正有帮助的是每次只验证一件事。这样失败也不会变成人生失败，只是一个假设不成立。"
        ]
      },
      aiPersona: {
        enabled: true,
        personaId: "persona-xiaolu",
        boundary: "这是基于知乎公开内容生成的经验回应，不代表作者本人。",
        suggestions: ["怎么选择试住城市？", "怎么避免把换城市神化？", "失败时怎么收尾？"]
      },
      chatReplies: [
        "她的经验是每次只验证一个问题。验证太多，最后就会变成情绪旅行，很难复盘。",
        "换城市有用，但它不会自动解决工作、关系和自我要求。它只是提供一个不同环境，让你看清问题在哪里复现。",
        "比较稳的做法是先写下这次迁移想验证的一句话，再设好结束时间。"
      ]
    },
    {
      id: "person-muyan",
      pathId: "path-skill",
      name: "牧言",
      avatar: `${avatarBase}openpeeps64.svg`,
      experienceSummary: "牧言没有立刻转行，而是在原岗位外做了 6 个公开小作品。他的原文强调作品不是为了证明天赋，而是为了让未来选择有可展示的证据。",
      source: {
        title: "Mock 知乎回答：转行前，我先做了六个小作品",
        evidence: "来源片段提到公开作品、反馈记录和低风险试错。",
        url: "#"
      },
      article: {
        title: "转行前，我先做了六个小作品",
        lead: "这篇 mock 原文记录了一个人如何把转型焦虑变成可展示的尝试。",
        paragraphs: [
          "我当时没有勇气直接转行，也不确定自己是不是只是在讨厌现在的工作。",
          "所以我给自己定了六个周末项目，每个项目都必须小到可以完成，也必须公开到能收到一点真实反馈。",
          "半年后，那些作品不算多厉害，但它们让我和别人谈未来时不再只靠想象。"
        ]
      },
      aiPersona: {
        enabled: true,
        personaId: "persona-muyan",
        boundary: "这是基于知乎公开内容生成的经验回应，不代表作者本人。",
        suggestions: ["小作品怎么定范围？", "没有反馈怎么办？", "什么时候可以转行？"]
      },
      chatReplies: [
        "这段公开经历里，作品的作用不是炫耀，而是把模糊愿望变成可被讨论的证据。",
        "他选择小项目，是因为小才会完成。完成后的反馈，比脑内规划更能帮你判断方向。",
        "如果你也在准备，可以先做一个两周内能完成的版本，不要一开始就设计成代表作。"
      ]
    },
    {
      id: "person-qingzhou",
      pathId: "path-skill",
      name: "青舟",
      avatar: `${avatarBase}openpeeps70.svg`,
      experienceSummary: "青舟用一年时间维护同行关系和复盘记录。她没有把人脉当成捷径，而是把每次请教、合作和拒绝都写进自己的路书。",
      source: {
        title: "Mock 知乎回答：我靠记录关系和机会，慢慢换了一条路",
        evidence: "来源片段包含请教记录、合作尝试和机会复盘。",
        url: "#"
      },
      article: {
        title: "我靠记录关系和机会，慢慢换了一条路",
        lead: "这篇 mock 原文关注关系和机会如何积累成选择空间。",
        paragraphs: [
          "我以前以为底气来自一个巨大机会，后来发现它更多来自很多次小连接。",
          "我每个月约两个人聊行业变化，不求介绍工作，只问他们现在真正需要解决什么问题。",
          "一年后我换方向时，并不是突然被拯救，而是手里已经有了几个可以试的入口。"
        ]
      },
      aiPersona: {
        enabled: true,
        personaId: "persona-qingzhou",
        boundary: "这是基于知乎公开内容生成的经验回应，不代表作者本人。",
        suggestions: ["怎么开口请教别人？", "关系记录写什么？", "如何不把人脉当捷径？"]
      },
      chatReplies: [
        "她的重点不是求别人给答案，而是持续观察真实需求。关系因此变成信息入口，而不是压力。",
        "记录可以很简单：聊了谁，对方正在解决什么，你能提供什么，下一次是否有具体动作。",
        "当这些记录积累起来，选择会变得更具体，也更不依赖一次突然的好运。"
      ]
    }
  ];

  App.mockData = {
    defaultQuery: "不工作了以后，我能去哪儿重新开始？",
    profile: {
      name: "知乎体验官",
      headline: "已完成 mock 登录"
    },
    clarifyQuestions: [
      {
        id: "need",
        text: "你现在最想先解决哪件事？",
        options: [
          { id: "rest", label: "先缓过来" },
          { id: "direction", label: "看清方向" },
          { id: "move", label: "换个环境" }
        ]
      },
      {
        id: "pace",
        text: "你能接受哪种试错方式？",
        options: [
          { id: "small", label: "小步试探" },
          { id: "season", label: "给自己一季" },
          { id: "prepare", label: "先准备底牌" }
        ]
      },
      {
        id: "concern",
        text: "你最担心的代价是什么？",
        options: [
          { id: "money", label: "现金流" },
          { id: "lonely", label: "孤独感" },
          { id: "career", label: "履历断层" }
        ]
      }
    ],
    paths,
    people,
    personas: people.map((person) => ({
      personaId: person.aiPersona.personaId,
      personId: person.id,
      displayName: `${person.name}的经验回声`,
      boundary: person.aiPersona.boundary
    })),
    starterBook: [
      {
        personId: "person-linbai",
        status: "reading",
        addedAt: "刚刚"
      }
    ],
    starterInteractions: [
      {
        id: "interaction-seed-1",
        type: "chat",
        personId: "person-linbai",
        content: "你问：90 天试住最该记录什么？",
        reply: "经验回声：钱、睡眠、工作效率和孤独感出现的时间点最有参考价值。",
        createdAt: "刚刚"
      },
      {
        id: "interaction-seed-2",
        type: "note",
        personId: "person-ahe",
        content: "留言：先把下班后还在消耗我的事情写下来。",
        reply: "",
        createdAt: "5 分钟前"
      }
    ],
    capsulePrompts: [
      "三个月后，我希望自己记得今天最想保住的是什么。",
      "如果这次选择没有成功，我也想温柔地承认哪一部分努力过。",
      "给未来的我一个提醒：不要把一次试错误读成整个人生。"
    ],
    starterCapsules: [
      {
        id: "capsule-seed-1",
        message: "先用一个月恢复睡眠，再决定是不是离开。",
        openAt: "2026-08-22",
        status: "等待开启"
      }
    ]
  };
})();
