/**
 * POST /api/contact — contact-form handler for arc-suite.com
 * Cloudflare Pages Function. No dependencies.
 *
 * Order of operations
 *   1. POST only
 *   2. Reject oversized bodies (64 KB)
 *   3. Origin / Referer must match ALLOWED_HOSTS
 *   4. Honeypot field ("botcheck") → fake success
 *   5. Per-IP rate limit, hashed IP            [optional: KV binding RATE_LIMIT]
 *   6. Turnstile verification                  [optional: TURNSTILE_SECRET]
 *   7. Validate and clean every field
 *   8. Store a durable copy of the enquiry     [optional: KV binding ENQUIRIES]
 *   9. Send the email, trying each configured provider in turn
 *  10. Ping a webhook, after the response      [optional: NOTIFY_WEBHOOK]
 *
 * Every optional piece stays dormant until its variable or binding exists,
 * so the form works from the first deploy and hardens as you configure it.
 * Full walkthrough: docs/SETUP.md
 */

const MAX_BYTES = 64 * 1024;
const TOPICS = ["Something new", "Improving what we have", "Infrastructure or security", "Not sure yet"];
const SHORT_WINDOW = 300, SHORT_MAX = 5;      // 5 messages / 5 minutes
const LONG_WINDOW = 3600, LONG_MAX = 20;      // 20 messages / hour
const ENQUIRY_TTL = 60 * 60 * 24 * 90;        // keep stored copies 90 days
const SEND_TIMEOUT = 10000;                   // per provider attempt

export async function onRequest(context) {
  if (context.request.method !== "POST") {
    return json(405, { success: false, message: "Method not allowed." }, { Allow: "POST" });
  }
  try {
    return await handle(context);
  } catch (err) {
    console.error("contact: unhandled", err && err.stack ? err.stack : err);
    return json(500, { success: false, message: "Something went wrong on our side." });
  }
}

