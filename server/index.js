require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const cron = require("node-cron");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "../public")));

// ── Config ────────────────────────────────────────────────────────────────────
// First invoice date to track. Anything earlier is ignored on every scrape.
const BACKFILL_START = "2026-06-01";
const VEGAS_TZ = "America/Los_Angeles";

// Sysco locations — confirmed from the account switcher screenshot
const SYSCO_LOCATIONS = [
  { id: "017-974499", name: "Durango (Main)", match: "974499" },
  { id: "017-974547", name: "Cheyenne",       match: "974547" },
  { id: "017-974546", name: "Rhodes Ranch",   match: "974546" },
  { id: "017-974545", name: "St Rose",        match: "974545" },
  { id: "017-974544", name: "The Strip",      match: "974544" },
];

// ── Persistence ───────────────────────────────────────────────────────────────
try { fs.mkdirSync("/data", { recursive: true }); } catch {}
const DATA_FILE = "/data/fc_invoices.json";

function loadStore() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      console.log("✅ Loaded: RD=" + Object.keys(d.rd || {}).length + " receipts, Sysco=" + Object.keys(d.sysco || {}).length + " orders");
      return { rd: d.rd || {}, sysco: d.sysco || {}, lastUpdated: d.lastUpdated || null };
    }
  } catch (e) { console.log("Load error:", e.message); }
  return { rd: {}, sysco: {}, lastUpdated: null };
}

const store = { ...loadStore(), log: [], scraping: false, progress: "" };

// Persistent log — survives restarts and redeploys
const LOG_FILE = "/data/fc_log.json";
try {
  if (fs.existsSync(LOG_FILE)) {
    store.log = JSON.parse(fs.readFileSync(LOG_FILE, "utf8")) || [];
    console.log("✅ Log restored: " + store.log.length + " entries");
  }
} catch (e) { console.log("Log load error:", e.message); }

function saveLog() {
  try { fs.writeFileSync(LOG_FILE, JSON.stringify(store.log)); } catch {}
}

// Crash guards — log instead of dying so /api/status always shows what happened
process.on("uncaughtException", (e) => {
  console.log("💥 uncaughtException: " + (e && e.stack ? e.stack : e));
  store.log.unshift({ time: new Date().toISOString(), msg: "💥 uncaughtException: " + (e && e.message ? e.message : e) });
  store.scraping = false;
});
process.on("unhandledRejection", (e) => {
  console.log("💥 unhandledRejection: " + (e && e.stack ? e.stack : e));
  store.log.unshift({ time: new Date().toISOString(), msg: "💥 unhandledRejection: " + (e && e.message ? e.message : e) });
});

function saveStore() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ rd: store.rd, sysco: store.sysco, lastUpdated: store.lastUpdated }));
  } catch (e) { console.log("Save error:", e.message); }
}

const log = (msg) => {
  console.log(msg);
  store.log.unshift({ time: new Date().toISOString(), msg });
  if (store.log.length > 2000) store.log.length = 2000;
  saveLog();
};

// ── GitHub backup (same pattern as prices app) ───────────────────────────────
async function githubCommit(filePath, content, message) {
  const token = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPO;
  if (!token || !repo) return false;
  const apiBase = "https://api.github.com/repos/" + repo + "/contents/" + filePath;
  const headers = { "Authorization": "token " + token, "Content-Type": "application/json", "User-Agent": "naan-curry-foodcost" };
  let sha = null;
  try {
    const get = await fetch(apiBase, { headers });
    if (get.ok) { const j = await get.json(); sha = j.sha; }
  } catch {}
  const body = { message, content, ...(sha ? { sha } : {}) };
  const put = await fetch(apiBase, { method: "PUT", headers, body: JSON.stringify(body) });
  return put.ok;
}

async function backupToGitHub() {
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) return;
  try {
    const encoded = Buffer.from(JSON.stringify({ rd: store.rd, sysco: store.sysco, lastUpdated: store.lastUpdated }, null, 2)).toString("base64");
    const ok = await githubCommit("backup/foodcost.json", encoded, "Food cost backup " + new Date().toISOString().slice(0, 10));
    log(ok ? "✅ GitHub backup committed" : "❌ GitHub backup failed");
  } catch (e) { log("Backup error: " + e.message); }
}

async function restoreFromGitHub() {
  const token = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPO;
  if (!token || !repo) return;
  if (Object.keys(store.rd).length > 0 || Object.keys(store.sysco).length > 0) {
    log("Restore: local data exists, skipping GitHub restore");
    return;
  }
  try {
    const r = await fetch("https://api.github.com/repos/" + repo + "/contents/backup/foodcost.json", {
      headers: { "Authorization": "token " + token, "User-Agent": "naan-curry-foodcost" },
    });
    if (!r.ok) { log("Restore: no backup on GitHub (" + r.status + ")"); return; }
    const j = await r.json();
    const data = JSON.parse(Buffer.from(j.content, "base64").toString("utf8"));
    store.rd = data.rd || {};
    store.sysco = data.sysco || {};
    store.lastUpdated = data.lastUpdated || null;
    saveStore();
    log("✅ Restored from GitHub: RD=" + Object.keys(store.rd).length + " Sysco=" + Object.keys(store.sysco).length);
  } catch (e) { log("Restore error: " + e.message); }
}

// ── Categories ────────────────────────────────────────────────────────────────
const CATEGORIES = ["Protein", "Dairy", "Produce", "Dry & Pantry", "Frozen", "Beverages", "Supplies", "Other"];

