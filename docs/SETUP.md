# Setup: Cloudflare Pages + working contact email

Do these in order. Steps 1–4 get the site live and the form delivering mail; 5–8 harden it. Anything marked *later* can wait without breaking anything.

---

## 1. Domain on Cloudflare

1. Cloudflare dashboard → **Add a domain** → `arc-suite.com` → follow the nameserver change at your registrar.
2. Wait until the zone shows **Active**.
3. SSL/TLS → Overview → set encryption mode to **Full (strict)**.
4. SSL/TLS → Edge Certificates → turn on **Always Use HTTPS** and **Automatic HTTPS Rewrites**.

---

## 2. Pages project

1. **Workers & Pages → Create → Pages → Connect to Git** → `Contact-ARC/ARC-Site`.
2. Build settings:
   - Framework preset: **None**
   - Build command: *(empty)*
   - Build output directory: **`public`**
   - Root directory: *(empty)*
3. Production branch: **`main`**. `Development` and any feature branch get their own preview URL automatically.
4. Deploy, then open the `*.pages.dev` URL and check the site renders.
5. **Custom domains** → add `arc-suite.com` and `www.arc-suite.com`.
6. Pick one canonical host. To send `www` to the apex: **Rules → Redirect Rules → Create**
   - When: `Hostname equals www.arc-suite.com`
   - Then: Dynamic redirect, `concat("https://arc-suite.com", http.request.uri.path)`, status **301**, preserve query string.

Note the exact project name (for example `arc-site`); you need it in `ALLOWED_HOSTS`.

---

## 3. The mailbox: where contact@arc-suite.com lands

Pick **one**. Both options own the root domain's MX records, so they can't run side by side.

### Option A — Cloudflare Email Routing (free, receive only)

Good for starting today. You receive at contact@, but you reply from your personal address unless you add a sending service.

1. **Email → Email Routing → Get started**. Cloudflare adds the MX and SPF records for you.
2. Create the address `contact@arc-suite.com` → destination: your personal inbox.
3. Open the verification email Cloudflare sends to that inbox and confirm it.
4. *Optional, useful:* add a catch-all to the same destination.

### Option B — Google Workspace (paid, full mailbox)

What you set up for The Loto Lab. You can send *as* contact@ and share the inbox.

1. Sign up for Workspace with `arc-suite.com`, verify the domain.
2. In Cloudflare DNS, add Google's MX records (from the Workspace setup screen), proxy **off** (grey cloud).
3. Add Google's DKIM TXT record from Workspace → Apps → Gmail → Authenticate email.
4. SPF: see the table in step 5.

Either way, **create a second address for DMARC reports**: `dmarc@arc-suite.com` → same inbox. It fills up, but you want it at first.

---

## 4. Sending: making the form's email arrive

The function tries providers in order and falls back if one fails. Configure **both**.

### 4a. Resend (primary)

Mature, free tier is generous, good deliverability.

1. Sign up at resend.com → **Domains → Add domain** → use the subdomain **`send.arc-suite.com`**.
   Using a subdomain keeps your form mail separate from your real mailbox, so a spam complaint can't hurt your main domain's reputation.
2. Resend shows the DNS records to add (an MX for bounce handling, an SPF TXT and a DKIM record). Add them in Cloudflare DNS exactly as shown, all proxy **off**. If Resend offers the Cloudflare integration, let it add them.
3. Wait for the domain to show **Verified**.
4. **API Keys → Create** → permission **Sending access** only → copy the key (`re_…`). You see it once.
5. Your sender becomes `web@send.arc-suite.com` (`CONTACT_FROM` in step 6).

### 4b. Cloudflare Email Service (fallback)

1. **Compute → Email Service → Email Sending** → onboard `arc-suite.com` and add the records it asks for.
2. Add `contact@arc-suite.com` as a **verified destination address** (Email → Email Routing → Destination addresses). Sending to verified destinations is free on all plans; sending to anyone else needs Workers Paid. The form only ever mails you, so the free path is enough.
3. **My Profile → API Tokens → Create Token** → custom token with the **Email Sending** permission on your account → copy it.
4. Copy your **Account ID** from the dashboard sidebar.

If step 4b turns out to need a paid plan on your account, leave those variables unset. Resend alone still works, and the function just logs that one provider is configured.

---

## 5. DNS records for deliverability

Without these, your form mail and your replies land in spam. Add in Cloudflare → DNS, all proxy **off**.

