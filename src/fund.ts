import { randomBytes } from "node:crypto";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { host, sats } from "./format.js";
import { normalizeNode, offersFor, unitCost, type Market } from "./market.js";
import { createInvoice, forgetInvoice, readWallet, settleInvoice, type InvoiceState } from "./wallet.js";

/** The node to add sats to: the one named, the cheapest that sells the model, the one already funded, or the one that sells the most. */
export async function fundingNode(market: Market, node?: string, model?: string): Promise<{ node: string; why?: string }> {
  if (node) return { node: normalizeNode(node) };
  const { offers, pictures } = await market.load();
  if (model) {
    const cheapest = offersFor(offers, model).sort((a, b) => unitCost(a) - unitCost(b))[0]
      ?? offersFor(pictures, model).sort((a, b) => a.perPicture - b.perPicture)[0];
    if (!cheapest) throw new Error(`No approved node sells "${model}".`);
    return { node: cheapest.node, why: `${host(cheapest.node)} sells ${cheapest.id} cheapest.` };
  }
  const funded = readWallet().keys.find((k) => offers.some((o) => o.node === k.node));
  if (funded) return { node: funded.node };
  const counts = new Map<string, number>();
  for (const o of offers) counts.set(o.node, (counts.get(o.node) ?? 0) + 1);
  const [best] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!best) throw new Error("No approved node answered. Try again, or pass --node <url>.");
  return { node: best[0], why: `${host(best[0])} sells the most models (${best[1]}).` };
}

type QR = { addData(text: string): void; make(): void; getModuleCount(): number; isDark(row: number, col: number): boolean };
// the encoder qrcode-terminal draws with, here drawn as an SVG
const QRCode = createRequire(import.meta.url)("qrcode-terminal/vendor/QRCode") as new (type: number, level: number) => QR;

function qrSvg(text: string): string {
  const qr = new QRCode(-1, 1);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let dark = "";
  for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) if (qr.isDark(row, col)) dark += `M${col + 4} ${row + 4}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 8} ${n + 8}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${dark}"/></svg>`;
}

const page = (body: string, refresh: boolean) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `${refresh ? '<meta http-equiv="refresh" content="3">' : ""}<title>Pay Routstr</title>` +
  "<style>body{font:16px/1.5 system-ui,sans-serif;max-width:26rem;margin:2rem auto;padding:0 1rem;text-align:center;color:#111;background:#fff}" +
  "svg{width:100%;max-width:20rem}code{display:block;word-break:break-all;font-size:.7rem;color:#555}</style>" + body;

export type FundOutcome = InvoiceState | "declined" | "cancelled";

/**
 * Adds sats from the user's browser. The invoice is shown only on a page on this machine that the app offers
 * the user to open, so the agent never sees it. Ends once it is paid, it runs out, or the call is cancelled.
 */
export async function fundInBrowser(
  node: string,
  amount: number,
  offer: (url: string, message: string) => Promise<boolean>,
  signal: AbortSignal
): Promise<FundOutcome> {
  const invoice = await createInvoice(node, amount);
  let state: InvoiceState = "waiting";
  const token = randomBytes(16).toString("hex");
  const server = http.createServer((req, res) => {
    if (req.method !== "GET" || req.url !== `/${token}`) return void res.writeHead(404).end();
    const where = `your Routstr wallet on ${host(node)}`;
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    }).end(
      state === "paid" ? page(`<h1>Paid</h1><p>${sats(amount)} sats are in ${where}. You can close this page.</p>`, false)
      : state === "expired" ? page("<h1>This invoice ran out</h1><p>Ask your agent to fund again for a new one.</p>", false)
      : page(`<h1>Pay ${sats(amount)} sats</h1><p>They go to ${where}.</p><a href="lightning:${invoice.bolt11}">${qrSvg(invoice.bolt11)}</a>` +
          `<code>${invoice.bolt11}</code><p>Scan it with any Lightning wallet. This page changes once it is paid.</p>`, true)
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${token}`;
  try {
    if (!(await offer(url, `Pay ${sats(amount)} sats to add them to your Routstr wallet on ${host(node)}. The invoice opens in your browser.`))) {
      // never shown, so never paid
      await forgetInvoice(invoice.invoiceId);
      return "declined";
    }
    while (state === "waiting" && Date.now() / 1000 < invoice.expiresAt + 60) {
      if (signal.aborted) return "cancelled";
      await new Promise((resolve) => setTimeout(resolve, 2000));
      state = await settleInvoice(invoice).catch(() => "waiting" as const);
    }
    if (state === "waiting") state = "expired";
    return state;
  } finally {
    // the page shows how it ended a little longer
    setTimeout(() => server.close(), 30_000).unref();
  }
}
