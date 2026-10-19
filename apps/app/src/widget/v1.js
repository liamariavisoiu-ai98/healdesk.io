/*
 * healdesk website chat, v1: the bubble a clinic pastes on its own website.
 *
 *   <script src="https://app.healdesk.io/widget/v1.js" data-clinic="<slug>" async></script>
 *
 * Served as it is written by app/widget/v1.js/route.ts, static and the same
 * for every clinic: it holds nothing of anyone's (CLAUDE.md, the PHI
 * boundary). Every request that carries a visitor's words goes to the origin
 * this file was loaded from, /api/widget/v1/<slug>/{start,message,end,contact}
 * (lib/chat/web-chat.ts, lib/chat/contact-form.ts), with no cookie.
 *
 * What it promises the visitor is what the engine does: AYA answers and takes
 * a request the practice confirms; she books nothing here. The opening line
 * the start route answers is the locked AI line and is always shown first;
 * no chat opens without it.
 *
 * When the chat is not answering (switched off, paused, capped, our endpoint
 * failing), the bubble becomes the contact form the engine offers; when even
 * that takes nothing, it tells the visitor to call the practice (CLAUDE.md,
 * "Failure": a visitor always reaches someone). A clinic may add
 * data-phone="+15551234567" to the line to have that number shown.
 *
 * Built to sit on any page: a closed shadow root for the host page's styles
 * and scripts, no dependencies, no innerHTML and no inline style or eval, so
 * it runs under a strict Content-Security-Policy and Trusted Types once the
 * page allows this script and connections to its origin. The visitor's words
 * are kept in memory only, never in the page's storage, and the chat is
 * ended (its transcript sent to the practice) when the page goes away.
 */
