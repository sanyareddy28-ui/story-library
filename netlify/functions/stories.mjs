import { getStore } from "@netlify/blobs";

export const config = { path: ["/api/stories", "/api/stories/*"] };

const TYPES = {
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const MAX_BYTES = 4 * 1024 * 1024; // Netlify functions accept ~6 MB requests

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
  const url = new URL(req.url);
  const id = url.pathname.split("/")[3]; // /api/stories/:id

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

  // Upload a story
  if (req.method === "POST") {
    const form = await req.formData();
    const file = form.get("file");
    const title = String(form.get("title") || "").trim().slice(0, 120);
    const author = String(form.get("author") || "").trim().slice(0, 80);
    const genre = String(form.get("genre") || "").trim().slice(0, 40);
    const description = String(form.get("description") || "").trim().slice(0, 500);

    if (!file || typeof file === "string" || !title || !author)
      return json({ error: "Title, author name and a file are required." }, 400);

    const ext = file.name.split(".").pop().toLowerCase();
    if (!TYPES[ext]) return json({ error: "Allowed file types: .txt, .md, .pdf, .docx" }, 400);
    if (file.size > MAX_BYTES) return json({ error: "File is larger than 4 MB." }, 400);

    const newId = crypto.randomUUID();
    await store.set(newId, await file.arrayBuffer(), {
      metadata: {
        title, author, genre, description, ext,
        filename: file.name.slice(0, 100),
        size: file.size,
        created: Date.now(),
      },
    });
    return json({ ok: true, id: newId }, 201);
  }

  // Delete a story
  if (req.method === "DELETE" && id) {
    await store.delete(id);
    return json({ ok: true });
  }

  return json({ error: "Not allowed" }, 405);
};
