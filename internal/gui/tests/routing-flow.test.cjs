// Run with Node's test runner and Playwright on the module path; see README.md.
// The Routing page's "Where requests go" card, over the stage: each agent
// with every account or provider magpie sent its requests to, how many
// went there and how they ended, so who is routed where reads at a glance
// (a reader new to magpie: the list's rows named no agent and no column).
// By session lists each session the same way. A click on a destination
// picks the newest request sent there and moves nothing. The request
// list has its columns named over it. English and Chinese; the API is faked.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(__dirname, "../assets");
const now = new Date();
const at = (i) => new Date(now.getTime() - (i + 1) * 60e3).toISOString();
const W = {
  c1: { id: "codex:a", provider: "codex", name: "Codex", who: "ann@example.com", kind: "account", model: "gpt-5.6-terra", icon: "codex-color", routing: "smart" },
  c2: { id: "codex:b", provider: "codex", name: "Codex", who: "bob@example.com", kind: "account", model: "gpt-5.6-terra", icon: "codex-color", routing: "smart" },
  ds: { id: "deepseek", provider: "deepseek", name: "DeepSeek", kind: "provider", model: "deepseek-flash", icon: "deepseek-color", routing: "smart" },
  km: { id: "moonshot", provider: "moonshot", name: "Kimi", kind: "provider", model: "kimi-k3", icon: "moonshot", routing: "smart" },
};
const mk = (i, agent, session, w, extra = {}) => ({
  id: 100 - i, seq: 100 - i, time: at(i), agent, session, model: w.provider + "/" + w.model, provider: w.provider,
  order: Object.values(W).filter((x) => x.provider === w.provider), done: true, status: 200, ms: 4000, tokens: 9000,
  tries: [{ id: w.id, model: w.model, start: at(i), done: true, status: 200, ms: 4000 }], ...extra,
});
// Codex: two to DeepSeek, one that moved from ann to bob; Claude Code:
// two to Kimi, one of them failed
const routes = [
  mk(0, "codex", "s-codex-1", W.ds),
  mk(1, "claude", "s-claude-1", W.km),
  { ...mk(2, "codex", "s-codex-2", W.c2), order: [W.c1, W.c2], tries: [
    { id: W.c1.id, model: "gpt-5.6-terra", start: at(2), done: true, status: 429, ms: 300, error: "rate limited" },
    { id: W.c2.id, model: "gpt-5.6-terra", start: at(2), done: true, status: 200, ms: 4000 }] },
  mk(3, "codex", "s-codex-1", W.ds),
  { ...mk(4, "claude", "s-claude-2", W.km), status: 500, tries: [{ id: W.km.id, model: "kimi-k3", start: at(4), done: true, status: 500, ms: 900, error: "upstream error" }] },
];

function serve(lang) {
  const state = { agents: [{ id: "codex", name: "Codex", path: "/t/codex", fields: [] }, { id: "claude", name: "Claude Code", path: "/t/claude", fields: [] }], profiles: [], settings: { lang, theme: "light" } };
  return async (route) => {
    const url = new URL(route.request().url());
    const json = (data) => route.fulfill({ json: data });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:true};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json(state);
    if (url.pathname === "/api/gateway/trace") {
      if (url.searchParams.get("wait")) await new Promise((r) => setTimeout(r, 20e3));
      return json({ mine: true, now: now.toISOString(), seq: 100, totals: { requests: routes.length, rerouted: 1, errors: 1 }, routes });
    }
    if (url.pathname === "/api/gateway/history") return json({ cut: false, days: [], routes: [] });
    if (url.pathname === "/api/groups") return json({ groups: [] });
    if (url.pathname === "/api/providers") return json({ providers: [], presets: [], excluded: [], gateway: { running: true, window: true } });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    await route.fulfill({ body: await fs.readFile(file).catch(() => ""), contentType });
  };
}

