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
    // console.log(`☈ Received ${path} with http:${response.status}`);
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

  // Store the basic todos and groups data
  // Full space fetching will happen on-demand in restructure()
  localStorage.setItem("todos", JSON.stringify(todosResult.body));
  localStorage.setItem("groups", JSON.stringify(groupsResult.body));
  // console.log("ǂ Piped data into localStorage");

  return [todosResult, groupsResult];
}

// Fetch full space data for specific space IDs to get connections
async function fetchFullSpaces(spaceIds) {
  if (!spaceIds || spaceIds.length === 0) return {};

  const BATCH_SIZE = 4;
  const fullSpaces = [];

  for (let i = 0; i < spaceIds.length; i += BATCH_SIZE) {
    const batch = spaceIds.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map((id) => fetchData(`/space/${id}`)),
    );
    for (const result of batchResults) {
      if (result.statusCode === 200 && result.body) {
        fullSpaces.push(result.body);
      }
    }
    // Small delay between batches to avoid rate limiting
    if (i + BATCH_SIZE < spaceIds.length) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  // Return as a map of spaceId -> full space data
  const fullSpacesById = {};
  for (const fs of fullSpaces) {
    if (fs.id) fullSpacesById[fs.id] = fs;
  }
  return fullSpacesById;
}

function startPolling() {
  collect()
    .catch((err) => console.error("Error:", err.message))
    .finally(() => setTimeout(startPolling, POLL_INTERVAL));
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

function buildFlatCard(card, space, group) {
  const isDone = /^\s*\[x\]/i.test(card.name || "");
  const todoText = stripTodoPrefix(card.name || "");

  const containingBoxes = findContainingBoxes(card, space.boxes || []);
  const boxNames = containingBoxes.length
    ? containingBoxes.map((b) => stripTodoPrefix(b.name || ""))
    : [];
  const boxColors = containingBoxes.length
    ? containingBoxes.map((b) => b.color)
    : [];

  const boxName = boxNames.length ? boxNames[0] : null;
  const boxColor = boxColors.length ? boxColors[0] : null;

  return {
    ...card,
    todoText,
    isDone,
    boxNames,
    boxColors,
    groupId: group && group.id,
    groupName: group && group.name,
    groupColor: group && group.color,
    groupEmoji: group && group.emoji,
    groupCollaboratorKey: group && group.collaboratorKey,
    groupCreatedByUserId: group && group.createdByUserId,
    spaceGroupId: space && space.groupId,
    spaceId: space && space.id,
    spaceName: space && space.name,
    spaceUrl: space && space.url,
    spacePrivacy: space && space.privacy,
    spaceBackground: space && space.background,
    spaceBackgroundTint: space && space.backgroundTint,
    spaceBackgroundIsGradient: space && space.backgroundIsGradient,
    spaceBackgroundGradient: space && space.backgroundGradient,
    spacePreviewImage: space && space.previewImage,
    spacePreviewThumbnailImage: space && space.previewThumbnailImage,
    spaceDrawingImage: space && space.drawingImage,
    spaceEditedAt: space && space.editedAt,
    spaceEditedByUserId: space && space.editedByUserId,
    // Sub-task fields (populated later)
    subTasks: [],
    parentIds: [],
    depth: 0,
  };
}

// Build sub-task hierarchy from connections
// A connection from cardA -> cardB means B is a sub-task of A
function buildSubTaskHierarchy(flatTodos, connections) {
  if (!connections || !connections.length) return flatTodos;

  const todoById = {};
  for (const todo of flatTodos) {
    todoById[todo.id] = todo;
  }

  // Build parent-child relationships from connections
  // Only consider connections between todo cards
  for (const conn of connections) {
    const parent = todoById[conn.startItemId];
    const child = todoById[conn.endItemId];

    if (parent && child && parent.id !== child.id) {
      // Add child to parent's subTasks (avoid duplicates)
      if (!parent.subTasks.some((s) => s.id === child.id)) {
        parent.subTasks.push(child);
      }
      // Track that child has this parent
      if (!child.parentIds.includes(parent.id)) {
        child.parentIds.push(parent.id);
      }
    }
  }

  // Calculate depth for each todo (for indentation)
  // Use BFS from root nodes to handle cycles gracefully
  function calculateDepths() {
    const visited = new Set();
    const queue = [];

    // Start with root todos (no parents)
    for (const todo of flatTodos) {
      if (todo.parentIds.length === 0) {
        todo.depth = 0;
        queue.push(todo);
        visited.add(todo.id);
      }
    }

    while (queue.length > 0) {
      const current = queue.shift();
      for (const child of current.subTasks) {
        // Only update depth if not visited or if this path gives deeper nesting
        if (!visited.has(child.id)) {
          child.depth = current.depth + 1;
          visited.add(child.id);
          queue.push(child);
        }
      }
    }

    // Handle any orphaned cycles (todos only in cycles)
    for (const todo of flatTodos) {
      if (!visited.has(todo.id)) {
        todo.depth = 1; // Treat as nested
        visited.add(todo.id);
      }
    }
  }

  calculateDepths();

  return flatTodos;
}

// Helper to check if a space will be displayed based on URL params
function shouldProcessSpace(
  space,
  urlSpaceFilters,
  urlGroupFilters,
  groupsById,
) {
  // If no filters, process all spaces
  if (
    (!urlSpaceFilters || urlSpaceFilters.length === 0) &&
    (!urlGroupFilters || urlGroupFilters.length === 0)
  ) {
    return true;
  }

  const spaceName = (space.name || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/ /g, "-")
    .replace(/[^A-Za-z0-9\-_]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  const spaceUrl = (space.url || "").toLowerCase();
  const spaceId = (space.id || "").toLowerCase();

  // Check if space matches space filter
  if (urlSpaceFilters && urlSpaceFilters.length > 0) {
    for (const filter of urlSpaceFilters) {
      const f = filter.toLowerCase();
      if (
        spaceName.includes(f) ||
        spaceUrl.includes(f) ||
        spaceId.includes(f)
      ) {
        return true;
      }
    }
  }

  // Check if space belongs to a filtered group
  if (urlGroupFilters && urlGroupFilters.length > 0 && space.groupId) {
    const group = groupsById[space.groupId];
    if (group) {
      const groupName = (group.name || "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .replace(/ /g, "-")
        .replace(/[^A-Za-z0-9\-_]/g, "")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "");

      for (const filter of urlGroupFilters) {
        const f = filter.toLowerCase();
        if (groupName.includes(f)) {
          return true;
        }
      }
    }
  }

  // Check for special "daily" filter
  if (urlGroupFilters && urlGroupFilters.includes("daily")) {
    if (
      window.chrono &&
      window.chrono.parseDate &&
      window.chrono.parseDate(space.name)
    ) {
      return true;
    }
  }

  return false;
}

async function restructure() {
  try {
    const rawSpaces = JSON.parse(localStorage.getItem("todos") || "[]");
    const rawGroups = JSON.parse(localStorage.getItem("groups") || "[]");

    // Get URL parameters to filter which spaces to fetch
    const params = new URLSearchParams(window.location.search);
    const groupParam = params.get("group");
    const spaceParam = params.get("space");
    const urlGroupFilters = groupParam
      ? groupParam.toLowerCase().split(",")
      : [];
    const urlSpaceFilters = spaceParam
      ? spaceParam.toLowerCase().split(",")
      : [];

    const groupsById = {};
    for (const g of rawGroups) groupsById[g.id] = g;

    // Filter to only spaces that will be displayed
    const spacesToFetch = rawSpaces.filter((space) =>
      shouldProcessSpace(space, urlSpaceFilters, urlGroupFilters, groupsById),
    );

    const spaceIds = spacesToFetch.map((s) => s.id).filter(Boolean);

    // Fetch full space data only for filtered spaces
    const fullSpacesById = await fetchFullSpaces(spaceIds);

    const spaceOutputsById = {};
    const processedSpaces = {};

    for (const space of rawSpaces) {
      const group = groupsById[space.groupId] || null;
      const cards = Array.isArray(space.cards) ? space.cards : [];
      const todoCards = cards.filter((c) => c && c.isTodo);
      let flatTodos = todoCards.map((c) => buildFlatCard(c, space, group));

      // Get connections from the full space data
      const fullSpace = fullSpacesById[space.id];
      const connections = (fullSpace && fullSpace.connections) || [];
      flatTodos = buildSubTaskHierarchy(flatTodos, connections);

      const spaceKey = `space_${safeName(space.name)}_${space.id}`;
      localStorage.setItem(spaceKey, JSON.stringify(flatTodos));
      processedSpaces[spaceKey] = true;

      spaceOutputsById[space.id] = {
        meta: {
          spaceId: space.id,
          spaceName: space.name,
          spaceUrl: space.url,
          spacePrivacy: space.privacy,
          spaceBackground: space.background,
          spaceBackgroundTint: space.backgroundTint,
          spaceBackgroundIsGradient: space.backgroundIsGradient,
          spaceBackgroundGradient: space.backgroundGradient,
          spacePreviewImage: space.previewImage,
          spacePreviewThumbnailImage: space.previewThumbnailImage,
          spaceDrawingImage: space.drawingImage,
          spaceEditedAt: space.editedAt,
          spaceEditedByUserId: space.editedByUserId,
          groupId: group && group.id,
          groupName: group && group.name,
          groupColor: group && group.color,
          groupEmoji: group && group.emoji,
          groupCollaboratorKey: group && group.collaboratorKey,
          groupCreatedByUserId: group && group.createdByUserId,
        },
        todos: flatTodos,
        groupId: space.groupId,
        key: spaceKey,
      };
    }

    // console.log(`⏚ Processed ${rawSpaces.length} spaces.`);

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
    // console.log(`⏚ Processed ${rawGroups.length} groups.`);

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
