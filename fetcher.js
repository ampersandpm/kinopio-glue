// fetcher.js — Polls the Kinopio API for todos and groups, then restructures
// the raw data into flat per-space and per-group entries in localStorage.
// The renderer picks up changes via "processedStorageUpdated" custom events
// triggered by a localStorage.setItem monkey-patch in renderer.js.

const API_HOST = "api.kinopio.club";
const AUTH = localStorage.getItem("KINOPIO_API_KEY") || "";
const POLL_INTERVAL = 1500;
const PROCESS_INTERVAL = 1750;

// -------------------------------------------------------------------
// Collection of tasks into raw json
// -------------------------------------------------------------------

async function fetchData(path) {
  try {
    const response = await fetch(`https://${API_HOST}${path}`, {
      headers: {
        Authorization: AUTH,
        "User-Agent": "KN-Glue",
      },
    });
    const data = await response.json();
    return { statusCode: response.status, body: data };
  } catch (error) {
    console.error("Fetch error:", error);
    throw error;
  }
}

async function collect() {
  const [todosResult, groupsResult] = await Promise.all([
    fetchData("/user/todos"),
    fetchData("/user/groups"),
  ]);

  localStorage.setItem("todos", JSON.stringify(todosResult.body));
  localStorage.setItem("groups", JSON.stringify(groupsResult.body));

  return [todosResult, groupsResult];
}

function startPolling() {
  collect()
    .catch((err) => console.error("Error:", err.message))
    .finally(() => setTimeout(startPolling, POLL_INTERVAL));
}

// -------------------------------------------------------------------
// List cache: fetched separately since /user/todos doesn't include lists
// -------------------------------------------------------------------

const _listCache = {};

async function fetchListsForTodos() {
  const rawSpaces = JSON.parse(localStorage.getItem("todos") || "[]");
  const listIds = new Set();
  for (const space of rawSpaces) {
    const cards = Array.isArray(space.cards) ? space.cards : [];
    for (const card of cards) {
      if (card.listId && !_listCache[card.listId]) listIds.add(card.listId);
    }
  }
  if (listIds.size === 0) return;

  const fetches = [...listIds].map(async (id) => {
    try {
      const result = await fetchData("/list/" + id);
      if (result.statusCode === 200 && result.body) {
        _listCache[id] = result.body;
      }
    } catch (e) {
      console.error("List fetch error for " + id + ":", e);
    }
  });
  await Promise.all(fetches);
}

// -------------------------------------------------------------------
// JSON Restructuring
// -------------------------------------------------------------------

function safeName(s) {
  const base = String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9 _.-]+/g, "-")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "untitled";
}

function stripTodoPrefix(name) {
  return String(name || "")
    .replace(/^\s*\[(?:x|X| )?\]\s*/i, "")
    .trim();
}

function findContainingBoxes(card, boxes) {
  if (!boxes || !Array.isArray(boxes)) return [];

  const containing = [];
  for (const box of boxes) {
    if (
      card.x >= box.x &&
      card.y >= box.y &&
      card.x <= box.x + (box.resizeWidth || 0) &&
      card.y <= box.y + (box.resizeHeight || 0)
    ) {
      containing.push(box);
    }
  }
  return containing;
}

// Parse "Name | due date" format from box or task names
function parsePipeDue(text) {
  const pipeIdx = text.lastIndexOf("|");
  if (pipeIdx === -1) return { name: text, rawDue: null };
  return {
    name: text.substring(0, pipeIdx).trim(),
    rawDue: text.substring(pipeIdx + 1).trim(),
  };
}

function buildFlatCard(card, space, group) {
  const isDone = /^\s*\[x\]/i.test(card.name || "");
  const todoText = stripTodoPrefix(card.name || "");

  const containingBoxes = findContainingBoxes(card, space.boxes || []);

  // Parse project info from boxes
  const projects = [];
  for (const box of containingBoxes) {
    const rawBoxName = stripTodoPrefix(box.name || "");
    const { name: projectName, rawDue } = parsePipeDue(rawBoxName);
    projects.push({
      name: projectName,
      color: box.color,
      rawDue: rawDue,
    });
  }

  const projectBox = containingBoxes.length ? containingBoxes[0] : null;
  const projectName = projects.length ? projects[0].name : null;
  const projectColor = projects.length ? projects[0].color : null;
  const projectRawDue = projects.length ? projects[0].rawDue : null;
  const projectBoxId = projectBox ? projectBox.id : null;

  // Resolve list info from pre-fetched cache
  let listName = null;
  let listColor = null;
  let listPositionIndex = card.listPositionIndex;
  if (card.listId && _listCache[card.listId]) {
    const list = _listCache[card.listId];
    listName = list.name || null;
    listColor = list.color || null;
  }

  return {
    ...card,
    todoText,
    isDone,
    projectName,
    projectColor,
    projectRawDue,
    projectBoxId,
    projectBoxX: projectBox ? projectBox.x : null,
    projectBoxY: projectBox ? projectBox.y : null,
    listName,
    listColor,
    listPositionIndex,
    groupId: group && group.id,
    groupName: group && group.name,
    spaceId: space && space.id,
    spaceName: space && space.name,
    spaceUrl: space && space.url,
    spaceBackground: space && space.background,
  };
}

async function restructure() {
  try {
    await fetchListsForTodos();
    const rawSpaces = JSON.parse(localStorage.getItem("todos") || "[]");
    const rawGroups = JSON.parse(localStorage.getItem("groups") || "[]");

    const groupsById = {};
    for (const g of rawGroups) groupsById[g.id] = g;

    const spaceOutputsById = {};
    const processedSpaces = {};

    for (const space of rawSpaces) {
      const group = groupsById[space.groupId] || null;
      const cards = Array.isArray(space.cards) ? space.cards : [];
      const todoCards = cards.filter((c) => c && c.isTodo);
      const flatTodos = todoCards.map((c) => buildFlatCard(c, space, group));

      const spaceKey = `space_${safeName(space.name)}_${space.id}`;
      localStorage.setItem(spaceKey, JSON.stringify(flatTodos));
      processedSpaces[spaceKey] = true;

      spaceOutputsById[space.id] = {
        meta: {
          spaceId: space.id,
          spaceName: space.name,
          groupId: group && group.id,
          groupName: group && group.name,
        },
        todos: flatTodos,
        groupId: space.groupId,
        key: spaceKey,
      };
    }

    const processedGroups = {};
    for (const group of rawGroups) {
      const groupedSpaces = [];
      for (const space of rawSpaces) {
        if (space.groupId !== group.id) continue;
        const entry = spaceOutputsById[space.id];
        if (!entry) continue;
        groupedSpaces.push({
          ...entry.meta,
          todos: entry.todos,
        });
      }
      const groupKey = `group_${safeName(group.name)}_${group.id}`;
      localStorage.setItem(groupKey, JSON.stringify(groupedSpaces));
      processedGroups[groupKey] = true;
    }

    localStorage.setItem(
      "processed_spaces",
      JSON.stringify(Object.keys(processedSpaces)),
    );
    localStorage.setItem(
      "processed_groups",
      JSON.stringify(Object.keys(processedGroups)),
    );
  } catch (e) {
    console.error("Restructure error:", e);
  }
}

if (AUTH) {
  startPolling();
  setInterval(() => {
    restructure().catch((err) => console.error("Restructure error:", err));
  }, PROCESS_INTERVAL);
}
