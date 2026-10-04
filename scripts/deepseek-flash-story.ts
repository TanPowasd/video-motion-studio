export const chapters = [
  {
    id: 'opening',
    label: '01 / INTRO',
    title: 'DeepSeek V4.1 Flash',
    lines: [
      '二零二六年九月十日，DeepSeek 发布 V4.1 Flash。它把原生视觉理解、更强的智能体能力和更低的使用成本，放进了同一个模型。',
    ],
  },
  {
    id: 'architecture',
    label: '02 / ARCHITECTURE',
    title: '非对称结构，让计算各司其职',
    lines: [
      '它是一款总参数五千五百二十亿的混合专家模型。新的因果编码器解码器结构，让输入端激活八十亿参数，输出端激活一百六十亿参数。',
      '输入与输出采用不同的计算规模，是这次架构变化的核心。',
    ],
  },
  {
    id: 'vision',
    label: '03 / MULTIMODAL',
    title: '图像，也能进入推理流程',
    lines: [
      'Flash 原生支持视觉理解。图像、图表和文字，可以成为同一个任务的上下文。结合工具调用，模型可以把理解结果接入后续工作流程。',
    ],
  },
  {
    id: 'context',
    label: '04 / CONTEXT',
    title: '让长任务，有更大的工作空间',
    lines: [
      '官方接口提供一百万 token 的上下文，最大输出三十八万四千 token。与上一代相比，缓存的显存需求降至四分之一，固态存储需求降至八分之一。',
      '这里说的是官方公布的缓存需求，不是所有部署的总内存。',
    ],
  },
  {
    id: 'agents',
    label: '05 / AGENT WORKFLOW',
    title: '从回答问题，到协作完成任务',
    lines: [
      '模型支持工具调用、结构化 JSON 输出，以及思考和非思考两种模式。开发者可以使用兼容接口，把它接入代码、检索和自动化任务。画面展示的是工作流示意。',
    ],
  },
  {
    id: 'benchmarks',
    label: '06 / EVALUATION',
    title: '能力，看具体任务与评测',
    lines: [
      '官方公布的结果中，科学问答 GPQA Diamond 为九十点九，Terminal Bench 二点一为九十点六，Codeforces 评分为三千四百七十一。',
      '这些是官方评测结果。实际效果仍取决于任务、提示和工具环境。',
    ],
  },
  {
    id: 'pricing',
    label: '07 / COST',
    title: '把成本，也放进工作流',
    lines: [
      '按当前官方价格，每百万 token，闲时缓存命中输入为零点零二元，未命中输入一元，输出四元。高峰价格分别翻倍。',
      '长任务可以结合缓存复用和任务时段，规划实际预算。价格信息以官方页面为准。',
    ],
  },
  {
    id: 'access',
    label: '08 / GET STARTED',
    title: '一个明确的入口',
    lines: [
      '调用时，模型名称使用 deepseek flash。官方已提供开放权重和技术报告。先用代表性的任务做小规模验证，再决定怎样接入自己的工作流程。',
    ],
  },
] as const;
export const citations = {
  release: 'https://api-docs.deepseek.com/zh-cn/news/news260910',
  updates: 'https://api-docs.deepseek.com/zh-cn/updates',
  pricing: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
  api: 'https://api-docs.deepseek.com/zh-cn/',
  weights: 'https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash',
};
