/* ============================================
 * 小说创作模块 v5.9.126 —— 规划 / 角色 / 伏笔 / 写作 / 审查 / 复盘
 * 五大视图：概览 / 规划 / 写作 / 审查 / 复盘
 * 数据：data/novel.json（首次访问 seed 自动载入）
 * 设计闭环：角色关系 + 事件节点 + 伏笔状态机 + 章草稿 + 4 维审查 + 周复盘
 * ============================================ */
(function (root) {
  "use strict";

  if (root.Novel) return;

  // ============================================================
  // 1. 数据层
  // ============================================================
  function nvDB() {
    if (typeof DB === "undefined" || !DB.data) return { books: [], chars: [], events: [], foreshadows: [], chapters: [], reviews: [], milestones: [] };
    if (!DB.data.novel) DB.data.novel = { books: [], chars: [], events: [], foreshadows: [], chapters: [], reviews: [], milestones: [] };
    return DB.data.novel;
  }
  function nvSave() {
    if (typeof DB !== "undefined" && DB.save) { try { DB.save(); } catch (e) {} }
  }
  function nvGet(id) {
    var d = nvDB();
    for (var i = 0; i < d.books.length; i++) if (d.books[i].id === id) return d.books[i];
    return null;
  }
  function nvChar(id) {
    var d = nvDB();
    for (var i = 0; i < d.chars.length; i++) if (d.chars[i].id === id) return d.chars[i];
    return null;
  }
  function nvChapter(id) {
    var d = nvDB();
    for (var i = 0; i < d.chapters.length; i++) if (d.chapters[i].id === id) return d.chapters[i];
    return null;
  }
  function nvForeshadow(id) {
    var d = nvDB();
    for (var i = 0; i < d.foreshadows.length; i++) if (d.foreshadows[i].id === id) return d.foreshadows[i];
    return null;
  }

  // 简易 ID 生成
  function nvUid(p) { return (p || "id") + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  // ============================================================
  // 2. Seed 加载（与 consumer.js 一致）
  // ============================================================
  var seedTried = false;
  function nvLoadSeed() {
    if (seedTried) return;
    seedTried = true;
    if (typeof localStorage === "undefined") return;
    if (localStorage.getItem("nv_seed_loaded")) return;
    var db = nvDB();
    if (db.books && db.books.length) { localStorage.setItem("nv_seed_loaded", "1"); return; }
    var ver = (typeof APP_VERSION !== "undefined") ? APP_VERSION : "0";
    fetch("data/novel.json?v=" + ver)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.books) return;
        ["books", "chars", "events", "foreshadows", "chapters", "reviews", "milestones"].forEach(function (k) {
          if (Array.isArray(j[k])) db[k] = j[k].slice();
        });
        nvSave();
        localStorage.setItem("nv_seed_loaded", "1");
        try { if (typeof render === "function") render(); } catch (e) {}
      }).catch(function () {});
  }

  // ============================================================
  // 3. 工具函数
  // ============================================================
  // 中文字数统计（按字计数，标点不算）
  function nvCnWordCount(s) {
    s = String(s || "");
    var m = s.match(/[\u4e00-\u9fff]/g);
    return m ? m.length : 0;
  }

  // 总字数（一本书）
  function nvBookWordCount(bookId) {
    var d = nvDB();
    var sum = 0;
    d.chapters.forEach(function (c) {
      if (c.bookId === bookId) sum += nvCnWordCount(c.draft);
    });
    return sum;
  }

  // 章节状态徽标
  var CHAPTER_STATUS_META = {
    draft: { label: "草稿", color: "#94a3b8" },
    revised: { label: "已润色", color: "#f59e0b" },
    final: { label: "定稿", color: "#10b981" }
  };

  // 伏笔状态机：合法迁移 setup → pending → paid/lost；paid/lost → pending（重提）允许
  var FORESHADOW_STATUS = ["setup", "pending", "paid", "lost"];
  var FORESHADOW_LABEL = { setup: "已埋", pending: "待兑", paid: "已兑", lost: "遗失" };
  var FORESHADOW_COLOR = { setup: "#0ea5e9", pending: "#f59e0b", paid: "#10b981", lost: "#94a3b8" };
  function nvFsTransition(fs, nextStatus) {
    if (!fs) return { ok: false, msg: "伏笔不存在" };
    if (FORESHADOW_STATUS.indexOf(nextStatus) < 0) return { ok: false, msg: "非法状态：" + nextStatus };
    var cur = fs.status;
    // 状态机规则
    var allowed = {
      setup: ["pending", "lost"],
      pending: ["paid", "lost", "setup"],  // pending 可以退回 setup（重置条件）
      paid: ["pending"],                     // 已兑现可以重新激活（如：被误解/重提）
      lost: ["pending"]                      // 遗失可重新激活
    };
    if (cur === nextStatus) return { ok: true, noop: true };
    if ((allowed[cur] || []).indexOf(nextStatus) < 0) {
      return { ok: false, msg: "伏笔状态不可由 " + FORESHADOW_LABEL[cur] + " 直接迁移到 " + FORESHADOW_LABEL[nextStatus] };
    }
    fs.status = nextStatus;
    if (nextStatus === "paid" && fs.payoffChapter == null) {
      // 自动推断 payoffChapter = 当前最大章节号 + 1
      var d = nvDB();
      var maxN = 0;
      d.chapters.forEach(function (c) { if (c.bookId === fs.bookId && c.num > maxN) maxN = c.num; });
      fs.payoffChapter = maxN + 1;
    }
    return { ok: true };
  }

  // 列出书的伏笔（按 status 分组）
  function nvBookForeshadows(bookId) {
    var d = nvDB();
    var grp = { setup: [], pending: [], paid: [], lost: [] };
    d.foreshadows.forEach(function (f) {
      if (f.bookId === bookId) grp[f.status].push(f);
    });
    return grp;
  }

  // 列书中"待兑"伏笔（用于续写时自动挑出）
  function nvBookPendingFs(bookId) {
    var d = nvDB();
    var arr = [];
    d.foreshadows.forEach(function (f) {
      if (f.bookId === bookId && (f.status === "setup" || f.status === "pending")) arr.push(f);
    });
    return arr;
  }

  // ============================================================
  // 4. 章审 4 维 + 自动 issue 生成
  // ============================================================
  var ISSUE_TYPE_LABEL = {
    pace: "节奏",
    tension: "张力",
    continuity: "连贯",
    setup_unpaid: "伏笔未兑",
    character_inconsistent: "角色不一致",
    foreshadow_lost: "伏笔遗失"
  };
  var ISSUE_TYPE_COLOR = {
    pace: "#0ea5e9",
    tension: "#ef4444",
    continuity: "#f59e0b",
    setup_unpaid: "#8b5cf6",
    character_inconsistent: "#ec4899",
    foreshadow_lost: "#94a3b8"
  };

  // 自动分析章文本，产出 issues 列表（启发式 + 规则）
  function nvReviewChapter(chapterId) {
    var ch = nvChapter(chapterId);
    if (!ch) return null;
    var d = nvDB();
    var issues = [];

    // 维度 1：节奏 —— 中文正文字数 < 800 视为节奏过快（草稿级），> 2500 视为拖沓
    var wc = nvCnWordCount(ch.draft);
    var pacing = wc < 800 ? 2 : (wc > 2500 ? 2 : 4);

    // 维度 2：张力 —— 标点密度（！、？、……）粗略估计
    var tens = (ch.draft.match(/[！!？?……]/g) || []).length;
    var tension = tens < 2 ? 2 : (tens > 12 ? 5 : 3);

    // 维度 3：连续性 —— 检查是否引入未在之前章节出现的新角色名（粗启发）
    var bookChars = d.chars.filter(function (x) { return x.bookId === ch.bookId; });
    var knownIds = new Set();
    d.chapters.forEach(function (c) {
      if (c.bookId !== ch.bookId) return;
      if (c.num >= ch.num) return;
      bookChars.forEach(function (ch2) { if ((c.draft || "").indexOf(ch2.name) >= 0) knownIds.add(ch2.id); });
    });
    bookChars.forEach(function (cc) {
      if (cc.firstAppearChapter > ch.num) {
        // 还未出场但被提及：可能是设定冲突
      }
      if ((ch.draft || "").indexOf(cc.name) >= 0 && !knownIds.has(cc.id) && cc.firstAppearChapter > ch.num) {
        issues.push({ type: "character_inconsistent", note: "角色「" + cc.name + "」原计划第 " + cc.firstAppearChapter + " 章后出场，本章提前出场且无铺垫" });
      }
    });
    var continuity = issues.filter(function (i) { return i.type === "character_inconsistent"; }).length === 0 ? 4 : 3;

    // 维度 4：伏笔 —— 本章若设了 setup 但同一作者在 5 章内仍未兑现
    d.foreshadows.forEach(function (f) {
      if (f.bookId !== ch.bookId) return;
      if (f.setupChapter === ch.num && f.status === "setup") {
        // 5 章内未升级到 pending 即视为遗忘
        var later = d.chapters.filter(function (c) { return c.bookId === ch.bookId && c.num > ch.num && c.num <= ch.num + 5; });
        if (later.length >= 5) {
          issues.push({ type: "foreshadow_lost", note: "伏笔「" + f.title + "」在第 " + ch.num + " 章铺设，5 章内未升级为待兑，可能被遗忘" });
        }
      }
    });

    return {
      pacing: pacing,
      tension: tension,
      continuity: continuity,
      wc: wc,
      issues: issues
    };
  }

  // ============================================================
  // 5. 脚手架：润色 / 续写
  // ============================================================
  // 润色：把用户的润色意图写到 chapter.notes[]
  function nvScaffoldPolish(chapterId, payload) {
    var ch = nvChapter(chapterId);
    if (!ch) return { ok: false, msg: "章节不存在" };
    if (!ch.notes) ch.notes = [];
    ch.notes.push({
      kind: "polish",
      location: String(payload.location || "").slice(0, 200),
      issueType: String(payload.issueType || "其他"),
      expect: String(payload.expect || "").slice(0, 500),
      keep: String(payload.keep || "").slice(0, 200),
      ts: new Date().toISOString()
    });
    nvSave();
    return { ok: true };
  }

  // 续写：输出提纲级（不写正文），写入 chapter.notes[]，并自动挑出本卷待兑现伏笔
  function nvScaffoldContinue(bookId, payload) {
    var d = nvDB();
    var pending = nvBookPendingFs(bookId);
    var book = nvGet(bookId);
    if (!book) return { ok: false, msg: "书不存在" };
    var maxN = 0;
    d.chapters.forEach(function (c) { if (c.bookId === bookId && c.num > maxN) maxN = c.num; });
    var nextNum = maxN + 1;

    // 自动挑必兑现伏笔：用户勾选 + 伏笔状态非 paid
    var mustPay = [];
    if (Array.isArray(payload.foreshadowIds)) {
      payload.foreshadowIds.forEach(function (fid) {
        var f = nvForeshadow(fid);
        if (f && f.bookId === bookId && f.status !== "paid") mustPay.push(f);
      });
    }
    var suggestFs = pending.filter(function (f) { return f.status === "pending"; }).slice(0, 3);

    var outline = "【续写提纲 #" + nextNum + "】\n" +
      "承接：" + (payload.tailFromPrev || "（未填）") + "\n" +
      "本章目标：" + (payload.goal || "（未填）") + "\n" +
      "必出角色：" + (payload.mustChars || "（未填）") + "\n" +
      "必兑现伏笔：" + (mustPay.map(function (f) { return f.title + "(#ch" + (f.setupChapter || "?") + ")"; }).join("、") || "（无）") + "\n" +
      "建议兑现伏笔：" + (suggestFs.map(function (f) { return f.title; }).join("、") || "（无）") + "\n" +
      "状态：提纲级（请作者自行扩展为正文）";

    // 写一条续写笔记到最后一章（用于历史溯源）
    var lastCh = d.chapters.filter(function (c) { return c.bookId === bookId; }).sort(function (a, b) { return b.num - a.num; })[0];
    if (lastCh) {
      if (!lastCh.notes) lastCh.notes = [];
      lastCh.notes.push({
        kind: "continue",
        nextNum: nextNum,
        outline: outline,
        ts: new Date().toISOString()
      });
    }
    nvSave();
    return { ok: true, outline: outline, mustPay: mustPay, suggestFs: suggestFs, nextNum: nextNum };
  }

  // ============================================================
  // 6. UI 工具
  // ============================================================
  function esc(s) {
    if (typeof escapeHtml === "function") return escapeHtml(String(s == null ? "" : s));
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function badge(text, color) {
    return '<span class="nv-b" style="background:' + color + '22;color:' + color + '">' + esc(text) + '</span>';
  }
  function today() { return (typeof root.today === "function") ? root.today() : new Date().toISOString().slice(0, 10); }

  // 顶层 tab
  var TABS = [
    { k: "overview", t: "概览" },
    { k: "planning", t: "规划" },
    { k: "writing", t: "写作" },
    { k: "review", t: "审查" },
    { k: "recap", t: "复盘" }
  ];
  function getTab() { return (typeof root.NV_TAB !== "undefined") ? root.NV_TAB : "overview"; }
  function setTab(k) { root.NV_TAB = k; if (typeof render === "function") render(); }

  // 路由 detail（章/伏笔/角色详情）
  function getView() { return (typeof root.NV_VIEW !== "undefined") ? root.NV_VIEW : "list"; }

  // ============================================================
  // 7. 入口
  // ============================================================
  function renderNovel() {
    var c = document.getElementById("app-content");
    if (!c) return;
    nvLoadSeed();
    var v = getView();
    if (v && v !== "list") {
      // detail 路由
      var parts = v.split(":");
      if (parts[0] === "chapter") return renderNovelChapterDetail(c, parts[1]);
      if (parts[0] === "char") return renderNovelCharDetail(c, parts[1]);
      if (parts[0] === "foreshadow") return renderNovelFsDetail(c, parts[1]);
    }
    var t = getTab();
    if (t === "planning") return renderNovelPlanning(c);
    if (t === "writing") return renderNovelWriting(c);
    if (t === "review") return renderNovelReview(c);
    if (t === "recap") return renderNovelRecap(c);
    return renderNovelOverview(c);
  }

  // Tab 栏
  function tabBarHtml() {
    var t = getTab();
    return '<div class="nv-tabs">' + TABS.map(function (x) {
      return '<span class="nv-tab' + (t === x.k ? " active" : "") + '" onclick="NV_TAB=\'' + x.k + '\';NV_VIEW=\'list\';render()">' + x.t + '</span>';
    }).join("") + '</div>';
  }

  // ============================================================
  // 8. 概览视图
  // ============================================================
  function renderNovelOverview(c) {
    var d = nvDB();
    var books = d.books || [];
    var totalPending = 0, totalLost = 0;
    d.foreshadows.forEach(function (f) {
      if (f.status === "pending" || f.status === "setup") totalPending++;
      if (f.status === "lost") totalLost++;
    });
    var totalWords = 0;
    books.forEach(function (b) { totalWords += nvBookWordCount(b.id); });

    var html = '<div class="section-title"><span class="emoji">📚</span> 小说创作</div>';
    html += '<div class="card nv-intro"><div class="card-body">' +
      '<div class="nv-intro-line">轻量闭环：<strong>规划 → 写作 → 审查 → 复盘</strong>。所有数据存本地，导出 JSON 可跨设备。</div>' +
      '<div class="nv-rule-chips">' +
      '<span class="nv-chip">📚 ' + books.length + ' 本书</span>' +
      '<span class="nv-chip">✍️ ' + totalWords.toLocaleString() + ' 字</span>' +
      '<span class="nv-chip">⏳ ' + totalPending + ' 待兑伏笔</span>' +
      '<span class="nv-chip">' + (totalLost > 0 ? '⚠ ' : '✓ ') + totalLost + ' 遗失</span>' +
      '</div>' +
      '<div class="nv-intro-actions">' +
      '<button class="btn btn-primary sm" onclick="nvExportJson()">📤 导出 JSON</button>' +
      '<button class="btn btn-ghost sm" onclick="nvImportJsonPrompt()">📥 导入</button>' +
      '</div>' +
      '</div></div>';

    html += tabBarHtml();

    // 每本书一张卡
    books.forEach(function (book) {
      var wc = nvBookWordCount(book.id);
      var pct = book.targetWords ? Math.min(100, Math.round(wc / book.targetWords * 100)) : 0;
      var fsGrp = nvBookForeshadows(book.id);
      var pendingCount = fsGrp.pending.length + fsGrp.setup.length;
      var lostCount = fsGrp.lost.length;
      var chapCount = d.chapters.filter(function (c) { return c.bookId === book.id; }).length;
      var ms = d.milestones.filter(function (m) { return m.bookId === book.id; }).sort(function (a, b) { return b.date.localeCompare(a.date); });

      html += '<div class="card nv-book-card" onclick="NV_TAB=\'writing\';NV_VIEW=\'chapter:ch_' + book.id.slice(5, 7) + '_01\';render()">' +
        '<div class="nv-book-head">' +
        '<span class="nv-book-title">' + esc(book.title) + '</span>' +
        '<span class="nv-book-genre">' + esc(book.genre || "") + '</span>' +
        '</div>' +
        '<div class="nv-book-progress">' +
        '<div class="nv-progress-track"><div class="nv-progress-fill" style="width:' + pct + '%"></div></div>' +
        '<span class="nv-progress-num">' + wc.toLocaleString() + ' / ' + (book.targetWords || 0).toLocaleString() + ' 字（' + pct + '%）</span>' +
        '</div>' +
        '<div class="nv-book-meta">' +
        '<span>📖 ' + chapCount + ' 章</span>' +
        '<span>⏳ ' + pendingCount + ' 待兑</span>' +
        (lostCount > 0 ? '<span class="nv-warn">⚠ ' + lostCount + ' 遗失</span>' : '<span>✓ ' + fsGrp.paid.length + ' 已兑</span>') +
        '</div>' +
        (ms[0] ? '<div class="nv-book-lastms">最近复盘：' + esc(ms[0].date) + ' · ' + esc((ms[0].reflection || "").slice(0, 60)) + '</div>' : '') +
        '</div>';
    });

    // 近期里程碑
    var allMs = (d.milestones || []).slice().sort(function (a, b) { return b.date.localeCompare(a.date); }).slice(0, 6);
    if (allMs.length) {
      html += '<div class="section-title"><span class="emoji">📈</span> 近期复盘</div><div class="card"><div class="card-body">';
      allMs.forEach(function (m) {
        var bk = nvGet(m.bookId);
        html += '<div class="nv-ms-row"><div class="nv-ms-date">' + esc(m.date) + '</div>' +
          '<div class="nv-ms-content"><b>' + esc(bk ? bk.title : "?") + '</b> · +' + (m.wordsAdded || 0) + ' 字 / ' + (m.chCompleted || 0) + ' 章<br>' +
          '<span class="nv-ms-text">' + esc(m.reflection || "") + '</span></div></div>';
      });
      html += '</div></div>';
    }

    c.innerHTML = html;
  }

  // ============================================================
  // 9. 规划视图：大纲 + 角色 + 事件 + 伏笔
  // ============================================================
  function renderNovelPlanning(c) {
    var d = nvDB();
    var t = (typeof root.NV_PLAN_SUB !== "undefined") ? root.NV_PLAN_SUB : "outline";
    var subTabs = [
      { k: "outline", t: "📑 大纲" },
      { k: "chars", t: "👤 角色" },
      { k: "events", t: "⚡ 事件" },
      { k: "foreshadows", t: "🌱 伏笔" }
    ];

    var html = '<div class="section-title"><span class="emoji">🗺️</span> 规划</div>';
    html += tabBarHtml();
    html += '<div class="nv-subtabs">' + subTabs.map(function (x) {
      return '<span class="nv-subtab' + (t === x.k ? " active" : "") + '" onclick="NV_PLAN_SUB=\'' + x.k + '\';render()">' + x.t + '</span>';
    }).join("") + '</div>';

    if (t === "chars") return renderPlanChars(c, html);
    if (t === "events") return renderPlanEvents(c, html);
    if (t === "foreshadows") return renderPlanForeshadows(c, html);
    return renderPlanOutline(c, html);
  }

  function renderPlanOutline(c, head) {
    var d = nvDB();
    head += '<div class="card"><div class="card-body">';
    d.books.forEach(function (book) {
      head += '<div class="nv-outline-book">' +
        '<div class="nv-outline-h">' + esc(book.title) + ' <span class="nv-dim">· ' + esc(book.world || "") + '</span></div>';
      (book.volumes || []).forEach(function (vol) {
        head += '<div class="nv-outline-vol">📘 ' + esc(vol.title) + '</div><div class="nv-outline-chs">';
        (vol.chapters || []).forEach(function (ch) {
          head += '<div class="nv-outline-ch"><b>第 ' + ch.num + ' 章 ' + esc(ch.title) + '</b>' +
            (ch.goal ? '<div class="nv-dim">' + esc(ch.goal) + '</div>' : '') + '</div>';
        });
        head += '</div>';
      });
      head += '</div>';
    });
    head += '</div></div>';
    c.innerHTML = head;
  }

  function renderPlanChars(c, head) {
    var d = nvDB();
    head += '<div class="nv-list">';
    d.chars.forEach(function (ch) {
      var book = nvGet(ch.bookId);
      head += '<div class="nv-list-item" onclick="NV_VIEW=\'char:' + ch.id + '\';render()">' +
        '<div class="nv-li-head"><b>' + esc(ch.name) + '</b> <span class="nv-dim">' + esc(book ? book.title : "") + '</span></div>' +
        '<div class="nv-li-sub">' +
        badge(ch.role, "#8b5cf6") + ' ' +
        badge(ch.status || "alive", ch.status === "dead" ? "#64748b" : "#10b981") +
        '</div>' +
        '<div class="nv-li-text nv-dim">人物弧：' + esc(ch.arc || "") + '</div>' +
        '</div>';
    });
    head += '</div>';
    c.innerHTML = head;
  }

  function renderPlanEvents(c, head) {
    var d = nvDB();
    head += '<div class="nv-list">';
    d.events.sort(function (a, b) { return a.chapter - b.chapter || (a.bookId || "").localeCompare(b.bookId || ""); }).forEach(function (ev) {
      var book = nvGet(ev.bookId);
      head += '<div class="nv-list-item">' +
        '<div class="nv-li-head"><b>第 ' + ev.chapter + ' 章 · ' + esc(ev.title) + '</b> <span class="nv-dim">· ' + esc(book ? book.title : "") + '</span></div>' +
        '<div class="nv-li-sub">' + badge(ev.type === "conflict" ? "冲突" : ev.type === "timeline" ? "时间跨度" : "剧情", "#0ea5e9") + '</div>' +
        '<div class="nv-li-text">' + esc(ev.summary) + '</div>' +
        (ev.affectedChars && ev.affectedChars.length ? '<div class="nv-li-text nv-dim">涉及：' + ev.affectedChars.map(function (id) { var x = nvChar(id); return esc(x ? x.name : id); }).join("、") + '</div>' : '') +
        '</div>';
    });
    head += '</div>';
    c.innerHTML = head;
  }

  function renderPlanForeshadows(c, head) {
    var d = nvDB();
    // 按书分组
    d.books.forEach(function (book) {
      var grp = nvBookForeshadows(book.id);
      head += '<div class="nv-fs-book">' +
        '<div class="nv-fs-book-h">' + esc(book.title) + ' · ' +
        badge("已埋 " + grp.setup.length, FORESHADOW_COLOR.setup) + ' ' +
        badge("待兑 " + grp.pending.length, FORESHADOW_COLOR.pending) + ' ' +
        badge("已兑 " + grp.paid.length, FORESHADOW_COLOR.paid) + ' ' +
        badge("遗失 " + grp.lost.length, FORESHADOW_COLOR.lost) +
        '</div>';

      var all = grp.setup.concat(grp.pending).concat(grp.paid).concat(grp.lost);
      all.forEach(function (f) {
        head += '<div class="nv-fs-item" onclick="NV_VIEW=\'foreshadow:' + f.id + '\';render()">' +
          '<div class="nv-li-head"><b>' + esc(f.title) + '</b> ' +
          badge(FORESHADOW_LABEL[f.status], FORESHADOW_COLOR[f.status]) +
          ' <span class="nv-dim">· 埋于第 ' + f.setupChapter + ' 章' +
          (f.payoffChapter ? ' · 兑于第 ' + f.payoffChapter + ' 章' : '') + '</span></div>' +
          '<div class="nv-li-text">「' + esc(f.setupSnippet) + '」</div>' +
          (f.note ? '<div class="nv-li-text nv-dim">📌 ' + esc(f.note) + '</div>' : '') +
          '</div>';
      });
    });
    c.innerHTML = head;
  }

  // ============================================================
  // 10. 角色详情
  // ============================================================
  function renderNovelCharDetail(c, charId) {
    var ch = nvChar(charId);
    if (!ch) { c.innerHTML = '<div class="empty-state"><div class="empty-text">角色不存在</div></div>'; return; }
    var html = '<div style="display:flex;gap:8px;margin-bottom:10px"><button class="btn btn-ghost sm" onclick="NV_VIEW=\'list\';NV_TAB=\'planning\';NV_PLAN_SUB=\'chars\';render()">← 返回规划</button></div>';
    html += '<div class="card"><div class="card-body">' +
      '<div class="nv-detail-h">' + esc(ch.name) + ' <span class="nv-dim">' + esc(nvGet(ch.bookId) ? nvGet(ch.bookId).title : "") + '</span></div>' +
      '<div class="nv-detail-row">' + badge(ch.role, "#8b5cf6") + ' ' + badge(ch.status || "alive", ch.status === "dead" ? "#64748b" : "#10b981") + ' · 首次出场：第 ' + ch.firstAppearChapter + ' 章</div>' +
      '<div class="nv-detail-row"><b>人物弧</b>：' + esc(ch.arc || "") + '</div>' +
      '<div class="nv-detail-row"><b>性格</b>：' + (ch.traits || []).map(function (t) { return badge(t, "#0a84ff"); }).join(" ") + '</div>' +
      '<div class="nv-detail-row"><b>秘密</b>：' + (ch.secrets || []).map(function (t) { return '<div class="nv-dim">· ' + esc(t) + '</div>'; }).join("") + '</div>' +
      '<div class="nv-detail-row"><b>关系</b>：';
    (ch.relationships || []).forEach(function (r) {
      var other = nvChar(r.with);
      html += '<div class="nv-rel-line">' + badge(other ? other.name : r.with, "#475569") + ' · ' + esc(r.type) + '</div>';
    });
    html += '</div></div></div>';
    c.innerHTML = html;
  }

  // ============================================================
  // 11. 伏笔详情
  // ============================================================
  function renderNovelFsDetail(c, fsId) {
    var f = nvForeshadow(fsId);
    if (!f) { c.innerHTML = '<div class="empty-state"><div class="empty-text">伏笔不存在</div></div>'; return; }
    var book = nvGet(f.bookId);
    var html = '<div style="display:flex;gap:8px;margin-bottom:10px"><button class="btn btn-ghost sm" onclick="NV_VIEW=\'list\';NV_TAB=\'planning\';NV_PLAN_SUB=\'foreshadows\';render()">← 返回规划</button></div>';
    html += '<div class="card"><div class="card-body">' +
      '<div class="nv-detail-h">' + esc(f.title) + ' <span class="nv-dim">' + esc(book ? book.title : "") + '</span></div>' +
      '<div class="nv-detail-row">' + badge(FORESHADOW_LABEL[f.status], FORESHADOW_COLOR[f.status]) + ' · 铺设于第 ' + f.setupChapter + ' 章' + (f.payoffChapter ? ' · 兑现于第 ' + f.payoffChapter + ' 章' : '') + '</div>' +
      '<div class="nv-detail-row"><b>原文出处</b>：<div class="nv-quote">「' + esc(f.setupSnippet) + '」</div></div>' +
      (f.note ? '<div class="nv-detail-row"><b>笔记</b>：' + esc(f.note) + '</div>' : '') +
      '<div class="nv-detail-row nv-detail-actions">' +
      '<div class="nv-label">状态迁移（伏笔状态机）：</div>' +
      '<div class="nv-fs-trans">';
    FORESHADOW_STATUS.forEach(function (st) {
      if (st === f.status) return;
      var r = nvFsTransition(f, st); // 试运行以提示
      html += '<button class="btn btn-ghost sm" ' + (r.ok ? '' : 'disabled title="' + esc(r.msg) + '"') + ' onclick="nvFsTrans(\'' + f.id + '\',\'' + st + '\')">' +
        '→ ' + FORESHADOW_LABEL[st] + '</button>';
    });
    html += '</div></div></div></div>';
    c.innerHTML = html;
  }

  // 伏笔状态迁移（UI 调用）
  root.nvFsTrans = function (fsId, nextStatus) {
    var f = nvForeshadow(fsId);
    var r = nvFsTransition(f, nextStatus);
    if (r.ok) { nvSave(); if (typeof render === "function") render(); }
    else { if (typeof showToast === "function") showToast(r.msg, "error"); }
  };

  // ============================================================
  // 12. 写作视图
  // ============================================================
  function renderNovelWriting(c) {
    var d = nvDB();
    var t = (typeof root.NV_WRITE_SUB !== "undefined") ? root.NV_WRITE_SUB : "list";
    var subTabs = [
      { k: "list", t: "📚 章列表" },
      { k: "scaffold", t: "🛠 续写 / 润色" }
    ];

    var html = '<div class="section-title"><span class="emoji">✍️</span> 写作</div>';
    html += tabBarHtml();
    html += '<div class="nv-subtabs">' + subTabs.map(function (x) {
      return '<span class="nv-subtab' + (t === x.k ? " active" : "") + '" onclick="NV_WRITE_SUB=\'' + x.k + '\';render()">' + x.t + '</span>';
    }).join("") + '</div>';

    if (t === "scaffold") return renderWriteScaffold(c, html);
    return renderWriteList(c, html);
  }

  function renderWriteList(c, head) {
    var d = nvDB();
    d.books.forEach(function (book) {
      var bookChs = d.chapters.filter(function (c) { return c.bookId === book.id; }).sort(function (a, b) { return a.num - b.num; });
      head += '<div class="card nv-write-book">' +
        '<div class="nv-write-book-h">' + esc(book.title) + ' <span class="nv-dim">· ' + bookChs.length + ' 章 · ' + nvBookWordCount(book.id).toLocaleString() + ' 字</span></div>';
      bookChs.forEach(function (ch) {
        var sm = CHAPTER_STATUS_META[ch.status] || CHAPTER_STATUS_META.draft;
        head += '<div class="nv-write-ch" onclick="NV_VIEW=\'chapter:' + ch.id + '\';render()">' +
          '<div class="nv-write-ch-l"><b>第 ' + ch.num + ' 章 · ' + esc(ch.title) + '</b></div>' +
          '<div class="nv-write-ch-r">' + badge(sm.label, sm.color) + ' <span class="nv-dim">' + nvCnWordCount(ch.draft) + ' 字</span></div>' +
          '</div>';
      });
      head += '</div>';
    });
    c.innerHTML = head;
  }

  function renderWriteScaffold(c, head) {
    var d = nvDB();
    head += '<div class="card nv-scaffold-card"><div class="card-body">' +
      '<div class="nv-detail-h">🛠 续写 / 润色脚手架</div>' +
      '<div class="nv-dim">不调用 LLM，只沉淀你的意图与上下文，生成结构化提纲/清单供你自行发挥或贴到外部 AI。</div>' +
      '<div class="nv-scaffold-tabs">' +
      '<span class="nv-subtab active" onclick="NV_WRITE_SUB=\'scaffold\';render()">续写新章</span>' +
      '</div>';

    head += '<div class="nv-form"><div class="nv-form-h">📝 续写新章</div>' +
      '<label>目标书</label><select id="nv-cont-book">' + d.books.map(function (b) { return '<option value="' + b.id + '">' + esc(b.title) + '</option>'; }).join("") + '</select>' +
      '<label>承接上一章的最后一句 / 关键情节</label><textarea id="nv-cont-tail" rows="2" placeholder="例：陈哲在父亲忌日打开硬盘..."></textarea>' +
      '<label>本章目标（想达成什么）</label><textarea id="nv-cont-goal" rows="2" placeholder="例：揭示硬盘内容，引出浮光名字的真正含义"></textarea>' +
      '<label>必出角色（用空格分隔多角色名）</label><input id="nv-cont-chars" placeholder="例：陈哲 苏宁">' +
      '<label>必兑现伏笔（自动挑出 setup+pending）</label><div id="nv-cont-fs" class="nv-fs-checks"></div>' +
      '<button class="btn btn-primary" onclick="nvDoContinue()">生成续写提纲</button>' +
      '<div id="nv-cont-out"></div>' +
      '</div>';

    // 润色旧章
    head += '<div class="nv-form"><div class="nv-form-h">✨ 润色旧章</div>' +
      '<label>目标章节</label><select id="nv-pol-ch">' + d.chapters.map(function (ch) {
        var b = nvGet(ch.bookId);
        return '<option value="' + ch.id + '">' + esc(b ? b.title : "?") + ' · 第 ' + ch.num + ' 章 ' + esc(ch.title) + '</option>';
      }).join("") + '</select>' +
      '<label>原文位置（句子摘录或段落起止）</label><textarea id="nv-pol-loc" rows="2" placeholder="例：开篇第 2 段『火从宗门大殿一路烧到了后山…』"></textarea>' +
      '<label>问题类型</label><select id="nv-pol-type"><option>啰嗦</option><option>节奏过快</option><option>节奏过慢</option><option>语气不一致</option><option>视角漂移</option><option>其他</option></select>' +
      '<label>期望改法（保留什么 / 改成什么）</label><textarea id="nv-pol-expect" rows="2" placeholder="例：把环境描写从 5 句压到 1 句，保留最后那句的火光意象"></textarea>' +
      '<label>必须保留的关键词 / 句子</label><input id="nv-pol-keep" placeholder="例：老丹、那半截残玉">' +
      '<button class="btn btn-primary" onclick="nvDoPolish()">写入润色清单</button>' +
      '<div id="nv-pol-out"></div>' +
      '</div>';

    head += '</div></div>';
    c.innerHTML = head;

    // 渲染时填充伏笔复选框
    setTimeout(function () {
      var box = document.getElementById("nv-cont-fs");
      if (!box) return;
      var pending = [];
      d.foreshadows.forEach(function (f) {
        if (f.status === "setup" || f.status === "pending") pending.push(f);
      });
      if (!pending.length) { box.innerHTML = '<span class="nv-dim">暂无待兑现伏笔</span>'; return; }
      box.innerHTML = pending.map(function (f) {
        var b = nvGet(f.bookId);
        return '<label class="nv-fs-check"><input type="checkbox" value="' + f.id + '" data-book="' + f.bookId + '" onclick="nvContFilterFs(this)">' +
          esc(f.title) + ' <span class="nv-dim">（' + esc(b ? b.title : "") + '）</span></label>';
      }).join("");
    }, 0);
  }

  // 续写时切换书 → 伏笔过滤
  root.nvContFilterFs = function (cb) {
    var sel = document.getElementById("nv-cont-book");
    if (!sel) return;
    var bid = sel.value;
    document.querySelectorAll("#nv-cont-fs label").forEach(function (lb) {
      var inp = lb.querySelector("input");
      if (inp.getAttribute("data-book") === bid) lb.style.display = "";
      else lb.style.display = "none";
    });
  };

  // 续写提交
  root.nvDoContinue = function () {
    var bid = document.getElementById("nv-cont-book").value;
    var tail = document.getElementById("nv-cont-tail").value;
    var goal = document.getElementById("nv-cont-goal").value;
    var chars = document.getElementById("nv-cont-chars").value;
    var fids = Array.prototype.slice.call(document.querySelectorAll("#nv-cont-fs input:checked")).map(function (x) { return x.value; });
    var r = nvScaffoldContinue(bid, { tailFromPrev: tail, goal: goal, mustChars: chars, foreshadowIds: fids });
    var out = document.getElementById("nv-cont-out");
    if (r.ok) {
      out.innerHTML = '<div class="nv-result"><pre>' + esc(r.outline) + '</pre>' +
        (r.suggestFs.length ? '<div class="nv-dim">📌 建议同时兑现：' + r.suggestFs.map(function (f) { return esc(f.title); }).join("、") + '</div>' : '') +
        '</div>';
    } else {
      out.innerHTML = '<div class="nv-result nv-result-err">' + esc(r.msg) + '</div>';
    }
  };

  // 润色提交
  root.nvDoPolish = function () {
    var cid = document.getElementById("nv-pol-ch").value;
    var loc = document.getElementById("nv-pol-loc").value;
    var type = document.getElementById("nv-pol-type").value;
    var expect = document.getElementById("nv-pol-expect").value;
    var keep = document.getElementById("nv-pol-keep").value;
    var r = nvScaffoldPolish(cid, { location: loc, issueType: type, expect: expect, keep: keep });
    var out = document.getElementById("nv-pol-out");
    if (r.ok) {
      out.innerHTML = '<div class="nv-result">✅ 润色清单已写入该章 notes，可进入章节详情查看</div>';
    } else {
      out.innerHTML = '<div class="nv-result nv-result-err">' + esc(r.msg) + '</div>';
    }
  };

  // ============================================================
  // 13. 章节详情
  // ============================================================
  function renderNovelChapterDetail(c, chId) {
    var ch = nvChapter(chId);
    if (!ch) { c.innerHTML = '<div class="empty-state"><div class="empty-text">章节不存在</div></div>'; return; }
    var book = nvGet(ch.bookId);
    var sm = CHAPTER_STATUS_META[ch.status] || CHAPTER_STATUS_META.draft;
    var review = nvReviewChapter(chId);
    var notes = ch.notes || [];

    var html = '<div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">' +
      '<button class="btn btn-ghost sm" onclick="NV_VIEW=\'list\';render()">← 返回</button>' +
      '<button class="btn btn-ghost sm" onclick="nvChStatus(\'' + ch.id + '\',\'draft\')">草稿</button>' +
      '<button class="btn btn-ghost sm" onclick="nvChStatus(\'' + ch.id + '\',\'revised\')">已润色</button>' +
      '<button class="btn btn-ghost sm" onclick="nvChStatus(\'' + ch.id + '\',\'final\')">定稿</button>' +
      '<button class="btn btn-primary sm" onclick="nvChEdit(\'' + ch.id + '\')">✏️ 编辑正文</button>' +
      '</div>';

    html += '<div class="card"><div class="card-body">' +
      '<div class="nv-detail-h">第 ' + ch.num + ' 章 · ' + esc(ch.title) + ' <span class="nv-dim">· ' + esc(book ? book.title : "") + '</span></div>' +
      '<div class="nv-detail-row">' + badge(sm.label, sm.color) + ' · ' + nvCnWordCount(ch.draft) + ' 字' +
      (ch.goal ? ' · <span class="nv-dim">目标：' + esc(ch.goal) + '</span>' : '') +
      '</div>' +
      '<div class="nv-detail-row"><div class="nv-chapter-text">' + esc(ch.draft).replace(/\n/g, "<br>") + '</div></div>' +
      '</div></div>';

    // 4 维自动审查
    if (review) {
      html += '<div class="card nv-review-card"><div class="card-body">' +
        '<div class="nv-detail-h">🔍 自动审查</div>' +
        '<div class="nv-review-grid">' +
        '<div class="nv-rv-cell"><div class="nv-rv-label">节奏</div><div class="nv-rv-val">' + review.pacing + '/5</div></div>' +
        '<div class="nv-rv-cell"><div class="nv-rv-label">张力</div><div class="nv-rv-val">' + review.tension + '/5</div></div>' +
        '<div class="nv-rv-cell"><div class="nv-rv-label">连贯</div><div class="nv-rv-val">' + review.continuity + '/5</div></div>' +
        '<div class="nv-rv-cell"><div class="nv-rv-label">字数</div><div class="nv-rv-val">' + review.wc + '</div></div>' +
        '</div>';
      if (review.issues.length) {
        html += '<div class="nv-rv-issues">';
        review.issues.forEach(function (i) {
          html += '<div class="nv-issue"><span class="nv-issue-type" style="background:' + ISSUE_TYPE_COLOR[i.type] + '22;color:' + ISSUE_TYPE_COLOR[i.type] + '">' + esc(ISSUE_TYPE_LABEL[i.type]) + '</span> ' + esc(i.note) + '</div>';
        });
        html += '</div>';
      } else {
        html += '<div class="nv-rv-ok">✅ 未发现自动检查项问题</div>';
      }
      html += '</div></div>';
    }

    // 脚手架笔记
    if (notes.length) {
      html += '<div class="card"><div class="card-body">' +
        '<div class="nv-detail-h">📋 脚手架笔记（' + notes.length + '）</div>';
      notes.forEach(function (n) {
        var icon = n.kind === "polish" ? "✨" : "📝";
        var tsStr = (n.ts || "").slice(0, 16).replace("T", " ");
        html += '<div class="nv-note-row">' +
          '<div class="nv-note-h">' + icon + ' ' + (n.kind === "polish" ? "润色" : "续写") + ' · ' + esc(tsStr) + '</div>';
        if (n.kind === "polish") {
          html += '<div><b>位置：</b>' + esc(n.location) + '</div>' +
            '<div><b>类型：</b>' + esc(n.issueType) + '</div>' +
            '<div><b>期望：</b>' + esc(n.expect) + '</div>' +
            '<div><b>保留：</b>' + esc(n.keep) + '</div>';
        } else {
          html += '<div><b>新章号：</b>' + esc(n.nextNum) + '</div>' +
            '<pre class="nv-pre">' + esc(n.outline) + '</pre>';
        }
        html += '</div>';
      });
      html += '</div></div>';
    }

    c.innerHTML = html;
  }

  // 章状态切换
  root.nvChStatus = function (chId, st) {
    var ch = nvChapter(chId);
    if (!ch) return;
    if (!CHAPTER_STATUS_META[st]) return;
    ch.status = st;
    if (st === "final" || st === "revised") ch.revisedAt = new Date().toISOString();
    nvSave();
    if (typeof render === "function") render();
  };

  // 章编辑（弹窗）
  root.nvChEdit = function (chId) {
    var ch = nvChapter(chId);
    if (!ch) return;
    var draft = prompt("编辑第 " + ch.num + " 章正文：", ch.draft || "");
    if (draft === null) return;
    ch.draft = draft;
    ch.wordCount = nvCnWordCount(draft);
    if (ch.status === "final") ch.status = "revised";
    nvSave();
    if (typeof render === "function") render();
  };

  // ============================================================
  // 14. 审查视图（列出所有章审结果）
  // ============================================================
  function renderNovelReview(c) {
    var d = nvDB();
    var html = '<div class="section-title"><span class="emoji">🔍</span> 审查</div>';
    html += tabBarHtml();
    html += '<div class="card"><div class="card-body">' +
      '<div class="nv-dim">自动跑 4 维启发式检查：节奏 / 张力 / 连贯 / 伏笔状态。会标出未兑现伏笔和疑似角色出场不一致。</div>' +
      '</div></div>';

    d.books.forEach(function (book) {
      var bookChs = d.chapters.filter(function (x) { return x.bookId === book.id; }).sort(function (a, b) { return a.num - b.num; });
      html += '<div class="nv-fs-book"><div class="nv-fs-book-h">' + esc(book.title) + '</div>';
      bookChs.forEach(function (ch) {
        var r = nvReviewChapter(ch.id);
        if (!r) return;
        var issueN = r.issues.length;
        var rev = d.reviews.find(function (x) { return x.chapterId === ch.id; });
        var repColor = issueN === 0 ? "#10b981" : (issueN >= 2 ? "#ef4444" : "#f59e0b");
        html += '<div class="nv-rev-row" onclick="NV_VIEW=\'chapter:' + ch.id + '\';render()">' +
          '<div class="nv-rev-h">第 ' + ch.num + ' 章 · ' + esc(ch.title) + '</div>' +
          '<div class="nv-rev-scores">' +
          '<span>节奏 <b>' + r.pacing + '</b></span>' +
          '<span>张力 <b>' + r.tension + '</b></span>' +
          '<span>连贯 <b>' + r.continuity + '</b></span>' +
          '<span>字数 <b>' + r.wc + '</b></span>' +
          '</div>' +
          '<div class="nv-rev-issues" style="border-left:3px solid ' + repColor + '">' +
          (issueN === 0 ? '<span class="nv-dim">✓ 无自动问题</span>' :
            r.issues.map(function (i) {
              return '<div class="nv-issue"><span class="nv-issue-type" style="background:' + ISSUE_TYPE_COLOR[i.type] + '22;color:' + ISSUE_TYPE_COLOR[i.type] + '">' + esc(ISSUE_TYPE_LABEL[i.type]) + '</span> ' + esc(i.note) + '</div>';
            }).join("")
          ) +
          '</div>' +
          (rev && rev.issues && rev.issues.length ? '<div class="nv-rev-manual">📝 人工笔记：' + esc((rev.issues[0] && rev.issues[0].note) || "") + '</div>' : '') +
          '</div>';
      });
      html += '</div>';
    });

    c.innerHTML = html;
  }

  // ============================================================
  // 15. 复盘视图
  // ============================================================
  function renderNovelRecap(c) {
    var d = nvDB();
    var html = '<div class="section-title"><span class="emoji">📈</span> 复盘</div>';
    html += tabBarHtml();

    // 字数曲线（按里程碑聚合）
    var ms = (d.milestones || []).slice().sort(function (a, b) { return a.date.localeCompare(b.date); });
    var maxW = 0, totalW = 0;
    ms.forEach(function (m) { totalW += (m.wordsAdded || 0); if (m.wordsAdded > maxW) maxW = m.wordsAdded; });
    html += '<div class="card"><div class="card-body">' +
      '<div class="nv-detail-h">📊 累计字数曲线（按里程碑）</div>' +
      '<div class="nv-bar-chart">';
    var acc = 0;
    ms.forEach(function (m) {
      acc += (m.wordsAdded || 0);
      var h = maxW ? Math.max(8, Math.round((m.wordsAdded || 0) / maxW * 60)) : 8;
      html += '<div class="nv-bar-col" title="' + esc(m.date) + ' +' + (m.wordsAdded || 0) + '">' +
        '<div class="nv-bar" style="height:' + h + 'px"></div>' +
        '<div class="nv-bar-label">' + esc(m.date.slice(5)) + '</div>' +
        '</div>';
    });
    html += '</div>' +
      '<div class="nv-dim" style="margin-top:6px">累计：' + totalW.toLocaleString() + ' 字</div>' +
      '</div></div>';

    // 全部里程碑列表
    html += '<div class="section-title"><span class="emoji">📋</span> 全部复盘（' + ms.length + '）</div><div class="card"><div class="card-body">';
    ms.slice().reverse().forEach(function (m) {
      var bk = nvGet(m.bookId);
      html += '<div class="nv-ms-row"><div class="nv-ms-date">' + esc(m.date) + '</div>' +
        '<div class="nv-ms-content"><b>' + esc(bk ? bk.title : "?") + '</b> · +' + (m.wordsAdded || 0) + ' 字 / ' + (m.chCompleted || 0) + ' 章' +
        (m.reflection ? '<div class="nv-ms-text">' + esc(m.reflection) + '</div>' : '') +
        '</div></div>';
    });
    html += '</div></div>';

    // 周复盘模板
    html += '<div class="card"><div class="card-body">' +
      '<div class="nv-detail-h">📝 周复盘模板（5 个问题）</div>' +
      '<ol class="nv-recap-list">' +
      '<li>本周写了多少字？哪一章最满意？</li>' +
      '<li>哪个伏笔铺设得当？哪个被遗忘了？</li>' +
      '<li>哪个角色的弧光在推进？哪个停滞了？</li>' +
      '<li>下周必须兑现哪个伏笔？必出哪个角色？</li>' +
      '<li>有没有发现节奏问题（章节密度、对话占比、视角漂移）？</li>' +
      '</ol>' +
      '<div class="nv-dim">把答案粘贴到「添加复盘」即可沉淀（功能随版本上线）</div>' +
      '</div></div>';

    c.innerHTML = html;
  }

  // ============================================================
  // 16. 导出 / 导入
  // ============================================================
  root.nvExportJson = function () {
    var d = nvDB();
    var blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "novel_" + today() + ".json";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    if (typeof showToast === "function") showToast("已导出 novel.json", "success");
  };

  root.nvImportJsonPrompt = function () {
    var inp = document.createElement("input");
    inp.type = "file"; inp.accept = "application/json";
    inp.onchange = function (e) {
      var f = e.target.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        try {
          var j = JSON.parse(r.result);
          var cur = nvDB();
          ["books", "chars", "events", "foreshadows", "chapters", "reviews", "milestones"].forEach(function (k) {
            if (Array.isArray(j[k])) cur[k] = j[k].slice();
          });
          nvSave();
          if (typeof render === "function") render();
          if (typeof showToast === "function") showToast("导入成功", "success");
        } catch (err) {
          if (typeof showToast === "function") showToast("JSON 解析失败：" + err.message, "error");
        }
      };
      r.readAsText(f);
    };
    inp.click();
  };

  // ============================================================
  // 暴露
  // ============================================================
  root.NV_TAB = "overview";
  root.NV_VIEW = "list";
  root.NV_PLAN_SUB = "outline";
  root.NV_WRITE_SUB = "list";
  root.Novel = {
    render: renderNovel,
    uid: nvUid,
    db: nvDB,
    save: nvSave,
    get: nvGet,
    char: nvChar,
    chapter: nvChapter,
    foreshadow: nvForeshadow,
    cnWordCount: nvCnWordCount,
    bookWordCount: nvBookWordCount,
    bookFs: nvBookForeshadows,
    pendingFs: nvBookPendingFs,
    fsTrans: nvFsTransition,
    review: nvReviewChapter,
    polish: nvScaffoldPolish,
    continue: nvScaffoldContinue,
    CHAPTER_STATUS_META: CHAPTER_STATUS_META,
    FORESHADOW_STATUS: FORESHADOW_STATUS,
    FORESHADOW_LABEL: FORESHADOW_LABEL,
    FORESHADOW_COLOR: FORESHADOW_COLOR,
    ISSUE_TYPE_LABEL: ISSUE_TYPE_LABEL,
    ISSUE_TYPE_COLOR: ISSUE_TYPE_COLOR
  };
})(typeof window !== "undefined" ? window : this);
