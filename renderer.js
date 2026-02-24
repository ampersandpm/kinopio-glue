// renderer.js — Renders tasks, projects, and a calendar from processed data
// in localStorage. Listens for "processedStorageUpdated" events (fired by the
// localStorage monkey-patch below and by cross-tab storage events) and
// re-renders when the data changes. Uses a djb2 hash to skip no-op renders.

// -------------------------------------------------------------------
// URL parameters -> arrays of relevant storage keys
// -------------------------------------------------------------------

const params = new URLSearchParams(window.location.search);
const group = params.get("group");
const space = params.get("space");
const groupsOrig = group ? group.toLowerCase().split(",") : [];
const spacesOrig = space ? space.toLowerCase().split(",") : [];

// Monkey-patch localStorage.setItem so that writes from the same tab fire a
// custom event. The native "storage" event only fires in *other* tabs, so
// without this patch the renderer would never know when fetcher.js updates
// the processed data.
(function () {
  const _set = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function (key, value) {
    _set(key, value);
    try {
      if (/^(processed_spaces|processed_groups|space_|group_)/.test(key)) {
        clearTimeout(window.__ks_timer);
        window.__ks_timer = setTimeout(
          () =>
            window.dispatchEvent(
              new CustomEvent("processedStorageUpdated", { detail: { key } }),
            ),
          25,
        );
      }
    } catch (_) {}
  };
})();

// Cross-tab: relay native storage events into the same custom event
window.addEventListener("storage", (e) => {
  try {
    if (
      e.key &&
      /^(processed_spaces|processed_groups|space_|group_)/.test(e.key)
    )
      window.dispatchEvent(
        new CustomEvent("processedStorageUpdated", { detail: { key: e.key } }),
      );
  } catch (_) {}
});

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function getProcessedSpaces() {
  return JSON.parse(localStorage.getItem("processed_spaces") || "[]");
}

function getProcessedGroups() {
  return JSON.parse(localStorage.getItem("processed_groups") || "[]");
}

// Resolve human-friendly names from URL params into localStorage keys
function updateNames(
  processedKeys,
  targetArray,
  keyPrefix,
  currentGroups,
  currentSpaces,
) {
  const lookup = Object.fromEntries(
    processedKeys
      .filter((key) => key.startsWith(keyPrefix))
      .map((key) => {
        const payload = JSON.parse(localStorage.getItem(key) || "null");
        let name = "";
        if (keyPrefix === "group_") {
          name =
            payload && Array.isArray(payload) && payload[0]
              ? payload[0].groupName || ""
              : "";
        } else if (keyPrefix === "space_") {
          name =
            payload && Array.isArray(payload) && payload[0]
              ? payload[0].spaceName || ""
              : "";
        }
        return [
          name
            .toLowerCase()
            .replace(/\s+/g, " ")
            .replace(/ /g, "-")
            .replace(/[^A-Za-z0-9\-_]/g, "")
            .replace(/-+/g, "-")
            .replace(/^-+|-+$/g, ""),
          key,
        ];
      }),
  );

  // When no filters are specified, show everything
  if (
    (!targetArray || targetArray.length === 0) &&
    (window.__mapsFilled ||
      ((!currentGroups || currentGroups.length === 0) &&
        (!currentSpaces || currentSpaces.length === 0)))
  ) {
    window.__mapsFilled = true;
    return processedKeys.filter((key) => key.startsWith(keyPrefix));
  }

  return targetArray?.map((item) => lookup[item.toLowerCase()] || item) || [];
}

// -------------------------------------------------------------------
// Compute a djb2 hash of all relevant storage entries to detect changes
// -------------------------------------------------------------------
function storageHash() {
  try {
    const re = /^(processed_spaces|processed_groups|space_|group_)/;
    const keys = [];
    for (let i = 0; i < localStorage.length; i++)
      keys.push(localStorage.key(i));
    keys.sort();
    let s = "";
    for (const k of keys) {
      if (re.test(k)) {
        const v = localStorage.getItem(k);
        s += k + ":" + (v == null ? "" : v) + "|";
      }
    }
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
    return (h >>> 0).toString(36);
  } catch (e) {
    return "";
  }
}

// -------------------------------------------------------------------
// Toggle state — module-scope so re-renders don't orphan in-flight state
// -------------------------------------------------------------------

let _pendingToggles = {}; // cardId -> AbortController for in-flight PATCH
let _toggleQueue = {}; // cardId -> { item, newName, prevName, prevIsDone, checkboxEl, rowEl, onToggle }
let _toggleFlushTimer = null;
let _optimisticState = {}; // cardId -> { name, isDone } applied during re-renders
let _deferredRerender = false;

