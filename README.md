# ARC website

Applications & Resource Customizations — [arc-suite.com](https://arc-suite.com)

Plain HTML, CSS and JavaScript with no build step, hosted on **Cloudflare Pages**. The contact form is handled by a Cloudflare Pages Function.

## Repository layout

```
ARC-Site/
├── public/                         Everything served to visitors
│   ├── index.html                  Home
│   ├── work/                       All work + 5 case studies
│   │   ├── the-loto-lab/           Case study with real screenshots
│   │   └── schools/                For schools (PowerSchool work), linked from Work
│   ├── legal-notice/  privacy/     Aviso legal + privacy policy
│   ├── what-we-do/  about/  contact/
│   ├── 404.html                    Served by Cloudflare for unknown paths
│   ├── _headers                    Security headers + CSP (Cloudflare Pages)
│   ├── og.svg / og.png             Link-preview image (placeholder; PNG is what platforms use)
│   ├── css/styles.css              Design tokens + all styles
│   ├── js/main.js                  Arch, nav, marquee, work panels, forms, theme toggle
│   └── assets/                     Icons, images, self-hosted fonts
├── functions/
│   └── api/contact.js              POST /api/contact — validates and emails form messages
├── docs/contact-email-preview.png  What the notification email looks like
├── .dev.vars.example               Local environment template
└── .gitignore
```

## Branches

- `main` — what is live. Protected: changes arrive by pull request only.
- `Development` — the working draft. Feature branches merge into it.
- Launch = one pull request from `Development` into `main`.

## Cloudflare Pages setup

1. **Workers & Pages → Create → Pages → Connect to Git** → pick `Contact-ARC/ARC-Site`.
2. Build settings:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: **`public`**
   - Root directory: *(leave empty)*
3. Production branch: `main`. Every other branch (including `Development`) gets its own preview URL automatically.
4. **Custom domains** → add `arc-suite.com` and `www.arc-suite.com`.

The `functions/` folder is picked up automatically and becomes `/api/contact`.

## Contact form setup

The full walkthrough — Pages, domain, mailbox, sending providers, DNS, KV, Turnstile and verification — is in **[docs/SETUP.md](docs/SETUP.md)**. Short version:

- `functions/api/contact.js` validates the message and emails it to `CONTACT_TO`.
- It tries each configured email provider in turn (`EMAIL_PROVIDER_ORDER`, default: binding → Resend → Cloudflare), retrying once per provider, so one outage doesn't lose an enquiry.
- With the `ENQUIRIES` KV binding, every message is stored for 90 days before sending, with status `sent` or `failed`.
- With the `RATE_LIMIT` KV binding, each visitor gets 5 messages per 5 minutes and 20 per hour.
- With `TURNSTILE_SECRET` set and a site key in the `arc:turnstile` meta tag, the form requires a Turnstile check.
- With `NOTIFY_WEBHOOK` set, each enquiry (and any delivery failure) is posted to Slack or Discord.

Every optional piece stays dormant until its variable or binding exists.

## The mailbox itself

Cloudflare doesn't host mailboxes. Either forward `contact@arc-suite.com` to your personal inboxes with **Email Routing** (free, receive-only), or host a real mailbox with **Google Workspace** (or Zoho / Microsoft 365) by adding its MX records in Cloudflare DNS. Email Routing and a mailbox provider can't both own the root domain's MX records, so pick one.

## Placeholders

Everything that still needs real content is highlighted on the page (dashed green outline or a green "Placeholder" tag) and marked in the HTML. List them all with:

```bash
grep -rn 'class="ph\|ph-tag\|PLACEHOLDER' public/
```

Current placeholders: legal details (legal notice + privacy policy + form notices), the Loto Lab quote and attribution, the school logo, the "Scale" and "Timeframe" facts on the four confidential case studies, the "Add details" tags on the schools page, and `og.png`.

## Legal pages

As an autónomo you still have a NIF: it's your DNI (or NIE) number. LSSI-CE requires the legal notice to show the titular's name, NIF, address and email.

- **Titular:** the person who owns the site. If both founders are autónomos without a shared entity, the site has to be in one person's name (or you set up a comunidad de bienes / sociedad civil, which gets its own NIF).
- **Address:** your fiscal address. A coworking or virtual-office address works if you'd rather not publish a home address, as long as it's valid for notifications.
- **Mailbox provider:** fill in the privacy policy once contact@ is set up (Google Workspace, Zoho, etc.).
- **Retention period:** pick one and fill it in.

The same titular name appears in the short privacy notice under both contact forms. This isn't legal advice; have a gestor or lawyer glance at the final text.

## Analytics

Cloudflare Web Analytics is cookieless and already allowed in the CSP. Turn it on in the Pages project → **Metrics → Web Analytics → Enable**. Cloudflare injects the script automatically; no code change needed. The privacy policy already mentions it.

## Fonts

Bricolage Grotesque and Figtree are self-hosted in `public/assets/fonts/` (Latin + Latin Extended, variable weight; licences included). Nothing loads from Google, which avoids the GDPR issue with Google Fonts.

## Link preview image

`og.png` (1200×630) is what WhatsApp, LinkedIn and others show. `og.svg` is its editable source. Platforms don't accept SVG, so after editing the SVG, export a PNG at the same size and replace `og.png`.

## Editing notes

- **Shared header and footer** are copied into every HTML page. A nav change is a find-and-replace across `public/`.
- **Motion:** page transitions use the CSS View Transitions API (browsers without it simply navigate normally); scroll reveals are in `js/main.js` → `reveals()`. Both switch off for visitors who prefer reduced motion.
- **Theme script:** every page has a small script in `<head>` that applies the saved theme (and adds the `js` class used by the reveals) before the page draws. Its hash is in `_headers` (Content-Security-Policy). If you change the script, update the hash or the browser will block it.
- **Turnstile:** the widget slot and the loader are already in place; setting the site key in the `arc:turnstile` meta tag switches them on (docs/SETUP.md step 8). No header change needed.
- **Case studies:** copy a folder in `public/work/`, edit it, add a card to `public/work/index.html`, and fix the "Next project" link in the case study before it.

## Before launch

- Every placeholder (see above).
- Founder photos (`public/assets/images/founders/`) and final bios.
- Loto Lab screenshots: current ones were rendered locally with fallback fonts; replace with captures of the live site.
- Case study wording, checked against each client relationship.
