/**
 * POST /api/contact — contact-form handler for arc-suite.com
 *
 * Cloudflare Pages Function. Same protections as the Loto Lab contact.php,
 * rebuilt for Cloudflare:
 *
 *   1. POST only, JSON responses
 *   2. Rejects requests over 64 KB
 *   3. Origin / Referer must be one of ALLOWED_HOSTS
 *   4. Honeypot field ("botcheck") — bots get a fake success
 *   5. Rate limiting per IP (hashed): 5 per 5 min, 20 per hour   [optional: KV binding RATE_LIMIT]
 *   6. Cloudflare Turnstile verification                          [optional: TURNSTILE_SECRET]
 *   7. Validation and length limits on every field
 *   8. Sends a styled HTML + plain-text email, Reply-To = the visitor
 *
 * ---------------------------------------------------------------------------
 * Environment (Pages project → Settings → Variables and Secrets)
 *
 *   CONTACT_TO          contact@arc-suite.com        where messages are delivered
 *   CONTACT_FROM        web@arc-suite.com            sender; must be on a domain onboarded to Email Sending
 *   ALLOWED_HOSTS       arc-suite.com,www.arc-suite.com,*.arc-site.pages.dev
 *   IP_SALT             (secret) any long random string
 *
 *   Email provider — set ONE of these:
 *     CF_ACCOUNT_ID + CF_EMAIL_TOKEN (secret)   Cloudflare Email Service REST API (default)
 *     RESEND_API_KEY (secret)                   Resend, as a fallback provider
 *
 *   Optional:
 *     TURNSTILE_SECRET (secret)                 turns on Turnstile verification
 *   Optional bindings (Settings → Bindings):
 *     RATE_LIMIT  (KV namespace)                turns on per-IP rate limiting
 *     EMAIL       (send_email)                  if available, used instead of the REST API
 * ---------------------------------------------------------------------------
 */

const MAX_BYTES = 64 * 1024;
const TOPICS = ["Something new", "Improving what we have", "Infrastructure or security", "Not sure yet"];
const SHORT_WINDOW = 300, SHORT_MAX = 5;
const LONG_WINDOW = 3600, LONG_MAX = 20;

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

