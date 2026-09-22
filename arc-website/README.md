# ARC website

Applications & Resource Customizations. Full-site proof of concept built as plain HTML, CSS and JavaScript, with no build step and no dependencies, so it runs on GitHub Pages as-is.

## Run it locally

Open `index.html` in a browser, or serve the folder so paths behave like production:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Structure

```
arc-website/
├── index.html                      Home
├── work/
│   ├── index.html                  All work
│   ├── architecture-practice/      Case study (shown in full)
│   ├── education-platform/        Case study (shown as architecture)
│   ├── legal-access/               Case study (shown as architecture)
│   ├── aviation-infrastructure/    Case study (shown as architecture)
│   └── industrial-environment/     Case study (shown as architecture)
├── what-we-do/index.html           Capabilities + how a project runs
├── about/index.html                Why ARC, founders, principles
├── contact/index.html              Contact form + what happens next
├── 404.html                        Not-found page
├── css/styles.css                  Design tokens + all styles
├── js/main.js                      Arch, nav, marquee, work panels, forms
├── assets/icons/                   ARC mark + industry symbols (SVG)
├── assets/images/                  Screenshots and founder photos
└── .nojekyll                       Serve files as-is on GitHub Pages
```

Links point to folders (`work/`, `about/`), so open the site through a local server rather than double-clicking files.

### Shared header and footer

Every page carries its own copy of the header, footer and icon sprite. That keeps the site dependency-free, but it means a nav change has to be made in all 11 HTML files (a find-and-replace across the repo does it). If the site grows much further, moving to a static site generator such as Eleventy would let you keep one copy.

### Adding a case study

Copy an existing folder in `work/`, rename it, edit the text and visual, then add a card for it in `work/index.html` and update the "Next project" link in the case study before it.

### 404 page

`404.html` uses root-relative links (`/`), which assumes the site is served from a domain root (a custom domain, or `username.github.io`). If it's served from a sub-path like `username.github.io/arc-website/`, change those links.

## Design tokens (css/styles.css, top of file)

| Token       | Hex       | Use                                  |
|-------------|-----------|--------------------------------------|
| `--paper`   | `#F7F7F3` | Main background                      |
| `--ink`     | `#0A1E3C` | Navy: type and structure             |
| `--teal`    | `#085041` | Large sections, confidential work    |
| `--emerald` | `#14B88A` | Accent only (keystone, focus, marks) |

Emerald is too light for body text on the off-white background, so links on light sections use `--teal-2`.

Typefaces: Bricolage Grotesque (headings) and Figtree (body), loaded from Google Fonts.

## Things to replace before launch

- **Contact email:** `CONTACT_EMAIL` in `js/main.js`.
- **Contact form:** GitHub Pages is static, so the form currently opens the visitor's email app. To receive submissions directly, create a form on a service like Formspree and paste its URL into `FORM_ENDPOINT` in `js/main.js`.
- **Architecture practice mockup:** the browser illustration in the Work section (`#p-architecture`) is a stand-in. Swap it for real screenshots in `assets/images/`.
- **Founders:** names, roles, bios and photos on the homepage and About page.
- **Client logos:** only the school and the architecture practice can be shown for now. Aviation and mining may be added later. The law firm must never appear.

## Deploying with GitHub Pages

1. Push this folder to a repository (e.g. `arc-website`).
2. In the repo: Settings → Pages → Build from branch → `main` / root.
3. For a custom domain, add it in the same settings page; GitHub creates the `CNAME` file.

Suggested workflow: branch per change → pull request → review → merge to `main`, which publishes automatically.

## Next steps

- Real screenshots for the architecture practice case study.
- Check every case study's wording with each client relationship in mind. The copy is a first draft.
- On small screens the header drops the "Let's talk" button to fit the three links; revisit if more pages are added.
