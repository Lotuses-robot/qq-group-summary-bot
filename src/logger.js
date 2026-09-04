// 日志模块：把带时间戳的日志行同时输出到控制台与当日日志文件（根目录 logs/YYYY-MM-DD.log），跨天自动轮转并清理 14 天前的旧文件。
// 导出：log / err。
// 依赖：Node 内置 fs/path/url；无类导出，被 src/ 下绝大多数模块（index/commands/chat/cache/lingo/scheduler/refresher/store/webui 等）import 使用。
// 数据：import 本模块即自动创建 logs/ 目录（模块级副作用）；无配置文件。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const logsDir = path.join(root, 'logs');

fs.mkdirSync(logsDir, { recursive: true });

let currentDay = '';
let currentFile = '';

function dayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 每次写入时检查日期，跨天自动轮转到新文件
function getLogFile() {
  const today = dayStr();
  if (today !== currentDay) {
    currentDay = today;
    currentFile = path.join(logsDir, `${today}.log`);
    // 清理超过 14 天的旧日志
    try {
      const files = fs.readdirSync(logsDir).filter((f) => f.endsWith('.log'));
      const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
      for (const f of files) {
        const full = path.join(logsDir, f);
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoff) {
          try { fs.unlinkSync(full); } catch { /* 忽略 */ }
        }
      }
    } catch { /* 忽略 */ }
  }
  return currentFile;
}

// 本地时间戳（zh-CN、24 小时制），作为日志行前缀
function ts() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

function writeLine(line) {
  try {
    fs.appendFileSync(getLogFile(), line + '\n');
  } catch {
    /* 忽略日志文件写入错误 */
  }
}

/**
 * 输出普通信息日志：控制台 stdout 与当日日志文件各一行。
 * @param {...*} args - 待输出的参数（按 String 转换后以空格连接）
 * @returns {void} 副作用：向 logs/YYYY-MM-DD.log 追加一行（写盘失败静默忽略，不影响主流程）
 */
export function log(...args) {
  const line = `[${ts()}] ${args.map(String).join(' ')}`;
  console.log(line);
  writeLine(line);
}

/**
 * 输出错误日志：带 [ERROR] 前缀，控制台 stderr 与当日日志文件各一行。
 * @param {...*} args - 待输出的参数（按 String 转换后以空格连接）
 * @returns {void} 副作用：向 logs/YYYY-MM-DD.log 追加一行（写盘失败静默忽略，不影响主流程）
 */
export function err(...args) {
  const line = `[${ts()}][ERROR] ${args.map(String).join(' ')}`;
  console.error(line);
  writeLine(line);
}
