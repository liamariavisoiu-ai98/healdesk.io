/**
 * Review comments, and handing them to Claude.
 *
 * Kept as a real file and inlined at build time rather than written inside the
 * page template. Escaping a few hundred lines of JavaScript through a template
 * literal is how backticks and ${} start meaning something they shouldn't.
 *
 * ## Why nothing is held only in memory
 *
 * The server rebuilds this page from markdown on every request, and refreshing
 * is the normal way to see a doc edit. So a comment that lived in a JS variable
 * would vanish exactly when the user expects it to persist. Every mutation
 * round-trips to the server first; the UI repaints from the response.
 *
 * The token comes from a meta tag and is minted per server process. A tab left
 * open across a restart gets a 403 rather than silently posting nowhere, which
 * is why the error path says "reload" rather than "try again".
 */
(function () {
  var meta = document.querySelector('meta[name="docs-token"]');
  var TOKEN = meta ? meta.content : "";
  var notes = [];
  var pending = null;

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign(
      { "Content-Type": "application/json", "X-Docs-Token": TOKEN },
      opts.headers || {},
    );
    return fetch(path, opts);
  }

  var fab = document.getElementById("fab");
  var drawer = document.getElementById("drawer");
  var dlist = document.getElementById("dlist");
  var compose = document.getElementById("compose");
  var cbody = document.getElementById("cbody");
  var con = document.getElementById("con");
  var sel = document.getElementById("sel");
  var submitBtn = document.getElementById("submit");

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function paint() {
    fab.querySelector(".n").textContent = notes.length;
    fab.classList.toggle("none", notes.length === 0);

    if (notes.length) {
      dlist.innerHTML = notes
        .map(function (n) {
          return (
            '<div class="dnote">' +
            '<button class="x" data-del="' + n.id + '" aria-label="Delete">&times;</button>' +
            '<div class="tgt">' + esc(n.label || "General") + "</div>" +
            (n.quote ? '<div class="q">' + esc(n.quote.slice(0, 180)) + "</div>" : "") +
            '<p class="b">' + esc(n.body) + "</p>" +
            "</div>"
          );
        })
        .join("");
    } else {
      dlist.innerHTML =
        '<p class="dempty">No comments yet.<br>Click <b>+ comment</b> on any task or' +
        " heading, or select text and press Comment.</p>";
    }

    submitBtn.disabled = notes.length === 0;

    // Show which items already carry a comment.
    document.querySelectorAll(".has-note").forEach(function (el) {
      el.classList.remove("has-note");
    });
    notes.forEach(function (n) {
      if (!n.target) return;
      var el = document.getElementById(n.target.replace(/^#/, ""));
      if (el) el.classList.add("has-note");
    });
  }

  function refresh() {
    return api("/api/comments")
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        notes = d.comments || [];
        paint();
      })
      .catch(function () {
        /* server unreachable — leave the UI as it was */
      });
  }

  function openCompose(target, label, quote) {
    pending = { target: target || "", label: label, quote: quote || "" };
    con.textContent = label + (quote ? " — on the selected text" : "");
    cbody.value = "";
    compose.classList.add("open");
    setTimeout(function () {
      cbody.focus();
    }, 20);
  }

  document.getElementById("ccancel").onclick = function () {
    compose.classList.remove("open");
  };
  compose.onclick = function (e) {
    if (e.target === compose) compose.classList.remove("open");
  };

  function saveComment() {
    var body = cbody.value.trim();
    if (!body || !pending) return;
    api("/api/comments", {
      method: "POST",
      body: JSON.stringify(Object.assign({ body: body }, pending)),
    }).then(function (r) {
      if (r.status === 403) {
        alert("This page is older than the server. Reload it.");
        return;
      }
      compose.classList.remove("open");
      return refresh();
    });
  }

  document.getElementById("csave").onclick = saveComment;
  // Cmd/Ctrl+Enter submits, because a comment box you have to reach for the
  // mouse to leave is a comment box people stop using.
  cbody.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") saveComment();
    if (e.key === "Escape") compose.classList.remove("open");
  });

  dlist.onclick = function (e) {
    var id = e.target && e.target.dataset ? e.target.dataset.del : null;
    if (!id) return;
    api("/api/comments/delete", {
      method: "POST",
      body: JSON.stringify({ id: id }),
    }).then(refresh);
  };

  fab.onclick = function () {
    drawer.classList.add("open");
  };
  document.getElementById("dclose").onclick = function () {
    drawer.classList.remove("open");
  };

  // ---------------------------------------------------------- selection
  document.addEventListener("mouseup", function () {
    setTimeout(function () {
      var s = window.getSelection();
      var text = s ? String(s).trim() : "";
      if (!text || text.length < 3 || compose.classList.contains("open")) {
        sel.style.display = "none";
        return;
      }
      var rect = s.getRangeAt(0).getBoundingClientRect();
      sel.style.display = "block";
      sel.style.top = window.scrollY + rect.top - 38 + "px";
      sel.style.left = window.scrollX + rect.left + "px";
      sel.onclick = function () {
        var host = s.anchorNode;
        while (host && host.nodeType === 3) host = host.parentNode;
        var card = host && host.closest ? host.closest(".task, h2, h3") : null;
        var titleEl = card && card.querySelector ? card.querySelector(".t-title") : null;
        var label = titleEl ? titleEl.textContent : card ? card.textContent : "Selected text";
        openCompose(card && card.id ? card.id : "", label.replace("+ comment", "").trim().slice(0, 120), text);
        sel.style.display = "none";
        window.getSelection().removeAllRanges();
      };
    }, 10);
  });

  /**
   * Inline "+ comment" buttons.
   *
   * Re-attached after every route change, because the router replaces main's
   * innerHTML wholesale and takes the previous buttons with it.
   */
  window.__attachComments = function () {
    document.querySelectorAll(".task > summary").forEach(function (sm) {
      if (sm.querySelector(".cbtn")) return;
      var b = document.createElement("button");
      b.className = "cbtn";
      b.textContent = "+ comment";
      b.onclick = function (e) {
        e.preventDefault();
        e.stopPropagation();
        var card = sm.parentNode;
        var t = card.querySelector(".t-title");
        openCompose(card.id, t ? t.textContent : card.id, "");
      };
      sm.appendChild(b);
    });

    document.querySelectorAll("main h2[id], main h3[id]").forEach(function (h) {
      if (h.querySelector(".cbtn")) return;
      var b = document.createElement("button");
      b.className = "cbtn";
      b.textContent = "+ comment";
      b.onclick = function (e) {
        e.preventDefault();
        var route = location.hash.replace(/^#\//, "").split("#")[0] || "start";
        openCompose(h.id, route + " → " + h.textContent.replace("+ comment", "").trim(), "");
      };
      h.appendChild(b);
    });

    paint();
  };

  // --------------------------------------------------------------- the run
  var runBox = document.getElementById("run");
  var rlog = document.getElementById("rlog");
  var rspin = document.getElementById("rspin");
  var rtitle = document.getElementById("rtitle");

  function log(text, cls) {
    var d = document.createElement("div");
    if (cls) d.className = cls;
    d.textContent = text;
    rlog.appendChild(d);
    rlog.scrollTop = rlog.scrollHeight;
  }

  document.getElementById("rclose").onclick = function () {
    runBox.classList.remove("open");
    refresh();
  };

  submitBtn.onclick = function () {
    if (!notes.length) return;
    var warn =
      "Claude will edit this repository to implement " + notes.length + " comment(s).\n\n" +
      "Nothing is committed — changes are left in the working tree for you to review " +
      "with git diff.\n\nContinue?";
    if (!window.confirm(warn)) return;

    drawer.classList.remove("open");
    rlog.innerHTML = "";
    rspin.style.display = "";
    rtitle.textContent = "Claude is working…";
    runBox.classList.add("open");
    log("Sending " + notes.length + " comment(s)…");

    // Server-sent events over POST, so fetch plus a manual reader — EventSource
    // is GET-only and cannot carry the token header.
    api("/api/run", { method: "POST", body: "{}" })
      .then(function (r) {
        if (!r.ok || !r.body) {
          return r.json().then(function (e) {
            throw new Error(e.error || "Could not start the run.");
          });
        }
        var reader = r.body.getReader();
        var dec = new TextDecoder();
        var buf = "";

        function pump() {
          return reader.read().then(function (res) {
            if (res.done) return;
            buf += dec.decode(res.value, { stream: true });
            var frames = buf.split("\n\n");
            buf = frames.pop() || "";

            frames.forEach(function (frame) {
              var evMatch = frame.match(/^event: (.*)$/m);
              var dataMatch = frame.match(/^data: (.*)$/m);
              if (!evMatch || !dataMatch) return;
              var ev = evMatch[1];
              var d;
              try {
                d = JSON.parse(dataMatch[1]);
              } catch (err) {
                return;
              }

              if (ev === "claude") {
                if (d.type === "system" && d.subtype === "init") log("Session started.");
                if (d.type === "assistant" && d.message && d.message.content) {
                  d.message.content.forEach(function (b) {
                    if (b.type === "text" && b.text.trim()) log(b.text.trim());
                    if (b.type === "tool_use") {
                      log("→ " + b.name + " " + JSON.stringify(b.input).slice(0, 110), "tool");
                    }
                  });
                }
                if (d.type === "result") {
                  log(d.is_error ? "Finished with errors." : "Finished.", d.is_error ? "err" : "ok");
                  if (d.total_cost_usd) {
                    log("Cost $" + d.total_cost_usd.toFixed(4) + " · " + d.num_turns + " turns");
                  }
                }
              }
              if (ev === "stderr" && d.text && d.text.trim()) log(d.text.trim(), "err");
              if (ev === "done") {
                rspin.style.display = "none";
                if (d.buildError) {
                  // Comments are kept in this case, so the run can be retried.
                  rtitle.textContent = "Changes made, but the build broke";
                  log("npm run docs:build failed after the edits:", "err");
                  log(d.buildError, "err");
                  log("Your comments have been kept so you can fix and resubmit.");
                } else {
                  rtitle.textContent = "Done — " + d.resolved + " comment(s) implemented";
                }
                if (d.committed) {
                  log("WARNING: HEAD moved during this run — something committed. Check git log.", "err");
                }
                if (d.changed && d.changed.length) {
                  log("");
                  log("Files changed:");
                  d.changed.forEach(function (f) { log("  " + f); });
                }
                log("");
                log("Review with: git diff", "ok");
              }
              if (ev === "failed") {
                rspin.style.display = "none";
                rtitle.textContent = "Run failed";
                log(d.message, "err");
              }
            });

            return pump();
          });
        }

        return pump();
      })
      .catch(function (e) {
        rspin.style.display = "none";
        rtitle.textContent = "Run failed";
        log(e.message, "err");
      });
  };

  refresh();
})();