// Known RD receipt UPCs → category (verified against real receipts)
const RD_UPC_CATEGORY = {
  // Protein (weight-embedded UPCs: 2-0XXXXX-0000)
  "20772320000": "Protein",   // CHX BRST JMB
  "20776580000": "Protein",   // CHX LEG MEAT JMB
  "20776700000": "Protein",   // CHX LEG QTR SML
  "20776820000": "Protein",   // CHX THIGHS
  "20772000000": "Protein",   // CHX WINGS
  "20790420000": "Protein",   // LAMB LEG BNLS FRZ AUS
  "20181001900": "Protein",   // GOAT CUBE
  // Dairy
  "7127035817":  "Dairy",     // CHZ PANEER LOAF
  "76069500575": "Dairy",     // YOGURT PLN JF
  "76069500868": "Dairy",     // CHZ JACK/CHED SHRD
  // Produce
  "2060042647":  "Produce",   // PD HRB MINT
  "2060044146":  "Produce",   // PD GARLIC PEELED
  "64612790014": "Produce",   // PDU GINGER FR
  "4612790014":  "Produce",   // PDU GINGER FR (alt)
  "81008518222": "Produce",   // PDU PPR SERRANO
  "84046513269": "Produce",   // PD MICRO FWR ORCHD
  "84046511762": "Produce",   // PD MICRO SLD RNBOW
  "74069569998": "Produce",   // PD CAUL 1CT
  "2060042708":  "Produce",   // PD PPR BELL GREEN
  "2060035413":  "Produce",   // PD CUCUMBER SEL
  "3022302671":  "Produce",   // PD CILANTRO
  "2060042570":  "Produce",   // PD LEMON CH
  "2060042750":  "Produce",   // PD SQUASH ITALN
  // Dry & Pantry
  "74504200010": "Dry & Pantry", // BASMATI CHEF SECRT
  "5900041556":  "Dry & Pantry", // FLOUR GOLDN TEMPLE
  "76069501474": "Dry & Pantry", // BEAN KDNY D/RED
  "2700038251":  "Dry & Pantry", // KETCHUP HUNTS
  "885161310170":"Dry & Pantry", // COCONUT MILK AROYD
  "76069557419": "Dry & Pantry", // SPC CINNAMON STCKS
  "76069520304": "Dry & Pantry", // SPC WHOLE FENNEL
  // Frozen
  "76069501000": "Frozen",    // VEG PEAS JFARMS
  "76069502007": "Frozen",    // FZ VEG BROC FLORET
  // Beverages
  "4900005846":  "Beverages", // COKE CLASSIC
  "4900005847":  "Beverages", // DIET COKE
  "4900005848":  "Beverages", // SPRITE
  "4900002469":  "Beverages", // COKE DIET 16.9Z
  "7929816900":  "Beverages", // EVIAN WATER
  // Supplies
  "76069501661": "Supplies",  // FOIL ROLL
  "76069503004": "Supplies",  // KIT PS BLK
  "76069533507": "Supplies",  // CONT SOUP CMB 16Z
  "76069533505": "Supplies",  // CONT SOUP CMB 8Z
  "76069533791": "Supplies",  // CONT REC BLK 24Z
  "7959448980":  "Supplies",  // BAG BRN SOS
};

// Keyword fallback for RD descriptions not in the UPC map. ORDER MATTERS —
// supplies/beverage/frozen checked before broader food matches.
const RD_KEYWORD_RULES = [
  { re: /FOIL|CONT |CONT$|KIT |BAG |CUP|LID |NAPKIN|GLOVE|FILM |WRAP|TOWEL|PRINTER|THERMAL|PAPER|PLATE|FORK|SPOON|KNIFE|STRAW|TISSUE|SOAP|SANITIZ|BLEACH|DETERG|TRASH|LINER/i, cat: "Supplies" },
  { re: /COKE|PEPSI|SPRITE|FANTA|SODA|EVIAN|WATER PET|JUICE DRINK|REDBULL|MONSTER|LEMONADE/i, cat: "Beverages" },
  { re: /^FZ |FROZEN|IQF/i, cat: "Frozen" },
  { re: /COCONUT MILK|SPC |SPICE|MASALA|CUMIN|TURMERIC|CARDAMOM|CLOVE|FENNEL|CINNAMON/i, cat: "Dry & Pantry" },
  { re: /CHZ|CHEESE|PANEER|YOGURT|MILK|CREAM|BUTTER(?! ALT)|GHEE/i, cat: "Dairy" },
  { re: /CHX|CHICKEN|LAMB|GOAT|BEEF|SHRP|SHRIMP|TILAPIA|FISH|SEAFOOD|MEAT/i, cat: "Protein" },
  { re: /^PD |^PDU |HRB |ONION|GARLIC|GINGER|CAUL|PPR |PEPPER|CUCUMBER|CILANTRO|MINT|LEMON|LIME|POTATO|CARROT|SPINACH|TOMATO FR|LETTUCE|CABBAGE|SQUASH|EGGPLANT/i, cat: "Produce" },
  { re: /FLOUR|RICE|BASMATI|ATTA|BEAN|SUGAR|SALT|OIL|KETCHUP|VINEGAR|CORNSTARCH|STARCH|BAKING|SAMBAL|SAUCE|PUREE|TOMATO|LENTIL|DAL|HONEY|SYRUP|COLOR/i, cat: "Dry & Pantry" },
];

function categorizeRd(upc, desc) {
  if (RD_UPC_CATEGORY[upc]) return RD_UPC_CATEGORY[upc];
  for (const rule of RD_KEYWORD_RULES) {
    if (rule.re.test(desc)) return rule.cat;
  }
  return "Other";
}

