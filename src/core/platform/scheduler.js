// 每日定时调度模块：在指定时刻（缺省 9:00，时刻由装配方按 report.* 传入）触发一次任务，
// 执行完自动安排下一天，当前用于「每日群活跃日报」的定时触发。
// 导出：Scheduler（class；对外接口 start/stop）。
// 依赖：./logger.js（log/err）；唯一实例化点 core/runtime.js：createApp 装配
// new Scheduler({ dailyHour, dailyMinute })——时刻取 report.hour/minute（缺省 9:00；旧
// config.schedule 整块 2026-09 起废弃不读）；start(dailyReport) 由 report 插件 hooks.start
// 调用、stop() 由其 hooks.stop 调用。
// 数据：不读写任何文件；触发时刻完全由实例化方传入（本类参数名 dailyHour/dailyMinute）。

import { log, err } from './logger.js';

/**
 * 每日定时器：以 setTimeout 链驱动，每天目标时刻执行一次回调并自动排入下一天；running 标志防止上一轮任务未结束时重入。
 */
export class Scheduler {
  /**
   * @param {{dailyHour?: number, dailyMinute?: number}} [opts] - 每日触发时刻（小时/分钟），缺省 9:00
   */
  constructor({ dailyHour = 9, dailyMinute = 0 } = {}) {
    this.dailyHour = dailyHour;
    this.dailyMinute = dailyMinute;
    this.running = false;
    this.timer = null;
  }

  /**
   * 计算距下一次触发时刻的毫秒数：今天的时刻已过时顺延至明天同一时刻。
   * @param {Date} [now] - 参考时间，缺省为当前时间
   * @returns {number} 距下次触发的毫秒数（恒为正，至少跨到下一个目标时刻）
   */
  msUntilNextRun(now = new Date()) {
    const next = new Date(now);
    next.setHours(this.dailyHour, this.dailyMinute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }

  /**
   * 启动循环调度：等待至每日目标时刻执行一次 run()，执行完自动安排下一天，周而复始。
   * @param {Function} run - 每次触发要执行的任务（通常为返回 Promise 的日报生成函数）
   * @returns {void} 副作用：写入内部定时器并打印下次触发时间的日志
   */
  start(run) {
    const scheduleNext = () => {
      const delay = this.msUntilNextRun();
      log(`[scheduler] 下次日报任务 ${this.dailyHour}:${String(this.dailyMinute).padStart(2, '0')}，约 ${Math.round(delay / 60000)} 分钟后`);
      this.timer = setTimeout(() => {
        this._run(run);
        scheduleNext();
      }, delay);
    };
    scheduleNext();
  }

  // 内部：执行一次任务回调；running 互斥防重入，任务抛错仅记录日志，不中断后续轮次
  async _run(run) {
    if (this.running) return;
    this.running = true;
    try {
      await run();
    } catch (e) {
      err('[scheduler] 日报任务出错:', e.message);
    } finally {
      this.running = false;
    }
  }

  /**
   * 停止调度：清除挂起的定时器（进程退出/重启前调用，不阻塞已开始执行的任务）。
   * @returns {void}
   */
  stop() {
    if (this.timer) clearTimeout(this.timer);
  }
}
