// -------------------------------------------------------------------
// URL parameters -> arrays of relevant files
// -------------------------------------------------------------------

const params = new URLSearchParams(window.location.search);
const group = params.get("group");
const space = params.get("space");
const groupsOrig = group ? group.toLowerCase().split(",") : [];
const spacesOrig = space ? space.toLowerCase().split(",") : [];

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
    } catch (e) {}
  };
})();

window.addEventListener("storage", (e) => {
  try {
    if (
      e.key &&
      /^(processed_spaces|processed_groups|space_|group_)/.test(e.key)
    )
      window.dispatchEvent(
        new CustomEvent("processedStorageUpdated", { detail: { key: e.key } }),
      );
  } catch (e) {}
});

// -------------------------------------------------------------------
// helpers
// -------------------------------------------------------------------

function getProcessedSpaces() {
  return JSON.parse(localStorage.getItem("processed_spaces") || "[]");
}

function getProcessedGroups() {
  return JSON.parse(localStorage.getItem("processed_groups") || "[]");
}

// full names -> groups & spaces arrays
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
        const parts = key.split("_");
        const id = parts[parts.length - 1];
        const name = parts.slice(1, -1).join("_").toLowerCase();
        return [name, key];
      }),
  );

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
// Compute a simple hash of all relevant storage entries
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
    // djb2
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
    return (h >>> 0).toString(36);
  } catch (e) {
    return "";
  }
}

// -------------------------------------------------------------------
// Rendering helper!
// -------------------------------------------------------------------