// Sysco SUPC → category (from the tracked item list + invoice group headers)
const SYSCO_SUPC_CATEGORY = {
  // Dairy
  "2822379": "Dairy", "4676306": "Dairy", "6935464": "Dairy", "7102961": "Dairy",
  // Protein (poultry + seafood + meat)
  "5231238": "Protein", "4418117": "Protein", "0868459": "Protein", "868459": "Protein",
  "6344790": "Protein", "1803287": "Protein", "8053456": "Protein",
  "5106388": "Protein", "0496671": "Protein", "496671": "Protein",
  // Produce
  "1094663": "Produce", "1094721": "Produce", "1543164": "Produce", "2037125": "Produce",
  "2219095": "Produce", "2252013": "Produce", "3879962": "Produce", "7007376": "Produce",
  "7350788": "Produce", "7410640": "Produce", "1910231": "Produce", "1243724": "Produce",
  "1821537": "Produce", "1184902": "Produce", "7078475": "Produce", "8474538": "Produce",
  "1675925": "Produce",
  // Frozen
  "1053826": "Frozen", "6988158": "Frozen", "2523833": "Frozen", "3960200": "Frozen", "6409940": "Frozen",
  // Dry & Pantry
  "8379251": "Dry & Pantry", "4002325": "Dry & Pantry", "4119079": "Dry & Pantry",
  "5087572": "Dry & Pantry", "4518403": "Dry & Pantry", "3355757": "Dry & Pantry",
  "4063095": "Dry & Pantry", "6914451": "Dry & Pantry", "4564894": "Dry & Pantry",
  "4073441": "Dry & Pantry", "5517701": "Dry & Pantry", "4113049": "Dry & Pantry",
  "2638660": "Dry & Pantry", "1425982": "Dry & Pantry", "4112262": "Dry & Pantry",
  "4014684": "Dry & Pantry", "4062337": "Dry & Pantry", "4014973": "Dry & Pantry",
  "4978856": "Dry & Pantry", "4978884": "Dry & Pantry", "9903790": "Dry & Pantry",
  // Beverages
  "2886075": "Beverages",
};

const SYSCO_KEYWORD_RULES = [
  { re: /CHEESE|MILK|CREAM|PANEER|YOGURT|BUTTER(?!-IT)/i, cat: "Dairy" },
  { re: /CHICKEN|BEEF|LAMB|GOAT|SHRIMP|TILAPIA|FISH|PORK|TURKEY/i, cat: "Protein" },
  { re: /FROZEN|IQF|PEA GREEN|BROCCOLI FLORET/i, cat: "Frozen" },
  { re: /ONION|POTATO|LEMON|MINT|CILANTRO|PEPPER|CUCUMBER|SPINACH|CARROT|CAULIFLOWER|GARLIC|GINGER|HERB|FRESH/i, cat: "Produce" },
  { re: /WATER|SODA|JUICE BEV/i, cat: "Beverages" },
  { re: /FLOUR|OIL|SUGAR|SALT|STARCH|VINEGAR|SAUCE|PUREE|TOMATO|BEAN|KETCHUP|SPICE|POWDER|RICE|SHORTENING|COLORING/i, cat: "Dry & Pantry" },
  { re: /PAPER|FOIL|CONTAINER|GLOVE|FILM|BAG /i, cat: "Supplies" },
];

function categorizeSysco(supc, name) {
  const clean = String(supc || "").replace(/^0+/, "");
  if (SYSCO_SUPC_CATEGORY[supc]) return SYSCO_SUPC_CATEGORY[supc];
  if (SYSCO_SUPC_CATEGORY[clean]) return SYSCO_SUPC_CATEGORY[clean];
  for (const rule of SYSCO_KEYWORD_RULES) {
    if (rule.re.test(name)) return rule.cat;
  }
  return "Other";
}

// ── RD CSV parsing ────────────────────────────────────────────────────────────
// Format (verified against real receipts):
//   "Restaurant Depot #39",,"Customer #3900367"
//   ...
//   "Invoice: 11471","Terminal: 16","2026/06/01 1:59 pm"
//   UPC,Description,"Unit Qty","Case Qty",Price
//   -2,"Previous Balance",0,0,$0.00
//   76069557419,"SPC CINNAMON STCKS 2LB   ",1,0,$31.76
//   ...negative price lines are returns/voids...
//   0,Sub-Total,0,0,"$2,638.53"
//   0,Tax,...  0,Total,...  0,"MC/VISA 5587",...  0,Balance,...
function parseCsvLine(line) {
  const fields = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") { fields.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function parseMoney(s) {
  if (s == null) return null;
  const neg = /-/.test(s);
  const m = String(s).match(/([\d,]+\.\d{2})/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/,/g, ""));
  return neg ? -v : v;
}

function parseRdReceipt(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  const receipt = { invoiceNo: null, date: null, dateTime: null, subTotal: null, tax: null, total: null, items: [] };
  let inItems = false;

  for (const line of lines) {
    const f = parseCsvLine(line);

    // Header: "Invoice: 11471","Terminal: 16","2026/06/01 1:59 pm"
    if (f[0] && f[0].startsWith("Invoice:")) {
      receipt.invoiceNo = f[0].replace("Invoice:", "").trim();
      const dt = (f[2] || "").trim();
      receipt.dateTime = dt;
      const dm = dt.match(/(\d{4})\/(\d{2})\/(\d{2})/);
      if (dm) receipt.date = dm[1] + "-" + dm[2] + "-" + dm[3];
      continue;
    }
    if (f[0] === "UPC") { inItems = true; continue; }
    if (!inItems) continue;

    const upc = (f[0] || "").trim();
    const desc = (f[1] || "").trim();
    const price = parseMoney(f[4]);

    if (upc === "-2") continue; // Previous Balance
    if (upc === "0") {
      if (desc === "Sub-Total") receipt.subTotal = price;
      else if (desc === "Tax") receipt.tax = price;
      else if (desc === "Total") receipt.total = price;
      continue; // payment + balance lines also land here, skip
    }
    if (price === null) continue;

    receipt.items.push({
      upc,
      desc,
      qty: parseFloat(f[2]) || parseFloat(f[3]) || 1,
      price,
      category: categorizeRd(upc, desc),
    });
  }
  return receipt.invoiceNo ? receipt : null;
}

