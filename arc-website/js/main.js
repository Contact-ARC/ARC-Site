/* ARC — site behavior. No dependencies. */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var SVG = "http://www.w3.org/2000/svg";

  /* ----------------------------------------------------------
     1. The arch: built from capability blocks.
        Left side = infrastructure, right side = what people use,
        keystone = the client's organization.
     ---------------------------------------------------------- */
  var BLOCKS = [
    { t: "Servers",            d: "Physical or cloud, set up and looked after properly." },
    { t: "Networking",         d: "Offices, sites and remote teams on one reliable network." },
    { t: "Security",           d: "Firewalls, access control and protection built in from day one." },
    { t: "Databases",          d: "Your data, structured so you can find it and trust it." },
    { t: "Integrations",       d: "APIs and connections between the tools you already use." },
    { t: "Your organization",  d: "The keystone. Everything we build is shaped around how you work.", key: true },
    { t: "Web applications",   d: "Internal tools and portals designed around your workflows." },
    { t: "Websites",           d: "Clear, fast sites that represent you properly." },
    { t: "Mobile apps",        d: "Your systems, in your people's pockets." },
    { t: "Email and workspace",d: "Email, Google Workspace and the everyday tools, done right." },
    { t: "Automation",         d: "Repetitive work handed to the machine." }
  ];
  var IDLE = {
    t: "Every block cut to fit.",
    d: "Infrastructure on one side, the things people use on the other. Your organization holds it together. Hover a block to explore."
  };

  function buildArch() {
    var svg = document.getElementById("arch");
    if (!svg) return;

    var cx = 300, cy = 320, rIn = 168, rOut = 262, keyExtra = 18;
    var n = BLOCKS.length, gap = 1.1, span = 180 / n;
    var titleEl = document.getElementById("arch-title");
    var descEl = document.getElementById("arch-desc");

    function pt(r, deg) {
      var a = deg * Math.PI / 180;
      return (cx + r * Math.cos(a)).toFixed(2) + " " + (cy - r * Math.sin(a)).toFixed(2);
    }
    function blockPath(a0, a1, r0, r1) {
      return "M" + pt(r1, a0) +
        " A" + r1 + " " + r1 + " 0 0 1 " + pt(r1, a1) +
        " L" + pt(r0, a1) +
        " A" + r0 + " " + r0 + " 0 0 0 " + pt(r0, a0) + " Z";
    }

    // base line + side labels
    var base = document.createElementNS(SVG, "path");
    base.setAttribute("d", "M" + (cx - rOut - 24) + " " + cy + "H" + (cx - rIn + 4) + "M" + (cx + rIn - 4) + " " + cy + "H" + (cx + rOut + 24));
    base.setAttribute("class", "base");
    base.setAttribute("aria-hidden", "true");
    svg.appendChild(base);

    [["Underneath", cx - (rIn + rOut) / 2], ["On the surface", cx + (rIn + rOut) / 2]].forEach(function (l) {
      var t = document.createElementNS(SVG, "text");
      t.setAttribute("x", l[1]); t.setAttribute("y", cy + 26);
      t.setAttribute("text-anchor", "middle"); t.setAttribute("class", "side-label");
      t.setAttribute("aria-hidden", "true");
      t.textContent = l[0];
      svg.appendChild(t);
    });

    var groups = [];
    BLOCKS.forEach(function (b, i) {
      var a0 = 180 - i * span - gap / 2;
      var a1 = 180 - (i + 1) * span + gap / 2;
      if (i === 0) a0 = 180;
      if (i === n - 1) a1 = 0;

      var g = document.createElementNS(SVG, "g");
      g.setAttribute("class", "block" + (b.key ? " keystone" : ""));
      g.setAttribute("tabindex", "0");
      g.setAttribute("role", "button");
      g.setAttribute("aria-label", b.t + ": " + b.d);

      var p = document.createElementNS(SVG, "path");
      p.setAttribute("d", blockPath(a0, a1, rIn, b.key ? rOut + keyExtra : rOut));
      g.appendChild(p);
      svg.appendChild(g);
      groups.push(g);

      function show() {
        groups.forEach(function (o) { o.classList.remove("is-on"); });
        g.classList.add("is-on");
        titleEl.textContent = b.t;
        descEl.textContent = b.d;
      }
      g.addEventListener("mouseenter", show);
      g.addEventListener("focus", show);
      g.addEventListener("click", show);
      g.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); show(); }
      });
    });

    svg.addEventListener("mouseleave", reset);
    svg.addEventListener("focusout", function (e) { if (!svg.contains(e.relatedTarget)) reset(); });
    function reset() {
      groups.forEach(function (o) { o.classList.remove("is-on"); });
      titleEl.textContent = IDLE.t;
      descEl.textContent = IDLE.d;
    }

    // Assemble: pairs from the springing points upward, keystone last.
    if (reduceMotion) return;
    svg.classList.add("will-build");
    var order = [];
    for (var k = 0; k < Math.floor(n / 2); k++) order.push([k, n - 1 - k]);
    order.push([Math.floor(n / 2)]);
    requestAnimationFrame(function () {
      order.forEach(function (pair, step) {
        pair.forEach(function (idx) {
          var g = groups[idx];
          g.style.transitionDelay = (250 + step * 110 + (idx === Math.floor(n / 2) ? 120 : 0)) + "ms";
        });
      });
      requestAnimationFrame(function () { svg.classList.add("is-built"); });
      setTimeout(function () {
        groups.forEach(function (g) { g.style.transitionDelay = ""; });
      }, 2200);
    });
  }

  /* ----------------------------------------------------------
     2. Header: blur on scroll, sliding nav indicator,
        current-section highlighting.
     ---------------------------------------------------------- */
  function header() {
    var el = document.querySelector(".site-header");
    var onScroll = function () { el.classList.toggle("is-scrolled", window.scrollY > 8); };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    var nav = document.querySelector(".nav");
    if (!nav) return;
    var ind = nav.querySelector(".nav-indicator");
    var links = Array.prototype.slice.call(nav.querySelectorAll("a"));
    var current = null;

    function moveTo(a) {
      if (!a) { ind.style.opacity = "0"; return; }
      ind.style.width = a.offsetWidth + "px";
      ind.style.transform = "translateX(" + a.offsetLeft + "px)";
      ind.style.opacity = "1";
    }
    links.forEach(function (a) {
      a.addEventListener("mouseenter", function () { moveTo(a); });
      a.addEventListener("focus", function () { moveTo(a); });
    });
    nav.addEventListener("mouseleave", function () { moveTo(current); });

    current = nav.querySelector('[aria-current="page"]');
    if (current) current.classList.add("is-current");
    // position after fonts settle so widths are right
    moveTo(current);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { moveTo(current); });
    window.addEventListener("resize", function () { moveTo(current); });
    // lets a single-page preview update the highlight without a reload
    document.addEventListener("arc:navchange", function () {
      links.forEach(function (l) { l.classList.remove("is-current"); });
      current = nav.querySelector('[aria-current="page"]');
      if (current) current.classList.add("is-current");
      moveTo(current);
    });
  }

  /* ----------------------------------------------------------
     3. Industries marquee: clone the track until it overflows.
     ---------------------------------------------------------- */
  function marquee() {
    var m = document.querySelector(".marquee");
    if (!m || reduceMotion) return;
    var track = m.querySelector(".marquee-track");
    var needed = Math.ceil((window.innerWidth * 2) / Math.max(track.scrollWidth, 1)) + 1;
    for (var i = 0; i < needed; i++) {
      var c = track.cloneNode(true);
      c.setAttribute("aria-hidden", "true");
      m.appendChild(c);
    }
  }

  /* ----------------------------------------------------------
     4. Work: list selects a panel. On narrow screens the stage
        moves directly under the selected project.
     ---------------------------------------------------------- */
  function work() {
    var items = Array.prototype.slice.call(document.querySelectorAll(".work-item"));
    var stage = document.getElementById("work-stage");
    if (!items.length || !stage) return;
    var home = stage.parentNode;
    var narrow = window.matchMedia("(max-width: 960px)");
    var active = items[0];

    function place() {
      if (narrow.matches) active.parentNode.appendChild(stage);
      else if (stage.parentNode !== home) home.appendChild(stage);
    }
    function select(item) {
      if (item === active && stage.parentNode) { place(); return; }
      active = item;
      items.forEach(function (it) {
        var on = it === item;
        it.classList.toggle("is-active", on);
        it.setAttribute("aria-pressed", on ? "true" : "false");
        var p = document.getElementById(it.dataset.panel);
        if (p) { p.hidden = !on; p.classList.toggle("is-active", on); }
      });
      place();
    }
    items.forEach(function (it) {
      it.addEventListener("click", function () { select(it); });
      it.addEventListener("mouseenter", function () { if (!narrow.matches) select(it); });
    });
    (narrow.addEventListener ? narrow.addEventListener("change", place) : narrow.addListener(place));
    place();
  }

  /* ----------------------------------------------------------
     5. Contact form. GitHub Pages is static, so by default this
        opens the visitor's email app. To receive submissions
        directly, set FORM_ENDPOINT (e.g. Formspree) below.
     ---------------------------------------------------------- */
  var CONTACT_EMAIL = "hello@example.com";
  var FORM_ENDPOINT = ""; // e.g. "https://formspree.io/f/xxxxxxx"

  function contact() {
    Array.prototype.forEach.call(document.querySelectorAll(".js-email"), function (a) {
      a.href = "mailto:" + CONTACT_EMAIL; a.textContent = CONTACT_EMAIL;
    });
    Array.prototype.forEach.call(document.querySelectorAll(".contact-form"), function (form) {
      var status = form.querySelector(".form-status");
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var fields = Array.prototype.slice.call(form.querySelectorAll("[required]"));
        var firstBad = null;
        fields.forEach(function (f) {
          var bad = !f.value.trim() || (f.type === "email" && !/^\S+@\S+\.\S+$/.test(f.value));
          f.setAttribute("aria-invalid", bad ? "true" : "false");
          if (bad && !firstBad) firstBad = f;
        });
        if (firstBad) {
          status.textContent = firstBad.type === "email" && firstBad.value.trim()
            ? "Check the email address, it doesn't look complete."
            : "Fill in your name, email and message, then send again.";
          firstBad.focus();
          return;
        }
        var data = new FormData(form);

        if (FORM_ENDPOINT) {
          status.textContent = "Sending…";
          fetch(FORM_ENDPOINT, { method: "POST", body: data, headers: { Accept: "application/json" } })
            .then(function (r) {
              if (!r.ok) throw new Error();
              form.reset();
              status.textContent = "Message sent. We'll be in touch soon.";
            })
            .catch(function () {
              status.textContent = "The message didn't go through. Email us at " + CONTACT_EMAIL + " instead.";
            });
          return;
        }

        var org = data.get("organization"), topic = data.get("topic");
        var body = (topic ? "Topic: " + topic + "\n\n" : "") + data.get("message") + "\n\n" + data.get("name") +
          (org ? "\n" + org : "") + "\n" + data.get("email");
        var subject = "Project enquiry" + (org ? " from " + org : "");
        window.location.href = "mailto:" + CONTACT_EMAIL + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
        status.textContent = "Your email app should open with the message ready to send.";
      });
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll(".js-year"), function (y) { y.textContent = new Date().getFullYear(); });
  buildArch();
  header();
  marquee();
  work();
  contact();
})();
