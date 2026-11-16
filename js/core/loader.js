/* 数据源装载器（v141 · P1-1）—— 收口八组同构状态的重复骨架。
 *
 * 背景：app.js 里 MARKET/LIVE/MACRO/NEWS/HIST/AY/同步 每个源都手写了同一套
 *   「在途去重 + TTL 判定 + 失败保留旧值 + 状态字段推进」，八份实现彼此相似，
 *   新增一个源只能复制粘贴，改一处口径要改八处。
 *
 * 本模块只收口**与数据源无关的纯骨架**，不含 DOM / 网络 / 具体字段：
 *   · busy：在途去重，连点只发一发，回包按 id 认人（调用方传 run函数）；
 *   · TTL：needRefresh() 区分「没有数据」与「数据过期」两种该刷的情形；
 *   · 失败保留旧值：run 抛错只推状态、不清数据（旧行情仍然有效）；
 *   · 状态推进：phase idle→loading→ok|err，at/err/lastTry 统一在此更新。
 *
 * ★ 采用「视图对象原地更新」而非替换引用：调用方（含 market-page.test.mjs 用
 *   new Function 注入的 MACRO/MACRO_ST）持有的引用始终有效，外部行为零变化。
 *
 * 纯函数 / 零依赖：单测在 tests/loader.test.mjs，不依赖 window/document。
 */

/** 建一个状态视图对象（字段可变，引用稳定）。 */
export function makeState(init = {}) {
  return Object.assign({ phase: "idle", at: 0, err: "", lastTry: 0 }, init);
}

/**
 * 建一个装载器。
 * @param {{
 *   state: object,
 *   get: function(): any,
 *   set: function(any): void,
 *   ttl: number,
 *   run: function(any): Promise<any>,
 *   onOk?: function(): void,
 *   onErr?: function(string): void,
 *   errSlice?: number,
 *   toast?: function(string, number): void,
 * }} cfg
 */
export function createLoader(cfg) {
  const { state, get, set, ttl, run } = cfg;
  const onOk = cfg.onOk || (() => {});
  const onErr = cfg.onErr || (() => {});
  const errSlice = cfg.errSlice || 140;
  let busy = null;   // 在途 promise；连点复用同一个

  /* 是否该刷：没有数据，或距上次尝试已过 TTL。
     用 lastTry 而非 at 判 TTL —— 与其刻层一致：失败后一段时间内不反复重试。 */
  function needRefresh(now = Date.now()) {
    return !get() || (now - (state.lastTry || 0)) > ttl;
  }

  /* 取一次。busy 去重；成功推 ok/at、失败推 err 但**不清数据**；两路都回调副作用。 */
  function refresh(opts = {}) {
    if (busy) return busy;
    state.phase = "loading";
    state.err = "";
    state.lastTry = Date.now();
    busy = (async () => {
      try {
        const result = await run(opts);
        if (result === false) throw new Error("取数返回失败");
        /* run 返回非 undefined 的值就当「取到的数据」写入；返回 undefined 表示
           run 自己已经 set 过（如 macroRefresh 内部写 MACRO），这里不重复写。 */
        if (result !== undefined && result !== true) set(result);
        state.phase = "ok";
        state.at = Date.now();
        onOk();
        return true;
      } catch (e) {
        state.phase = "err";
        state.err = String((e && e.message) || e).slice(0, errSlice);
        onErr(state.err);
        if (!opts.silent && cfg.toast) cfg.toast(`没取到：${state.err}`, 4200);
        return false;
      } finally { busy = null; }
    })();
    return busy;
  }

  return {
    state, get, set, ttl,
    needRefresh, refresh,
    isBusy: () => !!busy,
    /** 测试用：状态视图里数据是否已写入（成功路径 set 过）。 */
    hasData: () => !!get(),
  };
}