// ── Browser ───────────────────────────────────────────────────────────────────
async function launchBrowser() {
  log("🌐 Loading Chromium module...");
  const chromium = require("@sparticuz/chromium");
  const puppeteer = require("puppeteer-core");
  log("🌐 Extracting Chromium binary (memory-heavy step)...");
  const execPath = await chromium.executablePath();
  log("🌐 Launching browser at " + execPath + "...");
  const browser = await puppeteer.launch({
    args: [
      ...chromium.args,
      "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
      "--disable-gpu", "--single-process", "--no-zygote",
      "--renderer-process-limit=1", "--disable-extensions",
      "--js-flags=--max-old-space-size=256",
    ],
    executablePath: execPath, headless: chromium.headless, timeout: 30000,
  });
  log("🌐 Browser launched OK (mem: " + Math.round(process.memoryUsage().rss / 1048576) + "MB node rss)");
  return browser;
}

function withTimeout(p, ms, name) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(name + " timed out")), ms))]);
}

// ── RD receipts scraper ───────────────────────────────────────────────────────
// Flow: login via member SSO → /member/receipts → pick range → Request →
// wait for table (~15s+) → download each receipt's Excel/CSV → parse → dedupe.
async function scrapeRdReceipts() {
  log("🟢 RD receipts: starting...");
  store.progress = "Logging into Restaurant Depot...";
  let browser;
  const results = { added: 0, skipped: 0, failed: 0 };
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36");
    page.setDefaultTimeout(30000);

    // Login — same SSO flow as the prices app
    await page.goto(
      "https://member.restaurantdepot.com/rest/sso/auth/restaurantdepot/init?return_to=https%3A%2F%2Fwww.restaurantdepot.com%2F",
      { waitUntil: "domcontentloaded", timeout: 45000 }
    ).catch(e => log("RD SSO nav: " + e.message));
    await new Promise(r => setTimeout(r, 5000));
    await page.waitForSelector('#email, input[type="email"]', { timeout: 20000 });
    await page.click('#email, input[type="email"]');
    await page.keyboard.type(process.env.RD_EMAIL, { delay: 50 });
    await page.click('input[type="password"]');
    await page.keyboard.type(process.env.RD_PASSWORD, { delay: 50 });
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 4000));
    log("RD: logged in, URL=" + page.url());

    // Receipts page
    store.progress = "Requesting RD receipts...";
    await page.goto("https://www.restaurantdepot.com/member/receipts", { waitUntil: "domcontentloaded", timeout: 45000 });
    await new Promise(r => setTimeout(r, 4000));

    // Pick the longest available on-demand range that covers BACKFILL_START.
    // Page shows a dropdown like "Last 30 Days – On Demand" (likely 60 too).
    const daysNeeded = Math.ceil((Date.now() - new Date(BACKFILL_START + "T00:00:00").getTime()) / 86400000);
    const rangePicked = await page.evaluate((needed) => {
      const sel = document.querySelector("select");
      if (sel) {
        const opts = Array.from(sel.options).map((o, i) => {
          const m = o.textContent.match(/(\d+)\s*Days/i);
          return { i, days: m ? parseInt(m[1]) : 0, text: o.textContent.trim() };
        }).filter(o => o.days > 0).sort((a, b) => a.days - b.days);
        if (!opts.length) return "no day options";
        let pick = opts.find(o => o.days >= needed) || opts[opts.length - 1];
        sel.selectedIndex = pick.i;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return pick.text;
      }
      return "no select element";
    }, daysNeeded);
    log("RD: range picked = " + rangePicked + " (need " + daysNeeded + " days)");
    await new Promise(r => setTimeout(r, 1500));

    // Click Request
    const reqClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, input[type=submit], a"));
      const b = btns.find(el => el.textContent.trim().toLowerCase() === "request" || (el.value || "").toLowerCase() === "request");
      if (b) { b.click(); return true; }
      return false;
    });
    log("RD: Request clicked = " + reqClicked);

    // Wait for the receipts table (page says up to 2 minutes)
    store.progress = "Waiting for RD receipt list (can take up to 2 min)...";
    let rows = [];
    for (let w = 0; w < 60; w++) {
      await new Promise(r => setTimeout(r, 3000));
      rows = await page.evaluate(() => {
        // Rows look like: 2026/06/11 | Las Vegas, NV, #39 | $914.74 | View | Download Excel
        const out = [];
        const links = Array.from(document.querySelectorAll("a, button"));
        links.forEach((el, idx) => {
          const t = el.textContent.trim();
          if (/download/i.test(t) && /excel|csv/i.test(t + " " + (el.getAttribute("href") || ""))) {
            // climb to row, find date + total
            let row = el.closest("tr") || el.closest("li") || el.parentElement;
            for (let up = 0; up < 4 && row; up++) {
              if (/\d{4}\/\d{2}\/\d{2}/.test(row.innerText)) break;
              row = row.parentElement;
            }
            const text = row ? row.innerText : "";
            const dm = text.match(/(\d{4})\/(\d{2})\/(\d{2})/);
            const tm = text.match(/\$([\d,]+\.\d{2})/);
            out.push({
              idx,
              date: dm ? dm[1] + "-" + dm[2] + "-" + dm[3] : null,
              total: tm ? parseFloat(tm[1].replace(/,/g, "")) : null,
              href: el.getAttribute("href") || null,
            });
          }
        });
        return out;
      });
      if (rows.length > 0) break;
    }
    log("RD: " + rows.length + " receipt rows found");
    if (rows.length === 0) {
      log("❌ RD: no receipt rows appeared after Request");
      return results;
    }

    // Filter to backfill window
    const inRange = rows.filter(r => r.date && r.date >= BACKFILL_START);
    log("RD: " + inRange.length + "/" + rows.length + " receipts on/after " + BACKFILL_START);

    // Set up CDP download capture as a fallback for JS-triggered downloads
    const dlDir = "/tmp/rd_downloads";
    fs.rmSync(dlDir, { recursive: true, force: true });
    fs.mkdirSync(dlDir, { recursive: true });
    const client = await page.target().createCDPSession();
    await client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: dlDir }).catch(() => {});

    for (let i = 0; i < inRange.length; i++) {
      const row = inRange[i];
      store.progress = "Downloading RD receipt " + (i + 1) + "/" + inRange.length + " (" + row.date + ")...";
      try {
        let csvText = null;

        // Path 1: direct href fetch with session cookies (most reliable)
        if (row.href && /^https?:|^\//.test(row.href)) {
          csvText = await page.evaluate(async (href) => {
            try {
              const url = href.startsWith("http") ? href : window.location.origin + href;
              const res = await fetch(url, { credentials: "include" });
              if (!res.ok) return null;
              return await res.text();
            } catch { return null; }
          }, row.href);
        }

        // Path 2: click the link, capture the downloaded file via CDP
        if (!csvText) {
          const before = new Set(fs.readdirSync(dlDir));
          await page.evaluate((idx) => {
            const links = Array.from(document.querySelectorAll("a, button"));
            if (links[idx]) links[idx].click();
          }, row.idx);
          for (let w = 0; w < 20; w++) {
            await new Promise(r => setTimeout(r, 1000));
            const now = fs.readdirSync(dlDir).filter(f => !before.has(f) && !f.endsWith(".crdownload"));
            if (now.length > 0) {
              csvText = fs.readFileSync(path.join(dlDir, now[0]), "utf8");
              break;
            }
          }
        }

        if (!csvText) { log("RD: ⚠️ could not download receipt " + row.date + " $" + row.total); results.failed++; continue; }
        if (csvText.slice(0, 2) === "PK") { log("RD: ⚠️ receipt " + row.date + " is binary xlsx — skipping (need CSV)"); results.failed++; continue; }

        const receipt = parseRdReceipt(csvText);
        if (!receipt) { log("RD: ⚠️ could not parse receipt " + row.date); results.failed++; continue; }
        if (receipt.date && receipt.date < BACKFILL_START) { results.skipped++; continue; }

        const key = (receipt.date || row.date) + "_" + receipt.invoiceNo;
        if (store.rd[key]) { results.skipped++; continue; }

        store.rd[key] = {
          invoiceNo: receipt.invoiceNo,
          date: receipt.date || row.date,
          dateTime: receipt.dateTime,
          subTotal: receipt.subTotal,
          tax: receipt.tax,
          total: receipt.total != null ? receipt.total : row.total,
          items: receipt.items,
        };
        results.added++;
        log("RD: ✅ saved invoice " + receipt.invoiceNo + " (" + receipt.date + ") $" + (receipt.total ?? row.total) + " — " + receipt.items.length + " items");
      } catch (e) {
        log("RD: error on receipt " + row.date + ": " + e.message);
        results.failed++;
      }
    }
    log("✅ RD receipts done: +" + results.added + " new, " + results.skipped + " already stored, " + results.failed + " failed");
    return results;
  } catch (e) {
    log("RD FATAL: " + e.message);
    return results;
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
  }
}