(function () {
  "use strict";

  var doc = document;
  var win = window;
  var TAG = "healdesk-chat";

  var script =
    doc.currentScript ||
    doc.querySelector('script[data-clinic][src*="/widget/v1.js"]');
  if (!script || doc.querySelector(TAG)) return;
  if (!win.fetch || !Element.prototype.attachShadow) return;

  var slug = script.getAttribute("data-clinic") || "";
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) {
    warn("data-clinic is missing or not a clinic's name.");
    return;
  }
  var base;
  try {
    base = new URL(script.src, doc.baseURI).origin + "/api/widget/v1/" + slug + "/";
  } catch (e) {
    return;
  }
  var phone = readPhone(script.getAttribute("data-phone"));
  var fetchFn = win.fetch.bind(win);

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  var token = null; // the engine's signed handle on the chat; nothing the visitor wrote
  var talking = false; // a message has been sent since the chat last ended
  var busy = false;
  var started = null; // the start request, once made
  var view = "loading"; // loading | chat | form | call | done

  // ---------------------------------------------------------------------------
  // The DOM
  // ---------------------------------------------------------------------------

  var host = doc.createElement(TAG);
  host.style.setProperty("all", "initial", "important");
  var root = host.attachShadow({ mode: "closed" });
  adoptStyles(root, css(readColor(script.getAttribute("data-color"))));

  var launcher = el("button", { class: "launcher", type: "button", "aria-expanded": "false", "aria-controls": "panel" });
  launcher.appendChild(icon("M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"));
  launcher.appendChild(el("span", { class: "launcher-label" }, "Chat with us"));

  var panel = el("section", { class: "panel", id: "panel", role: "dialog", "aria-labelledby": "title" });
  panel.hidden = true;

  var header = el("div", { class: "header" });
  var titles = el("div", { class: "titles" });
  titles.appendChild(el("h2", { id: "title" }, "Chat with us"));
  titles.appendChild(el("p", { class: "sub" }, "AI assistant"));
  header.appendChild(titles);
  var endButton = el("button", { class: "text-button", type: "button" }, "End chat");
  endButton.hidden = true;
  header.appendChild(endButton);
  var closeButton = el("button", { class: "icon-button", type: "button", "aria-label": "Close chat" });
  closeButton.appendChild(icon("M6 6l12 12M18 6L6 18"));
  header.appendChild(closeButton);
  panel.appendChild(header);

  var body = el("div", { class: "body" });
  var log = el("div", { class: "log", role: "log", "aria-live": "polite", "aria-label": "Conversation" });
  body.appendChild(log);
  var status = el("p", { class: "status", role: "status", "aria-live": "polite" });
  body.appendChild(status);
  var contactArea = el("div", { class: "contact" });
  contactArea.hidden = true;
  body.appendChild(contactArea);
  panel.appendChild(body);

  var compose = el("form", { class: "compose", novalidate: "" });
  compose.appendChild(el("label", { class: "sr", for: "input" }, "Your message"));
  var input = el("textarea", { id: "input", rows: "1", maxlength: "2000", placeholder: "Type your message", autocomplete: "off" });
  compose.appendChild(input);
  var sendButton = el("button", { class: "send", type: "submit", "aria-label": "Send message" });
  sendButton.appendChild(icon("M3 11l18-8-8 18-2-8-8-2z"));
  compose.appendChild(sendButton);
  compose.hidden = true;
  panel.appendChild(compose);

  root.appendChild(panel);
  root.appendChild(launcher);

  launcher.addEventListener("click", function () {
    setOpen(panel.hidden);
  });
  closeButton.addEventListener("click", function () {
    setOpen(false);
  });
  panel.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
    }
  });
  endButton.addEventListener("click", function () {
    endChat(false);
  });
  compose.addEventListener("submit", function (event) {
    event.preventDefault();
    send();
  });
  input.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
    }
  });
  input.addEventListener("input", grow);
  win.addEventListener("pagehide", function () {
    endChat(true);
  });

  if (doc.body) doc.body.appendChild(host);
  else doc.addEventListener("DOMContentLoaded", function () { doc.body.appendChild(host); });

  // ---------------------------------------------------------------------------
  // Opening and closing
  // ---------------------------------------------------------------------------

  function setOpen(open) {
    panel.hidden = !open;
    launcher.setAttribute("aria-expanded", open ? "true" : "false");
    launcher.setAttribute("aria-label", open ? "Close chat" : "Chat with us");
    host.setAttribute("data-open", open ? "true" : "false");
    if (!open) {
      launcher.focus();
      return;
    }
    if (!started) {
      started = start();
      started.then(focusFirst);
    } else {
      focusFirst();
    }
  }

  function focusFirst() {
    if (panel.hidden) return;
    var target =
      view === "chat" ? input : contactArea.querySelector("input, button, a") || closeButton;
    target.focus();
  }

  // ---------------------------------------------------------------------------
  // The chat
  // ---------------------------------------------------------------------------

  function start() {
    setStatus("Connecting…");
    return post("start", {}).then(function (res) {
      setStatus("");
      if (res.ok && res.data.mode === "chat" && opens(res.data)) {
        token = res.data.token;
        say("assistant", res.data.opening, "opening");
        showChat();
        return true;
      }
      fallBack(res);
      return false;
    });
  }

  /** A chat opens only with its opening line, the locked AI line, to show first. */
  function opens(data) {
    return typeof data.opening === "string" && data.opening.trim() !== "" && typeof data.token === "string";
  }

  function send() {
    var text = input.value.trim();
    if (!text || busy || view !== "chat") return;
    busy = true;
    sendButton.disabled = true;
    input.value = "";
    grow();
    var bubble = say("person", text);
    setStatus("Replying…", true);
    deliver(text, true).then(function (outcome) {
      busy = false;
      sendButton.disabled = false;
      if (outcome === "limited") setStatus("That's a lot of messages at once. Please wait a minute, then send it again.");
      else if (outcome === "unsent") setStatus("That message didn't send. Please try again.");
      if (outcome === "limited" || outcome === "unsent") {
        bubble.remove();
        if (!input.value) input.value = text;
        grow();
      }
      if (view === "chat") input.focus();
    });
  }

  /** One message: "sent", "limited" (try again), "unsent", or "fallback" (the view changed). */
  function deliver(text, mayRestart) {
    return post("message", { token: token, text: text }).then(function (res) {
      var data = res.data;
      if (res.ok && data.mode === "chat" && typeof data.reply === "string") {
        setStatus("");
        if (typeof data.token === "string") token = data.token;
        say("assistant", data.reply);
        if (data.ended) {
          note("This chat has ended. Send a message to start a new one.");
          talking = false;
          endButton.hidden = true;
        } else {
          talking = true;
          endButton.hidden = false;
        }
        return "sent";
      }
      if (res.status === 429) return "limited";
      if (res.status === 400 && data.error === "token" && mayRestart) {
        // The chat's token ran out (twelve hours): a new chat, opened with
        // its own opening line, then the message again.
        return post("start", {}).then(function (again) {
          if (again.ok && again.data.mode === "chat" && opens(again.data)) {
            token = again.data.token;
            talking = false;
            note("Your earlier chat timed out, so this is a new one.");
            say("assistant", again.data.opening, "opening");
            return deliver(text, false);
          }
          fallBack(again);
          return "fallback";
        });
      }
      if (res.status === 400) return "unsent";
      fallBack(res);
      return "fallback";
    });
  }

  /** The visitor ended the chat, or the page is going: its transcript goes to the practice now. */
  function endChat(leaving) {
    if (!talking || !token) return;
    talking = false;
    endButton.hidden = true;
    var payload = JSON.stringify({ token: token });
    if (leaving) {
      // text/plain keeps it a simple request a beacon may send; the route
      // reads the body as JSON whatever its type.
      var sent = false;
      try {
        sent = navigator.sendBeacon(base + "end", new Blob([payload], { type: "text/plain" }));
      } catch (e) {
        sent = false;
      }
      if (!sent) post("end", { token: token }, true);
      return;
    }
    post("end", { token: token });
    note("Chat ended. Send a message to start a new one.");
  }

  // ---------------------------------------------------------------------------
  // When the chat is not answering
  // ---------------------------------------------------------------------------

  /**
   * Whatever the chat cannot do, the visitor still reaches the practice. A
   * page that is not the clinic's website, or a name no clinic has, gets an
   * answer without CORS headers, which the browser hides as a network
   * failure (status 0): the way to call, and the console's own CORS error.
   */
  function fallBack(res) {
    var form = res.data && res.data.mode === "contact_form" ? res.data.form : null;
    if (form && form.takesMessages === true && Array.isArray(form.times) && form.times.length) showForm(form.times);
    else if (res.status === 429) showCall("Lots of people are messaging right now.");
    else showCall();
  }

  function showChat() {
    view = "chat";
    contactArea.hidden = true;
    compose.hidden = false;
  }

  function clearContact() {
    compose.hidden = true;
    endButton.hidden = true;
    talking = false;
    contactArea.hidden = false;
    while (contactArea.firstChild) contactArea.removeChild(contactArea.firstChild);
  }

  function showForm(times) {
    view = "form";
    clearContact();
    var form = el("form", { class: "form", novalidate: "", "aria-labelledby": "form-title" });
    form.appendChild(el("h3", { id: "form-title" }, "Leave your number"));
    form.appendChild(
      el("p", {}, "The chat isn't answering right now. Leave your first name and number, and the practice will call you back."),
    );
    var name = field(form, "first", "First name", { type: "text", autocomplete: "given-name", maxlength: "60" });
    var tel = field(form, "phone", "Phone number", { type: "tel", autocomplete: "tel", inputmode: "tel", maxlength: "32" });
    var group = el("fieldset", { class: "times", "aria-describedby": "time-error" });
    group.appendChild(el("legend", {}, "Best time to call"));
    times.forEach(function (time, i) {
      if (!time || typeof time.id !== "string" || typeof time.label !== "string") return;
      var id = "time-" + i;
      var option = el("div", { class: "option" });
      var radio = el("input", { type: "radio", name: "time", id: id, value: time.id });
      if (i === 0) radio.checked = true;
      option.appendChild(radio);
      option.appendChild(el("label", { for: id }, time.label));
      group.appendChild(option);
    });
    group.appendChild(el("p", { class: "error", id: "time-error" }));
    form.appendChild(group);
    form.appendChild(el("p", { class: "fine" }, "If it's an emergency, call 911."));
    var submit = el("button", { class: "primary", type: "submit" }, "Send");
    form.appendChild(submit);
    contactArea.appendChild(form);

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (submit.disabled) return;
      var picked = form.querySelector("input[name=time]:checked");
      var bad = [];
      if (!name.input.value.trim()) bad.push("first_name");
      if (!tel.input.value.trim()) bad.push("phone");
      if (!picked) bad.push("preferred_time");
      if (bad.length) return mark(bad);
      submit.disabled = true;
      setStatus("Sending…");
      post("contact", { firstName: name.input.value.trim(), phone: tel.input.value.trim(), preferredTime: picked.value }).then(function (res) {
        submit.disabled = false;
        setStatus("");
        if (res.ok && res.data.mode === "received") {
          view = "done";
          clearContact();
          var done = el("p", { class: "received", tabindex: "-1" }, String(res.data.reply || "Thanks. The practice will call you back."));
          contactArea.appendChild(done);
          done.focus();
        } else if (res.status === 400 && Array.isArray(res.data.fields)) {
          mark(res.data.fields);
        } else if (res.status === 429) {
          setStatus("That's a lot of messages at once. Please wait a little, then try again.");
        } else {
          showCall();
          focusFirst();
        }
      });
    });

    function mark(problems) {
      var first = null;
      [
        ["first_name", name.input, name.error, "Please enter your first name."],
        ["phone", tel.input, tel.error, "Please enter a phone number we can call, like 555 123 4567."],
        ["preferred_time", group.querySelector("input"), group.querySelector(".error"), "Please choose a time."],
      ].forEach(function (row) {
        var wrong = problems.indexOf(row[0]) !== -1;
        if (row[1]) row[1].setAttribute("aria-invalid", wrong ? "true" : "false");
        row[2].textContent = wrong ? row[3] : "";
        if (wrong && !first) first = row[1];
      });
      if (problems.indexOf("unknown_field") !== -1 && !first) setStatus("Something went wrong. Please call the practice.");
      if (first) first.focus();
    }
  }

  function showCall(lead) {
    view = "call";
    clearContact();
    var box = el("div", { class: "call" });
    box.appendChild(el("h3", {}, "Please call the practice"));
    box.appendChild(el("p", {}, (lead ? lead + " " : "") + "The chat isn't available right now."));
    if (phone) {
      var line = el("p", {}, "Call ");
      line.appendChild(el("a", { href: "tel:" + phone.e164 }, phone.shown));
      line.appendChild(doc.createTextNode(" to speak to someone."));
      box.appendChild(line);
    } else {
      box.appendChild(el("p", {}, "Its phone number is on this website."));
    }
    box.appendChild(el("p", { class: "fine" }, "If it's an emergency, call 911."));
    contactArea.appendChild(box);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * POST to the engine. Never rejects: a network failure answers status 0.
   * text/plain keeps every call a simple request, so no preflight; the
   * route checks the page's origin itself and reads the body as JSON.
   */
  function post(path, payload, keepalive) {
    return fetchFn(base + path, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      keepalive: !!keepalive,
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(payload),
    }).then(
      function (response) {
        return response.json().then(
          function (data) {
            return { ok: response.ok, status: response.status, data: data && typeof data === "object" ? data : {} };
          },
          function () {
            return { ok: false, status: response.status, data: {} };
          },
        );
      },
      function () {
        return { ok: false, status: 0, data: {} };
      },
    );
  }

  /** A message in the log, as text: nothing anyone wrote is ever parsed as markup. */
  function say(who, text, extra) {
    var row = el("div", { class: "msg " + who + (extra ? " " + extra : "") });
    row.appendChild(el("span", { class: "sr" }, who === "person" ? "You: " : "Assistant: "));
    row.appendChild(doc.createTextNode(String(text)));
    log.appendChild(row);
    body.scrollTop = body.scrollHeight;
    return row;
  }

  function note(text) {
    log.appendChild(el("p", { class: "note" }, text));
    body.scrollTop = body.scrollHeight;
  }

  function setStatus(text, typing) {
    status.textContent = text;
    status.className = typing ? "status typing" : "status";
  }

  function field(form, id, label, attrs) {
    var wrap = el("div", { class: "field" });
    wrap.appendChild(el("label", { for: id }, label));
    attrs.id = id;
    attrs["aria-describedby"] = id + "-error";
    attrs.required = "";
    var control = el("input", attrs);
    wrap.appendChild(control);
    var error = el("p", { class: "error", id: id + "-error" });
    wrap.appendChild(error);
    form.appendChild(wrap);
    return { input: control, error: error };
  }

  function grow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  }

  function el(tag, attrs, text) {
    var node = doc.createElement(tag);
    for (var key in attrs) node.setAttribute(key, attrs[key]);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(path) {
    var ns = "http://www.w3.org/2000/svg";
    var svg = doc.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    var p = doc.createElementNS(ns, "path");
    p.setAttribute("d", path);
    svg.appendChild(p);
    return svg;
  }

  function readPhone(value) {
    if (!value) return null;
    var digits = String(value).replace(/[^\d+]/g, "");
    if (!/^\+?\d{7,15}$/.test(digits)) return null;
    var us = digits.replace(/^\+?1(?=\d{10}$)/, "");
    var shown = /^\d{10}$/.test(us) ? "(" + us.slice(0, 3) + ") " + us.slice(3, 6) + "-" + us.slice(6) : digits;
    return { e164: digits.charAt(0) === "+" ? digits : "+" + (digits.length === 10 ? "1" + digits : digits), shown: shown };
  }

  function readColor(value) {
    return value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#1f4e79";
  }

  /** Black or white text on the accent, whichever reads. */
  function ink(hex) {
    var c = [1, 3, 5].map(function (i) {
      var v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    var lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    return lum > 0.179 ? "#111111" : "#ffffff";
  }

  /** Constructed sheets where the browser has them, which a style-src policy does not govern. */
  function adoptStyles(shadow, text) {
    try {
      if ("adoptedStyleSheets" in shadow && typeof CSSStyleSheet === "function") {
        var sheet = new CSSStyleSheet();
        sheet.replaceSync(text);
        shadow.adoptedStyleSheets = [sheet];
        return;
      }
    } catch (e) {
      /* fall through to a style element */
    }
    shadow.appendChild(el("style", {}, text));
  }

  function warn(message) {
    if (win.console && console.warn) console.warn("healdesk chat: " + message);
  }

  function css(accent) {
    var on = ink(accent);
    return [
      ":host{all:initial}",
      "*,*::before,*::after{box-sizing:border-box}",
      "[hidden]{display:none!important}",
      ".launcher,.panel{font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.45;color:#1a1a1a;-webkit-font-smoothing:antialiased}",
      ".sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}",
      "svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}",
      "button{font:inherit;cursor:pointer}",
      ":focus-visible{outline:3px solid " + accent + ";outline-offset:2px}",
      ".launcher{position:fixed;right:max(16px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));z-index:2147483000;display:flex;align-items:center;gap:8px;min-height:56px;padding:0 20px 0 16px;border:2px solid transparent;border-radius:28px;background:" + accent + ";color:" + on + ";font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,.25)}",
      ".launcher:focus-visible{outline-color:#1a1a1a;box-shadow:0 0 0 3px #fff}",
      ":host([data-open=true]) .launcher-label{display:none}",
      ":host([data-open=true]) .launcher{padding:0 14px}",
      ".panel{position:fixed;right:16px;bottom:88px;z-index:2147483000;display:flex;flex-direction:column;width:380px;max-width:calc(100vw - 32px);height:min(600px,calc(100vh - 120px));background:#fff;border:1px solid #d0d0d0;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.2);overflow:hidden}",
      ".header{display:flex;align-items:center;gap:8px;padding:12px 12px 12px 16px;background:" + accent + ";color:" + on + "}",
      ".titles{flex:1;min-width:0}",
      "h2{margin:0;font-size:17px;font-weight:700}",
      ".sub{margin:0;font-size:13px;opacity:.9}",
      ".icon-button,.text-button{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;padding:0 10px;border:0;border-radius:8px;background:transparent;color:inherit}",
      ".text-button{font-size:14px;text-decoration:underline}",
      ".icon-button:hover,.text-button:hover{background:rgba(127,127,127,.2)}",
      ".header :focus-visible{outline-color:" + on + "}",
      ".body{flex:1;min-height:0;display:flex;flex-direction:column;overflow-y:auto;overscroll-behavior:contain}",
      ".body>*{flex:none}",
      ".log{display:flex;flex-direction:column;gap:8px;padding:16px}",
      ".log:empty{padding:8px 0 0}",
      ".msg{max-width:85%;padding:10px 14px;border-radius:14px;white-space:pre-wrap;overflow-wrap:anywhere}",
      ".msg.assistant{align-self:flex-start;background:#f0f2f5;border-bottom-left-radius:4px}",
      ".msg.person{align-self:flex-end;background:" + accent + ";color:" + on + ";border-bottom-right-radius:4px}",
      ".note{margin:4px 0;text-align:center;font-size:13px;color:#555}",
      ".status{margin:0 16px 8px;font-size:14px;color:#555}",
      ".status:empty{margin:0}",
      ".compose{display:flex;align-items:flex-end;gap:8px;padding:10px 12px;border-top:1px solid #e3e3e3}",
      "textarea{flex:1;resize:none;min-height:44px;max-height:120px;padding:10px 12px;font:inherit;color:inherit;background:#fff;border:1px solid #8a8a8a;border-radius:10px}",
      ".send{flex:none;width:44px;height:44px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:10px;background:" + accent + ";color:" + on + "}",
      ".send:disabled{opacity:.5;cursor:default}",
      ".contact{padding:0 16px 16px}",
      "h3{margin:0 0 8px;font-size:17px}",
      ".contact p{margin:0 0 12px}",
      ".field{margin-bottom:12px}",
      "label{display:block;font-weight:600;margin-bottom:4px}",
      "input[type=text],input[type=tel]{width:100%;min-height:44px;padding:8px 12px;font:inherit;color:inherit;background:#fff;border:1px solid #8a8a8a;border-radius:10px}",
      "[aria-invalid=true]{border-color:#b00020;border-width:2px}",
      ".error{margin:4px 0 0!important;font-size:14px;color:#b00020}",
      ".error:empty{display:none}",
      "fieldset{margin:0 0 12px;padding:0;border:0}",
      "legend{font-weight:600;margin-bottom:4px;padding:0}",
      ".option{display:flex;align-items:center;gap:8px;min-height:36px}",
      ".option label{font-weight:400;margin:0}",
      "input[type=radio]{width:20px;height:20px;margin:0;accent-color:" + accent + "}",
      ".fine{font-size:14px;color:#555}",
      ".primary{min-height:44px;padding:0 24px;border:0;border-radius:10px;background:" + accent + ";color:" + on + ";font-weight:600}",
      ".primary:disabled{opacity:.6;cursor:default}",
      ".received{padding:12px 14px;background:#f0f2f5;border-radius:12px}",
      "a{color:" + accent + ";font-weight:600}",
      "@media (max-width:480px){.panel{inset:0;width:100%;max-width:none;height:100%;border:0;border-radius:0;padding-bottom:env(safe-area-inset-bottom)}" +
        ":host([data-open=true]) .launcher{display:none}}",
      "@media (prefers-reduced-motion:no-preference){.panel{animation:rise .18s ease-out}.status.typing::after{content:'';display:inline-block;width:1.2em;animation:dots 1.2s steps(4) infinite}" +
        "@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}" +
        "@keyframes dots{0%{content:''}25%{content:'.'}50%{content:'..'}75%{content:'...'}}}",
      "@media (forced-colors:active){.launcher,.send,.primary,.msg{border:1px solid ButtonText}.msg.person{color:CanvasText;background:Canvas}}",
    ].join("\n");
  }
})();
