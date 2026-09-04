/**
 * LLM 群聊概括器。
 *
 * 职责：把一组消息记录拼成结构化中文 prompt，调用 OpenAI 兼容
 * {llm.baseUrl}/chat/completions 生成 markdown 群聊概括或「昨日日报」。
 * 请求形状、prompt 约束与两调用点的差异详见 docs/external-apis.md §2——
 * 调用经 core/platform/http.js fetchRetry（60s 超时、2 次重试），失败一律抛错冒泡，
 * 由调用方（summary/report 插件）兜底。
 *
 * 对外导出：类 Summarizer，仅由 core/runtime.js 的 createApp 装配一次（构造入参是
 * config.json 的 llm 节）；summarize 被 plugins/summary.js 的 doSummary（手动概括，
 * purpose='manual'）与 plugins/report.js 的 dailyReport（昨日日报，purpose='daily'）两处调用。
 */
import { hhmm } from './store.js';
import { log } from './logger.js';
import { fetchRetry } from './http.js';

/**
 * LLM 概括器：消息记录列表 → 结构化 prompt → /chat/completions → markdown 概括文本。
 * 纯无状态（除构造配置外不持有可变状态），可安全复用同一实例。
 */
export class Summarizer {
  /**
   * @param {Object} [cfg={}] - config.json 的 llm 节；键可缺省，逐个有默认值
   * @param {string} [cfg.apiKey] - API 密钥；缺省回退 process.env.LLM_API_KEY，再缺为 ''（请求必失败）
   * @param {string} [cfg.baseUrl='https://api.openai.com/v1'] - OpenAI 兼容端点；末尾 / 会被剥掉
   * @param {string} [cfg.model='gpt-3.5-turbo'] - 模型名
   * @param {number} [cfg.maxMessages=3000] - 送入 prompt 的消息行数上限（超出时只保留最新 N 条）
   * @param {number} [cfg.maxTokens=2048] - 请求体 max_tokens（输出长度上限）
   */
  constructor(cfg = {}) {
    this.apiKey = cfg.apiKey || process.env.LLM_API_KEY || '';
    this.baseUrl = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.model = cfg.model || 'gpt-3.5-turbo';
    this.maxMessages = cfg.maxMessages || 3000;
    this.maxTokens = cfg.maxTokens || 2048;
  }

  /**
   * 概括一段群聊并返回 markdown 文本。
   * 流程：记录 → "[HH:mm] 昵称: 文本" 行（超出 maxMessages 时只保留最新）→ 按
   * purpose 选角色与话术拼 prompt → fetch /chat/completions → 取
   * choices[0].message.content 并 trim。success 无副作用（不写上下文历史）。
   * @param {string} groupId - 群号；只进日志，不拼入 prompt（prompt 明令不输出群号）
   * @param {Object[]} recs - 消息记录（需含 time/name/text）；空数组直接返回 null，不发请求
   * @param {string} spanText - 时间范围描述文案（summary/report 两插件构造后传入；
   *   当前方法体未使用——prompt 要求模型不得输出时间范围等元信息，故保留为接口占位）
   * @param {string} [purpose='manual'] - 'manual'（手动群聊概括，约 300 字内）|
   *   'daily'（昨日日报，约 500 字内）；其他值按 manual 处理
   * @returns {Promise<string|null>} 概括 markdown 文本；recs 为空返回 null
   * @throws LLM 返回非 2xx 时抛「LLM API 错误 <status>: <body 前 500 字>」；
   *   2xx 但响应缺 content 时抛「LLM 返回内容为空」
   * 副作用: 调用一次 LLM HTTP 接口（60s 超时、最多 2 次重试，见 external-apis.md §2 与 http.js）
   */
  async summarize(groupId, recs, spanText, purpose = 'manual') {
    if (!recs.length) return null;

    const lines = recs.map((r) => `[${hhmm(r.time)}] ${r.name}: ${r.text}`);
    const trimmed = lines.slice(-this.maxMessages).join('\n');

    const role = purpose === 'daily'
      ? '你是一天群聊的记录官，负责为群主产出每日群聊日报。'
      : '你是专业的群聊分析助手。';

    const prompt = [
      role,
      '',
      `消息数量：${recs.length} 条`,
      '',
      purpose === 'daily'
        ? '请用简洁的中文生成这份群的"昨日日报"概括，使用 markdown 格式：'
        : '请用简洁的中文生成一份群聊概括，使用 markdown 格式：',
      '1. 主要话题：按讨论热度列出 2-5 个话题及简述',
      '2. 关键信息：重要通知、结论、决策等（如无则写"无"）',
      '3. 待办或提醒：群里提到的待办事项、需要某人注意的事情（如无则写"无"）',
      '4. 活跃概况：一句话点评整体讨论氛围',
      '',
      '要求：',
      '- 严格基于聊天记录内容，不要编造或猜测记录之外的信息',
      '- 不要输出群号、时间范围等元信息',
      '- 严禁输出任何涉及个人隐私、色情、暴力、违法或不当的内容；如聊天中有此类内容，一律不提及',
      '- 每条要点控制在 1-2 行',
      `- 总长度控制在约 ${purpose === 'daily' ? 500 : 300} 字以内`,
      '',
      '聊天记录：',
      trimmed,
    ].join('\n');

    log(`[summarizer] 正在调用 ${this.model} 概括群 ${groupId}...`);

    const resp = await fetchRetry(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: '你是一个严谨、简洁的群聊分析助手。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
        max_tokens: this.maxTokens,
      }),
    }, { timeoutMs: 60000, retries: 2, retryDelayMs: 2000 });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`LLM API 错误 ${resp.status}: ${text.slice(0, 500)}`);
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('LLM 返回内容为空');
    return content;
  }
}