async function handle({ request, env, waitUntil }) {
  const later = typeof waitUntil === "function" ? waitUntil : (p) => { p.catch(() => {}); };

  /* 2) Size ---------------------------------------------------------- */
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BYTES) return json(413, { success: false, message: "The request is too large." });

  /* 3) Origin -------------------------------------------------------- */
  if (!originAllowed(request, env)) {
    console.warn("contact: blocked origin", request.headers.get("origin") || request.headers.get("referer") || "none");
    return json(403, { success: false, message: "Origin not allowed." });
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json(400, { success: false, message: "Could not read the form." });
  }

  /* 4) Honeypot ------------------------------------------------------ */
  if (String(form.get("botcheck") || "") !== "") {
    return json(200, { success: true, message: "Thanks." });
  }

  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  const ipHash = await sha256(String(env.IP_SALT || "") + ip);
  const shortHash = ipHash.slice(0, 12);

  /* 5) Rate limit ---------------------------------------------------- */
  if (env.RATE_LIMIT) {
    try {
      if (await rateLimited(env.RATE_LIMIT, ipHash)) {
        console.warn("contact: rate-limited", shortHash);
        return json(429, { success: false, message: "Too many messages. Try again in a few minutes." });
      }
    } catch (err) {
      // A KV problem must never block a real enquiry.
      console.error("contact: rate-limit check failed", err && err.message);
    }
  }

  /* 6) Turnstile ----------------------------------------------------- */
  if (env.TURNSTILE_SECRET) {
    const ok = await verifyTurnstile(env.TURNSTILE_SECRET, String(form.get("cf-turnstile-response") || ""), ip);
    if (!ok) {
      console.warn("contact: turnstile failed", shortHash);
      return json(403, { success: false, message: "We couldn't verify you're not a robot. Reload the page and try again." });
    }
  }

  /* 7) Validate ------------------------------------------------------ */
  const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max);
  const data = {
    name: clean(form.get("name"), 100),
    email: clean(form.get("email"), 150).toLowerCase(),
    organization: clean(form.get("organization"), 150),
    topic: clean(form.get("topic"), 40),
    message: clean(String(form.get("message") ?? "").replace(/\r\n?/g, "\n"), 5000),
  };
  const errors = [];
  if (data.name.length < 2 || /[\r\n]/.test(data.name)) errors.push("name");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email) || /[\r\n]/.test(data.email)) errors.push("email");
  if (/[\r\n]/.test(data.organization)) errors.push("organization");
  if (data.message.length < 5) errors.push("message");
  if (!TOPICS.includes(data.topic)) data.topic = "";
  if (errors.length) {
    return json(400, { success: false, message: "Check the highlighted fields.", fields: errors });
  }

  const meta = {
    page: safePath(request.headers.get("referer") || ""),
    country: (request.cf && request.cf.country) || "",
    ray: request.headers.get("cf-ray") || "",
    ipHash: shortHash,
    received: new Date(),
  };

  /* 8) Durable copy, written before we try to send -------------------- */
  const recordKey = `enq:${meta.received.toISOString()}:${shortHash}`;
  if (env.ENQUIRIES) {
    try {
      await env.ENQUIRIES.put(recordKey, JSON.stringify({ ...data, meta, status: "pending" }), { expirationTtl: ENQUIRY_TTL });
    } catch (err) {
      console.error("contact: could not store enquiry", err && err.message);
    }
  }

  /* 9) Send ----------------------------------------------------------- */
  const mail = buildEmail(data, meta);
  const msg = {
    to: env.CONTACT_TO || "contact@arc-suite.com",
    from: { email: env.CONTACT_FROM || "web@arc-suite.com", name: "ARC website" },
    replyTo: { email: data.email, name: data.name },
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  };

  const result = await send(env, msg);

  if (env.ENQUIRIES) {
    const patch = { ...data, meta, status: result.ok ? "sent" : "failed", via: result.via, error: result.error };
    later(env.ENQUIRIES.put(recordKey, JSON.stringify(patch), { expirationTtl: ENQUIRY_TTL }).catch(() => {}));
  }
  if (env.NOTIFY_WEBHOOK) {
    later(notify(env.NOTIFY_WEBHOOK, data, result).catch(() => {}));
  }

  if (!result.ok) {
    console.error("contact: all providers failed", shortHash, result.error);
    return json(502, { success: false, message: `The message couldn't be sent. Email us directly at ${msg.to}.` });
  }

  console.log("contact: sent", shortHash, "via", result.via);
  return json(200, { success: true, message: "Message sent." });
}

/* -------------------------------------------------------------------------- */
/* Sending: try every configured provider, in order, before giving up.         */
/* -------------------------------------------------------------------------- */

function providerOrder(env) {
  const configured = [];
  if (env.EMAIL && typeof env.EMAIL.send === "function") configured.push("binding");
  if (env.RESEND_API_KEY) configured.push("resend");
  if (env.CF_ACCOUNT_ID && env.CF_EMAIL_TOKEN) configured.push("cloudflare");

  const wanted = String(env.EMAIL_PROVIDER_ORDER || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!wanted.length) return configured;
  return wanted.filter((p) => configured.includes(p)).concat(configured.filter((p) => !wanted.includes(p)));
}

async function send(env, msg) {
  const order = providerOrder(env);
  if (!order.length) return { ok: false, via: null, error: "no email provider configured" };

  const failures = [];
  for (const via of order) {
    try {
      await withRetry(() => PROVIDERS[via](env, msg));
      return { ok: true, via, error: null };
    } catch (err) {
      const reason = (err && err.message) || String(err);
      console.error(`contact: provider ${via} failed`, reason);
      failures.push(`${via}: ${reason}`);
    }
  }
  return { ok: false, via: null, error: failures.join(" | ") };
}

// One retry, because most provider failures are transient.
async function withRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err && err.permanent) throw err;
    await new Promise((r) => setTimeout(r, 400));
    return await fn();
  }
}

