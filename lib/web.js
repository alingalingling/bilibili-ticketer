// dsh-bilibili-ticket client bundle: a sidebar footer button plus a draggable
// monitoring panel rendered into `shell.overlay`. Data flows over the
// `/bili-ticket` host RPC channel; no filesystem or secrets are touched in the
// browser. Hand-rolled in plain JS (no build step) — the only platform module
// is `react`, shared by the DSH shell. UI styled after Bilibili's pink brand.
window.__ModuleLoader__.load({
  id: "dsh-bilibili-ticket",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { useState, useEffect, useCallback, useSyncExternalStore, useRef } = React;
    const h = React.createElement;

    // ------------------------------------------------------------------ //
    // tiny observable store (open/close shared by button + overlay)
    // ------------------------------------------------------------------ //
    function createStore(initial) {
      let value = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => value,
        set(next) { value = next; for (const l of listeners) l(); },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
      };
    }
    const openStore = createStore(false);

    // ------------------------------------------------------------------ //
    // host RPC client
    // ------------------------------------------------------------------ //
    let rpc = null;
    function setRpc(next) { rpc = next; }
    async function call(endpoint, payload = {}) {
      if (!rpc) throw new Error("bili-ticket: 未连接主机 (no connection)");
      const result = await rpc.call("/bili-ticket", endpoint, payload);
      if (result.ok) return result.value;
      throw new Error(result.error?.message ?? "bili-ticket: request failed");
    }

    // ------------------------------------------------------------------ //
    // styles (Bilibili pink theme)
    // ------------------------------------------------------------------ //
    const CSS = `
.bt-root{position:fixed;top:64px;right:20px;width:360px;max-height:74vh;display:flex;flex-direction:column;
  background:#1b1c24;color:#e6e8ee;border:1px solid #292b35;border-radius:14px;
  box-shadow:0 18px 50px rgba(0,0,0,.55);font:13px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;z-index:1000;overflow:hidden}
.bt-head{display:flex;align-items:center;justify-content:space-between;padding:13px 16px;border-bottom:1px solid #292b35;cursor:move;background:#1f202a;user-select:none}
.bt-title{font-weight:600;font-size:14px;color:#f0f1f5;display:flex;align-items:center;gap:8px}
.bt-title::before{content:"";width:4px;height:14px;border-radius:2px;background:#FB7299}
.bt-close{cursor:pointer;border:none;background:transparent;color:#6d7280;font-size:18px;line-height:1;padding:2px 7px;border-radius:6px}
.bt-close:hover{background:rgba(255,255,255,.08);color:#e6e8ee}
.bt-body{padding:14px 16px;overflow-y:auto;display:flex;flex-direction:column;gap:14px}
.bt-row{display:flex;align-items:center;gap:10px}
.bt-dot{width:8px;height:8px;border-radius:50%;flex:none}
.bt-dot.ok{background:#2fd36d;box-shadow:0 0 0 3px rgba(47,211,109,.16)}
.bt-dot.bad{background:#f85149;box-shadow:0 0 0 3px rgba(248,81,73,.16)}
.bt-section{font-size:12px;font-weight:600;color:#9aa0ae;display:flex;align-items:center;gap:6px}
.bt-section::before{content:"";width:3px;height:12px;border-radius:2px;background:#FB7299;flex:none}
.bt-warn{padding:9px 12px;border-left:3px solid #f85149;background:rgba(248,81,73,.1);border-radius:6px;color:#ffb4ae;font-size:12px;line-height:1.5}
.bt-task{border:1px solid #292b35;border-left:3px solid #3d4050;border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:7px;background:#20212a}
.bt-task.bt-st-running,.bt-task.bt-st-success{border-left-color:#2fd36d}
.bt-task.bt-st-waiting{border-left-color:#00AEEC}
.bt-task.bt-st-failed,.bt-task.bt-st-needs_captcha{border-left-color:#f85149}
.bt-task-head{display:flex;align-items:center;gap:8px}
.bt-task-name{font-weight:500;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#f0f1f5}
.bt-badge{font-size:11px;padding:2px 9px;border-radius:6px;flex:none;white-space:nowrap;font-weight:500}
.bt-badge.grab{background:rgba(251,114,153,.14);color:#ff8fb3}
.bt-badge.monitor{background:rgba(0,174,236,.14);color:#5cc8ff}
.bt-badge.idle{background:rgba(255,255,255,.07);color:#9aa0ae}
.bt-badge.waiting{background:rgba(0,174,236,.14);color:#5cc8ff}
.bt-badge.running{background:rgba(47,211,109,.16);color:#5be08a}
.bt-badge.success{background:rgba(47,211,109,.16);color:#5be08a}
.bt-badge.failed{background:rgba(248,81,73,.14);color:#ffb4ae}
.bt-badge.needs_captcha{background:rgba(248,81,73,.14);color:#ffb4ae}
.bt-badge.stopped{background:rgba(255,255,255,.07);color:#9aa0ae}
.bt-meta{font-size:11px;color:#7a8090}
.bt-actions{display:flex;gap:8px}
.bt-btn{font-size:12px;padding:5px 12px;border-radius:7px;border:1px solid #343642;background:#2a2c38;color:#e6e8ee;cursor:pointer;font-weight:500;transition:background .12s,border-color .12s}
.bt-btn:hover{background:#343645;border-color:#3d4050}
.bt-btn:disabled{opacity:.45;cursor:default}
.bt-btn.primary{background:linear-gradient(180deg,#ff8fb3,#FB7299);border-color:#FB7299;color:#fff;box-shadow:0 2px 6px rgba(251,114,153,.28)}
.bt-btn.primary:hover{background:linear-gradient(180deg,#ff9dbf,#ff7fa7)}
.bt-btn.danger{background:transparent;border-color:rgba(248,81,73,.4);color:#ff9a92}
.bt-btn.danger:hover{background:rgba(248,81,73,.12)}
.bt-log{display:flex;flex-direction:column;gap:3px;font-size:11px;font-family:ui-monospace,'SF Mono',Consolas,monospace}
.bt-log-line{display:flex;gap:6px}
.bt-log-time{color:#6d7280;flex:none}
.bt-log-msg{color:#b6bac6;word-break:break-all}
.bt-log-msg.warn{color:#e3b341}.bt-log-msg.error{color:#ffb4ae}
.bt-empty{color:#6d7280;font-size:12px;text-align:center;padding:12px 0}
.bt-sb{display:flex;align-items:center;gap:8px;cursor:pointer;border:none;background:transparent;color:inherit;font:inherit;padding:6px 10px;border-radius:8px;width:100%}
.bt-sb:hover{background:rgba(251,114,153,.14)}
.bt-sb-dot{width:8px;height:8px;border-radius:50%;background:#FB7299;flex:none}
.bt-qr{font-size:12px;color:#ff9dbb;word-break:break-all;background:rgba(251,114,153,.08);border:1px solid rgba(251,114,153,.25);border-radius:8px;padding:8px 11px}
.bt-form{display:flex;flex-direction:column;gap:8px;border:1px solid #292b35;border-radius:10px;padding:11px 12px;background:#20212a}
.bt-form-row{display:flex;align-items:center;gap:8px}
.bt-label{font-size:12px;color:#9aa0ae;flex:none;min-width:76px}
.bt-input{flex:1;min-width:0;font-size:12px;padding:6px 10px;border-radius:7px;border:1px solid #343642;background:#1b1c24;color:#e6e8ee}
.bt-input::placeholder{color:#5f6472}
.bt-input:focus{outline:none;border-color:#FB7299}
.bt-select{flex:1;min-width:0;font-size:12px;padding:6px 10px;border-radius:7px;border:1px solid #343642;background:#262834;color:#e6e8ee}
.bt-hint{font-size:11px;color:#6d7280}
.bt-search-list{display:flex;flex-direction:column;gap:6px;max-height:190px;overflow-y:auto}
.bt-search-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-radius:8px;border:1px solid #292b35;cursor:pointer;background:#20212a}
.bt-search-item:hover{border-color:#FB7299}
.bt-search-item.sel{border-color:#FB7299;background:rgba(251,114,153,.1)}
.bt-search-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:#f0f1f5}
.bt-search-price{font-size:11px;color:#ff8fb3;flex:none;font-weight:500}
.bt-ticket-list{display:flex;flex-wrap:wrap;gap:6px}
.bt-ticket{display:flex;flex-direction:column;gap:1px;padding:7px 11px;border-radius:8px;border:1px solid #343642;cursor:pointer;background:#20212a}
.bt-ticket:hover{border-color:#FB7299}
.bt-ticket.sel{border-color:#FB7299;background:rgba(251,114,153,.12)}
.bt-ticket-name{font-size:12px;font-weight:500;color:#f0f1f5}
.bt-ticket-price{font-size:11px;color:#ff8fb3}
.bt-sel{font-size:12px;color:#ff9dbb;padding:7px 10px;border-radius:8px;background:rgba(251,114,153,.08);border:1px solid rgba(251,114,153,.25)}
.bt-note{font-size:11px;color:#7a8090;padding:8px 11px;border-radius:8px;background:rgba(255,255,255,.03);border:1px dashed #343642;line-height:1.6}
.bt-root::before{content:"";flex:none;height:3px;background:linear-gradient(90deg,#FB7299,#ffa3c0 55%,#FB7299)}
.bt-login{display:flex;align-items:center;gap:10px;padding:11px 12px;border:1px solid #292b35;border-radius:10px;background:#20212a}
.bt-nick{font-weight:600;font-size:15px;color:#f0f1f5;line-height:1.3}
.bt-logbox{background:#181921;border:1px solid #262832;border-radius:8px;padding:9px 11px}
`;

    let cssInjected = false;
    function injectCss() {
      if (cssInjected || typeof document === "undefined") return;
      cssInjected = true;
      const style = document.createElement("style");
      style.setAttribute("data-dsh-bili-ticket", "");
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    // ------------------------------------------------------------------ //
    // presentation helpers
    // ------------------------------------------------------------------ //
    const STATUS_LABEL = {
      idle: "待启动", waiting: "等待开售", running: "运行中",
      success: "已成功", failed: "失败", needs_captcha: "需验证码", stopped: "已停止"
    };
    const TYPE_LABEL = { grab: "抢票", monitor: "蹲回流" };

    function fmtTime(ts) {
      try { return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false }); }
      catch { return ""; }
    }

    // ------------------------------------------------------------------ //
    // panel component
    // ------------------------------------------------------------------ //
    function Panel({ onClose }) {
      const [status, setStatus] = useState(null);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      const [qrPath, setQrPath] = useState(null);
      const rootRef = useRef(null);
      const [pos, setPos] = useState(null);   // null = 默认靠右；拖拽后为 { left, top }

      const refresh = useCallback(async () => {
        try { setStatus(await call("status")); setError(null); }
        catch (e) { setError(String(e?.message ?? e)); }
      }, []);

      useEffect(() => {
        refresh();
        const t = setInterval(refresh, 2000);
        return () => clearInterval(t);
      }, [refresh]);

      async function act(endpoint, payload) {
        setBusy(true);
        setError(null);
        try { await call(endpoint, payload); await refresh(); }
        catch (e) { setError(String(e?.message ?? e)); }
        finally { setBusy(false); }
      }

      async function doQrLogin() {
        setBusy(true);
        setError(null);
        setQrPath(null);
        try {
          const r = await call("login-qr", {});
          if (r?.filePath) setQrPath(r.filePath);
          await refresh();
        } catch (e) { setError(String(e?.message ?? e)); }
        finally { setBusy(false); }
      }

      // ---- 面板拖拽（按住标题栏拖动，可拖到屏幕任意位置）----
      function startDrag(e) {
        if (e.target.closest("button")) return;   // 点关闭按钮不触发拖动
        const el = rootRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const offX = e.clientX - rect.left;
        const offY = e.clientY - rect.top;
        function onMove(ev) {
          const x = ev.clientX - offX;
          const y = ev.clientY - offY;
          const maxX = Math.max(0, window.innerWidth - 80);
          const maxY = Math.max(0, window.innerHeight - 48);
          setPos({ left: Math.max(0, Math.min(x, maxX)), top: Math.max(0, Math.min(y, maxY)) });
        }
        function onUp() {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
        }
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      }

      // ---- 参数 / 选项目 / 建任务 ----
      const [config, setConfig] = useState(null);
      const [buyers, setBuyers] = useState([]);
      const [kw, setKw] = useState("");
      const [results, setResults] = useState([]);
      const [searching, setSearching] = useState(false);
      const [project, setProject] = useState(null);   // { projectId, title, tickets }
      const [ticket, setTicket] = useState(null);     // { skuId, screenId, name, price }
      const [form, setForm] = useState({ type: "monitor", num: "1", buyerId: "", pollIntervalMs: "", stormIntervalMs: "", name: "" });

      const loadConfig = useCallback(async () => {
        try { setConfig(await call("config/get", {})); } catch { /* 非关键 */ }
      }, []);
      const loadBuyers = useCallback(async () => {
        try { const r = await call("buyers", {}); setBuyers(r?.buyers ?? []); } catch { /* 非关键 */ }
      }, []);

      useEffect(() => { loadConfig(); loadBuyers(); }, [loadConfig, loadBuyers]);

      function setField(k, v) { setForm((f) => ({ ...f, [k]: v })); }
      function setCfgField(k, v) { setConfig((c) => ({ ...(c ?? {}), [k]: v })); }

      async function doSearch() {
        if (!kw.trim()) return;
        setSearching(true); setError(null);
        try {
          const r = await call("search", { keyword: kw.trim() });
          setResults(r?.items ?? []);
        } catch (e) { setError(String(e?.message ?? e)); }
        finally { setSearching(false); }
      }

      async function pickProject(p) {
        setBusy(true); setError(null);
        setTicket(null);
        try {
          const r = await call("detail", { projectId: p.projectId });
          setProject({ projectId: p.projectId, title: p.title, tickets: r?.tickets ?? [] });
        } catch (e) { setError(String(e?.message ?? e)); setProject(null); }
        finally { setBusy(false); }
      }

      function pickTicket(t) { setTicket(t); }

      async function saveConfig() {
        setBusy(true); setError(null);
        try {
          const r = await call("config/set", {
            pollIntervalMs: config?.pollIntervalMs,
            stormLeadMs: config?.stormLeadMs,
            stormIntervalMs: config?.stormIntervalMs,
            orderTimeoutMs: config?.orderTimeoutMs
          });
          if (r?.ok === false) setError(r.error ?? "参数保存失败");
          else { setConfig(r.config ?? r); await refresh(); }
        } catch (e) { setError(String(e?.message ?? e)); }
        finally { setBusy(false); }
      }

      async function createTask() {
        if (!project?.projectId || !ticket?.skuId) { setError("请先搜索并选择项目与票档"); return; }
        setBusy(true); setError(null);
        try {
          const r = await call("task/create", {
            name: form.name || (`${project.title || "任务"}-${ticket.name || ""}`).slice(0, 30),
            type: form.type,
            projectId: project.projectId,
            screenId: ticket.screenId || null,
            skuIds: [ticket.skuId],
            num: Number(form.num) || 1,
            buyerIds: form.buyerId ? [form.buyerId] : [],
            pollIntervalMs: form.pollIntervalMs,
            stormIntervalMs: form.stormIntervalMs
          });
          if (r?.error) setError(r.error);
          else {
            setProject(null); setTicket(null); setResults([]); setKw("");
            setForm((f) => ({ ...f, name: "" }));
            await refresh();
          }
        } catch (e) { setError(String(e?.message ?? e)); }
        finally { setBusy(false); }
      }

      function cfgField(label, key) {
        return h("div", { className: "bt-form-row" },
          h("span", { className: "bt-label" }, label),
          h("input", { className: "bt-input", type: "number", min: "0", value: config?.[key] ?? "", onChange: (e) => setCfgField(key, e.target.value) })
        );
      }

      const loggedIn = status?.loggedIn === true;
      const tasks = status?.tasks ?? [];
      const logs = status?.recentLogs ?? [];
      const running = new Set(status?.runningTaskIds ?? []);

      const taskEls = tasks.length
        ? tasks.map((t) => {
            const isRunning = running.has(t.id) || t.status === "running" || t.status === "waiting";
            return h("div", { key: t.id, className: "bt-task bt-st-" + t.status },
              h("div", { className: "bt-task-head" },
                h("span", { className: "bt-task-name", title: t.name }, t.name),
                h("span", { className: "bt-badge " + t.type }, TYPE_LABEL[t.type] ?? t.type),
                h("span", { className: "bt-badge " + t.status }, STATUS_LABEL[t.status] ?? t.status)
              ),
              (t.attemptCount != null || t.lastError || t.orderId || t.pollIntervalMs != null || t.stormIntervalMs != null) ? h("div", { className: "bt-meta" },
                [t.attemptCount != null ? `尝试 ${t.attemptCount} 次` : null,
                 t.pollIntervalMs != null ? `蹲回流 ${t.pollIntervalMs}ms` : null,
                 t.stormIntervalMs != null ? `抢票 ${t.stormIntervalMs}ms` : null,
                 t.orderId ? `订单 ${t.orderId}` : null,
                 t.lastError ? `错误: ${t.lastError}` : null].filter(Boolean).join(" · ")
              ) : null,
              h("div", { className: "bt-actions" },
                isRunning
                  ? h("button", { className: "bt-btn", disabled: busy, onClick: () => act("task/stop", { taskId: t.id }) }, "停止")
                  : h("button", { className: "bt-btn primary", disabled: busy, onClick: () => act("task/start", { taskId: t.id }) }, "启动"),
                h("button", { className: "bt-btn danger", disabled: busy, onClick: () => act("task/delete", { taskId: t.id }) }, "删除")
              )
            );
          })
        : [h("div", { key: "empty", className: "bt-empty" }, "暂无任务")];

      const logEls = logs.length
        ? logs.slice(-30).map((l, i) =>
            h("div", { key: i, className: "bt-log-line" },
              h("span", { className: "bt-log-time" }, fmtTime(l.ts)),
              h("span", { className: "bt-log-msg " + (l.level === "warn" || l.level === "error" ? l.level : "") }, String(l.msg))
            ))
        : [h("div", { key: "empty", className: "bt-empty" }, "暂无日志")];

      const resultEls = results.length
        ? results.map((it) =>
            h("div", { key: it.projectId, className: "bt-search-item" + (project?.projectId === it.projectId ? " sel" : ""), onClick: () => pickProject(it) },
              h("div", { style: { flex: 1, minWidth: 0 } },
                h("div", { className: "bt-search-name", title: it.title }, it.title),
                [it.city, it.venue, it.saleTime].filter(Boolean).length ? h("div", { className: "bt-meta" }, [it.city, it.venue, it.saleTime].filter(Boolean).join(" · ")) : null
              ),
              it.price ? h("span", { className: "bt-search-price" }, it.price) : null
            ))
        : [h("div", { key: "empty", className: "bt-empty" }, "无结果")];

      const ticketEls = project?.tickets?.length
        ? project.tickets.map((tk) =>
            h("div", { key: tk.skuId, className: "bt-ticket" + (ticket?.skuId === tk.skuId ? " sel" : ""), onClick: () => pickTicket(tk) },
              h("span", { className: "bt-ticket-name" }, tk.name),
              tk.price != null ? h("span", { className: "bt-ticket-price" }, tk.price + "元") : null
            ))
        : null;

      return h("div", { className: "bt-root", ref: rootRef, style: pos ? { left: pos.left + "px", top: pos.top + "px", right: "auto" } : null },
        h("div", { className: "bt-head", onMouseDown: startDrag },
          h("span", { className: "bt-title" }, "会员购抢票"),
          h("button", { className: "bt-close", onClick: onClose, title: "关闭" }, "×")
        ),
        h("div", { className: "bt-body" },
          h("div", { className: "bt-login" },
            h("span", { className: "bt-dot " + (loggedIn ? "ok" : "bad") }),
            loggedIn
              ? h("div", { style: { flex: 1, display: "flex", flexDirection: "column" } },
                  h("span", { className: "bt-nick" }, status?.userName || "已登录"),
                  status?.uid ? h("span", { className: "bt-meta" }, "UID " + status.uid) : null
                )
              : h("span", { style: { flex: 1 } }, "未登录"),
            h("button", { className: "bt-btn primary", disabled: busy, onClick: doQrLogin }, "扫码登录")
          ),
          qrPath ? h("div", { className: "bt-qr" }, "二维码图片：" + qrPath + "（双击打开扫码）") : null,
          error ? h("div", { className: "bt-warn" }, String(error)) : null,
          status?.captcha ? h("div", { className: "bt-warn" }, status.captcha) : null,
          h("div", { className: "bt-note" }, "搜项目、建任务、抢票、调参数，都可以直接跟 AI 对话完成——下面的手动设置只是可选快捷方式。"),

          h("div", { className: "bt-section" }, "抢票参数"),
          h("div", { className: "bt-form" },
            cfgField("蹲回流间隔(ms)", "pollIntervalMs"),
            cfgField("抢票风暴间隔(ms)", "stormIntervalMs"),
            cfgField("开售提前量(ms)", "stormLeadMs"),
            cfgField("下单超时(ms)", "orderTimeoutMs"),
            h("div", { className: "bt-form-row" },
              h("button", { className: "bt-btn primary", disabled: busy, onClick: saveConfig }, "保存参数"),
              h("span", { className: "bt-hint" }, "保存后重启也生效")
            )
          ),

          h("div", { className: "bt-section" }, "新建任务"),
          h("div", { className: "bt-form" },
            h("div", { className: "bt-form-row" },
              h("input", { className: "bt-input", placeholder: "搜索演出/漫展关键词", value: kw, onChange: (e) => setKw(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") doSearch(); } }),
              h("button", { className: "bt-btn", disabled: searching || busy, onClick: doSearch }, searching ? "搜索中" : "搜索")
            ),
            results.length ? h("div", { className: "bt-search-list" }, resultEls) : null,
            project ? h("div", { className: "bt-sel" }, "已选项目：" + project.title) : null,
            project && ticketEls ? h("div", { className: "bt-ticket-list" }, ticketEls) : null,
            ticket ? h("div", { className: "bt-sel" }, "已选票档：" + ticket.name + (ticket.price != null ? " · " + ticket.price + "元" : "")) : null,

            h("div", { className: "bt-form-row" },
              h("span", { className: "bt-label" }, "模式"),
              h("select", { className: "bt-select", value: form.type, onChange: (e) => setField("type", e.target.value) },
                h("option", { value: "monitor" }, "蹲回流"),
                h("option", { value: "grab" }, "抢票")
              )
            ),
            h("div", { className: "bt-form-row" },
              h("span", { className: "bt-label" }, "数量"),
              h("input", { className: "bt-input", type: "number", min: "1", max: "6", value: form.num, onChange: (e) => setField("num", e.target.value) })
            ),
            h("div", { className: "bt-form-row" },
              h("span", { className: "bt-label" }, "购票人"),
              h("select", { className: "bt-select", value: form.buyerId, onChange: (e) => setField("buyerId", e.target.value) },
                h("option", { value: "" }, "不指定"),
                ...(buyers.map((b) => h("option", { key: b.id, value: b.id }, `${b.name}`)))
              )
            ),
            h("div", { className: "bt-form-row" },
              h("span", { className: "bt-label" }, "蹲回流间隔"),
              h("input", { className: "bt-input", type: "number", min: "0", placeholder: "留空用全局", value: form.pollIntervalMs, onChange: (e) => setField("pollIntervalMs", e.target.value) })
            ),
            h("div", { className: "bt-form-row" },
              h("span", { className: "bt-label" }, "抢票间隔"),
              h("input", { className: "bt-input", type: "number", min: "0", placeholder: "留空用全局", value: form.stormIntervalMs, onChange: (e) => setField("stormIntervalMs", e.target.value) })
            ),
            h("div", { className: "bt-form-row" },
              h("span", { className: "bt-label" }, "名称"),
              h("input", { className: "bt-input", placeholder: "可选，默认自动", value: form.name, onChange: (e) => setField("name", e.target.value) })
            ),
            h("div", { className: "bt-form-row" },
              h("button", { className: "bt-btn primary", disabled: busy, onClick: createTask }, "创建任务"),
              h("span", { className: "bt-hint" }, "创建后需在下方点「启动」")
            )
          ),

          h("div", { className: "bt-section" }, `任务 (${tasks.length})`),
          taskEls,

          h("div", { className: "bt-section" }, "最近日志"),
          h("div", { className: "bt-log bt-logbox" }, logEls)
        )
      );
    }

    // ------------------------------------------------------------------ //
    // sidebar button + overlay
    // ------------------------------------------------------------------ //
    function SidebarButton({ wide }) {
      return h("button", { className: "bt-sb", title: "会员购抢票", onClick: () => openStore.set(true) },
        h("span", { className: "bt-sb-dot" }),
        wide ? h("span", null, "抢票") : null
      );
    }

    function Overlay() {
      const open = useSyncExternalStore(openStore.subscribe, openStore.getSnapshot);
      if (!open) return null;
      return h(Panel, { onClose: () => openStore.set(false) });
    }

    // ------------------------------------------------------------------ //
    // apply
    // ------------------------------------------------------------------ //
    exports.inject = ["slots", "connection"];
    exports.apply = function (ctx) {
      setRpc(ctx.connection?.rpc ?? null);
      injectCss();

      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
        { name: "sidebar.footer.action", id: "dsh-bili-ticket", order: 30 },
        SidebarButton
      ));

      ctx.slots.inject("shell.overlay", () => ctx.slots.register(
        { name: "shell.overlay", id: "dsh-bili-ticket-panel" },
        Overlay
      ));
    };

    return module.exports;
  }
});
