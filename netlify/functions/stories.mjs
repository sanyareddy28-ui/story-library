import { getStore } from "@netlify/blobs";

export const config = { path: ["/api/stories", "/api/stories/*"] };

const TYPES = {
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const IMAGES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_BYTES = 4 * 1024 * 1024; // story file
const MAX_COVER = 1.5 * 1024 * 1024; // cover photo

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const isAdmin = (req) => {
  const pass = process.env.ADMIN_PASSWORD;
  return Boolean(pass) && req.headers.get("x-admin-password") === pass;
};

export default async (req) => {
  const store = getStore("stories");
  const covers = getStore("covers");
  const url = new URL(req.url);
  const parts = url.pathname.split("/"); // ["", "api", "stories", id, "cover"]
  const id = parts[3];
  const isCover = parts[4] === "cover";

  // Check password (used by the admin login screen)
  if (req.method === "GET" && url.searchParams.has("auth")) {
    return isAdmin(req) ? json({ ok: true }) : json({ error: "Wrong password" }, 401);
  }

  // List all stories
  if (req.method === "GET" && !id) {
    const { blobs } = await store.list();
    const items = await Promise.all(
      blobs.map(async (b) => {
        const m = await store.getMetadata(b.key);
        return m ? { id: b.key, ...m.metadata } : null;
      })
    );
    return json(items.filter(Boolean).sort((a, b) => b.created - a.created));
  }

  // Cover photo
  if (req.method === "GET" && id && isCover) {
    const c = await covers.getWithMetadata(id, { type: "arrayBuffer" });
    if (!c) return new Response("No cover", { status: 404 });
    return new Response(c.data, {
      headers: {
        "Content-Type": c.metadata.type,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "public, max-age=86400",
      },
    });
  }

  // Read or download one story file
  if (req.method === "GET" && id) {
    const found = await store.getWithMetadata(id, { type: "arrayBuffer" });
    if (!found) return json({ error: "Story not found" }, 404);
    const m = found.metadata;
    const mode = url.searchParams.has("download") ? "attachment" : "inline";
    return new Response(found.data, {
      headers: {
        "Content-Type": TYPES[m.ext] || "application/octet-stream",
        "Content-Disposition": `${mode}; filename*=UTF-8''${encodeURIComponent(m.filename)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "public, max-age=300",
      },
    });
  }

  // Everything below needs the admin password
  if (!isAdmin(req)) return json({ error: "Wrong password" }, 401);

  // Upload a story (with an optional cover photo)
  if (req.method === "POST") {
    const form = await req.formData();
    const file = form.get("file");
    const cover = form.get("cover");
    const title = String(form.get("title") || "").trim().slice(0, 120);
    const author = String(form.get("author") || "").trim().slice(0, 80);
    const genre = String(form.get("genre") || "").trim().slice(0, 40);
    const description = String(form.get("description") || "").trim().slice(0, 500);

    if (!file || typeof file === "string" || !title || !author)
      return json({ error: "Title, author name and a file are required." }, 400);

    const ext = file.name.split(".").pop().toLowerCase();
    if (!TYPES[ext]) return json({ error: "Allowed file types: .txt, .md, .pdf, .docx" }, 400);
    if (file.size > MAX_BYTES) return json({ error: "File is larger than 4 MB." }, 400);

    let hasCover = false;
    if (cover && typeof cover !== "string" && cover.size > 0) {
      if (!IMAGES.includes(cover.type)) return json({ error: "Cover must be a JPG, PNG, WebP or GIF image." }, 400);
      if (cover.size > MAX_COVER) return json({ error: "Cover photo is larger than 1.5 MB." }, 400);
      hasCover = true;
    }

    const newId = crypto.randomUUID();
    const now = Date.now();
    if (hasCover) await covers.set(newId, await cover.arrayBuffer(), { metadata: { type: cover.type } });
    await store.set(newId, await file.arrayBuffer(), {
      metadata: {
        title, author, genre, description, ext, hasCover,
        filename: file.name.slice(0, 100),
        size: file.size,
        created: now,
        cv: now,
      },
    });
    return json({ ok: true, id: newId }, 201);
  }

  // Set or replace the cover photo of an existing story
  if (req.method === "PUT" && id && isCover) {
    const type = (req.headers.get("content-type") || "").split(";")[0].trim();
    if (!IMAGES.includes(type)) return json({ error: "Cover must be a JPG, PNG, WebP or GIF image." }, 400);
    const buf = await req.arrayBuffer();
    if (buf.byteLength > MAX_COVER) return json({ error: "Cover photo is larger than 1.5 MB." }, 400);
    const found = await store.getWithMetadata(id, { type: "arrayBuffer" });
    if (!found) return json({ error: "Story not found" }, 404);
    await covers.set(id, buf, { metadata: { type } });
    await store.set(id, found.data, { metadata: { ...found.metadata, hasCover: true, cv: Date.now() } });
    return json({ ok: true });
  }

  // Delete a story and its cover
  if (req.method === "DELETE" && id) {
    await store.delete(id);
    await covers.delete(id);
    return json({ ok: true });
  }

  return json({ error: "Not allowed" }, 405);
};