const PROVIDERS = {
  // A) send_email binding, where the platform offers it
  async binding(env, msg) {
    await env.EMAIL.send(msg);
  },

  // B) Resend
  async resend(env, msg) {
    const res = await timedFetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${msg.from.name} <${msg.from.email}>`,
        to: [msg.to],
        reply_to: `${sanitizeName(msg.replyTo.name)} <${msg.replyTo.email}>`,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throwHttp(res.status, `resend ${res.status} ${body.slice(0, 200)}`);
    }
  },

  // C) Cloudflare Email Service REST API
  async cloudflare(env, msg) {
    const res = await timedFetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/sending/send`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.CF_EMAIL_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          to: msg.to,
          from: { address: msg.from.email, name: msg.from.name },
          reply_to: msg.replyTo.email,
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
        }),
      }
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) {
      const e = (body.errors && body.errors[0]) || {};
      throwHttp(res.status, `cloudflare ${res.status} ${e.code || ""} ${e.message || ""}`.trim());
    }
  },
};

function timedFetch(url, opts) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(SEND_TIMEOUT) });
}

// A 4xx other than 429 means the request itself is wrong: retrying won't help.
function throwHttp(status, message) {
  const err = new Error(message);
  err.permanent = status >= 400 && status < 500 && status !== 429;
  throw err;
}

function sanitizeName(s) {
  return String(s).replace(/[<>"\r\n]/g, "").slice(0, 80);
}

/* -------------------------------------------------------------------------- */
/* Optional webhook (Slack, Discord, or anything that accepts JSON)            */
/* -------------------------------------------------------------------------- */

async function notify(url, data, result) {
  const line = [
    result.ok ? "New ARC enquiry" : "ARC enquiry — EMAIL FAILED, copy is in KV",
    `From: ${data.name}${data.organization ? ` (${data.organization})` : ""} <${data.email}>`,
    data.topic ? `Topic: ${data.topic}` : null,
    `${data.message.slice(0, 500)}${data.message.length > 500 ? "…" : ""}`,
    result.ok ? `Sent via ${result.via}` : `Error: ${result.error}`,
  ].filter(Boolean).join("\n");

  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: line, content: line }), // "text" for Slack, "content" for Discord
    signal: AbortSignal.timeout(5000),
  });
}

/* -------------------------------------------------------------------------- */
/* The email itself                                                           */
/* -------------------------------------------------------------------------- */