// Reads the active account number from the header: "NAAN AND CURRY (017-974499)"
async function getActiveSyscoAccount(page) {
  return await page.evaluate(() => {
    const m = document.body.innerText.match(/\(017-(\d{6})\)/);
    return m ? m[1] : null;
  });
}

// Switches the Sysco account and VERIFIES the header actually changed.
// Returns true only when the target account is confirmed active.
async function switchSyscoAccount(page, loc) {
  const current = await getActiveSyscoAccount(page);
  if (current === loc.match) { log("Sysco: already on " + loc.name); return true; }

  // Open the switcher — click the innermost header element showing the account
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll("button, a, div, span"))
      .filter(el => /\(017-\d{6}\)/.test(el.textContent) && el.textContent.length < 120);
    if (!els.length) return false;
    els.sort((a, b) => a.textContent.length - b.textContent.length);
    const t = els[0];
    (t.closest("button") || t).click();
    return true;
  });

  // Poll for the panel to render the target account number (#017-XXXXXX format)
  let panelReady = false;
  for (let w = 0; w < 12; w++) {
    await new Promise(r => setTimeout(r, 1000));
    panelReady = await page.evaluate((match) => document.body.innerText.includes("#017-" + match), loc.match);
    if (panelReady) break;
  }
  if (!panelReady) { log("Sysco: ⚠️ switcher panel never showed #017-" + loc.match); return false; }

  // Click the target account row (innermost match, climbed to its card)
  await page.evaluate((match) => {
    const els = Array.from(document.querySelectorAll("div, li, button, a, span, p, h3, h4"))
      .filter(el => el.textContent.includes("#017-" + match) && el.textContent.length < 250);
    if (!els.length) return false;
    els.sort((a, b) => a.textContent.length - b.textContent.length);
    let target = els[0];
    for (let up = 0; up < 5 && target; up++) {
      if (/NAAN AND CURRY/i.test(target.textContent)) break;
      target = target.parentElement;
    }
    (target || els[0]).click();
    return true;
  }, loc.match);

  // Verify the header now shows the target account
  for (let w = 0; w < 15; w++) {
    await new Promise(r => setTimeout(r, 1000));
    const active = await getActiveSyscoAccount(page);
    if (active === loc.match) return true;
  }
  return false;
}