function flushToggleQueue() {
  _toggleFlushTimer = null;
  const queue = _toggleQueue;
  _toggleQueue = {};

  const promises = [];

  for (const cardId in queue) {
    (function (entry) {
      if (_pendingToggles[entry.item.id]) {
        _pendingToggles[entry.item.id].abort();
        delete _pendingToggles[entry.item.id];
      }

      const controller = new AbortController();
      _pendingToggles[entry.item.id] = controller;

      const p = fetch("https://" + API_HOST + "/card", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: AUTH,
        },
        body: JSON.stringify({ id: entry.item.id, name: entry.newName }),
        signal: controller.signal,
      })
        .then(function (res) {
          delete _pendingToggles[entry.item.id];
          if (!res.ok) throw new Error("HTTP " + res.status);
          delete _optimisticState[entry.item.id];
        })
        .catch(function (err) {
          delete _pendingToggles[entry.item.id];
          delete _optimisticState[entry.item.id];
          if (err.name === "AbortError") return;
          console.error("Toggle error:", err);
          // Revert UI on genuine failure
          entry.item.name = entry.prevName;
          entry.item.isDone = entry.prevIsDone;
          entry.checkboxEl.classList.toggle("checked", entry.prevIsDone);
          if (entry.prevIsDone) entry.rowEl.classList.add("done");
          else entry.rowEl.classList.remove("done");
          if (entry.onToggle) entry.onToggle();
        });
      promises.push(p);
    })(queue[cardId]);
  }

  if (promises.length > 0) {
    Promise.allSettled(promises).then(function () {
      if (_deferredRerender) {
        _deferredRerender = false;
        window.__ks_last_hash = storageHash();
        renderOnce();
      }
    });
  }
}

function toggleTaskDone(item, checkboxEl, rowEl, onToggle) {
  const cardName = item.name || "";
  let newName;
  if (/^\s*\[x\]/i.test(cardName)) {
    newName = cardName.replace(/^\s*\[x\]/i, "[ ]");
  } else {
    newName = cardName.replace(/^\s*\[\s?\]/i, "[x]");
  }

  const nowDone = /^\s*\[x\]/i.test(newName);

  // Snapshot the pre-queue state for revert — only from the first queued click
  const existingEntry = _toggleQueue[item.id];
  const prevName = existingEntry ? existingEntry.prevName : item.name;
  const prevIsDone = existingEntry ? existingEntry.prevIsDone : item.isDone;
  item.name = newName;
  item.isDone = nowDone;

  checkboxEl.classList.toggle("checked", nowDone);
  if (nowDone) rowEl.classList.add("done");
  else rowEl.classList.remove("done");

  if (onToggle) onToggle();

  _optimisticState[item.id] = { name: newName, isDone: nowDone };
  _toggleQueue[item.id] = {
    item,
    newName,
    prevName,
    prevIsDone,
    checkboxEl,
    rowEl,
    onToggle,
  };

  resetToggleTimer();
}

function resetToggleTimer() {
  if (_toggleFlushTimer !== null) clearTimeout(_toggleFlushTimer);
  _toggleFlushTimer = setTimeout(flushToggleQueue, 1000);
}

// -------------------------------------------------------------------
// Rendering
// -------------------------------------------------------------------