function buildEmail(d, meta) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const when = new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Madrid" }).format(meta.received);

  const subject = `New enquiry from ${d.name}${d.organization ? ` (${d.organization})` : ""}`;
  const replyHref = `mailto:${encodeURIComponent(d.email)}?subject=${encodeURIComponent("Re: your message to ARC")}`;

  const navy = "#0A1E3C", teal = "#085041", emerald = "#14B88A", paper = "#F7F7F3", ink2 = "#45546B", line = "#E2E5DE";
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

  const row = (label, value) => value ? `
            <tr>
              <td style="padding:14px 0;border-top:1px solid ${line};width:130px;vertical-align:top;font:500 13px/1.5 ${font};color:${ink2};">${label}</td>
              <td style="padding:14px 0;border-top:1px solid ${line};vertical-align:top;font:600 15px/1.5 ${font};color:${navy};">${value}</td>
            </tr>` : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light only">
  <meta name="supported-color-schemes" content="light">
  <title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${paper};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(d.message.slice(0, 120))}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${paper};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">

          <tr>
            <td style="background:${navy};border-radius:20px 20px 0 0;padding:28px 36px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font:700 22px/1 ${font};letter-spacing:3px;color:#FFFFFF;">
                    <span style="display:inline-block;width:10px;height:10px;border-radius:10px 10px 0 0;background:${emerald};margin-right:10px;vertical-align:middle;"></span>ARC
                  </td>
                  <td align="right" style="font:500 13px/1 ${font};color:#A9B7C9;">New enquiry</td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="background:#FFFFFF;padding:36px 36px 8px;">
              <p style="margin:0 0 6px;font:500 14px/1.4 ${font};color:${ink2};">${esc(when)}</p>
              <h1 style="margin:0 0 ${d.topic ? "14px" : "24px"};font:700 26px/1.2 ${font};color:${navy};letter-spacing:-0.3px;">${esc(d.name)} wants to talk.</h1>
              ${d.topic ? `<p style="margin:0 0 24px;"><span style="display:inline-block;padding:6px 12px;border-radius:999px;background:#E3F6EF;font:600 13px/1 ${font};color:${teal};">${esc(d.topic)}</span></p>` : ""}

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                ${row("Name", esc(d.name))}
                ${row("Email", `<a href="mailto:${esc(d.email)}" style="color:${teal};text-decoration:underline;">${esc(d.email)}</a>`)}
                ${row("Organization", esc(d.organization))}
              </table>
            </td>
          </tr>

          <tr>
            <td style="background:#FFFFFF;padding:8px 36px 32px;">
              <p style="margin:16px 0 10px;font:500 13px/1.5 ${font};color:${ink2};">Message</p>
              <div style="padding:20px 22px;border-radius:14px;background:${paper};border-left:4px solid ${emerald};font:400 16px/1.65 ${font};color:${navy};white-space:pre-wrap;">${esc(d.message)}</div>
            </td>
          </tr>

          <tr>
            <td style="background:#FFFFFF;padding:0 36px 36px;border-radius:0 0 20px 20px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="border-radius:999px;background:${navy};">
                    <a href="${replyHref}" style="display:inline-block;padding:14px 26px;font:600 15px/1 ${font};color:#FFFFFF;text-decoration:none;border-radius:999px;">Reply to ${esc(d.name.split(" ")[0])}</a>
                  </td>
                </tr>
              </table>
              <p style="margin:14px 0 0;font:400 13px/1.5 ${font};color:${ink2};">Or just hit reply. It goes straight to ${esc(d.email)}.</p>
            </td>
          </tr>

          <tr>
            <td style="padding:20px 36px;font:400 12px/1.6 ${font};color:#7A8699;">
              Sent from the contact form on arc-suite.com${meta.page ? ` (${esc(meta.page)})` : ""}${meta.country ? `, visitor in ${esc(meta.country)}` : ""}.${meta.ray ? ` Ray ${esc(meta.ray)}.` : ""}
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = [
    "NEW ENQUIRY — ARC website",
    when,
    "",
    `Name:         ${d.name}`,
    `Email:        ${d.email}`,
    d.organization ? `Organization: ${d.organization}` : null,
    d.topic ? `Topic:        ${d.topic}` : null,
    "",
    "Message:",
    d.message,
    "",
    "—",
    `Reply to this email to answer ${d.name} directly.`,
    `Sent from the contact form on arc-suite.com${meta.page ? ` (${meta.page})` : ""}.`,
  ].filter((l) => l !== null).join("\n");

  return { subject, html, text };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function hostAllowed(host, env) {
  const list = String(env.ALLOWED_HOSTS || "arc-suite.com,www.arc-suite.com")
    .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  host = host.toLowerCase();
  return list.some((rule) => (rule.startsWith("*.") ? host.endsWith(rule.slice(1)) : host === rule));
}

function originAllowed(request, env) {
  const src = request.headers.get("origin") || request.headers.get("referer");
  if (!src) return false;
  try {
    return hostAllowed(new URL(src).hostname, env);
  } catch {
    return false;
  }
}

function safePath(url) {
  try { return new URL(url).pathname.slice(0, 120); } catch { return ""; }
}

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// KV is eventually consistent, so this is a soft limit. Pair it with a WAF
// rate-limiting rule on /api/contact for a hard one (see docs/SETUP.md).
async function rateLimited(kv, key) {
  const now = Math.floor(Date.now() / 1000);
  const k = `rl:${key}`;
  let stamps = [];
  try { stamps = JSON.parse((await kv.get(k)) || "[]"); } catch { stamps = []; }
  stamps = stamps.filter((t) => now - t < LONG_WINDOW);
  const inShort = stamps.filter((t) => now - t < SHORT_WINDOW).length;
  if (inShort >= SHORT_MAX || stamps.length >= LONG_MAX) return true;
  stamps.push(now);
  await kv.put(k, JSON.stringify(stamps), { expirationTtl: LONG_WINDOW });
  return false;
}

async function verifyTurnstile(secret, token, ip) {
  if (!token) return false;
  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  body.append("remoteip", ip);
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", body, signal: AbortSignal.timeout(8000),
    });
    const out = await res.json();
    return out.success === true;
  } catch (err) {
    console.error("contact: turnstile check failed", err && err.message);
    return false;
  }
}