function renderOnce() {
  const target = document.getElementById("render-target");
  if (!target) return;
  target.innerHTML = "";

  var overlay;
  var iframe;

  function showOverlay(href) {
    overlay.style.display = "flex";
    target.classList.add("overlay-open");
    iframe.src = href;
    overlay.style.opacity = "0";
    overlay.style.transform = "scale(0.8)";
    setTimeout(() => {
      overlay.style.opacity = "1";
      overlay.style.transform = "scale(1)";
    }, 0);
  }

  function hideOverlay() {
    overlay.style.opacity = "0";
    overlay.style.transform = "scale(0.8)";
    setTimeout(() => {
      overlay.style.display = "none";
      iframe.src = "";
      target.classList.remove("overlay-open");
    }, 200);
  }

  if (!document.getElementById("iframe-overlay")) {
    overlay = document.createElement("div");
    overlay.id = "iframe-overlay";
    overlay.style.zIndex = "9999";
    overlay.style.display = "none";
    iframe = document.createElement("iframe");
    iframe.id = "card-iframe";
    iframe.style.border = "none";
    overlay.appendChild(iframe);
    var closeButton = document.createElement("button");
    var closeImg = document.createElement("img");
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

  if (groupsOrig.includes("daily")) {
    const dailySpaceKeys = processedSpacesKeys.filter((key) => {
      const payload = fetchJson(key);
      return (
        payload &&
        Array.isArray(payload) &&
        payload.some(
          (item) =>
            item &&
            item.spaceName &&
            window.chrono &&
            window.chrono.parseDate(item.spaceName),
        )
      );
    });
    dailySpaceKeys.forEach((key) => {
      if (!spaces.includes(key)) spaces.push(key);
    });
  }

  if (!groups || !groups.length || !spaces || !spaces.length) {
  } else {
    var remaining = spaces.slice();

    groups.forEach(function (g) {
      const payload = JSON.parse(localStorage.getItem(g) || "[]");
      if (!payload || !Array.isArray(payload)) return;

      var ids = new Set();
      payload.forEach(function (sp) {
        if (sp.spaceId) ids.add(String(sp.spaceId));
        if (sp.spaceUrl) ids.add(String(sp.spaceUrl));
        if (sp.spaceName) ids.add(String(sp.spaceName));
      });

      remaining = remaining.filter(function (entry) {
        if (!entry || typeof entry !== "string") return true;
        for (var id of ids) {
          if (!id) continue;
          if (entry.indexOf(id) !== -1) return false;
        }
        return true;
      });
    });

    spaces = remaining;
  }

  var dateCards = [];

  function fetchJson(key) {
    return JSON.parse(localStorage.getItem(key) || "null");
  }

  function isMobile() {
    return (
      window.matchMedia("(pointer: coarse)").matches ||
      window.matchMedia("(max-width: 768px)").matches
    );
  }

  function createCard(item) {
    var card = document.createElement("div");
    var cardLink = document.createElement("a");
    var cardTags = document.createElement("div");

    card.className = "card";
    cardTags.className = "box-tag-wrapper";
    if (item.isDone == true) card.className += " done";

    var cardText = document.createElement("p");
    card.append(cardText);

    var textContent = item.todoText;

    if (item.urlPreviewUrl != null) {
      var link = document.createElement("a");
      link.href = item.urlPreviewUrl;
      link.target = "_blank";
      link.className = "external";
      card.append(link);

      textContent = textContent.replace(
        item.urlPreviewUrl + "?hidden=true",
        "",
      );
    }

    cardLink.href = `https://kinopio.club/${item.spaceId}/${item.id}`;
    cardLink.className = "internal";
    cardLink.addEventListener("click", function (e) {
      if (isMobile()) {
        return;
      }
      e.preventDefault();
      if (overlay.style.display !== "none") {
        hideOverlay();
        setTimeout(() => showOverlay(this.href), 200);
      } else {
        showOverlay(this.href);
      }
    });
    card.append(cardLink);

    // markdown links
    textContent = textContent.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      function (match, linkText, url) {
        return '<a href="' + url + '" target="_blank">' + linkText + "</a>";
      },
    );

    // auto-detect plain URLs and convert to links
    textContent = textContent.replace(
      /(^|[^"'>=])(https?:\/\/[^\s<>"]+)/gi,
      function (match, prefix, url) {
        return prefix + '<a href="' + url + '" target="_blank">' + url + "</a>";
      },
    );

    // Strip markdown formatting & make truncate empty spaces newlines
    textContent = textContent.replace(/^#+\s+/gm, "");
    textContent = textContent.replace(/\n+$/, "");
    textContent = textContent.replace(/\n\n/g, "\n");
    textContent = textContent.replace(/\n/g, "<br>");

    // due date handling
    var dueDateLine = item.todoText.substring(
      item.todoText.lastIndexOf("\n") + 1,
    );

    // small helper for date formatting
    const fOptions = { month: "short", day: "numeric" };

    // inline helper to push parsed date onto UI and item
    function commitDate(parsed) {
      const display = parsed.toLocaleDateString("en-US", fOptions);
      const iso = parsed.toISOString();
      textContent =
        textContent + `<br><span class="due-date">Due: ${display}</span>`;
      item.dueDate = display;
      item.dueDateIso = iso;
      dateCards.push(item);
    }

    // branch 1: explicit due: line
    if (/^due:\s*/i.test(dueDateLine)) {
      textContent = textContent.replace(`<br>${dueDateLine}`, "");
      const raw = dueDateLine.replace(/^\s*due:\s*/i, "");
      const createdAt = new Date(item.createdAt);
      const parsed = chrono.parseDate(raw, createdAt);
      if (parsed) {
        commitDate(parsed);
      } else {
        textContent = textContent + `<br>Due: ${raw}`;
      }
    } else {
      // branch 2: date in spaceName
      const parsedFromSpace = chrono.parseDate(item.spaceName);
      if (parsedFromSpace) {
        textContent = textContent.replace(`<br>${dueDateLine}`, "");
        const display = parsedFromSpace.toLocaleDateString("en-US", fOptions);
        const iso = parsedFromSpace.toISOString();
        textContent =
          textContent + `<br><span class="due-date">Due: ${display}</span>`;
        item.dueDate = display;
        item.dueDateIso = iso;
        item.dueDateParsedFromSpace = true;
        dateCards.push(item);
      } else {
        // nothing to do
      }
    }

    cardText.innerHTML = textContent;

    if (Array.isArray(item.boxNames) && item.boxNames.length) {
      for (var bi = 0; bi < item.boxNames.length; bi++) {
        var name = item.boxNames[bi];
        if (!name) continue;
        var color = Array.isArray(item.boxColors)
          ? item.boxColors[bi]
          : undefined;

        var boxTag = document.createElement("div");
        boxTag.textContent = name;
        if (color) boxTag.style.backgroundColor = color;
        else boxTag.style.backgroundColor = "#ddd";

        // compute readable text color
        var m,
          r = 0,
          g = 0,
          b = 0;
        if (color && (m = color.match(/^#([a-f\d]{6})$/i))) {
          r = parseInt(m[1].slice(0, 2), 16);
          g = parseInt(m[1].slice(2, 4), 16);
          b = parseInt(m[1].slice(4, 6), 16);
        } else if (color && (m = color.match(/^#([a-f\d]{3})$/i))) {
          r = parseInt(m[1][0] + m[1][0], 16);
          g = parseInt(m[1][1] + m[1][1], 16);
          b = parseInt(m[1][2] + m[1][2], 16);
        } else if (
          color &&
          (m = color.match(/^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/i))
        ) {
          r = +m[1];
          g = +m[2];
          b = +m[3];
        }

        if (
          typeof r === "number" &&
          typeof g === "number" &&
          typeof b === "number"
        ) {
          var brightness = (r * 299 + g * 587 + b * 114) / 1000;
          boxTag.style.color = brightness > 128 ? "#000" : "#fff";
        }

        cardTags.appendChild(boxTag);
      }
      card.append(cardTags);
    }

    return card;
  }

  function createSpaceWrap(titleText, items) {
    var spaceWrap = document.createElement("div");
    spaceWrap.className = "space";

    var spaceTitle = document.createElement("h3");
    spaceTitle.textContent = titleText || "";
    var cardWrapper = document.createElement("div");
    cardWrapper.className = "card-wrapper";

    var headerWrapper = document.createElement("div");
    headerWrapper.className = "space-header-wrapper";

    var bgDiv = document.createElement("div");
    var firstItem = Array.isArray(items) && items.length ? items[0] : null;
    var bg =
      firstItem && firstItem.spaceBackground ? firstItem.spaceBackground : null;
    bgDiv.style.backgroundImage = "url('" + bg + "')";
    headerWrapper.appendChild(bgDiv);
    headerWrapper.appendChild(spaceTitle);

    spaceWrap.appendChild(headerWrapper);
    spaceWrap.appendChild(cardWrapper);

    // Sort items by text length, longest first, then group by first box tag
    var NOBOX = "__no-box__";
    var sorted = (items || []).sort(function (a, b) {
      var textA = (a && a.todoText && a.todoText.length) || 0;
      var textB = (b && b.todoText && b.todoText.length) || 0;
      return textB - textA;
    });

    var grouped = {};
    for (var i = 0; i < sorted.length; i++) {
      var it = sorted[i];
      var key = NOBOX;
      if (
        Array.isArray(it && it.boxNames) &&
        it.boxNames.length > 0 &&
        it.boxNames[0] != null
      ) {
        key = String(it.boxNames[0]).toLowerCase();
      }
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(it);
    }

    var groupKeys = Object.keys(grouped).sort(function (a, b) {
      if (a === NOBOX) return 1;
      if (b === NOBOX) return -1;
      return a.localeCompare(b);
    });

    items = [];
    for (var k = 0; k < groupKeys.length; k++) {
      var groupArray = grouped[groupKeys[k]];
      for (var j = 0; j < groupArray.length; j++) {
        items.push(groupArray[j]);
      }
    }

    items.forEach(function (it) {
      cardWrapper.appendChild(createCard(it));
    });

    spaceWrap.classList.add("done");
    var cards = cardWrapper.querySelectorAll(".card");
    for (var i = 0; i < cards.length; i++) {
      if (!cards[i].classList.contains("done")) {
        spaceWrap.classList.remove("done");
        break;
      }
    }

    if (
      titleText &&
      window.chrono &&
      window.chrono.parseDate(titleText) &&
      titleText
        .toLowerCase()
        .includes(window.chrono.parseDate(titleText).getFullYear())
    ) {
      spaceWrap.classList.add("hidden");
    }

    return spaceWrap;
  }

  function finalizeGroupDone(groupEl) {
    groupEl.classList.add("done");
    var spacesEls = groupEl.querySelectorAll(".space");
    for (var i = 0; i < spacesEls.length; i++) {
      if (!spacesEls[i].classList.contains("done")) {
        groupEl.classList.remove("done");
        break;
      }
    }
  }

  function renderGroup(titleText, spacesArray) {
    if (!spacesArray || !spacesArray.length) return;
    var groupWrap = document.createElement("div");
    groupWrap.className = "group";
    var groupTitle = document.createElement("h2");
    groupTitle.textContent = titleText || "";
    groupWrap.appendChild(groupTitle);

    spacesArray.forEach(function (sp) {
      var todos = sp && sp.todos ? sp.todos : [];
      var name = sp && sp.spaceName ? sp.spaceName : "";
      var spaceEl = createSpaceWrap(name, todos);
      if (spaces.length === 1)
        spaceEl.querySelector(".card-wrapper").classList.add("column");
      groupWrap.appendChild(spaceEl);
    });

    finalizeGroupDone(groupWrap);
    target.appendChild(groupWrap);
  }

  groups.forEach(function (g) {
    var payload = fetchJson(g);
    if (!payload || !Array.isArray(payload)) return;

    var groupName = payload[0] && payload[0].groupName;

    renderGroup(groupName, payload);
  });

  if (spaces && spaces.length) {
    var standaloneItems = [];

    spaces.forEach(function (s) {
      var payload = fetchJson(s);
      if (!payload) return;

      var items = Array.isArray(payload) ? payload : [payload];
      var first = items[0] || {};
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
  //  Rendering the calendar
  // -------------------------------------------------------------------

  if (dateCards && dateCards.length) {
    function dateKeyFromItem(it) {
      if (!it) return "no-date";
      if (it.dueDateIso && typeof it.dueDateIso === "string") {
        return it.dueDateIso.slice(0, 10);
      }
      if (it.dueDate) {
        var d = new Date(it.dueDate);
        if (!isNaN(d)) return d.toISOString().slice(0, 10);
      }
      return "no-date";
    }

    function displayFromKey(key) {
      if (!key || key === "no-date") return "No date";
      const parts = key.split("-");
      const d = new Date(
        parseInt(parts[0]),
        parseInt(parts[1]) - 1,
        parseInt(parts[2]),
      );
      return isNaN(d)
        ? key
        : d.toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
          });
    }

    // Build: date -> { display, spaces: { spaceName: [items] } }
    var byDate = Object.create(null);
    for (var i = 0; i < dateCards.length; i++) {
      var it = dateCards[i];
      var key = dateKeyFromItem(it);
      var bucket =
        byDate[key] ||
        (byDate[key] = {
          display: displayFromKey(key),
          spaces: Object.create(null),
        });
      var spaceName = it.spaceName || it.spaceId || "Unknown";
      (bucket.spaces[spaceName] || (bucket.spaces[spaceName] = [])).push(it);
    }

    // Sort date keys (YYYY-MM-DD strings are lex-sortable); put "no-date" last
    var keys = Object.keys(byDate).sort(function (a, b) {
      if (a === "no-date") return 1;
      if (b === "no-date") return -1;
      return a < b ? -1 : a > b ? 1 : 0;
    });

    function stripInlineDue(cardEl) {
      var spans = cardEl.querySelectorAll("span.due-date");
      for (var si = 0; si < spans.length; si++) {
        var sp = spans[si];
        var prev = sp.previousSibling;
        while (
          prev &&
          ((prev.nodeType === 3 && /^\s*$/.test(prev.nodeValue)) ||
            (prev.nodeType === 1 && prev.nodeName === "BR"))
        ) {
          var rm = prev;
          prev = prev.previousSibling;
          if (rm.parentNode) rm.parentNode.removeChild(rm);
        }
        if (sp.parentNode) sp.parentNode.removeChild(sp);
      }
    }

    var __savedDateCards = dateCards;
    dateCards = [];

    var calendarDiv = document.createElement("div");
    calendarDiv.id = "calendar";
    var calendarFrag = document.createDocumentFragment();
    var backlogFrag = document.createDocumentFragment();

    var todayKey = new Date().toISOString().slice(0, 10);

    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var groupData = byDate[key];

      var groupWrap = document.createElement("div");
      groupWrap.className = "date-group";

      var groupTitle = document.createElement("h2");
      groupTitle.textContent = groupData.display || "";
      if (key === todayKey) {
        groupTitle.textContent = "❉ Today";
      }
      groupWrap.appendChild(groupTitle);

      var groupDone = true;

      const spaceNames = Object.keys(groupData.spaces).sort((a, b) => {
        const aNative = groupData.spaces[a].some(
          (item) => item.dueDateParsedFromSpace,
        );
        const bNative = groupData.spaces[b].some(
          (item) => item.dueDateParsedFromSpace,
        );

        if (aNative && !bNative) return -1;
        if (!aNative && bNative) return 1;
        a = (a || "").toLowerCase();
        b = (b || "").toLowerCase();
        return a.localeCompare(b);
      });

      for (var s = 0; s < spaceNames.length; s++) {
        var sName = spaceNames[s];
        var items = groupData.spaces[sName];

        var spaceWrap = document.createElement("div");
        spaceWrap.className = "date-space";

        var customHeader = false;
        for (var t = 0; t < items.length; t++) {
          if (items[t].dueDateParsedFromSpace === true) {
            customHeader = true;
            break;
          }
        }

        if (!customHeader) {
          var spaceTitle = document.createElement("h3");
          spaceTitle.textContent = sName || "";
          spaceWrap.appendChild(spaceTitle);
        } else {
          var spaceTitle = document.createElement("h3");
          spaceTitle.textContent = "↪ Daily";
          spaceWrap.appendChild(spaceTitle);
        }

        var cardWrapper = document.createElement("div");
        cardWrapper.className = "card-wrapper";
        spaceWrap.appendChild(cardWrapper);

        var spaceDone = true;
        for (var m = 0; m < items.length; m++) {
          var cardEl = createCard(items[m]);
          stripInlineDue(cardEl);
          if (!items[m].isDone) spaceDone = false;
          cardWrapper.appendChild(cardEl);
        }

        if (spaceDone) {
          spaceWrap.classList.add("done");
        } else {
          groupDone = false;
        }

        groupWrap.appendChild(spaceWrap);
      }

      if (groupDone) groupWrap.classList.add("done");

      if (key !== "no-date" && key < todayKey) {
        backlogFrag.appendChild(groupWrap);
      } else {
        calendarFrag.appendChild(groupWrap);
      }
    }

    if (backlogFrag.children.length > 0) {
      var backlogWrapper = document.createElement("div");
      backlogWrapper.id = "backlog-wrapper";

      var backlogTitle = document.createElement("h2");
      backlogTitle.textContent = "✷ Backlog";
      backlogWrapper.appendChild(backlogTitle);

      let allBacklogGroupsDone = true;
      for (let i = 0; i < backlogFrag.children.length; i++) {
        if (!backlogFrag.children[i].classList.contains("done")) {
          allBacklogGroupsDone = false;
          break;
        }
      }
      if (allBacklogGroupsDone) {
        backlogWrapper.classList.add("done");
      }

      backlogWrapper.appendChild(backlogFrag);
      calendarDiv.appendChild(backlogWrapper);
    }

    calendarDiv.appendChild(calendarFrag);

    dateCards = __savedDateCards;

    target.prepend(calendarDiv);
  }
}

// initlal render
window.addEventListener("load", () => {
  try {
    window.__ks_last_hash = storageHash();
    renderOnce();
  } catch (e) {
    console.error("Render error:", e);
  }
});

// in-place changes
window.addEventListener("processedStorageUpdated", () => {
  try {
    const newHash = storageHash();
    if (newHash === window.__ks_last_hash) return;
    window.__ks_last_hash = newHash;

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