| Type | Name | Value | Notes |
|---|---|---|---|
| TXT | `arc-suite.com` | `v=spf1 include:_spf.mx.cloudflare.net ~all` | **Option A**. Cloudflare usually adds this itself |
| TXT | `arc-suite.com` | `v=spf1 include:_spf.google.com ~all` | **Option B** instead of the line above |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@arc-suite.com; fo=1` | Start here |
| MX / TXT | `send` | *(from the Resend dashboard)* | Step 4a |
| TXT | *(Google's DKIM name)* | *(from Workspace)* | Option B only |

Only **one** SPF record per name. If you ever need two sources on the same name, merge them into one record with two `include:` terms.

After two to four weeks of clean DMARC reports, tighten to `p=quarantine`, and later `p=reject`.

---

## 6. Variables and secrets

Pages project → **Settings → Variables and Secrets**. Add to **Production** and **Preview** (preview deployments need them too, or the form fails there).

| Name | Value | Type |
|---|---|---|
| `CONTACT_TO` | `contact@arc-suite.com` | Text |
| `CONTACT_FROM` | `web@send.arc-suite.com` | Text |
| `ALLOWED_HOSTS` | `arc-suite.com,www.arc-suite.com,*.arc-site.pages.dev` | Text |
| `IP_SALT` | a long random string | **Secret** |
| `RESEND_API_KEY` | `re_…` | **Secret** |
| `CF_ACCOUNT_ID` | your account ID | Text |
| `CF_EMAIL_TOKEN` | the API token from 4b | **Secret** |
| `EMAIL_PROVIDER_ORDER` | `resend,cloudflare` | Text (optional) |
| `NOTIFY_WEBHOOK` | Slack or Discord webhook URL | **Secret** (optional) |
| `TURNSTILE_SECRET` | from step 8 | **Secret** (optional) |

Replace `arc-site` in `ALLOWED_HOSTS` with your real project name.

Generate the salt:

```bash
openssl rand -hex 32
```

Redeploy after adding variables. Pages only picks them up on the next build.

---

## 7. KV: rate limiting and a copy of every enquiry

Both are optional, and both are worth it. The first stops someone hammering the form; the second means a provider outage can't lose you a lead.

1. **Storage & Databases → KV → Create namespace**: `arc-rate-limit` and `arc-enquiries`.
2. Pages project → **Settings → Bindings → Add → KV namespace**:
   - Variable name `RATE_LIMIT` → `arc-rate-limit`
   - Variable name `ENQUIRIES` → `arc-enquiries`
   - Add both for Production and Preview.
3. Redeploy.

Enquiries are stored under keys like `enq:2026-09-23T10:04:11.000Z:9f2c1a…` with a status of `sent` or `failed`, and expire after 90 days. Read them in the dashboard, or:

```bash
npx wrangler kv key list --binding ENQUIRIES
```

Add a hard rate limit too: **Security → WAF → Rate limiting rules → Create**
- When: `URI Path equals /api/contact` and `Request Method equals POST`
- Rate: 10 requests per 1 minute per IP → Action: **Block**, duration 10 minutes.

KV is eventually consistent, so the in-code limit is a soft one; this rule is the hard one.

---

## 8. Turnstile (optional, recommended once the form is live)

1. **Turnstile → Add site** → domain `arc-suite.com` (add your `pages.dev` domain too) → widget mode **Managed**.
2. Copy the **site key** (public) and **secret key** (private).
3. Put the site key in every page:

```bash
grep -rl 'name="arc:turnstile"' public/ | \
  xargs sed -i 's|<meta name="arc:turnstile" content="">|<meta name="arc:turnstile" content="YOUR_SITE_KEY">|'
```

4. Add `TURNSTILE_SECRET` as a secret variable (step 6) and redeploy.

The widget appears above the send button and the function starts requiring it. Leave the meta content empty and the secret unset to keep it off. No CSP change is needed; `challenges.cloudflare.com` is already allowed in `public/_headers`.

Also worth turning on: **Security → Bots → Bot Fight Mode** (free).

---

## 9. Test locally before pushing

```bash
cp .dev.vars.example .dev.vars     # fill in real values; it's gitignored
npx wrangler pages dev public
```

Then, in another terminal:

```bash
# should succeed
curl -i http://localhost:8788/api/contact \
  -H "Origin: http://localhost:8788" \
  -F name="Test Person" -F email="you@example.com" \
  -F message="Testing the ARC contact form."

# should be 403: no Origin header
curl -i -X POST http://localhost:8788/api/contact -F name=x -F email=y@z.com -F message=hello

# should be 405
curl -i http://localhost:8788/api/contact
```

---

## 10. Verify in production

- [ ] Send a real message from `arc-suite.com/contact/`. It arrives at contact@.
- [ ] In Gmail, open the message → **Show original** → SPF **PASS**, DKIM **PASS**, DMARC **PASS**.
- [ ] Hit **Reply** on the notification: it addresses the visitor, not you.
- [ ] Send six messages in a row: the sixth returns "Too many messages".
- [ ] Post to `/api/contact` from a different origin: 403.
- [ ] `npx wrangler kv key list --binding ENQUIRIES` shows the test message with `"status":"sent"`.
- [ ] Pages → Functions → **Real-time logs** shows `contact: sent … via resend`.
- [ ] Send a message from the `Development` preview URL too.
- [ ] Run the site through securityheaders.com: A or better.

---

## 11. Keep it working

- **Monthly canary:** send yourself a test message. Silent breakage is the normal failure mode for contact forms.
- **DMARC reports:** skim them for the first month, then tighten `p=` as in step 5.
- **Key rotation:** rotate `RESEND_API_KEY` and `CF_EMAIL_TOKEN` if anyone leaves the project or a laptop goes missing.
- **Failure alerting:** with `NOTIFY_WEBHOOK` set, a failed send posts to Slack or Discord with `EMAIL FAILED` in the first line. Without it, check Functions logs.
- **If mail stops arriving:** Functions logs first (which provider failed and why), then the KV enquiries list (was it received at all?), then the provider dashboards.
