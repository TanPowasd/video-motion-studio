import {
  defineComponent,
  rect,
  text,
  path,
  ellipse,
  group,
  progress,
  spring,
  lerp,
  easings,
  linearGradient,
  glow,
  particles,
  type Node,
} from '@vmotion/sdk';
type Cue = { start: number; end: number; text: string };
const C = {
  bg: '#07101e',
  panel: '#102039',
  line: '#213856',
  blue: '#4c8eff',
  cyan: '#7ce5fb',
  white: '#eef5ff',
  muted: '#91aac8',
  green: '#7aebc0',
  warm: '#ffbd8b',
};
const whale =
  'M-200 2 C-190 -32 -132 -88 -38 -82 C40 -77 98 -40 141 -7 C176 -6 184 -50 173 -76 C228 -49 217 25 170 54 C142 71 126 78 123 109 C93 108 66 90 47 72 C-34 90 -131 55 -171 19 C-181 28 -190 35 -205 38 C-197 28 -195 14 -200 2 Z';
const ease = (ctx: { frame: number; fps: number }, start: number, duration = 24) =>
  progress(ctx, { start, duration, easing: easings.outCubic });
function line(
  id: string,
  a: { x: number; y: number },
  b: { x: number; y: number },
  props: Partial<Node> = {},
) {
  return path(id, `M${a.x} ${a.y}L${b.x} ${b.y}`, {
    fill: 'transparent',
    stroke: C.line,
    strokeWidth: 2,
    ...props,
  });
}
function heading(
  id: string,
  value: string,
  x: number,
  y: number,
  size = 38,
  width = 1550,
  color = C.white,
) {
  return text(id, value, {
    x,
    y,
    fontSize: size,
    width,
    height: size * 1.6,
    fontWeight: 600,
    fill: color,
  });
}
function chip(id: string, label: string, x: number, y: number, width = 200) {
  return [
    rect(`${id}-bg`, {
      x,
      y,
      width,
      height: 52,
      radius: 26,
      fill: '#132947',
      stroke: '#2c5487',
      strokeWidth: 1,
    }),
    text(`${id}-text`, label, {
      x: x + 18,
      y: y + 10,
      width: width - 36,
      height: 40,
      fontSize: 23,
      fill: C.cyan,
      align: 'center',
    }),
  ];
}
function panel(id: string, x: number, y: number, width: number, height: number) {
  return rect(id, {
    x,
    y,
    width,
    height,
    radius: 24,
    fill: C.panel,
    stroke: C.line,
    strokeWidth: 1,
  });
}
export default defineComponent({
  name: 'DeepSeek V4.1 Flash · Intro',
  parameters: {
    chapter: {
      type: 'enum',
      options: [
        'opening',
        'architecture',
        'vision',
        'context',
        'agents',
        'benchmarks',
        'pricing',
        'access',
      ],
      default: 'opening',
    },
    duration: { type: 'number', default: 12, min: 1 },
    cues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: { type: 'number', default: 0 },
          end: { type: 'number', default: 1 },
          text: { type: 'string', default: '' },
        },
      },
      default: [],
    },
  },
  render(ctx, params) {
    const mode = params.chapter,
      duration = params.duration,
      s = ctx.seconds,
      p = (value: number) => ease(ctx, value * 30),
      exit = Math.min(1, Math.max(0, (duration - s) / 0.45)),
      nodes: Node[] = [
        rect('background', {
          width: 1920,
          height: 1080,
          gradient: linearGradient({ x: 0, y: 0 }, { x: 1920, y: 1080 }, [
            '#07101e',
            '#102449',
            '#071220',
          ]),
        }),
        path(
          'ambient-lines',
          Array.from({ length: 8 }, (_, i) => `M${250 + i * 220} -60L${-180 + i * 220} 1140`).join(
            ' ',
          ),
          { fill: 'transparent', stroke: '#244470', strokeWidth: 1, opacity: 0.3 },
        ),
        text('brand', 'deepseek', {
          x: 76,
          y: 45,
          width: 500,
          height: 50,
          fontSize: 34,
          fontWeight: 700,
          fill: C.white,
        }),
        text('series', 'V4.1 FLASH  /  MODEL BRIEF', {
          x: 1100,
          y: 52,
          width: 744,
          height: 42,
          fontSize: 19,
          align: 'right',
          fill: C.muted,
        }),
        line('top-rule', { x: 76, y: 115 }, { x: 1844, y: 115 }),
        text('source', '据 DeepSeek 官方资料 · 核查 2026.10.04', {
          x: 76,
          y: 993,
          width: 920,
          height: 30,
          fontSize: 18,
          fill: '#6e89ab',
        }),
        text('credit', 'MADE WITH VMOTION', {
          x: 1460,
          y: 993,
          width: 384,
          height: 30,
          fontSize: 17,
          align: 'right',
          fill: '#6e89ab',
        }),
        rect('progress-base', { x: 76, y: 1030, width: 1768, height: 3, fill: '#243b59' }),
        rect('progress', {
          x: 76,
          y: 1030,
          width: 1768 * Math.min(1, s / duration),
          height: 3,
          fill: C.blue,
        }),
      ];
    const content: Node[] = [];
    if (mode === 'opening') {
      const a = p(0.15),
        whaleNodes = [
          path('whale', whale, { x: 0, y: 0, fill: C.blue }),
          ellipse('eye', { x: 80, y: -12, width: 10, height: 10, fill: '#b8d8ff' }),
        ];
      content.push(
        ...group('whale-mark', whaleNodes, {
          x: 1510,
          y: 467,
          scaleX: 1.75,
          scaleY: 1.75,
          rotation: -4 + 4 * a,
          opacity: a,
          effects: [glow(C.blue, 18, 0.35)],
        }),
        text('kicker', '2026.09.10 / 正式发布', {
          x: 84,
          y: 234,
          width: 900,
          height: 52,
          fontSize: 28,
          fill: C.cyan,
          opacity: p(0.1),
        }),
        heading('deepseek', 'DeepSeek', 78, 324, 124, 1200),
        heading('version', 'V4.1 Flash', 78, 481, 130, 1350),
        text('tagline', '原生多模态 · 新结构 · 更普惠', {
          x: 86,
          width: 1100,
          height: 66,
          fontSize: 42,
          fill: C.muted,
          opacity: p(0.7),
          y: 687 - 16 * p(0.7),
        }),
        ...chip('intro-chip', 'API：deepseek-flash', 82, 789, 360),
      );
      for (let i = 0; i < 16; i++) {
        const angle = (i / 16) * Math.PI * 2 + s * 0.13;
        content.push(
          ellipse(`orbit-${i}`, {
            x: 1510 + Math.cos(angle) * 302,
            y: 467 + Math.sin(angle) * 222,
            width: i % 4 ? 5 : 9,
            height: i % 4 ? 5 : 9,
            fill: i % 4 ? C.blue : C.cyan,
            opacity: 0.5,
          }),
        );
      }
    } else if (mode === 'architecture') {
      content.push(
        heading('title', '非对称结构，让计算各司其职', 76, 174, 60),
        text('subtitle', 'Causal-Encoder-Decoder · 混合专家（MoE）', {
          x: 82,
          y: 259,
          width: 1700,
          height: 52,
          fontSize: 29,
          fill: C.muted,
        }),
        panel('input-card', 82, 355, 510, 363),
        panel('model-card', 680, 329, 560, 415),
        panel('output-card', 1328, 355, 510, 363),
      );
      for (const [i, x, label, num, color] of [
        [0, 112, '输入端激活', '8B', C.cyan],
        [1, 735, '总参数', '552B', C.white],
        [2, 1358, '输出端激活', '16B', C.blue],
      ] as const) {
        content.push(
          heading(`label-${i}`, label, x, 390, 28, 460, C.muted),
          heading(`number-${i}`, num, x, 482, i === 1 ? 104 : 115, 460, color),
          text(`unit-${i}`, i === 1 ? '总参数量 ≠ 每个 token 的激活量' : 'B = 十亿参数', {
            x,
            y: 637,
            width: 460,
            height: 48,
            fontSize: i === 1 ? 23 : 25,
            fill: C.muted,
          }),
        );
      }
      for (let i = 0; i < 8; i++)
        content.push(
          rect(`expert-${i}`, {
            x: 720 + (i % 4) * 126,
            y: 789 + Math.floor(i / 4) * 44,
            width: 100,
            height: 21,
            radius: 5,
            fill: i % 3 ? C.line : C.blue,
            opacity: 0.35 + 0.5 * Math.max(0, Math.sin(s * 2 - i)),
          }),
        );
      for (const [x, id] of [
        [606, 'input-flow'],
        [1250, 'output-flow'],
      ] as const) {
        content.push(
          path(id, `M${x} 536H${x + 65}`, {
            fill: 'transparent',
            stroke: C.cyan,
            strokeWidth: 4,
            strokeDash: [11, 8],
            strokeDashOffset: -s * 26,
          }),
          path(id + '-head', `M${x + 53} 523L${x + 69} 536L${x + 53} 549`, {
            fill: 'transparent',
            stroke: C.cyan,
            strokeWidth: 4,
          }),
        );
      }
      content.push(
        text('note', '输入与输出采用不同计算规模', {
          x: 80,
          y: 868,
          width: 1760,
          height: 50,
          fontSize: 32,
          align: 'center',
          fill: C.cyan,
        }),
      );
    } else if (mode === 'vision') {
      content.push(
        heading('title', '图像，也能进入推理流程', 76, 174, 64),
        text('subtitle', '原生视觉理解 · 图像、图表与文字共同构成上下文', {
          x: 82,
          y: 265,
          width: 1680,
          height: 54,
          fontSize: 31,
          fill: C.muted,
        }),
        panel('image-card', 84, 374, 535, 390),
        panel('understand-card', 729, 430, 430, 286),
        panel('result-card', 1283, 374, 555, 390),
      );
      const image: Node[] = [
        rect('sky', { width: 450, height: 280, radius: 16, fill: '#183957' }),
        ellipse('sun', { x: 322, y: 39, width: 66, height: 66, fill: C.warm }),
        path('mountain', 'M0 280L115 102L230 280Z', { fill: '#347c99' }),
        path('mountain2', 'M132 280L300 123L450 280Z', { fill: '#5aa6ae' }),
      ];
      content.push(
        ...group('illustration', image, { x: 126, y: 418, opacity: p(0.5) }),
        heading('vision-center', '理解', 813, 481, 60, 262, C.cyan),
        text('vision-process', '识别 → 联系 → 推理', {
          x: 754,
          y: 573,
          width: 382,
          height: 56,
          fontSize: 28,
          align: 'center',
          fill: C.muted,
        }),
        heading('output-label', '结构化结果', 1320, 417, 30, 468),
        line('chart-axis', { x: 1330, y: 675 }, { x: 1778, y: 675 }),
      );
      for (let i = 0; i < 5; i++) {
        const amount = p(0.7 + i * 0.16),
          h = [88, 132, 102, 175, 146][i] * amount;
        content.push(
          rect(`chart-bar-${i}`, {
            x: 1345 + i * 85,
            y: 670 - h,
            width: 49,
            height: h,
            radius: 8,
            fill: i === 3 ? C.cyan : C.blue,
          }),
          text(`label-${i}`, ['A', 'B', 'C', 'D', 'E'][i], {
            x: 1345 + i * 85,
            y: 690,
            width: 49,
            height: 34,
            fontSize: 19,
            align: 'center',
            fill: C.muted,
          }),
        );
      }
      for (const [x, id] of [
        [640, 'in'],
        [1180, 'out'],
      ] as const)
        content.push(
          path(`connector-${id}`, `M${x} 568H${x + 65}`, {
            fill: 'transparent',
            stroke: C.cyan,
            strokeWidth: 3,
            strokeDash: [9, 6],
            strokeDashOffset: -s * 40,
          }),
        );
      content.push(
        text('vision-caption', '将理解结果接入后续任务', {
          x: 80,
          y: 846,
          width: 1760,
          height: 65,
          fontSize: 39,
          align: 'center',
          fill: C.white,
        }),
      );
    } else if (mode === 'context') {
      content.push(
        heading('title', '让长任务，有更大的工作空间', 76, 174, 60),
        panel('context-card', 84, 333, 804, 485),
        panel('memory-card', 958, 333, 880, 485),
        heading('context-number', '1M', 130, 393, 150, 710, C.cyan),
        heading('context-label', '上下文 tokens', 139, 582, 39, 710),
        text('output-length', '最大输出 384K tokens', {
          x: 139,
          y: 690,
          width: 710,
          height: 59,
          fontSize: 33,
          fill: C.muted,
        }),
        heading('cache-title', '缓存需求下降', 999, 381, 37, 760),
      );
      for (const [i, name, ratio] of [
        [0, 'HBM 显存', 0.25],
        [1, 'SSD 存储', 0.125],
      ] as const) {
        const y = 493 + i * 137;
        content.push(
          text(`memory-label-${i}`, name, {
            x: 1003,
            y,
            width: 350,
            height: 50,
            fontSize: 28,
            fill: C.muted,
          }),
          rect(`old-${i}`, {
            x: 1003,
            y: y + 54,
            width: 578,
            height: 23,
            radius: 5,
            fill: '#304765',
          }),
          rect(`new-${i}`, {
            x: 1003,
            y: y + 54,
            width: lerp(578, 578 * ratio, p(0.6 + i * 0.2)),
            height: 23,
            radius: 5,
            fill: i ? C.blue : C.cyan,
          }),
          heading(`ratio-${i}`, i ? '1/8' : '1/4', 1634, y + 24, 54, 167, C.cyan),
        );
      }
      content.push(
        text('cache-note', '相对上一代的缓存需求 · 官方公布', {
          x: 1003,
          y: 756,
          width: 760,
          height: 43,
          fontSize: 24,
          fill: C.muted,
        }),
        text('context-note', '更大的上下文，需要更高效的存储', {
          x: 80,
          y: 858,
          width: 1760,
          height: 62,
          fontSize: 38,
          align: 'center',
          fill: C.white,
        }),
      );
    } else if (mode === 'agents') {
      content.push(
        heading('title', '从回答问题，到协作完成任务', 76, 174, 60),
        text('subtitle', 'Tool Calls · JSON Output · 思考 / 非思考模式', {
          x: 82,
          y: 264,
          width: 1700,
          height: 53,
          fontSize: 30,
          fill: C.muted,
        }),
      );
      const stages = ['任务', '计划', '调用工具', '检查结果', '交付'],
        active = Math.floor(s * 1.1) % 5;
      for (let i = 0; i < 5; i++) {
        const x = 82 + i * 355,
          a = p(0.3 + i * 0.1);
        content.push(
          ...group(
            `stage-${i}`,
            [
              panel('panel', 0, 0, 330, 285),
              text('index', `0${i + 1}`, {
                x: 29,
                y: 24,
                width: 270,
                height: 40,
                fontSize: 26,
                fill: C.blue,
              }),
              heading('name', stages[i], 25, 102, 38, 280),
              path('check', 'M0 11L9 20L25 0', {
                x: 274,
                y: 35,
                fill: 'transparent',
                stroke: C.green,
                strokeWidth: 4,
                opacity: i <= active ? 1 : 0.2,
              }),
            ],
            { x, y: 396 + 20 * (1 - a), opacity: a },
          ),
        );
        if (i < 4)
          content.push(
            path(`arrow-${i}`, `M${x + 330} 536H${x + 350}`, {
              fill: 'transparent',
              stroke: C.blue,
              strokeWidth: 3,
            }),
          );
      }
      content.push(
        ...chip('tool1', '代码', 341, 746, 220),
        ...chip('tool2', '检索', 603, 746, 220),
        ...chip('tool3', '自动化', 865, 746, 240),
        ...chip('tool4', '结构化数据', 1147, 746, 340),
        text('workflow-note', '能力流程示意 · 非真实 API 执行记录', {
          x: 84,
          y: 867,
          width: 1760,
          height: 52,
          fontSize: 25,
          align: 'center',
          fill: C.muted,
        }),
      );
    } else if (mode === 'benchmarks') {
      content.push(
        heading('title', '能力，看具体任务与评测', 76, 174, 62),
        text('subtitle', 'DeepSeek 官方公布的基准结果', {
          x: 82,
          y: 266,
          width: 1700,
          height: 53,
          fontSize: 31,
          fill: C.muted,
        }),
      );
      for (const [i, name, value, unit, color] of [
        [0, 'GPQA Diamond', 90.9, '科学问答', C.cyan],
        [1, 'Terminal-Bench 2.1', 90.6, '终端任务', C.blue],
        [2, 'Codeforces', 3471, 'Rating · 编程评分', C.warm],
      ] as const) {
        const x = 82 + i * 604,
          a = p(0.2 + i * 0.18),
          count = value * a;
        content.push(
          panel(`metric-card-${i}`, x, 380, 568, 362),
          heading(`metric-label-${i}`, name, x + 34, 418, i === 1 ? 31 : 35, 500, C.muted),
          heading(
            `metric-value-${i}`,
            value > 100 ? Math.round(count).toString() : count.toFixed(1),
            x + 34,
            501,
            value > 100 ? 105 : 121,
            500,
            color,
          ),
          text(`metric-unit-${i}`, unit, {
            x: x + 38,
            y: 669,
            width: 492,
            height: 44,
            fontSize: 26,
            fill: C.muted,
          }),
        );
      }
      content.push(
        text('bench-note', '官方评测 ≠ 你的任务结果', {
          x: 84,
          y: 806,
          width: 1760,
          height: 59,
          fontSize: 37,
          align: 'center',
          fill: C.white,
        }),
        text('bench-sub', '任务 · 提示 · 工具环境，都会影响实际效果', {
          x: 84,
          y: 875,
          width: 1760,
          height: 49,
          fontSize: 28,
          align: 'center',
          fill: C.muted,
        }),
      );
    } else if (mode === 'pricing') {
      content.push(
        heading('title', '把成本，也放进工作流', 76, 174, 64),
        text('subtitle', '人民币 / 每百万 tokens · 闲时价格为高峰的一半', {
          x: 82,
          y: 263,
          width: 1680,
          height: 53,
          fontSize: 31,
          fill: C.muted,
        }),
        panel('price-table', 84, 372, 1754, 421),
        heading('table-label', '计费项', 125, 406, 28, 840, C.muted),
        heading('offpeak', '闲时', 1074, 406, 28, 280, C.cyan),
        heading('peak', '高峰', 1515, 406, 28, 280, C.muted),
      );
      const rows = [
        ['输入 · 缓存命中', '¥0.02', '¥0.04'],
        ['输入 · 缓存未命中', '¥1', '¥2'],
        ['输出', '¥4', '¥8'],
      ];
      rows.forEach((row, i) => {
        const y = 489 + i * 93,
          a = p(0.3 + i * 0.18);
        content.push(
          line(`rule-${i}`, { x: 125, y: y - 16 }, { x: 1790, y: y - 16 }),
          text(`price-label-${i}`, row[0], {
            x: 125,
            y,
            width: 800,
            height: 61,
            fontSize: 35,
            fill: C.white,
            opacity: a,
          }),
          text(`price-off-${i}`, row[1], {
            x: 1074,
            y,
            width: 290,
            height: 65,
            fontSize: 48,
            fontWeight: 600,
            fill: C.cyan,
            opacity: a,
          }),
          text(`price-peak-${i}`, row[2], {
            x: 1515,
            y,
            width: 280,
            height: 65,
            fontSize: 45,
            fill: C.muted,
            opacity: a,
          }),
        );
      });
      content.push(
        text('schedule', '北京时间工作日：9–12 点、14–18 点为高峰；周末与中国法定节假日为闲时。', {
          x: 88,
          y: 821,
          width: 1744,
          height: 60,
          fontSize: 26,
          fill: C.muted,
        }),
        text('price-note', '价格快照：2026.10.04 · 后续以官方页面为准', {
          x: 88,
          y: 894,
          width: 1744,
          height: 44,
          fontSize: 23,
          fill: C.muted,
        }),
      );
    } else {
      content.push(
        heading('title', '一个明确的入口', 76, 174, 67),
        panel('code-panel', 84, 347, 1120, 410),
        text('code-label', 'MODEL / API', {
          x: 128,
          y: 389,
          width: 990,
          height: 45,
          fontSize: 24,
          fill: C.muted,
        }),
        text('code-main', 'model: "deepseek-flash"', {
          x: 126,
          y: 469,
          width: 1026,
          height: 89,
          fontFamily: 'Consolas',
          fontSize: 56,
          fontWeight: 600,
          fill: C.cyan,
        }),
        text('code-url', 'https://api.deepseek.com', {
          x: 129,
          y: 609,
          width: 996,
          height: 62,
          fontFamily: 'Consolas',
          fontSize: 33,
          fill: C.muted,
        }),
        heading('access-title', '先验证，再接入', 1304, 407, 43, 534),
        text('access-list', '代表性任务\n真实工具环境\n效果与预算', {
          x: 1304,
          y: 486,
          width: 490,
          height: 220,
          fontSize: 34,
          lineHeight: 1.85,
          fill: C.muted,
        }),
        ...chip('weights', '开放权重', 87, 813, 310),
        ...chip('report', '技术报告', 437, 813, 310),
        text('final-line', '让理解、推理与工具，进入同一条工作流。', {
          x: 786,
          y: 816,
          width: 1058,
          height: 59,
          fontSize: 34,
          align: 'right',
          fill: C.white,
        }),
      );
    }
    const entry = p(0);
    nodes.push(...group('content', content, { opacity: entry * exit, y: 18 * (1 - entry) }));
    const cue = (params.cues as Cue[]).find((cue) => s >= cue.start && s < cue.end);
    if (cue)
      nodes.push(
        rect('subtitle-bg', {
          x: 130,
          y: 926,
          width: 1660,
          height: 60,
          radius: 14,
          fill: '#07101ef0',
        }),
        text('subtitle', cue.text, {
          x: 164,
          y: 938,
          width: 1592,
          height: 45,
          fontSize: 29,
          align: 'center',
          fill: '#f0f6ff',
        }),
      );
    return nodes;
  },
});
