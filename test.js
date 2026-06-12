const fs = require("fs");
const { parseRdReceipt, categorizeSysco, buildDashboard, store } = require("./server/index.js");

const files = [
  "fixtures/receipt-11471.csv",
  "fixtures/receipt-17348.csv",
  "fixtures/receipt-3412.csv",
  "fixtures/receipt-17352.csv",
];

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (extra ? " → " + extra : "")); }
};

console.log("=== RD RECEIPT PARSING ===");
const parsed = {};
for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  const r = parseRdReceipt(text);
  parsed[r.invoiceNo] = r;
  console.log("\nInvoice " + r.invoiceNo + " (" + r.date + "): " + r.items.length + " items, total " + r.total);
  const itemSum = Math.round(r.items.reduce((s, i) => s + i.price, 0) * 100) / 100;
  console.log("  itemSum=" + itemSum + " subTotal=" + r.subTotal + " tax=" + r.tax);
  check("item sum matches sub-total", Math.abs(itemSum - r.subTotal) < 0.01, itemSum + " vs " + r.subTotal);
}

// Invoice 11471: lamb credit -4.12 must net; total 2638.53
check("11471 total", parsed["11471"].total === 2638.53, parsed["11471"].total);
check("11471 date", parsed["11471"].date === "2026-06-01", parsed["11471"].date);
check("11471 has 18 line items (incl credit)", parsed["11471"].items.length === 18, parsed["11471"].items.length);
check("11471 lamb credit captured", parsed["11471"].items.some(i => i.price === -4.12));

// Invoice 17348: full void receipt nets to zero
check("17348 nets to $0", parsed["17348"].total === 0, parsed["17348"].total);
const s17348 = parsed["17348"].items.reduce((s, i) => s + i.price, 0);
check("17348 items net zero", Math.abs(s17348) < 0.01, s17348);

// Invoice 3412: tax handling
check("3412 total 917.22", parsed["3412"].total === 917.22, parsed["3412"].total);
check("3412 tax 19.01", parsed["3412"].tax === 19.01, parsed["3412"].tax);
check("3412 subtotal 898.21", parsed["3412"].subTotal === 898.21, parsed["3412"].subTotal);

// Invoice 17352
check("17352 total 817.69", parsed["17352"].total === 817.69, parsed["17352"].total);

console.log("\n=== CATEGORIZATION (RD) ===");
const catOf = (inv, desc) => parsed[inv].items.find(i => i.desc.includes(desc))?.category;
check("CHX BRST → Protein", catOf("11471", "CHX BRST") === "Protein", catOf("11471", "CHX BRST"));
check("LAMB LEG → Protein", catOf("11471", "LAMB LEG") === "Protein");
check("SPC CINNAMON → Dry & Pantry", catOf("11471", "CINNAMON") === "Dry & Pantry", catOf("11471", "CINNAMON"));
check("PANEER → Dairy", catOf("3412", "PANEER") === "Dairy");
check("YOGURT → Dairy", catOf("3412", "YOGURT") === "Dairy");
check("HRB MINT → Produce", catOf("3412", "MINT") === "Produce");
check("GARLIC PEELED → Produce", catOf("3412", "GARLIC") === "Produce");
check("CAUL → Produce", catOf("3412", "CAUL") === "Produce");
check("BASMATI → Dry & Pantry", catOf("3412", "BASMATI") === "Dry & Pantry");
check("COCONUT MILK → Dry & Pantry (not Dairy)", catOf("3412", "COCONUT") === "Dry & Pantry", catOf("3412", "COCONUT"));
check("FZ BROC → Frozen", catOf("3412", "BROC") === "Frozen", catOf("3412", "BROC"));
check("VEG PEAS → Frozen", catOf("17352", "PEAS") === "Frozen", catOf("17352", "PEAS"));
check("COKE → Beverages", catOf("3412", "COKE CLASSIC") === "Beverages");
check("EVIAN → Beverages", catOf("17352", "EVIAN") === "Beverages");
check("FOIL → Supplies", catOf("3412", "FOIL") === "Supplies");
check("CONT SOUP → Supplies", catOf("3412", "CONT SOUP CMB 16Z") === "Supplies");
check("BAG BRN → Supplies", catOf("3412", "BAG BRN") === "Supplies");
check("KETCHUP → Dry & Pantry", catOf("17352", "KETCHUP") === "Dry & Pantry");
check("BEAN KDNY → Dry & Pantry", catOf("17352", "BEAN KDNY") === "Dry & Pantry");
check("KIT PS → Supplies", catOf("3412", "KIT PS") === "Supplies", catOf("3412", "KIT PS"));
check("FLOUR GOLDN → Dry & Pantry", catOf("17352", "FLOUR") === "Dry & Pantry");
check("CHZ JACK → Dairy", catOf("17352", "CHZ JACK") === "Dairy");
check("CILANTRO → Produce", catOf("17352", "CILANTRO") === "Produce");
check("MICRO FWR ORCHD → Produce", catOf("3412", "ORCHD") === "Produce");
check("CUCUMBER → Produce", catOf("3412", "CUCUMBER") === "Produce");

