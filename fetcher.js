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
    console.log(`☈ Received ${path} with http:${response.status}`);
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
  console.log("ǂ Piped data into localStorage");

  return [todosResult, groupsResult];
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
  };
}

function restructure() {
  try {
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

    console.log(`⏚ Processed ${rawSpaces.length} spaces.`);

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
    console.log(`⏚ Processed ${rawGroups.length} groups.`);

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

if (!AUTH) {
  console.log("Please set KINOPIO_API_KEY in localStorage");
} else {
  startPolling();
  setInterval(() => {
    restructure();
  }, PROCESS_INTERVAL);
}