const L = {
  en: { title: "Where requests go", bySession: "By session", cols: ["Sent by", "Where it was sent", "Requests", "How it ended"], ok: "all answered", failed: "1 failed", moved: "1 after another account failed", head: ["Time", "From · model asked for", "Where it was sent", "Time taken · usage"] },
  zh: { title: "请求去向", bySession: "按会话", cols: ["谁发的", "送到哪里", "请求", "结果"], ok: "全部成功", failed: "1 次失败", moved: "1 次是换线后送达", head: ["时间", "谁发的 · 请求的模型", "送到哪里", "用时 · 用量"] },
};

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const lang of ["en", "zh"]) {
    test(`${engine} ${lang}: who was routed where, by agent and by session`, async (t) => {
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width: 1280, height: 700 } });
      page.setDefaultTimeout(8000);
      page.setDefaultNavigationTimeout(60000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/*", serve(lang));
      await page.goto("http://magpie.test/?view=routing");
      const flow = page.locator("#rtFlow");
      await flow.locator(".rt-flow-src").first().waitFor();
      const s = L[lang];
      assert.equal(await flow.locator(".rt-flow-head b").textContent(), s.title);
      assert.deepEqual(await flow.locator(".rt-flow-cols span").allTextContents(), s.cols);

      // by agent: a row an agent, in its name's order, a line a destination
      const read = () => flow.locator(".rt-flow-src").evaluateAll((rows) => rows.map((r) => ({
        from: r.querySelector(".from b").textContent,
        to: [...r.querySelectorAll(".rt-flow-dst")].map((d) => [d.querySelector(".fnm").textContent, d.querySelector("code").textContent, d.querySelector(".fn b").textContent, d.querySelector(".fres").textContent, d.classList.contains("bad")]),
      })));
      assert.deepEqual(await read(), [
        { from: "Claude Code", to: [["Kimi", "kimi-k3", "2", s.failed, true]] },
        { from: "Codex", to: [["DeepSeek", "deepseek-flash", "2", s.ok, false], ["bob@example.com", "gpt-5.6-terra", "1", s.moved, false]] },
      ]);

      // a destination picks the newest request sent there, and nothing moves under the click
      const dst = flow.locator(".rt-flow-dst", { hasText: "bob@example.com" });
      const place = () => dst.evaluate((e) => [document.querySelector("#view-routing").scrollTop, Math.round(e.getBoundingClientRect().top)]);
      const was = await place();
      await dst.click();
      await page.locator('.rt-req[aria-pressed="true"]', { hasText: "bob@example.com" }).waitFor();
      assert.deepEqual(await place(), was, "a click scrolls nothing");

      // by session: a row a session, the one that sent last first; kept over a reload
      await flow.locator(".rt-flow-pill", { hasText: s.bySession }).click();
      assert.deepEqual((await read()).map((r) => [r.from, r.to.map((d) => d[0]).join()]), [
        ["Codex · s-codex-1", "DeepSeek"], ["Claude Code · s-claude-1", "Kimi"], ["Codex · s-codex-2", "bob@example.com"], ["Claude Code · s-claude-2", "Kimi"],
      ]);
      await page.reload();
      await flow.locator(".rt-flow-src").first().waitFor();
      assert.equal(await flow.locator('.rt-flow-pill[aria-pressed="true"]').textContent(), s.bySession);

      // the request list's columns are named, each over its part of a row
      const head = page.locator(".rt-req-cols");
      assert.deepEqual(await head.locator("span").allTextContents(), s.head);
      const xs = await page.evaluate(() => {
        const x = (e) => Math.round(e.getBoundingClientRect().left);
        const h = [...document.querySelectorAll(".rt-req-cols span")], r = document.querySelector(".rt-req");
        return { head: h.slice(0, 3).map(x), row: [r.querySelector(".at"), r.querySelector(".asked"), r.querySelector(".to")].map(x) };
      });
      xs.head.forEach((v, i) => assert(Math.abs(v - xs.row[i]) <= 8, `column ${i} is named over its part: ${JSON.stringify(xs)}`));
      assert.deepEqual(errors, []);
    });
  }
}