// ── Sysco orders scraper ──────────────────────────────────────────────────────
// Flow: login → for each of 5 locations: switch account → /app/orders →
// collect Delivered orders since BACKFILL_START → open each → scrape line
// items from the order detail DOM → dedupe by order number.
async function scrapeSyscoOrders() {
  log("🔵 Sysco orders: starting...");
  store.progress = "Logging into Sysco...";
  let browser;
  const results = { added: 0, skipped: 0, failed: 0 };
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36");
    page.setDefaultTimeout(30000);

    // Login — same Okta flow as the prices app
    await page.goto("https://shop.sysco.com/auth/login", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));
    await page.waitForSelector('input[type="email"]', { timeout: 15000 });
    await page.click('input[type="email"]');
    await page.keyboard.type(process.env.SYSCO_EMAIL, { delay: 50 });
    const nextOk = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, [role=button]"));
      const next = btns.find(b => b.textContent.trim().toLowerCase() === "next");
      if (next) { next.click(); return true; }
      return false;
    });
    if (!nextOk) await page.keyboard.press("Enter");
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));
    await page.waitForSelector('#okta-signin-password, input[type="password"]', { timeout: 20000 });
    await page.click('#okta-signin-password, input[type="password"]');
    await page.keyboard.type(process.env.SYSCO_PASSWORD, { delay: 50 });
    const loginBtn = await page.$("#okta-signin-submit") || await page.$('input[type="submit"]') || await page.$('button[type="submit"]');
    if (loginBtn) await loginBtn.click(); else await page.keyboard.press("Enter");
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 4000));
    log("Sysco: logged in=" + page.url());
    if (!page.url().includes("shop.sysco.com")) throw new Error("Login failed: " + page.url());

    // Dismiss marketing popup if present
    await page.evaluate(() => {
      const closeBtn = document.querySelector('button[aria-label="close icon"], .marketing-modal-close-btn, [class*="modal-close"]');
      if (closeBtn) closeBtn.click();
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));

    for (const loc of SYSCO_LOCATIONS) {
      store.progress = "Sysco: switching to " + loc.name + "...";
      try {
        const switched = await switchSyscoAccount(page, loc);
        log("Sysco: switch to " + loc.name + " (#017-" + loc.match + ") = " + switched);
        if (!switched) {
          log("Sysco: ⏭️ SKIPPING " + loc.name + " — account switch not verified (prevents mislabeled orders)");
          continue;
        }
        await new Promise(r => setTimeout(r, 2000));

        // Orders page
        await page.goto("https://shop.sysco.com/app/orders", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 6000));

        // Collect Delivered order numbers + delivery dates from the Historical list
        const orders = await page.evaluate(() => {
          const out = [];
          const body = document.body.innerText;
          // Pattern per row: ... Delivered ... 4165361 ... 06/06/2026 ... $623.15
          const rowEls = Array.from(document.querySelectorAll("tr, [class*='row'], li"));
          const seen = new Set();
          rowEls.forEach(el => {
            const t = el.innerText || "";
            if (!/Delivered/i.test(t)) return;
            const onum = t.match(/\b(\d{7})\b/);
            const date = t.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
            const total = t.match(/\$([\d,]+\.\d{2})/);
            if (onum && date && !seen.has(onum[1])) {
              seen.add(onum[1]);
              out.push({
                orderNo: onum[1],
                deliveryDate: date[3] + "-" + date[1] + "-" + date[2],
                listTotal: total ? parseFloat(total[1].replace(/,/g, "")) : null,
              });
            }
          });
          // fallback: parse from text if structured rows missed
          if (out.length === 0) {
            const re = /Delivered\s+(\d{7})\s+(\d{2})\/(\d{2})\/(\d{4})[\s\S]{0,80}?\$([\d,]+\.\d{2})/g;
            let m;
            while ((m = re.exec(body)) !== null) {
              if (!seen.has(m[1])) {
                seen.add(m[1]);
                out.push({ orderNo: m[1], deliveryDate: m[4] + "-" + m[2] + "-" + m[3], listTotal: parseFloat(m[5].replace(/,/g, "")) });
              }
            }
          }
          return out;
        });
        const newOrders = orders.filter(o => o.deliveryDate >= BACKFILL_START && !store.sysco[o.orderNo]);
        log("Sysco [" + loc.name + "]: " + orders.length + " delivered orders visible, " + newOrders.length + " new since " + BACKFILL_START);

        for (const ord of newOrders) {
          store.progress = "Sysco " + loc.name + ": reading order " + ord.orderNo + "...";
          try {
            // Open the order detail — retry up to 3x, verify the detail page loaded
            let opened = false;
            for (let attempt = 0; attempt < 3 && !opened; attempt++) {
              const clicked = await page.evaluate((orderNo) => {
                const els = Array.from(document.querySelectorAll("a, td, div, span, button"));
                const el = els.find(e => e.textContent.trim() === orderNo) ||
                           els.find(e => e.textContent.includes(orderNo) && e.textContent.length < 60);
                if (el) {
                  el.scrollIntoView({ block: "center" });
                  const row = el.closest("tr") || el.closest("[class*='row']") || el;
                  (el.tagName === "A" ? el : row).click();
                  return true;
                }
                return false;
              }, ord.orderNo);
              if (!clicked) break;
              await new Promise(r => setTimeout(r, 6000));
              // Detail page has "Back to Orders" / "Total Line Items"; the list page doesn't
              opened = await page.evaluate(() => /Back to Orders|Total Line Items/i.test(document.body.innerText));
              if (!opened) {
                await page.goto("https://shop.sysco.com/app/orders", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
                await new Promise(r => setTimeout(r, 5000));
              }
            }
            if (!opened) { log("Sysco: ⚠️ could not open order " + ord.orderNo); results.failed++; continue; }

            // Scrape line items: rows contain "Name / 1234567 | pack | brand / qty CS($x.xx CS) / allocated / $total"
            const detail = await page.evaluate(() => {
              const items = [];
              const seen = new Set();
              const all = Array.from(document.querySelectorAll("tr, [class*='row'], li, div"));
              all.forEach(el => {
                const t = (el.innerText || "").trim();
                const supcM = t.match(/\b(\d{7})\s*\|/);
                if (!supcM) return;
                if (t.length > 400) return; // too big = container, not a row
                const supc = supcM[1];
                const lines = t.split("\n").map(s => s.trim()).filter(Boolean);
                const supcLineIdx = lines.findIndex(l => l.startsWith(supc));
                const name = supcLineIdx > 0 ? lines[supcLineIdx - 1] : lines[0];
                const qtyM = t.match(/(\d+)\s*CS\s*\(\$([\d,]+\.\d{2})/);
                const totals = t.match(/\$([\d,]+\.\d{2})(?!\s*CS)/g);
                const lastTotal = totals ? parseFloat(totals[totals.length - 1].replace(/[$,]/g, "")) : null;
                const dedupeKey = supc + "_" + name;
                if (seen.has(dedupeKey)) return;
                seen.add(dedupeKey);
                items.push({
                  supc, name,
                  qty: qtyM ? parseInt(qtyM[1]) : 1,
                  unitPrice: qtyM ? parseFloat(qtyM[2].replace(/,/g, "")) : null,
                  total: lastTotal,
                });
              });
              const estM = document.body.innerText.match(/(?:Estimated Total|Est Order Total[^$]*)\$?\s*\$?([\d,]+\.\d{2})/);
              return { items, estTotal: estM ? parseFloat(estM[1].replace(/,/g, "")) : null };
            });

            // Sanity: prefer rows where total ≈ qty × unitPrice; fix obvious misses
            const items = detail.items.map(it => {
              let total = it.total;
              if (it.unitPrice != null && it.qty) {
                const calc = Math.round(it.qty * it.unitPrice * 100) / 100;
                if (total == null || Math.abs(total - calc) > Math.max(1, calc * 0.5)) total = calc;
              }
              return { ...it, total, category: categorizeSysco(it.supc, it.name) };
            }).filter(it => it.total != null && it.total > 0);

            const itemSum = Math.round(items.reduce((s, i) => s + i.total, 0) * 100) / 100;
            store.sysco[ord.orderNo] = {
              orderNo: ord.orderNo,
              location: loc.name,
              locationId: loc.id,
              deliveryDate: ord.deliveryDate,
              total: ord.listTotal != null ? ord.listTotal : (detail.estTotal != null ? detail.estTotal : itemSum),
              itemSum,
              items,
            };
            results.added++;
            log("Sysco: ✅ saved order " + ord.orderNo + " [" + loc.name + "] " + ord.deliveryDate + " $" + store.sysco[ord.orderNo].total + " — " + items.length + " items");
          } catch (e) {
            log("Sysco: error on order " + ord.orderNo + ": " + e.message);
            results.failed++;
          }
          // Back to orders list for the next one
          await page.goto("https://shop.sysco.com/app/orders", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
          await new Promise(r => setTimeout(r, 5000));
        }
      } catch (e) {
        log("Sysco [" + loc.name + "] error: " + e.message);
        results.failed++;
      }
    }
    log("✅ Sysco orders done: +" + results.added + " new, " + results.failed + " failed");
    return results;
  } catch (e) {
    log("Sysco FATAL: " + e.message);
    return results;
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
  }
}