function renderOnce() {
  const target = document.getElementById("render-target");
  if (!target) return;
  target.innerHTML = "";

  let overlay;
  let iframe;

  // Registry for calendar project card bars, keyed by project name.
  // Populated by createProjectDiv, read by the calendar render loop.
  const _calProjectRegistry = {};

  function showOverlay(href) {
    iframe.src = href;
    target.classList.add("overlay-open");
    // Force a reflow so the transition from scale(0.8)->scale(1) plays
    overlay.classList.add("visible");
  }

  function hideOverlay() {
    overlay.classList.remove("visible");
    // Wait for the CSS transition to finish before clearing the iframe
    setTimeout(() => {
      iframe.src = "";
      target.classList.remove("overlay-open");
    }, 200);
  }

  if (!document.getElementById("iframe-overlay")) {
    overlay = document.createElement("div");
    overlay.id = "iframe-overlay";
    iframe = document.createElement("iframe");
    iframe.id = "card-iframe";
    iframe.style.border = "none";
    overlay.appendChild(iframe);
    const closeButton = document.createElement("button");
    const closeImg = document.createElement("img");
    closeImg.src =
      "data:image/svg+xml,%3csvg%20height='10'%20viewBox='0%200%2010%2010'%20width='10'%20xmlns='http://www.w3.org/2000/svg'%3e%3cg%20fill='none'%20fill-rule='evenodd'%20stroke='%23000'%20transform='translate(0%20-.5)'%3e%3cpath%20d='m0%205.5h10'/%3e%3cpath%20d='m0%205.5h10'%20transform='matrix(0%201%20-1%200%2010.5%20.5)'/%3e%3c/g%3e%3c/svg%3e";
    closeImg.style.transform = "rotate(45deg)";
    closeButton.appendChild(closeImg);
    closeButton.addEventListener("click", hideOverlay);
    overlay.appendChild(closeButton);
    document.body.appendChild(overlay);
  } else {
    overlay = document.getElementById("iframe-overlay");
    iframe = document.getElementById("card-iframe");
  }

  const processedSpacesKeys = getProcessedSpaces();
  const processedGroupsKeys = getProcessedGroups();

  let groups = updateNames(
    processedGroupsKeys,
    groupsOrig,
    "group_",
    groupsOrig,
    spacesOrig,
  );
  let spaces = updateNames(
    processedSpacesKeys,
    spacesOrig,
    "space_",
    groupsOrig,
    spacesOrig,
  );

  // Remove spaces already covered by groups
  if (groups && groups.length && spaces && spaces.length) {
    let remaining = spaces.slice();

    groups.forEach(function (g) {
      const payload = JSON.parse(localStorage.getItem(g) || "[]");
      if (!payload || !Array.isArray(payload)) return;

      const ids = new Set();
      payload.forEach(function (sp) {
        if (sp.spaceId) ids.add(String(sp.spaceId));
        if (sp.spaceUrl) ids.add(String(sp.spaceUrl));
        if (sp.spaceName) ids.add(String(sp.spaceName));
      });

      remaining = remaining.filter(function (entry) {
        if (!entry || typeof entry !== "string") return true;
        for (const id of ids) {
          if (!id) continue;
          if (entry.indexOf(id) !== -1) return false;
        }
        return true;
      });
    });

    spaces = remaining;
  }

  const dateCards = [];

  function fetchJson(key) {
    return JSON.parse(localStorage.getItem(key) || "null");
  }

  // Strip a preview URL from task text so it doesn't duplicate the arrow button
  function stripPreviewUrl(text, url) {
    if (!url || !text) return text;
    if (text.trim() === url || text.trim() === url.replace(/\/+$/, ""))
      return "";
    const esc = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(
      new RegExp("\\[([^\\]]*?)\\]\\(" + esc + "[^)]*\\)", "gi"),
      "$1",
    );
    text = text.replace(new RegExp(esc + "\\S*", "gi"), "");
    return text
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // Sort by y-position, then x-position as tiebreaker
  function sortByPosition(items) {
    return items.slice().sort(function (a, b) {
      const dy = (a.y || 0) - (b.y || 0);
      if (dy !== 0) return dy;
      return (a.x || 0) - (b.x || 0);
    });
  }

  function isMobile() {
    return (
      window.matchMedia("(pointer: coarse)").matches ||
      window.matchMedia("(max-width: 768px)").matches
    );
  }

  function relativeDueDate(isoString) {
    if (!isoString) return "";
    const due = new Date(isoString);
    if (isNaN(due)) return "";
    const today = new Date();
    const todayDay = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
    );
    const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
    const diffMs = dueDay - todayDay;
    const diffDays = Math.round(diffMs / 86400000);
    if (diffDays === 0) return "today";
    if (diffDays === 1) return "tomorrow";
    if (diffDays === -1) return "yesterday";
    if (diffDays > 0) return "in " + diffDays + " days";
    return Math.abs(diffDays) + " days ago";
  }

  // -------------------------------------------------------------------
  // Parse due date from a task item.
  // For non-project tasks: "due: X" on last line, or "text | date" pipe syntax.
  // Tasks inside projects do NOT get due dates.
  // -------------------------------------------------------------------
  function parseDueDate(item) {
    if (item.projectName)
      return { textContent: null, dueDate: null, dueDateIso: null };

    const todoText = item.todoText;
    const dueDateLine = todoText.substring(todoText.lastIndexOf("\n") + 1);
    const fOptions = { month: "short", day: "numeric" };

    if (/^due:\s*/i.test(dueDateLine)) {
      const raw = dueDateLine.replace(/^\s*due:\s*/i, "");
      const createdAt = new Date(item.createdAt);
      const parsed = chrono.parseDate(raw, createdAt);
      if (parsed) {
        const display = parsed.toLocaleDateString("en-US", fOptions);
        return {
          textContent: todoText.replace(dueDateLine, "").replace(/\n$/, ""),
          dueDate: display,
          dueDateIso: parsed.toISOString(),
        };
      }
      return { textContent: null, dueDate: null, dueDateIso: null };
    }

    // Check pipe syntax: "task name | date"
    const pipeIdx = todoText.lastIndexOf("|");
    if (pipeIdx !== -1) {
      const beforePipe = todoText.substring(0, pipeIdx).trim();
      const afterPipe = todoText.substring(pipeIdx + 1).trim();
      const createdAt = new Date(item.createdAt);
      const parsed = chrono.parseDate(afterPipe, createdAt);
      if (parsed) {
        const display = parsed.toLocaleDateString("en-US", fOptions);
        return {
          textContent: beforePipe,
          dueDate: display,
          dueDateIso: parsed.toISOString(),
        };
      }
    }

    return { textContent: null, dueDate: null, dueDateIso: null };
  }

  // -------------------------------------------------------------------
  // Shared text formatting: markdown links, bare URLs, heading strip, newlines
  // -------------------------------------------------------------------
  function formatTaskText(text) {
    // Markdown links → HTML anchors
    text = text.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      function (match, linkText, url) {
        return '<a href="' + url + '" target="_blank">' + linkText + "</a>";
      },
    );
    // Auto-detect bare URLs
    text = text.replace(
      /(^|[^"'>=])(https?:\/\/[^\s<>"]+)/gi,
      function (match, prefix, url) {
        return prefix + '<a href="' + url + '" target="_blank">' + url + "</a>";
      },
    );
    // Strip markdown headings
    text = text.replace(/^#+\s+/gm, "");
    // Collapse and convert newlines
    text = text.replace(/\n+$/, "");
    text = text.replace(/\n\n/g, "\n");
    text = text.replace(/\n/g, "<br>");
    return text;
  }

  // -------------------------------------------------------------------
  // Shared button group: link, scissors (copy), and card (open in Kinopio)
  // -------------------------------------------------------------------
  function createTaskButtons(item) {
    const buttons = document.createElement("div");
    buttons.className = "task-buttons";

    // Link button (external URL)
    if (item.urlPreviewUrl) {
      const linkBtn = document.createElement("a");
      linkBtn.href = item.urlPreviewUrl;
      linkBtn.target = "_blank";
      linkBtn.className = "task-btn task-btn-link";
      linkBtn.title = "Open link";
      buttons.appendChild(linkBtn);
    }

    // Scissors button (copy to clipboard)
    const scissorsBtn = document.createElement("button");
    scissorsBtn.className = "task-btn task-btn-scissors";
    scissorsBtn.title = "Copy task info";
    let clipText = item.todoText;
    if (item.projectName) clipText += " | " + item.projectName;
    clipText += " | " + (item.spaceName || "");
    scissorsBtn.addEventListener("click", function () {
      navigator.clipboard.writeText(clipText.trim());
      scissorsBtn.classList.add("copied");
      setTimeout(function () {
        scissorsBtn.classList.remove("copied");
      }, 2000);
    });
    buttons.appendChild(scissorsBtn);

    // Card button (direct link to card in Kinopio)
    const cardBtn = document.createElement("a");
    cardBtn.href = "https://kinopio.club/" + item.spaceId + "/" + item.id;
    cardBtn.className = "task-btn task-btn-card";
    cardBtn.title = "Open in Kinopio";
    cardBtn.addEventListener("click", function (e) {
      if (isMobile()) return;
      e.preventDefault();
      if (overlay.classList.contains("visible")) {
        hideOverlay();
        setTimeout(() => showOverlay(this.href), 200);
      } else {
        showOverlay(this.href);
      }
    });
    buttons.appendChild(cardBtn);

    return buttons;
  }

  // -------------------------------------------------------------------
  // Create a task row for the project/loose-tasks view
  // -------------------------------------------------------------------
  function createTaskRow(item, onToggle) {
    const row = document.createElement("div");
    row.className = "task-row";
    if (item.isDone) row.classList.add("done");

    if (item.backgroundColor) {
      row.style.backgroundColor = item.backgroundColor + "22";
    }

    // Checkbox
    const checkbox = document.createElement("span");
    checkbox.className = "task-checkbox";
    if (item.isDone) checkbox.classList.add("checked");
    checkbox.addEventListener("click", function () {
      toggleTaskDone(item, checkbox, row, onToggle);
    });
    checkbox.addEventListener("mouseenter", function () {
      if (Object.keys(_toggleQueue).length > 0) resetToggleTimer();
    });
    checkbox.addEventListener("mouseleave", function () {
      if (Object.keys(_toggleQueue).length > 0) resetToggleTimer();
    });
    row.appendChild(checkbox);

    // Task text
    const textEl = document.createElement("span");
    textEl.className = "task-text";

    let textContent = item.todoText;

    // Strip pipe-date from display for non-project tasks
    if (!item.projectName) {
      const dueInfo = parseDueDate(item);
      if (dueInfo.textContent !== null) {
        textContent = dueInfo.textContent;
      }
    }

    textContent = stripPreviewUrl(textContent, item.urlPreviewUrl);
    textEl.innerHTML = formatTaskText(textContent);
    row.appendChild(textEl);

    row.appendChild(createTaskButtons(item));

    return row;
  }

  // -------------------------------------------------------------------
  // Render a list header row: circular progress + list name
  // -------------------------------------------------------------------
  function createListHeaderRow(listName, tasks, listColor) {
    const row = document.createElement("div");
    row.className = "task-row list-header-row";

    const total = tasks.length;
    const done = tasks.filter(function (t) {
      return t.isDone;
    }).length;
    const pct = total > 0 ? done / total : 0;

    // SVG circle parameters
    const r = 7; // radius — slightly larger than 14px checkbox half-width
    const cx = 9;
    const cy = 9;
    const size = 18;
    const circumference = 2 * Math.PI * r;

    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "list-progress-circle");
    svg.setAttribute("width", size);
    svg.setAttribute("height", size);
    svg.setAttribute("viewBox", "0 0 " + size + " " + size);

    // Background track circle
    const track = document.createElementNS(ns, "circle");
    track.setAttribute("class", "list-circle-track");
    track.setAttribute("cx", cx);
    track.setAttribute("cy", cy);
    track.setAttribute("r", r);
    svg.appendChild(track);

    // Fill circle (clockwise from noon via stroke-dashoffset)
    const arc = document.createElementNS(ns, "circle");
    arc.setAttribute("class", "list-circle-arc");
    arc.setAttribute("cx", cx);
    arc.setAttribute("cy", cy);
    arc.setAttribute("r", r);
    arc.setAttribute("stroke-dasharray", circumference);
    arc.setAttribute("stroke-dashoffset", circumference * (1 - pct));
    // rotate so the arc starts at 12 o'clock
    arc.setAttribute("transform", "rotate(-90 " + cx + " " + cy + ")");
    svg.appendChild(arc);

    // Infill when complete
    const fill = document.createElementNS(ns, "circle");
    fill.setAttribute("class", "list-circle-fill");
    fill.setAttribute("cx", cx);
    fill.setAttribute("cy", cy);
    fill.setAttribute("r", r - 1.5);
    if (listColor) svg.style.setProperty("--list-color", listColor);
    svg.appendChild(fill);

    if (pct >= 1) svg.classList.add("complete");

    row.appendChild(svg);

    const textEl = document.createElement("span");
    textEl.className = "task-text list-title";
    textEl.textContent = listName || "";
    row.appendChild(textEl);

    // Empty spacer to keep grid consistent
    const spacer = document.createElement("div");
    spacer.className = "task-buttons";
    row.appendChild(spacer);

    return row;
  }

  // -------------------------------------------------------------------
  // Render an ordered array of tasks, grouping list tasks into
  // indented blocks beneath a list header.
  // -------------------------------------------------------------------
  function renderTasksWithLists(tasks, onProjectToggle) {
    const frag = document.createDocumentFragment();

    // Pre-group all list tasks by listId
    const listGroups = {};
    const seenLists = {};

    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      if (t.listId && t.listName) {
        if (!listGroups[t.listId]) {
          listGroups[t.listId] = {
            type: "list",
            listId: t.listId,
            name: t.listName,
            tasks: [],
          };
        }
        listGroups[t.listId].tasks.push(t);
      }
    }

    // Build ordered sequence: insert list group at first occurrence, skip later ones
    const sequence = [];
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      if (t.listId && t.listName) {
        if (!seenLists[t.listId]) {
          seenLists[t.listId] = true;
          sequence.push(listGroups[t.listId]);
        }
      } else {
        sequence.push({ type: "task", item: t });
      }
    }

    for (let s = 0; s < sequence.length; s++) {
      const entry = sequence[s];
      if (entry.type === "task") {
        frag.appendChild(createTaskRow(entry.item, onProjectToggle));
      } else {
        // List block
        const listWrap = document.createElement("div");
        listWrap.className = "list-group";

        // Sort by listPositionIndex within the list
        entry.tasks.sort(function (a, b) {
          return (a.listPositionIndex || 0) - (b.listPositionIndex || 0);
        });

        const listColor = entry.tasks[0] && entry.tasks[0].listColor;
        const listHeaderRow = createListHeaderRow(entry.name, entry.tasks, listColor);
        const listCircleSvg = listHeaderRow.querySelector(".list-progress-circle");
        const listCircleArc = listHeaderRow.querySelector(".list-circle-arc");
        listWrap.appendChild(listHeaderRow);

        // Closure to recompute the circle + done state on toggle.
        // Also calls onProjectToggle so the parent project bar stays in sync.
        const onListToggle = (function (tasks, circleSvg, circleArc, wrap, onProject) {
          const circ = 2 * Math.PI * 7;
          return function () {
            const done = tasks.filter(function (t) {
              return t.isDone;
            }).length;
            const pct = tasks.length > 0 ? done / tasks.length : 0;
            circleArc.setAttribute("stroke-dashoffset", circ * (1 - pct));
            const allDone = done === tasks.length && tasks.length > 0;
            if (allDone) circleSvg.classList.add("complete");
            else circleSvg.classList.remove("complete");
            if (allDone) wrap.classList.add("done");
            else wrap.classList.remove("done");
            if (onProject) onProject();
          };
        })(entry.tasks, listCircleSvg, listCircleArc, listWrap, onProjectToggle);

        const listTasksEl = document.createElement("div");
        listTasksEl.className = "list-tasks";
        for (let lt = 0; lt < entry.tasks.length; lt++) {
          listTasksEl.appendChild(createTaskRow(entry.tasks[lt], onListToggle));
        }
        listWrap.appendChild(listTasksEl);

        const allDone = entry.tasks.every(function (t) {
          return t.isDone;
        });
        if (allDone && entry.tasks.length > 0) listWrap.classList.add("done");

        frag.appendChild(listWrap);
      }
    }

    return frag;
  }

  // -------------------------------------------------------------------
  // Create a project div with progress bar and task list
  // -------------------------------------------------------------------
  function createProjectDiv(
    projectName,
    projectColor,
    projectRawDue,
    tasks,
    projectId,
  ) {
    const proj = document.createElement("div");
    proj.className = "project";

    const header = document.createElement("div");
    header.className = "project-header";

    // Progress bar
    const total = tasks.length;
    const done = tasks.filter(function (t) {
      return t.isDone;
    }).length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    const progressWrap = document.createElement("div");
    progressWrap.className = "project-progress";
    const progressBar = document.createElement("div");
    progressBar.className = "project-progress-fill";
    progressBar.style.width = pct + "%";
    if (projectColor) progressBar.style.backgroundColor = projectColor;
    progressWrap.appendChild(progressBar);

    const pctLabel = document.createElement("span");
    pctLabel.className = "project-pct";
    pctLabel.textContent = pct + "%";

    const nameEl = document.createElement("div");
    nameEl.className = "project-name";

    // Due date for project (parsed from pipe in box name)
    if (projectRawDue) {
      const parsed = chrono.parseDate(projectRawDue);
      if (parsed) {
        const dueBadge = document.createElement("span");
        dueBadge.className = "project-due";
        const isoStr = parsed.toISOString();
        const relStr = relativeDueDate(isoStr);
        const absStr = parsed.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        });
        dueBadge.textContent = relStr ? absStr + ", " + relStr : absStr;
        nameEl.appendChild(dueBadge);

        // Register for calendar
        dateCards.push({
          todoText: projectName,
          spaceName: tasks[0] && tasks[0].spaceName,
          spaceId: tasks[0] && tasks[0].spaceId,
          firstTaskId: tasks[0] && tasks[0].id,
          id: "project-" + (projectId || projectName),
          projectId: projectId || projectName,
          isDone: pct === 100,
          dueDate: absStr,
          dueDateIso: parsed.toISOString(),
          isProject: true,
          projectPct: pct,
          projectColor: projectColor,
        });
      }
    }
    nameEl.appendChild(document.createTextNode(projectName));

    // Tint header with project color
    if (projectColor) {
      header.style.backgroundColor = projectColor + "30";
      progressBar.style.backgroundColor = projectColor;
    }

    header.appendChild(progressWrap);
    header.appendChild(pctLabel);
    header.appendChild(nameEl);

    proj.appendChild(header);

    // Closure to update project bar + calendar card bar on toggle
    const _projRegistryKey = projectId || projectName;
    const onProjectToggle = (function (tasks, bar, label, projEl, regKey) {
      return function () {
        const done = tasks.filter(function (t) {
          return t.isDone;
        }).length;
        const pct =
          tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0;
        bar.style.width = pct + "%";
        label.textContent = pct + "%";
        if (pct === 100) projEl.classList.add("done");
        else projEl.classList.remove("done");
        const calReg = _calProjectRegistry[regKey];
        if (calReg && calReg.barFill) {
          calReg.barFill.style.width = pct + "%";
          calReg.pctSpan.textContent = pct + "%";
          if (pct === 100) calReg.cardEl.classList.add("done");
          else calReg.cardEl.classList.remove("done");
        }
      };
    })(tasks, progressBar, pctLabel, proj, _projRegistryKey);

    // Task list (with inline list grouping)
    const taskList = document.createElement("div");
    taskList.className = "project-tasks";
    taskList.appendChild(renderTasksWithLists(tasks, onProjectToggle));
    proj.appendChild(taskList);

    if (pct === 100) proj.classList.add("done");

    // Register so the calendar bar can find this project later
    _calProjectRegistry[_projRegistryKey] = {
      tasks: tasks,
      barFill: null,
      pctSpan: null,
      cardEl: null,
    };

    return proj;
  }

  // -------------------------------------------------------------------
  // Render a space: group tasks by project, loose tasks separate
  // -------------------------------------------------------------------
  function createSpaceWrap(titleText, items) {
    const spaceWrap = document.createElement("div");
    spaceWrap.className = "space";

    const spaceTitle = document.createElement("h3");
    spaceTitle.textContent = titleText || "";

    const headerWrapper = document.createElement("div");
    headerWrapper.className = "space-header-wrapper";

    const bgDiv = document.createElement("div");
    const firstItem = Array.isArray(items) && items.length ? items[0] : null;
    const bg =
      firstItem && firstItem.spaceBackground ? firstItem.spaceBackground : null;
    if (bg) bgDiv.style.backgroundImage = "url('" + bg + "')";
    headerWrapper.appendChild(bgDiv);
    headerWrapper.appendChild(spaceTitle);

    spaceWrap.appendChild(headerWrapper);

    // Apply optimistic overrides so server lag doesn't revert checked state
    for (let oi = 0; oi < items.length; oi++) {
      const opt = _optimisticState[items[oi].id];
      if (opt) {
        items[oi].name = opt.name;
        items[oi].isDone = opt.isDone;
        items[oi].todoText = stripTodoPrefix(opt.name);
      }
    }

    // Separate into projects and loose tasks
    const projectMap = {};
    const looseTasks = [];

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.projectName) {
        const projKey = it.projectBoxId || it.projectName;
        if (!projectMap[projKey]) {
          projectMap[projKey] = {
            name: it.projectName,
            color: it.projectColor,
            rawDue: it.projectRawDue,
            id: projKey,
            tasks: [],
          };
        }
        projectMap[projKey].tasks.push(it);
      } else {
        looseTasks.push(it);
      }
    }

    // Sort tasks within each project by position
    const projectNames = Object.keys(projectMap).sort();
    for (let p = 0; p < projectNames.length; p++) {
      projectMap[projectNames[p]].tasks = sortByPosition(
        projectMap[projectNames[p]].tasks,
      );
    }

    // Sort loose tasks by position, parse due dates, register in calendar
    const sortedLoose = sortByPosition(looseTasks);
    for (let j = 0; j < sortedLoose.length; j++) {
      const dueInfo = parseDueDate(sortedLoose[j]);
      if (dueInfo.dueDateIso) {
        sortedLoose[j].dueDate = dueInfo.dueDate;
        sortedLoose[j].dueDateIso = dueInfo.dueDateIso;
        dateCards.push(sortedLoose[j]);
      }
    }

    // Render loose tasks first (above projects), with inline list grouping
    if (sortedLoose.length) {
      const looseWrap = document.createElement("div");
      looseWrap.className = "loose-tasks";
      looseWrap.appendChild(renderTasksWithLists(sortedLoose));
      spaceWrap.appendChild(looseWrap);
    }

    // Then render projects
    for (let p2 = 0; p2 < projectNames.length; p2++) {
      const pData = projectMap[projectNames[p2]];
      const projEl = createProjectDiv(
        pData.name,
        pData.color,
        pData.rawDue,
        pData.tasks,
        pData.id,
      );
      spaceWrap.appendChild(projEl);
    }

    // Mark space done if everything is done
    const allDone = items.every(function (it) {
      return it.isDone;
    });
    if (allDone && items.length > 0) spaceWrap.classList.add("done");

    return spaceWrap;
  }

  function renderGroup(titleText, spacesArray) {
    if (!spacesArray || !spacesArray.length) return;
    const groupWrap = document.createElement("div");
    groupWrap.className = "group";
    if (titleText) {
      const groupTitle = document.createElement("h2");
      groupTitle.textContent = titleText;
      groupWrap.appendChild(groupTitle);
    }

    const spacesRow = document.createElement("div");
    spacesRow.className = "group-spaces";

    spacesArray
      .slice()
      .sort(function (a, b) {
        return (b.todos ? b.todos.length : 0) - (a.todos ? a.todos.length : 0);
      })
      .forEach(function (sp) {
        const todos = sp && sp.todos ? sp.todos : [];
        const name = sp && sp.spaceName ? sp.spaceName : "";
        const spaceEl = createSpaceWrap(name, todos);
        spacesRow.appendChild(spaceEl);
      });

    groupWrap.appendChild(spacesRow);

    // Mark group done if all spaces are done
    groupWrap.classList.add("done");
    const spaceEls = groupWrap.querySelectorAll(".space");
    for (let i = 0; i < spaceEls.length; i++) {
      if (!spaceEls[i].classList.contains("done")) {
        groupWrap.classList.remove("done");
        break;
      }
    }

    target.appendChild(groupWrap);
  }

  // Render groups
  groups.forEach(function (g) {
    const payload = fetchJson(g);
    if (!payload || !Array.isArray(payload)) return;

    const groupName = payload[0] && payload[0].groupName;
    renderGroup(groupName, payload);
  });

  // Render standalone spaces
  if (spaces && spaces.length) {
    const standaloneItems = [];

    spaces.forEach(function (s) {
      const payload = fetchJson(s);
      if (!payload) return;

      const items = Array.isArray(payload) ? payload : [payload];
      const first = items[0] || {};
      standaloneItems.push({
        spaceName: first.spaceName || s,
        todos: items,
      });
    });

    if (standaloneItems.length) {
      if (groups.length === 0 && spaces.length > 0) {
        renderGroup("", standaloneItems);
      } else {
        renderGroup("⧉ Residuum", standaloneItems);
      }
    }
  }

  // -------------------------------------------------------------------
  // Calendar: task card (no progress bar, has checkbox + actions)
  // -------------------------------------------------------------------

  function createCalTaskCard(item, onToggle) {
    const card = document.createElement("div");
    card.className = "cal-task-card";
    if (item.isDone) card.classList.add("done");

    // Top row: checkbox + text + due date
    const topRow = document.createElement("div");
    topRow.className = "cal-task-top";

    const checkbox = document.createElement("span");
    checkbox.className = "task-checkbox";
    if (item.isDone) checkbox.classList.add("checked");
    checkbox.addEventListener("click", function () {
      toggleTaskDone(item, checkbox, card, onToggle);
    });
    checkbox.addEventListener("mouseenter", function () {
      if (Object.keys(_toggleQueue).length > 0) resetToggleTimer();
    });
    checkbox.addEventListener("mouseleave", function () {
      if (Object.keys(_toggleQueue).length > 0) resetToggleTimer();
    });
    topRow.appendChild(checkbox);

    const textSpan = document.createElement("span");
    textSpan.className = "cal-card-name task-text";
    let textContent = item.todoText;

    // Strip due date from display (shown as a badge)
    const calDueInfo = parseDueDate(item);
    if (calDueInfo.textContent !== null) {
      textContent = calDueInfo.textContent;
    }

    textContent = stripPreviewUrl(textContent, item.urlPreviewUrl);
    if (item.dueDate) {
      const dueSpan = document.createElement("span");
      dueSpan.className = "cal-card-due";
      const calRelStr = relativeDueDate(item.dueDateIso);
      dueSpan.textContent = calRelStr
        ? item.dueDate + ", " + calRelStr
        : item.dueDate;
      textSpan.appendChild(dueSpan);
    }
    textSpan.insertAdjacentHTML("beforeend", formatTaskText(textContent));
    topRow.appendChild(textSpan);
    card.appendChild(topRow);

    // Bottom row: space name + action buttons
    const bottomRow = document.createElement("div");
    bottomRow.className = "cal-task-bottom";

    const spaceSpan = document.createElement("span");
    spaceSpan.className = "cal-card-space";
    spaceSpan.textContent = item.spaceName || "";
    bottomRow.appendChild(spaceSpan);

    bottomRow.appendChild(createTaskButtons(item));
    card.appendChild(bottomRow);

    return card;
  }

  // -------------------------------------------------------------------
  // Rendering the calendar
  // -------------------------------------------------------------------

  if (dateCards && dateCards.length) {
    function dateKeyFromItem(it) {
      if (!it) return "no-date";
      if (it.dueDateIso && typeof it.dueDateIso === "string") {
        return it.dueDateIso.slice(0, 10);
      }
      if (it.dueDate) {
        const d = new Date(it.dueDate);
        if (!isNaN(d)) return d.toISOString().slice(0, 10);
      }
      return "no-date";
    }

    const byDate = Object.create(null);

    function addToByDate(it) {
      const key = dateKeyFromItem(it);
      if (!byDate[key]) byDate[key] = { items: [] };
      byDate[key].items.push(it);
    }

    for (let i = 0; i < dateCards.length; i++) {
      addToByDate(dateCards[i]);
    }

    const keys = Object.keys(byDate).sort(function (a, b) {
      if (a === "no-date") return 1;
      if (b === "no-date") return -1;
      return a < b ? -1 : a > b ? 1 : 0;
    });

    const calendarDiv = document.createElement("div");
    calendarDiv.id = "calendar";
    const calHeading = document.createElement("h2");
    calHeading.textContent = "Deadlines:";
    calHeading.className = "calendar-heading";
    calendarDiv.appendChild(calHeading);
    const calendarFrag = document.createDocumentFragment();

    let globalCardIndex = 0;

    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      const groupData = byDate[key];

      const groupWrap = document.createElement("div");
      groupWrap.className = "date-group";

      const cardWrapper = document.createElement("div");
      cardWrapper.className = "card-wrapper";

      let groupDone = true;

      for (let m = 0; m < groupData.items.length; m++) {
        const calItem = groupData.items[m];
        if (calItem.isProject) {
          const card = document.createElement("div");
          card.className = "cal-project-card";
          if (calItem.isDone) card.classList.add("done");
          else groupDone = false;
          if (calItem.projectColor)
            card.style.backgroundColor = calItem.projectColor + "20";

          const topRow = document.createElement("div");
          topRow.className = "cal-card-top";
          const nameSpan = document.createElement("div");
          nameSpan.className = "cal-card-name";
          if (calItem.dueDate) {
            const dueSpan = document.createElement("span");
            dueSpan.className = "cal-card-due";
            const projRelStr = relativeDueDate(calItem.dueDateIso);
            dueSpan.textContent = projRelStr
              ? calItem.dueDate + ", " + projRelStr
              : calItem.dueDate;
            nameSpan.appendChild(dueSpan);
          }
          nameSpan.appendChild(document.createTextNode(calItem.todoText));
          topRow.appendChild(nameSpan);
          card.appendChild(topRow);

          if (calItem.spaceName) {
            const spaceSpan = document.createElement("div");
            spaceSpan.className = "cal-card-space";
            spaceSpan.textContent = calItem.spaceName;
            card.appendChild(spaceSpan);
          }

          const bottomRow = document.createElement("div");
          bottomRow.className = "cal-card-bottom";
          const barWrap = document.createElement("div");
          barWrap.className = "project-progress cal-card-bar";
          const barFill = document.createElement("div");
          barFill.className = "project-progress-fill";
          barFill.style.width = calItem.projectPct + "%";
          if (calItem.projectColor)
            barFill.style.backgroundColor = calItem.projectColor;
          barWrap.appendChild(barFill);
          bottomRow.appendChild(barWrap);
          const pctSpan = document.createElement("span");
          pctSpan.className = "project-pct";
          pctSpan.textContent = calItem.projectPct + "%";
          bottomRow.appendChild(pctSpan);

          if (calItem.firstTaskId && calItem.spaceId) {
            const projCardBtn = document.createElement("a");
            projCardBtn.href =
              "https://kinopio.club/" +
              calItem.spaceId +
              "/" +
              calItem.firstTaskId;
            projCardBtn.className = "task-btn task-btn-card";
            projCardBtn.title = "Open in Kinopio";
            projCardBtn.style.filter = "opacity(12%) blur(1px)";
            projCardBtn.addEventListener("click", function (e) {
              if (isMobile()) return;
              e.preventDefault();
              if (overlay.classList.contains("visible")) {
                hideOverlay();
                setTimeout(() => showOverlay(this.href), 200);
              } else {
                showOverlay(this.href);
              }
            });
            bottomRow.appendChild(projCardBtn);
          }

          card.appendChild(bottomRow);

          // Populate the registry entry that onProjectToggle will read
          const _calRegKey = calItem.projectId || calItem.todoText;
          if (_calProjectRegistry[_calRegKey]) {
            _calProjectRegistry[_calRegKey].barFill = barFill;
            _calProjectRegistry[_calRegKey].pctSpan = pctSpan;
            _calProjectRegistry[_calRegKey].cardEl = card;
          }

          cardWrapper.appendChild(card);
        } else {
          const taskCard = createCalTaskCard(calItem);
          if (!calItem.isDone) groupDone = false;
          cardWrapper.appendChild(taskCard);
        }
      }

      // Apply tilt + stacking to all cards in this date group
      const cardEls = cardWrapper.children;
      const totalCards = cardEls.length;
      for (let ci = 0; ci < totalCards; ci++) {
        const cardEl = cardEls[ci];
        // Stable seeded rotation from card id + index (doesn't flicker on re-render)
        let seed = 0;
        const seedStr =
          (groupData.items[ci] && groupData.items[ci].id
            ? String(groupData.items[ci].id)
            : "") + ci;
        for (let si = 0; si < seedStr.length; si++)
          seed = (seed * 31 + seedStr.charCodeAt(si)) & 0xffffffff;
        let rot = (((seed >>> 0) % 1000) / 1000) * 3 + 0.1;
        if (globalCardIndex % 2 !== 0) rot = -rot;
        cardEl.style.setProperty("--base-rot", rot.toFixed(2) + "deg");
        cardEl.style.zIndex = ci + 1;
        globalCardIndex++;
      }
      if (totalCards > 1) cardWrapper.classList.add("stacked");

      if (groupDone) groupWrap.classList.add("done");
      groupWrap.appendChild(cardWrapper);
      calendarFrag.appendChild(groupWrap);
    }

    calendarDiv.appendChild(calendarFrag);

    target.prepend(calendarDiv);
  }
}

// Initial render
window.addEventListener("load", () => {
  try {
    window.__ks_last_hash = storageHash();
    renderOnce();
  } catch (e) {
    console.error("Render error:", e);
  }
});

// Re-render on data changes
window.addEventListener("processedStorageUpdated", () => {
  try {
    const newHash = storageHash();
    if (newHash === window.__ks_last_hash) return;
    window.__ks_last_hash = newHash;

    // Suppress re-render while toggles are queued or in-flight to avoid
    // reverting optimistic UI. The flush handler will re-render when done.
    if (
      Object.keys(_toggleQueue).length > 0 ||
      Object.keys(_pendingToggles).length > 0
    ) {
      _deferredRerender = true;
      return;
    }

    if (document.hidden) {
      clearTimeout(window.__ks_vis_timer);
      window.__ks_vis_timer = setTimeout(() => {
        if (!document.hidden) renderOnce();
      }, 250);
    } else {
      renderOnce();
    }
  } catch (e) {
    console.error("Re-render error:", e);
  }
});