async function handle({ request, env }) {
  /* 2) Size */
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BYTES) return json(413, { success: false, message: "The request is too large." });

  /* 3) Origin / Referer */
  if (!originAllowed(request, env)) {
    return json(403, { success: false, message: "Origin not allowed." });
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json(400, { success: false, message: "Could not read the form." });
  }

  /* 4) Honeypot */
  if (String(form.get("botcheck") || "") !== "") {
    return json(200, { success: true, message: "Thanks." });
  }

  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  const ipHash = await sha256(String(env.IP_SALT || "") + ip);

  /* 5) Rate limiting (only if a KV namespace is bound as RATE_LIMIT) */
  if (env.RATE_LIMIT) {
    const limited = await rateLimited(env.RATE_LIMIT, ipHash);
    if (limited) {
      console.warn("contact: rate-limited", ipHash.slice(0, 12));
      return json(429, { success: false, message: "Too many messages. Try again in a few minutes." });
    }
  }

  /* 6) Turnstile (only if TURNSTILE_SECRET is set) */
  if (env.TURNSTILE_SECRET) {
    const ok = await verifyTurnstile(env.TURNSTILE_SECRET, String(form.get("cf-turnstile-response") || ""), ip);
    if (!ok) return json(403, { success: false, message: "We couldn't verify you're not a robot." });
  }

  /* 7) Validate */
  const clean = (v, max) => String(v ?? "").trim().slice(0, max);
  const data = {
    name: clean(form.get("name"), 100),
    email: clean(form.get("email"), 150),
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

  /* 8) Send */
  const referer = request.headers.get("referer") || "";
  const meta = {
    page: safePath(referer),
    country: (request.cf && request.cf.country) || "",
    received: new Date(),
  };
  const mail = buildEmail(data, meta);
  const to = env.CONTACT_TO || "contact@arc-suite.com";
  const from = env.CONTACT_FROM || "web@arc-suite.com";

  try {
    await sendEmail(env, {
      to,
      from: { email: from, name: "ARC website" },
      replyTo: { email: data.email, name: data.name },
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
  } catch (err) {
    console.error("contact: send failed", ipHash.slice(0, 12), err && err.message ? err.message : err);
    return json(502, { success: false, message: "The message couldn't be sent. Try again later." });
  }

  return json(200, { success: true, message: "Message sent." });
}

/* -------------------------------------------------------------------------- */
/* Email delivery                                                             */
/* -------------------------------------------------------------------------- */

async function sendEmail(env, msg) {
  // A) send_email binding, if the project has one
  if (env.EMAIL && typeof env.EMAIL.send === "function") {
    await env.EMAIL.send(msg);
    return;
  }

  // B) Cloudflare Email Service REST API
  if (env.CF_ACCOUNT_ID && env.CF_EMAIL_TOKEN) {
    const res = await fetch(
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
      throw new Error(`cloudflare ${res.status} ${e.code || ""} ${e.message || ""}`.trim());
    }
    return;
  }

  // C) Resend
  if (env.RESEND_API_KEY) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${msg.from.name} <${msg.from.email}>`,
        to: [msg.to],
        reply_to: `${msg.replyTo.name.replace(/[<>"]/g, "")} <${msg.replyTo.email}>`,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      }),
    });
    if (!res.ok) throw new Error(`resend ${res.status} ${await res.text().catch(() => "")}`);
    return;
  }

  throw new Error("No email provider configured (set CF_ACCOUNT_ID + CF_EMAIL_TOKEN, or RESEND_API_KEY)");
}

/* -------------------------------------------------------------------------- */
/* The email itself                                                           */
/* -------------------------------------------------------------------------- */

function buildEmail(d, meta) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const when = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "long", timeStyle: "short", timeZone: "Europe/Madrid",
  }).format(meta.received);

  const subject = `New enquiry from ${d.name}${d.organization ? ` (${d.organization})` : ""}`;
  const replySubject = encodeURIComponent(`Re: your message to ARC`);
  const replyHref = `mailto:${encodeURIComponent(d.email)}?subject=${replySubject}`;

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

          <!-- Header -->
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

          <!-- Body -->
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

          <!-- Message -->
          <tr>
            <td style="background:#FFFFFF;padding:8px 36px 32px;">
              <p style="margin:16px 0 10px;font:500 13px/1.5 ${font};color:${ink2};">Message</p>
              <div style="padding:20px 22px;border-radius:14px;background:${paper};border-left:4px solid ${emerald};font:400 16px/1.65 ${font};color:${navy};white-space:pre-wrap;">${esc(d.message)}</div>
            </td>
          </tr>

          <!-- Action -->
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

          <!-- Footer -->
          <tr>
            <td style="padding:20px 36px;font:400 12px/1.6 ${font};color:#7A8699;">
              Sent from the contact form on arc-suite.com${meta.page ? ` (${esc(meta.page)})` : ""}${meta.country ? `, visitor in ${esc(meta.country)}` : ""}.
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = [
    `NEW ENQUIRY — ARC website`,
    when,
    ``,
    `Name:         ${d.name}`,
    `Email:        ${d.email}`,
    d.organization ? `Organization: ${d.organization}` : null,
    d.topic ? `Topic:        ${d.topic}` : null,
    ``,
    `Message:`,
    d.message,
    ``,
    `—`,
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
  return list.some((rule) =>
    rule.startsWith("*.") ? host.endsWith(rule.slice(1)) : host === rule
  );
}

function originAllowed(request, env) {
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const src = origin || referer;
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

// KV is eventually consistent, so this is a soft limit — good enough to stop
// someone hammering the form. For a hard limit, add a WAF rate-limiting rule
// on /api/contact as well (see README).
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
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    const out = await res.json();
    return out.success === true;
  } catch {
    return false;
  }
}