// ── Scrape orchestrator ───────────────────────────────────────────────────────
async function runScrape(source = "all") {
  if (store.scraping) { log("⏭️ Scrape skipped — already running"); return; }
  store.scraping = true;
  store.progress = "Starting...";
  try {
    if (source === "rd" || source === "all") {
      try { await withTimeout(scrapeRdReceipts(), 480000, "RD receipts"); }
      catch (e) { log("❌ RD: " + e.message); }
      saveStore();
    }
    if (source === "sysco" || source === "all") {
      try { await withTimeout(scrapeSyscoOrders(), 900000, "Sysco orders"); }
      catch (e) { log("❌ Sysco: " + e.message); }
      saveStore();
    }
    store.lastUpdated = new Date().toISOString();
    saveStore();
    backupToGitHub().catch(e => log("Backup error: " + e.message));
  } finally {
    store.scraping = false;
    store.progress = "";
  }
}

// ── Dashboard math ────────────────────────────────────────────────────────────
function vegasToday() {
  const now = new Date();
  return new Intl.DateTimeFormat("en-CA", { timeZone: VEGAS_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now); // YYYY-MM-DD
}

function rangeBounds(range) {
  const today = vegasToday();
  if (range === "7") {
    const d = new Date(today + "T00:00:00");
    d.setDate(d.getDate() - 6);
    return { from: d.toISOString().slice(0, 10), to: today, label: "Last 7 Days" };
  }
  if (range === "30") {
    const d = new Date(today + "T00:00:00");
    d.setDate(d.getDate() - 29);
    return { from: d.toISOString().slice(0, 10), to: today, label: "Last 30 Days" };
  }
  // default: current month
  return { from: today.slice(0, 8) + "01", to: today, label: monthLabel(today) };
}

function monthLabel(ymd) {
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return months[parseInt(ymd.slice(5, 7)) - 1] + " " + ymd.slice(0, 4);
}

function buildDashboard(range) {
  const { from, to, label } = rangeBounds(range);
  const clampFrom = from < BACKFILL_START ? BACKFILL_START : from;

  const catTotals = {};
  CATEGORIES.forEach(c => { catTotals[c] = { rd: 0, sysco: 0 }; });

  let rdTotal = 0, rdItemSum = 0, rdInvoices = 0;
  const rdList = [];
  Object.values(store.rd).forEach(inv => {
    if (!inv.date || inv.date < clampFrom || inv.date > to) return;
    rdInvoices++;
    rdTotal += inv.total || 0;
    (inv.items || []).forEach(it => {
      catTotals[it.category] = catTotals[it.category] || { rd: 0, sysco: 0 };
      catTotals[it.category].rd += it.price;
      rdItemSum += it.price;
    });
    rdList.push({ vendor: "rd", key: inv.date + "_" + inv.invoiceNo, date: inv.date, label: "Invoice " + inv.invoiceNo, sub: (inv.items || []).length + " items", total: inv.total || 0, items: inv.items || [] });
  });
  // Tax & adjustments = invoice totals minus categorized line sums
  const rdTaxAdj = Math.round((rdTotal - rdItemSum) * 100) / 100;

  let syscoTotal = 0, syscoOrders = 0;
  const locTotals = {};
  SYSCO_LOCATIONS.forEach(l => { locTotals[l.name] = { total: 0, orders: 0 }; });
  const syscoList = [];
  Object.values(store.sysco).forEach(ord => {
    if (!ord.deliveryDate || ord.deliveryDate < clampFrom || ord.deliveryDate > to) return;
    syscoOrders++;
    syscoTotal += ord.total || 0;
    if (!locTotals[ord.location]) locTotals[ord.location] = { total: 0, orders: 0 };
    locTotals[ord.location].total += ord.total || 0;
    locTotals[ord.location].orders++;
    (ord.items || []).forEach(it => {
      catTotals[it.category] = catTotals[it.category] || { rd: 0, sysco: 0 };
      catTotals[it.category].sysco += it.total;
    });
    syscoList.push({ vendor: "sysco", key: ord.orderNo, date: ord.deliveryDate, label: "Order " + ord.orderNo, sub: ord.location + " · " + (ord.items || []).length + " items", total: ord.total || 0, items: ord.items || [] });
  });

  const r2 = (n) => Math.round(n * 100) / 100;
  const categories = CATEGORIES
    .map(c => ({ name: c, rd: r2(catTotals[c].rd), sysco: r2(catTotals[c].sysco), total: r2(catTotals[c].rd + catTotals[c].sysco) }))
    .filter(c => c.total !== 0)
    .sort((a, b) => b.total - a.total);

  const invoices = [...rdList, ...syscoList].sort((a, b) => b.date.localeCompare(a.date));

  return {
    range, from: clampFrom, to, label,
    rdTotal: r2(rdTotal), syscoTotal: r2(syscoTotal), grandTotal: r2(rdTotal + syscoTotal),
    rdInvoices, syscoOrders, rdTaxAdj,
    categories,
    locations: SYSCO_LOCATIONS.map(l => ({ name: l.name, total: r2(locTotals[l.name].total), orders: locTotals[l.name].orders })).sort((a, b) => b.total - a.total),
    invoices,
    lastUpdated: store.lastUpdated,
    scraping: store.scraping,
    progress: store.progress,
  };
}

// ── API ───────────────────────────────────────────────────────────────────────
app.get("/api/data", (req, res) => {
  res.json(buildDashboard(req.query.range || "month"));
});

app.get("/api/status", (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit) : null;
  res.json({
    status: "running",
    scraping: store.scraping,
    progress: store.progress,
    lastUpdated: store.lastUpdated,
    rdReceipts: Object.keys(store.rd).length,
    syscoOrders: Object.keys(store.sysco).length,
    logEntries: store.log.length,
    log: limit ? store.log.slice(0, limit) : store.log,
  });
});

