const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");

const PORT = process.env.PORT || 3000;
const API_HOST = "api.kinopio.club";
const AUTH = `${process.env.KINOPIO_API_KEY}`;
const POLL_INTERVAL = 500;
const PROCESS_INTERVAL = 750;

// -------------------------------------------------------------------
// Collection of tasks into raw json
// -------------------------------------------------------------------

function fetchAndWrite(path, file) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: API_HOST,
        path,
        headers: {
          Authorization: AUTH,
          "User-Agent": "KN-Glue",
          "User-Agent": "Node.js/Kinopio-Glue",
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          console.log(`☈ Recieved ${path} with http:${res.statusCode}`);
          fs.writeFile(file, body, () => {});
          console.log(`ǂ Piped into ${file}`);
          resolve({ statusCode: res.statusCode, body });
        });
      },
    );
    req.on("error", reject);
  });
}

function collect() {
  return Promise.all([
    fetchAndWrite("/user/todos", "todos.json"),
    fetchAndWrite("/user/groups", "groups.json"),
  ]);
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

  // For consumers that expect a single boxName/boxColor, keep the first match (may be undefined)
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
  const todosPath = path.join(__dirname, "todos.json");
  const groupsPath = path.join(__dirname, "groups.json");

  const rawSpaces = JSON.parse(fs.readFileSync(todosPath, "utf8"));
  const rawGroups = JSON.parse(fs.readFileSync(groupsPath, "utf8"));

  const distDir = path.join(__dirname, "dist");
  const spacesDir = path.join(distDir, "spaces");
  const groupsDir = path.join(distDir, "groups");
  fs.mkdirSync(spacesDir, { recursive: true });
  fs.mkdirSync(groupsDir, { recursive: true });

  const groupsById = {};
  for (const g of rawGroups) groupsById[g.id] = g;

  const spaceOutputsById = {};

  for (const space of rawSpaces) {
    const group = groupsById[space.groupId] || null;
    const cards = Array.isArray(space.cards) ? space.cards : [];
    const todoCards = cards.filter((c) => c && c.isTodo);
    const flatTodos = todoCards.map((c) => buildFlatCard(c, space, group));

    const spaceFileBase = `${safeName(space.name)}.${space.id}.json`;
    const spaceFilePath = path.join(spacesDir, spaceFileBase);
    fs.writeFileSync(spaceFilePath, JSON.stringify(flatTodos, null, 2));

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
      fileBase: spaceFileBase,
    };
  }

  console.log(`⏚ Processed ${rawSpaces.length} spaces.`);

  const groupFilenames = [];
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
    const groupFileBase = `${safeName(group.name)}.${group.id}.json`;
    const groupFilePath = path.join(groupsDir, groupFileBase);
    fs.writeFileSync(groupFilePath, JSON.stringify(groupedSpaces, null, 2));
    groupFilenames.push(groupFileBase);
  }
  console.log(`⏚ Processed ${rawGroups.length} groups.`);

  const groupMapFilePath = path.join(groupsDir, "map.txt");
  fs.writeFileSync(groupMapFilePath, groupFilenames.join("\n"));

  const spaceFilenames = Object.values(spaceOutputsById).map(
    (entry) => entry.fileBase,
  );
  const spaceMapFilePath = path.join(spacesDir, "map.txt");
  fs.writeFileSync(spaceMapFilePath, spaceFilenames.join("\n"));
}

setInterval(() => {
  try {
    restructure();
  } catch (_e) {}
}, PROCESS_INTERVAL);

// -------------------------------------------------------------------
// Serverstuff
// -------------------------------------------------------------------

const serve = (res) => {
  const fs = require("fs");
  const path = require("path");

  const distDir = path.join(__dirname, "dist");
  const req = res.req || res.request;
  const urlPath =
    req && req.url ? decodeURIComponent(req.url.split("?")[0]) : "/";

  if (urlPath === "/" || urlPath === "") {
    const indexPath = path.join(distDir, "index.html");
    const ext = path.extname(indexPath).toLowerCase();
    const type =
      ".html" === ext ? "text/html; charset=utf-8" : "application/octet-stream";
    res.setHeader("Content-Type", type);
    const stream = fs.createReadStream(indexPath);
    stream.pipe(res);
    return;
  }

  const filePath = path.join(distDir, urlPath.replace(/^\/+/, ""));

  fs.stat(filePath, (err) => {
    if (err) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const map = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg",
    };
    const type = map[ext] || "application/octet-stream";
    res.setHeader("Content-Type", type);
    const stream = fs.createReadStream(filePath);
    stream.on("error", () => {
      res.statusCode = 500;
      res.end("Server error");
    });
    stream.pipe(res);
  });
};

const server = http.createServer((req, res) => {
  serve(res);
});

server.listen(PORT, () => {
  startPolling();
});
