/*
 * 数据刷新插件（P3b 由 runtime.js 迁入：refreshData 编排正文 + 原路由链 S11 手动刷新指令 +
 * 数据自动更新定时器，三者收口到本插件的 api.refresh）。
 *
 * 三触发源共用同一编排（docs/architecture.md §6.3）：hooks.start 的自动定时器 / handleMessage
 * 的 S11 群指令 / 外部（WebUI /api/refresh，P3c 前经 runtime 桥接层）调 api.refresh()。
 * 编排正文：先快照旧 6★/5★ 干员与卡池 id（走 arkdb 公开快照 API）→ refresher.refresh()
 * （依次 干员→档案→藏品→卡池；ETag 304 跳过、结构校验失败抛错）→ 有更新则 arkdb.reload()
 * 热重载并 diff 出新增干员/新开放卡池 → 按 broadcast 组「【数据更新播报】」。
 * 数据保鲜联动（2026-09 修复坑 3）：updated 非空时同步清掉知识检索缓存（cache.deleteByPrefix
 * ('q:')）——联网检索结果基于旧数据，刷新后必须失效保证「数据最新」，跨群共享键语义不动。
 * 定时器生命周期：hooks.start 注册（仅 dataRefresh.enabled !== false，首次 firstDelayMinutes
 * 分钟后、此后每 intervalHours 小时——setInterval 由首个 setTimeout 内链式启用，同旧实现）；
 * hooks.stop 清理（旧实现退出路径不清理、依赖 process.exit，插件化后补上，属无害增强）。
 *
 * 消息面：priority 800（PRIORITY.refresh）= 原 S11 位置（先于确定性指令 700–400、后于总结 900）。
 * 整串锚定正则 /^(刷新数据|更新数据|更新数据库)$/ 匹配 ctx.text（剥 @ 后问题），命中即 ack
 * 「正在更新本地数据库，稍候…」并异步执行，返回 true 消费消息；失败补发错误消息。
 *
 * 依赖：logger；服务/配置经 createRefreshPlugin(deps) 注入（deps 直传，不随静态数组交付）；
 * 实例化点：core/runtime.js createApp 装配期。
 * 读写数据：联网下载写盘 data/ark/（原子写入 + 旧文件 .bak 备份）；arkdb 内存热重载；可能群发播报。
 */
import { log, err } from '../core/platform/logger.js';
import { PRIORITY } from '../core/registry.js';

/**
 * 数据刷新插件描述符构造：{name:'refresh', priority: PRIORITY.refresh, handleMessage,
 * hooks:{start,stop}, api:{refresh}}。
 * @param {Object} deps - runtime 装配期注入
 * @param {Object} deps.arkdb - ArkDB 实例（snapshotHighOps/snapshotGachaPools/reload）
 * @param {Object} deps.refresher - DataRefresher 实例（联网刷新 data/ark/）
 * @param {Object} deps.cache - KnowledgeCache 实例（数据有更新时 deleteByPrefix('q:') 清知识检索缓存）
 * @param {Object} deps.client - NapCatClient 实例（回执/播报群发）
 * @param {Object} deps.store - MessageStore 实例（trackedGroupIds 兜底广播目标）
 * @param {Function} deps.trackedGroups - () => Array，config.groups 访问器（空数组 = 跟踪全部群）
 * @param {boolean} deps.broadcast - 自动更新后是否广播新增内容（config.dataRefresh.announce === true）
 * @param {Object} deps.schedule - config.dataRefresh 子集：{enabled?, firstDelayMinutes?, intervalHours?}
 * @returns {Object} 注册表可直接 register 的插件描述符
 */