app.get("/api/trigger", (req, res) => {
  const src = req.query.source || "all";
  if (store.scraping) return res.json({ message: "Scrape already in progress", skipped: true });
  res.json({ message: "Scraping " + src });
  runScrape(src).catch(e => log("Trigger: " + e.message));
});

app.get("/api/force-backup", async (req, res) => {
  await backupToGitHub();
  res.json({ ok: true });
});

// Manually remove a stored invoice/order if something parsed wrong
app.get("/api/clear", (req, res) => {
  const { vendor, key } = req.query;
  if (!vendor || !key) return res.status(400).json({ error: "vendor and key required" });
  const bucket = vendor === "rd" ? store.rd : store.sysco;
  if (bucket[key]) {
    delete bucket[key];
    saveStore();
    log("🧹 Cleared " + vendor + " " + key);
    return res.json({ cleared: true });
  }
  res.json({ cleared: false });
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "../public/index.html")));

// ── Cron: every day 5:00 PM Las Vegas ────────────────────────────────────────
cron.schedule("0 17 * * *", () => {
  log("⏰ Daily 5pm scrape");
  runScrape("all").catch(console.error);
}, { timezone: VEGAS_TZ });

if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    log("🚀 Food cost tracker on port " + PORT + " (tracking from " + BACKFILL_START + ")");
    restoreFromGitHub().catch(e => log("Restore error: " + e.message));
  });
}

module.exports = { parseRdReceipt, categorizeRd, categorizeSysco, buildDashboard, store, CATEGORIES };
