// Probe: the web card is flush — the preview image fills the
// card edge to edge with the title and domain overlaid at the
// bottom on a gradient scrim, and the no-image card has its
// title and domain at the bottom with dark text and no scrim.
// Saves a screenshot next to this script for a visual check.
// Requires `npm run build` first. Run under xvfb-run -a. Not
// part of the e2e suite: run it by hand when the link layout
// changes.
import electronPath from "electron";
import { _electron as electron } from "playwright-core";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bowerbird-link-flush-"));
const boardPath = path.join(tmp, "board.json");
const dataHome = path.join(tmp, "data");
const configHome = path.join(tmp, "config");
const pluginsDir = path.join(tmp, "plugins");
fs.mkdirSync(dataHome, { recursive: true });
fs.mkdirSync(configHome, { recursive: true });
fs.mkdirSync(pluginsDir, { recursive: true });

// The link image must be an http(s) URL (safeHttpUrl), so
// serve the welcome photo over a local server.
const imgPath = path.join(repoRoot, "assets", "welcome-bower.jpg");
const server = http.createServer((req, res) => {
  if (req.url === "/photo.jpg") {
    res.writeHead(200, { "Content-Type": "image/jpeg" });
    fs.createReadStream(imgPath).pipe(res);
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const imgUrl = `http://127.0.0.1:${port}/photo.jpg`;

const board = {
  items: [
    { id: 1, group: null, pos: { x: 100, y: 100 }, size: { w: 320, h: 300 }, kind: { UrlCard: { url: "https://example.com/photo", title: "A photo on the web", description: "should not show", image: imgUrl, icon: null, embed: false } } },
    { id: 2, group: null, pos: { x: 500, y: 100 }, size: { w: 320, h: 132 }, kind: { UrlCard: { url: "https://example.com", title: "Example Domain", description: "A sample link card", image: null, icon: null, embed: false } } },
  ],
  camera: { x: 0, y: 0, zoom: 1 },
  next_id: 3,
  next_group: 1,
  bg: "#FFFFFF",
  grid: "Dots",
};
fs.writeFileSync(boardPath, JSON.stringify(board));

const fail = (msg) => { console.error("FAIL:", msg); process.exit(1); };
const app = await electron.launch({
  executablePath: electronPath,
  args: [".", "--no-sandbox", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  cwd: repoRoot,
  env: { ...process.env, BOWERBIRD_BOARD_PATH: boardPath, XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: configHome, BOWERBIRD_PLUGINS_DIR: pluginsDir },
});
const page = await app.firstWindow();
await page.setViewportSize({ width: 1000, height: 560 });
await page.waitForSelector("#board", { timeout: 30000 });
await page.locator(`#cards .card[data-id="1"]`).first().waitFor({ timeout: 30000 });
// The image must load before the layout is judged.
await page.waitForFunction(() => {
  const img = document.querySelector(`#cards .card[data-id="1"] .link-image img`);
  return img && img.complete && img.naturalWidth > 0;
}, { timeout: 30000 }).catch(() => fail("link image did not load"));

const m = await page.evaluate(() => {
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
  };
  const card1 = document.querySelector(`#cards .card[data-id="1"]`);
  const card2 = document.querySelector(`#cards .card[data-id="2"]`);
  const img = card1.querySelector(".link-image");
  const title1 = card1.querySelector(".link-title");
  const domain1 = card1.querySelector(".link-domain");
  const title2 = card2.querySelector(".link-title");
  const domain2 = card2.querySelector(".link-domain");
  const cs = (el, prop) => getComputedStyle(el)[prop];
  return {
    card1: rect(card1),
    img: rect(img),
    title1: { ...rect(title1), color: cs(title1, "color") },
    domain1: { ...rect(domain1), color: cs(domain1, "color") },
    card2: rect(card2),
    title2: { ...rect(title2), color: cs(title2, "color") },
    domain2: { ...rect(domain2), color: cs(domain2, "color") },
    hasImage2: !!card2.querySelector(".link-image"),
    title1Action: title1.getAttribute("data-action"),
    domain1Action: domain1.getAttribute("data-action"),
  };
});
console.log(JSON.stringify(m, null, 2));
const tol = 2;
// With an image: the image fills the card edge to edge.
if (Math.abs(m.img.top - m.card1.top) > tol || Math.abs(m.img.left - m.card1.left) > tol ||
    Math.abs(m.img.right - m.card1.right) > tol || Math.abs(m.img.bottom - m.card1.bottom) > tol) {
  fail("link image does not fill the card edge to edge");
}
// The title and domain sit at the bottom, over the image, in
// white (over the scrim) — not dark text on a white card.
if (m.title1.color !== "rgb(255, 255, 255)") fail(`title over the image is ${m.title1.color}, expected white`);
if (m.domain1.color !== "rgba(255, 255, 255, 0.85)") fail(`domain over the image is ${m.domain1.color}, expected white 85%`);
if (m.card1.bottom - m.title1.bottom < 10 || m.card1.bottom - m.title1.bottom > 45) {
  fail(`title is not at the bottom of the image card (gap ${m.card1.bottom - m.title1.bottom})`);
}
if (m.card1.bottom - m.domain1.bottom < 5 || m.card1.bottom - m.domain1.bottom > 20) {
  fail(`domain is not at the bottom of the image card (gap ${m.card1.bottom - m.domain1.bottom})`);
}
// Without an image: no image element, dark title and domain,
// at the bottom of the card, no scrim.
if (m.hasImage2) fail("no-image card has a link image");
if (m.title2.color === "rgb(255, 255, 255)") fail("no-image title is white on a white card");
if (m.domain2.color === "rgb(255, 255, 255)" || m.domain2.color === "rgba(255, 255, 255, 0.85)") fail("no-image domain is white on a white card");
if (m.card2.bottom - m.title2.bottom < 10 || m.card2.bottom - m.title2.bottom > 45) {
  fail(`no-image title is not at the bottom of the card (gap ${m.card2.bottom - m.title2.bottom})`);
}
// The open-link behaviour is intact: title and domain still
// carry the open-link action.
if (m.title1Action !== "open-link" || m.domain1Action !== "open-link") {
  fail("title/domain lost the open-link action");
}
// Only the title and the domain open the link: the image
// wrapper is a plain div with no action, so clicking the
// image selects the card instead of opening the site.
const imgWrap = await page.evaluate(() => {
  const w = document.querySelector(`#cards .card[data-id="1"] .link-image`);
  return w ? { tag: w.tagName, action: w.getAttribute("data-action") } : null;
});
if (!imgWrap) fail("no link-image wrapper");
if (imgWrap.tag !== "DIV" || imgWrap.action !== null) {
  fail(`link image wrapper is <${imgWrap.tag}> with action ${imgWrap.action}, expected a plain <div>`);
}
// The image never changes on select/deselect: its fit and
// box are identical deselected, selected, and deselected
// again. Click the image (top, clear of the title/domain
// overlay) to select, then empty board to deselect.
const imgState = () => page.evaluate(() => {
  const card = document.querySelector(`#cards .card[data-id="1"]`);
  const img = card?.querySelector(".link-image img");
  if (!img) return null;
  const r = img.getBoundingClientRect();
  return {
    fit: getComputedStyle(img).objectFit,
    inlineFit: img.style.objectFit || null,
    rect: { top: r.top, left: r.left, w: r.width, h: r.height },
    selected: card.classList.contains("selected"),
  };
});
const before = await imgState();
if (!before) fail("no link image to measure");
if (before.fit !== "cover") fail(`link image fit is ${before.fit} deselected, expected cover`);
if (before.selected) fail("link card starts selected");
await page.mouse.click(260, 160);
await page.waitForFunction(() => {
  const card = document.querySelector(`#cards .card[data-id="1"]`);
  return card && card.classList.contains("selected");
}, { timeout: 10000 }).catch(() => fail("clicking the link image did not select the card"));
const selected = await imgState();
await page.mouse.click(900, 500);
await page.waitForFunction(() => {
  const card = document.querySelector(`#cards .card[data-id="1"]`);
  return card && !card.classList.contains("selected");
}, { timeout: 10000 }).catch(() => fail("clicking empty board did not deselect the card"));
const after = await imgState();
const same = (a, b) => a && b && a.fit === b.fit && a.inlineFit === b.inlineFit &&
  Math.abs(a.rect.top - b.rect.top) <= tol && Math.abs(a.rect.left - b.rect.left) <= tol &&
  Math.abs(a.rect.w - b.rect.w) <= tol && Math.abs(a.rect.h - b.rect.h) <= tol;
if (!same(before, selected)) fail(`link image changed on select: ${JSON.stringify(before)} -> ${JSON.stringify(selected)}`);
if (!same(before, after)) fail(`link image changed on deselect: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
console.log("link image identical deselected/selected/deselected:", JSON.stringify(before));

const shot = path.join(path.dirname(fileURLToPath(import.meta.url)), "link-flush-shot.png");
await page.screenshot({ path: shot });
console.log("screenshot:", shot);
console.log("PASS: link card is flush — image full-bleed with the title/domain overlaid at the bottom, no-image card dark text at the bottom");
await app.close();
server.close();
process.exit(0);
