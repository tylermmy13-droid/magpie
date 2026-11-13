// Run with Node's test runner and Playwright on the module path; see README.md.
// Usage › Requests opens Simple for a reader new to it: who sent a request,
// the model it asked for, where it went, its tokens, cost, time and
// status. Detailed, picked over the table, shows the other columns too, and the
// pick is kept over a reload. English and Chinese; the API is faked.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(__dirname, "../assets");
const now = Date.now();
const ROWS = Array.from({ length: 12 }, (_, i) => ({ t: new Date(now - (60 + i * 60) * 1e3).toISOString(), agent: "codex", agentName: "Codex", icon: "codex-color", provider: "relay", providerName: "Relay", host: "team", req: "sol", model: "gpt-6-sol", served: "gpt-6-sol", effort: "high", in: 1000 + i, out: 100, cache_read: 512, ms: 900, ttft_ms: 300, status: 200, cost: 0.001, priced: true }));
const usage = { calls: 12, errors: 0, input: 12000, output: 1200, cache_read: 6000, cache_write: 0, reasoning: 0, unpriced: 0, cost: 0.012, bucket: "day", series: [], agents: [], models: [] };

function serve(lang) {
  return async (route) => {
    const url = new URL(route.request().url());
    const json = (data) => route.fulfill({ json: data });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:false};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/gateway/trace") return json({ mine: false, seq: 0, routes: [], totals: { requests: 0, rerouted: 0, errors: 0 }, now: new Date().toISOString() });
    if (url.pathname === "/api/gateway/history") return json({ days: [], routes: [], cut: false });
    if (url.pathname === "/api/providers") return json({ providers: [], presets: [], excluded: [], models: [], gateway: { running: false } });
    if (url.pathname === "/api/state") return json({ agents: [], profiles: [], settings: { lang, theme: "light" } });
    if (url.pathname === "/api/usage/requests") return json({ ...usage, period: url.searchParams.get("period"), rows: ROWS, offset: 0, total: ROWS.length, agents: [{ id: "codex", name: "Codex", icon: "codex-color" }], callerKeys: [] });
    if (url.pathname === "/api/usage/quotas") return json([]);
    if (url.pathname === "/api/usage") return json(usage);
    if (url.pathname === "/api/sessions") return json({ sessions: [], dirs: [] });
    if (url.pathname === "/api/sessions/stats") return json({ from: "", to: "", days: [], agents: {} });
    if (url.pathname === "/api/groups") return json({ groups: [], models: [] });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    await route.fulfill({ body: await fs.readFile(file).catch(() => ""), contentType });
  };
}

const L = {
  en: { tab: "Requests", simple: ["Time", "Agent", "Requested", "Provider · account", "In", "Out", "Cost", "Duration", "Status"], pills: ["Simple view", "Detailed view"] },
  zh: { tab: "请求", simple: ["时间", "Agent", "请求模型", "供应商 · 账号", "输入", "输出", "费用", "耗时", "状态"], pills: ["简洁", "详细"] },
};

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const lang of ["en", "zh"]) {
    test(`${engine} ${lang}: the requests table opens Simple, and Detailed shows every column`, async (t) => {
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width: 2600, height: 800 } });
      page.setDefaultTimeout(8000);
      page.setDefaultNavigationTimeout(60000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/*", serve(lang));
      await page.goto("http://magpie.test/?view=usage");
      const s = L[lang];
      await page.locator("#view-usage [role=tab], .nav-s").filter({ hasText: s.tab }).first().click();
      await page.locator(".led tbody tr").first().waitFor();
      const shown = () => page.locator(".led th").evaluateAll((ths) => ths.filter((x) => x.offsetParent).map((x) => x.textContent.trim().toLowerCase()));
      assert.deepEqual(await page.locator("#ledView button").allTextContents(), s.pills);
      assert.deepEqual(await shown(), s.simple.map((x) => x.toLowerCase()));
      // a row has as many cells in sight as the head
      assert.equal(await page.locator(".led tbody tr").first().locator("td").evaluateAll((tds) => tds.filter((x) => x.offsetParent).length), s.simple.length);
      assert.equal(await page.locator('#ledView button[aria-pressed="true"]').textContent(), s.pills[0]);

      await page.locator("#ledView button").nth(1).click();
      // Detailed: the columns Simple leaves out are back (as many of the seventeen as the window fits)
      const all = (await shown()).length;
      assert(all >= 13, `Detailed shows ${all} columns`);
      await page.reload();
      await page.locator("#view-usage [role=tab], .nav-s").filter({ hasText: s.tab }).first().click();
      await page.locator(".led tbody tr").first().waitFor();
      assert.equal((await shown()).length, all, "the pick is kept");
      await page.locator("#ledView button").first().click();
      assert.equal((await shown()).length, s.simple.length);
      assert.deepEqual(errors, []);
    });
  }
}