export function createRefreshPlugin(deps) {
  const { arkdb, refresher, cache, client, store, trackedGroups, broadcast } = deps;
  const schedule = deps.schedule || {};
  // 定时器句柄（hooks.stop 清理用；旧实现退出不清理、依赖 process.exit，插件化后补上）
  let firstTimer = null;
  let repeatTimer = null;

  /**
   * 数据自动/手动刷新编排（§6.3 单一 runner，三个触发源共用）。
   * @param {string|null} [notifyGroupId=null] - 群指令触发时传群号：必向该群回执「【数据更新】…」结果消息
   *   （另在 broadcast===true 时附播报）；为 null（定时器/WebUI 触发）时仅当 broadcast 把播报广播给全部跟踪群
   * @returns {Promise<string>} 「【数据更新】…」结果文本（供群回执与 WebUI /api/refresh 复用）
   * 副作用：联网下载写盘 data/ark/（原子写入+旧文件 .bak 备份）、arkdb 内存热重载、
   * 更新时清 q:* 知识检索缓存（坑 3）、可能群发播报；发送失败吞掉只记日志
   */
  async function refresh(notifyGroupId = null) {
    log('[refresh] 开始更新本地数据...');

    // 快照旧数据（用于新增播报对比；走公开快照 API，不再直读 characters/_isOperator/gachaPools）
    const oldHighOps = new Map(arkdb.snapshotHighOps().map((o) => [o.id, o.name]));
    const oldPoolIds = new Set(arkdb.snapshotGachaPools().map((p) => p.gachaPoolId));

    const { updated, unchanged, failed } = await refresher.refresh();

    let announce = '';
    if (updated.length > 0) {
      arkdb.reload();
      log('[refresh] 内存数据已重新加载');
      // 坑 3（2026-09）：数据真有更新才失效知识检索缓存——联网检索结果基于旧数据，
      // 不清会让同问题命中过期答案；只删 q: 段，词典命中计数等其他键与跨群共享语义不动
      const cleared = cache.deleteByPrefix('q:');
      if (cleared > 0) log(`[refresh] 数据已更新，清除 ${cleared} 条知识检索缓存`);

      // 对比新增内容
      const new6 = [];
      const new5 = [];
      for (const c of arkdb.snapshotHighOps()) {
        if (!oldHighOps.has(c.id)) {
          if (c.rarity === 'TIER_6') new6.push(c.name);
          else if (c.rarity === 'TIER_5') new5.push(c.name);
        }
      }
      const now = Math.floor(Date.now() / 1000);
      const newPools = [];
      for (const p of arkdb.snapshotGachaPools()) {
        if (!oldPoolIds.has(p.gachaPoolId) && (!p.openTime || p.openTime <= now) && (!p.endTime || p.endTime >= now)) {
          newPools.push(p.gachaPoolName);
        }
      }
      const parts = [];
      if (new6.length) parts.push(`新增 6★ 干员：${new6.join('、')}`);
      if (new5.length) parts.push(`新增 5★ 干员：${new5.join('、')}`);
      if (newPools.length) parts.push(`新开放卡池：${[...new Set(newPools)].join('、')}`);
      if (parts.length) announce = `【数据更新播报】\n${parts.join('\n')}`;
    }

    const msg = `【数据更新】\n成功：${updated.length ? updated.join('、') : '无'}\n未变化：${unchanged.length ? unchanged.join('、') : '无'}\n${failed.length ? '失败：' + failed.join('、') : '全部成功'}`;
    if (notifyGroupId) {
      client.sendGroupMsg(notifyGroupId, msg).catch((e) => err(`[refresh] 通知发送失败:`, e.message));
      if (announce && broadcast) {
        client.sendGroupMsg(notifyGroupId, announce).catch(() => {});
      }
    } else if (announce && broadcast) {
      // 自动更新时向所有监控群播报新增内容（默认关闭，需 announce: true 显式开启）
      const targets = trackedGroups().length ? trackedGroups() : store.trackedGroupIds();
      for (const gid of targets) {
        client.sendGroupMsg(gid, announce).catch(() => {});
      }
      log('[refresh] 已向群聊播报新增内容');
    }
    return msg;
  }

  return {
    name: 'refresh',
    priority: PRIORITY.refresh,
    /**
     * 手动刷新指令（原路由链 S11）：整串锚定命中即消费消息（ack + 异步刷新，失败补发错误消息）。
     * @param {Object} ctx - 消息上下文（runtime S12 分发）：{groupId, text, ...}
     * @returns {true|null} true = 命中；null = 未命中
     */
    handleMessage(ctx) {
      const t = String(ctx.text || '').trim();
      // 手动刷新本地数据（联网更新 ArknightsGameData）——整串锚定（非包含匹配）
      if (!/^(刷新数据|更新数据|更新数据库)$/.test(t)) return null;
      log(`[group ${ctx.groupId}] 收到数据刷新指令`);
      client.sendGroupMsg(ctx.groupId, '正在更新本地数据库，稍候…').catch(() => {});
      refresh(ctx.groupId).catch((e) => {
        err('[refresh] 手动刷新失败:', e.message);
        client.sendGroupMsg(ctx.groupId, `数据更新失败：${e.message}`).catch(() => {});
      });
      return true;
    },
    /**
     * 生命周期：start 注册数据自动更新定时器（原 runtime.start 首段；仅 dataRefresh.enabled !==
     * false 时启用，默认开：首次 firstDelayMinutes(30) 分钟后、此后每 intervalHours(24) 小时）。
     * @returns {void} 副作用：挂 setTimeout/setInterval（句柄留待 stop 清理）
     */
    hooks: {
      start() {
        if (schedule.enabled !== false) {
          const firstMs = (schedule.firstDelayMinutes ?? 30) * 60 * 1000;
          const intervalMs = (schedule.intervalHours ?? 24) * 3600 * 1000;
          firstTimer = setTimeout(() => {
            refresh().catch((e) => err('[refresh] 更新失败:', e.message));
            repeatTimer = setInterval(() => refresh().catch((e) => err('[refresh] 更新失败:', e.message)), intervalMs);
          }, firstMs);
          log(`[refresh] 数据定期更新已启用：首次 ${schedule.firstDelayMinutes ?? 30} 分钟后，此后每 ${schedule.intervalHours ?? 24} 小时`);
        }
      },
      /** 停服清理：清掉挂起的自动更新定时器（旧实现退出路径无此清理、依赖 process.exit） */
      stop() {
        if (firstTimer) clearTimeout(firstTimer);
        if (repeatTimer) clearInterval(repeatTimer);
      },
    },
    /** 编排入口暴露（WebUI /api/refresh 与 runtime 桥接层共用；P3c 起 WebUI 插件直接经 api 取用） */
    api: { refresh },
  };
}
