// 敏感内容过滤模块：识别群消息中的隐私信息（手机号/邮箱/身份证/银行卡/地址/IP）与敏感词，
// 供消息入库与日报统计前剔除敏感消息、脱敏保留其余消息。
// 导出：isSensitive / sanitizeText / filterMessages（均无副作用、无状态的纯函数）。
// 依赖：无第三方依赖；由 src/index.js import filterMessages（经配置开关包装后作为消息过滤闸门），isSensitive/sanitizeText 供本模块内部复用。
// 数据：不读写任何文件；匹配模式、关键词表与脱敏占位符均为本文件私有常量。

// 模块私有：隐私信息正则集（带 g 标志，调用前需重置 lastIndex）；命中即判为敏感，并被 sanitizeText 替换为占位符
const PRIVACY_PATTERNS = [
  // 大陆手机号：1[3-9] 开头 11 位
  /(?<![0-9])1[3-9]\d{9}(?![0-9])/g,
  // 邮箱
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  // 身份证号 18 位
  /\b\d{17}[\dXx]\b/g,
  // 银行卡号（13-19 位）
  /\b(?:\d{4}[- ]?){3,4}\d{1,3}\b/g,
  // 地址：行政区划词（省可选）+ 市/区/县 + 具体路名/大道（紧邻组合，避免单字误伤）
  /(?:[\u4e00-\u9fff]{1,6}?(?:省|自治区|特别行政区))?[\u4e00-\u9fff]{1,8}?(?:市|自治州|区|县|镇|乡|街道)[\u4e00-\u9fff]{1,10}?(?:路|街|大道|巷|胡同|弄)/g,
  // IP 地址
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
];

// 模块私有：命中即判为敏感的关键词表（隐私索取/违法/色情/自伤类），用于 isSensitive 的快速包含匹配
const SENSITIVE_KEYWORDS = [
  '身份证', '银行卡', '手机号', '电话号码', '住址', '家庭住址',
  '密码', '验证码', '账号密码', '银行卡号', '身份证号',
  '裸照', '裸聊', '色情', '黄色视频', 'AV', 'a片', '黄片', '自拍',
  '约炮', '卖淫', '嫖娼', '援助交际', '包养',
  '毒品', '冰毒', '海洛因', '大麻', '摇头丸',
  '枪支', '弹药', '爆炸物', '自制炸弹',
  '赌博', '博彩', '赌球', '六合彩',
  '诈骗', '传销', '洗钱', '刷单兼职',
  '自杀', '自残',
];

// 模块私有：脱敏时的替换占位符（仅替换隐私模式匹配段，不替换关键词本身）
const PLACEHOLDER = '[内容已过滤]';

/**
 * 判断文本是否命中敏感词（隐私索取/违法/色情/自伤类）或隐私模式（手机号/邮箱/身份证/银行卡/地址/IP 等）。
 * @param {string} text - 待检测文本
 * @returns {boolean} 命中任一关键词或隐私模式返回 true；空文本或未命中返回 false
 */
export function isSensitive(text) {
  if (!text) return false;
  for (const kw of SENSITIVE_KEYWORDS) {
    if (text.includes(kw)) return true;
  }
  for (const re of PRIVACY_PATTERNS) {
    re.lastIndex = 0; // 带 g 标志的正则需重置，避免跨调用 lastIndex 残留
    if (re.test(text)) return true;
  }
  return false;
}

/**
 * 将文本中所有隐私模式匹配段（手机号/邮箱/身份证/银行卡/地址/IP）替换为占位符。
 * @param {string} text - 待脱敏文本
 * @returns {string} 脱敏后的文本；空文本（含 null/undefined）原样返回
 */
export function sanitizeText(text) {
  if (!text) return text;
  let out = text;
  for (const re of PRIVACY_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, PLACEHOLDER);
  }
  return out;
}

/**
 * 按条分流消息数组：敏感消息整体剔除，其余消息做隐私脱敏后保留（仅改 text 字段，其余字段透传）。
 * @param {Object[]} recs - 消息记录数组，每条需含 text 字段
 * @returns {{kept: Object[], filtered: Object[]}} kept 为脱敏后的保留记录；filtered 为命中敏感内容被剔除的原始记录
 */
export function filterMessages(recs) {
  const kept = [];
  const filtered = [];
  for (const r of recs) {
    if (isSensitive(r.text)) {
      filtered.push(r);
      continue;
    }
    kept.push({ ...r, text: sanitizeText(r.text) });
  }
  return { kept, filtered };
}