console.log("\n=== CATEGORIZATION (SYSCO) ===");
check("2822379 cheese → Dairy", categorizeSysco("2822379", "Cheese Cheddr Jack") === "Dairy");
check("5231238 chicken → Protein", categorizeSysco("5231238", "Chicken Brst") === "Protein");
check("0868459 leg meat → Protein", categorizeSysco("0868459", "Chicken Leg Meat") === "Protein");
check("1803287 leg qrtr halal → Protein", categorizeSysco("1803287", "Chicken Leg Qrtr Sm Hal") === "Protein");
check("5106388 shrimp → Protein", categorizeSysco("5106388", "Shrimp Wht P&D") === "Protein");
check("1094721 onion → Produce", categorizeSysco("1094721", "Onion Yellow Jumbo Bag") === "Produce");
check("8474538 baby spinach (untracked SUPC) → Produce", categorizeSysco("8474538", "Spinach Baby Frsh") === "Produce");
check("8379251 flour → Dry & Pantry", categorizeSysco("8379251", "Flour All Purp") === "Dry & Pantry");
check("1053826 peas → Frozen", categorizeSysco("1053826", "Pea Green Packaged") === "Frozen");
check("4978856 diced tomato → Dry & Pantry", categorizeSysco("4978856", "Tomato Diced In Juice") === "Dry & Pantry");
check("unknown SUPC w/ name → keyword fallback", categorizeSysco("9999999", "Pepper Green Bell Choice Fresh") === "Produce");

console.log("\n=== DASHBOARD MATH ===");
// Inject parsed receipts + a fake Sysco order into the store, then build
Object.values(parsed).forEach(r => {
  store.rd[r.date + "_" + r.invoiceNo] = {
    invoiceNo: r.invoiceNo, date: r.date, dateTime: r.dateTime,
    subTotal: r.subTotal, tax: r.tax, total: r.total, items: r.items,
  };
});
store.sysco["4165361"] = {
  orderNo: "4165361", location: "Cheyenne", locationId: "017-974547",
  deliveryDate: "2026-06-06", total: 623.15, itemSum: 623.15,
  items: [
    { supc: "1094721", name: "Onion Yellow Jumbo Bag", qty: 12, unitPrice: 15.49, total: 185.88, category: categorizeSysco("1094721", "Onion Yellow Jumbo Bag") },
    { supc: "4418117", name: "Chicken Legs Quarters", qty: 1, unitPrice: 29.59, total: 29.59, category: categorizeSysco("4418117", "Chicken Legs Quarters") },
  ],
};

const dash = buildDashboard("30");
console.log("RD total: " + dash.rdTotal + " | Sysco total: " + dash.syscoTotal + " | Grand: " + dash.grandTotal);
const expectedRd = Math.round((2638.53 + 0 + 917.22 + 817.69) * 100) / 100;
check("RD total = sum of receipt totals (" + expectedRd + ")", dash.rdTotal === expectedRd, dash.rdTotal);
check("Sysco total = 623.15", dash.syscoTotal === 623.15, dash.syscoTotal);
check("Grand total", dash.grandTotal === Math.round((expectedRd + 623.15) * 100) / 100, dash.grandTotal);
check("Tax & adjustments ≈ RD tax (19.01)", Math.abs(dash.rdTaxAdj - 19.01) < 0.02, dash.rdTaxAdj);
check("Cheyenne location total", dash.locations.find(l => l.name === "Cheyenne")?.total === 623.15);
check("4 RD invoices counted", dash.rdInvoices === 4, dash.rdInvoices);
check("categories sorted desc", dash.categories.every((c, i, a) => i === 0 || a[i - 1].total >= c.total));
const protein = dash.categories.find(c => c.name === "Protein");
console.log("Protein: RD=" + protein.rd + " Sysco=" + protein.sysco);
check("Protein RD includes lamb net + chicken", protein.rd > 2400, protein.rd);
console.log("\nCategories:", dash.categories.map(c => c.name + " " + c.total).join(" | "));
console.log("Invoices in feed: " + dash.invoices.length);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
