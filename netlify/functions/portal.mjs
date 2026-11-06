// Portal de setteo: lee GoHighLevel (pipelines Agendas y WEBINAR, contactos y conversaciones). Solo lectura.
import { timingSafeEqual } from "node:crypto";

const env = (k, d) => process.env[k] || d;
const GHL_TOKEN = env("GHL_TOKEN");
const GHL_LOCATION = env("GHL_LOCATION", "x7nYndpXUc1dmpunATsZ");
const PASSWORD = env("DASHBOARD_PASSWORD");
const DAY = 864e5;

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
function passOk(given) {
  if (!PASSWORD || !given) return false;
  const a = Buffer.from(String(given)), b = Buffer.from(PASSWORD);
  return a.length === b.length && timingSafeEqual(a, b);
}
const norm = (s) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9@./ ]+/g, " ").replace(/\s+/g, " ").trim();
const ms = (v) => (typeof v === "number" ? v : Date.parse(v || 0) || 0);

async function ghl(path, params, version = "2021-07-28") {
  const u = new URL("https://services.leadconnectorhq.com" + path);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(u, { headers: { Authorization: `Bearer ${GHL_TOKEN}`, Version: version, Accept: "application/json" } });
    if (r.status === 429 && attempt < 3) { await new Promise((res) => setTimeout(res, 900 * (attempt + 1))); continue; }
    if (!r.ok) throw { code: `http_${r.status}`, detail: (await r.text()).slice(0, 300) };
    return r.json();
  }
}

/* ---------- pipelines ---------- */
async function meta() {
  const j = await ghl("/opportunities/pipelines", { locationId: GHL_LOCATION });
  const pipelines = (j.pipelines || [])
    .filter((p) => /agendas|webinar/.test(norm(p.name)))
    .map((p) => ({ id: p.id, name: p.name, stages: (p.stages || []).map((s) => ({ id: s.id, name: s.name })) }));
  return { pipelines, location: GHL_LOCATION };
}

/* ---------- una columna: oportunidades de una etapa ---------- */
async function col(pipelineId, stageId, days) {
  const cutoff = days > 0 ? Date.now() - days * DAY : 0;
  const out = [];
  let startAfter, startAfterId, total = 0;
  for (let page = 0; page < 10; page++) {
    const j = await ghl("/opportunities/search", { location_id: GHL_LOCATION, pipeline_id: pipelineId, pipeline_stage_id: stageId, limit: 100, startAfter, startAfterId });
    const items = j.opportunities || [];
    total = j.meta?.total ?? total;
    for (const o of items) {
      const changed = ms(o.lastStageChangeAt || o.updatedAt || o.createdAt);
      if (changed < cutoff) continue;
      out.push({
        id: o.id, cid: o.contactId || o.contact?.id || "", name: o.contact?.name || o.name || "(sin nombre)",
        email: o.contact?.email || "", phone: o.contact?.phone || "", tags: o.contact?.tags || [],
        created: ms(o.createdAt), changed, source: o.source || "",
      });
    }
    startAfter = j.meta?.startAfter; startAfterId = j.meta?.startAfterId;
    if (!items.length || !startAfterId) break;
  }
  return { opps: out, total };
}

/* ---------- ficha de un lead ---------- */
let pipeCache = null;
async function pipeNames() {
  if (pipeCache) return pipeCache;
  const j = await ghl("/opportunities/pipelines", { locationId: GHL_LOCATION });
  const p = {}, s = {};
  for (const x of j.pipelines || []) { p[x.id] = x.name; for (const st of x.stages || []) s[st.id] = st.name; }
  return (pipeCache = { p, s });
}
let fieldDefs = null; // nombres de los campos personalizados (caché por instancia)
async function customFieldNames() {
  if (fieldDefs) return fieldDefs;
  try {
    const j = await ghl(`/locations/${GHL_LOCATION}/customFields`, {});
    fieldDefs = Object.fromEntries((j.customFields || []).map((f) => [f.id, f.name]));
  } catch { fieldDefs = {}; }
  return fieldDefs;
}
const senderOf = (m) => (m.direction === "inbound" ? "lead" : m.source === "workflow" ? "automático" : m.source === "app" ? "equipo" : m.source || "otro");

// Las preguntas fijas del setteo (se buscan en los mensajes enviados).
const DATOS = [
  { k: "nicho", n: "Nicho y modelo de negocio", q: "Contame brevemente a qué te dedicás y cuál es tu proyecto?",
    chat: /a que te dedicas|cual es tu proyecto/, form: /modelo de negocio|a que te dedicas|actividad|nicho|profesion/ },
  { k: "modalidad", n: "Presencial o digital", q: "Tu servicio lo brindás de manera presencial o digital?",
    chat: /presencial o (digital|online)|(digital|online) o presencial/, form: /presencial|digital|modalidad/ },
  { k: "factura", n: "Cuánto factura", q: "Cuánto cobrás el servicio y cuánto facturás al mes aprox?",
    chat: /cuanto cobras|cuanto facturas|facturacion/, form: /factur|ingreso/ },
  { k: "codecisor", n: "Codecisor", q: "A la sesión te sumás sola/o o estas decisiones las tomás con alguien más?",
    chat: /te sumas sol[ao]|con alguien mas|decisiones las tomas/, form: /codecisor|decide/ },
  { k: "inversion", n: "Inversión", q: "Para acceder a los programas de acompañamiento de Founders se necesita una inversión mínima de 2000 USD, es un monto que podés invertir ahora si la propuesta es lo que estás buscando?",
    chat: /inversion.*(2000|2 000|2\.000|usd)|(2000|2 000|2\.000|usd).*inversion/, form: /inversion|invertir/ },
  { k: "red", n: "Usuario de red social", q: "Cuál es tu usuario de Instagram (o de la red que más uses)?",
    chat: null, form: /instagram|red social|usuario|redes/ },
];

async function lead(cid) {
  const [c, defs] = await Promise.all([ghl(`/contacts/${encodeURIComponent(cid)}`, {}), customFieldNames()]);
  const contact = c.contact || {};
  const fields = (contact.customFields || [])
    .map((f) => ({ name: defs[f.id] || f.id, value: Array.isArray(f.value) ? f.value.join(", ") : String(f.value ?? "") }))
    .filter((f) => f.value.trim() && !/^(fbc|fbp|fcblid|fbclid|user_agent|event_source_url|ip|timezone)$/i.test(f.name.trim()));
  const pick = (re) => fields.find((f) => re.test(norm(f.name)))?.value || "";
  const origen = { campaign: pick(/utm campaign/), medium: pick(/utm medium/), content: pick(/utm content/) };

  // Conversación completa: mensajes, notas y cambios de etapa.
  const cs = await ghl("/conversations/search", { locationId: GHL_LOCATION, contactId: cid, limit: 20 }, "2021-04-15");
  const raw = [];
  for (const cv of cs.conversations || []) {
    let lastMessageId;
    for (let page = 0; page < 5; page++) {
      const j = await ghl(`/conversations/${cv.id}/messages`, { limit: 100, lastMessageId }, "2021-04-15");
      const box = j.messages || {};
      raw.push(...(Array.isArray(box) ? box : box.messages || []));
      lastMessageId = box.lastMessageId;
      if (!box.nextPage || !lastMessageId) break;
    }
  }
  const timeline = raw.map((m) => {
    const a = m.activity;
    if (a && /opportunity/.test(a.type || "")) {
      return { at: ms(m.dateAdded), kind: "etapa", pipeline: a.data?.pipeline || "", from: a.data?.stage?.oldStageName || "", to: a.data?.stage?.newStageName || "", title: a.title || "", status: a.data?.status || "" };
    }
    if (m.messageType === "TYPE_INTERNAL_COMMENT") return { at: ms(m.dateAdded), kind: "nota", text: String(m.body || ""), who: m.from || "" };
    if (m.messageType?.startsWith("TYPE_ACTIVITY")) return { at: ms(m.dateAdded), kind: "actividad", text: a?.title || m.body || m.messageType };
    return { at: ms(m.dateAdded), kind: "mensaje", dir: m.direction || "", sender: senderOf(m), channel: (m.messageType || "").replace("TYPE_", ""), text: String(m.body || "") };
  }).sort((x, y) => x.at - y.at);

  // Los 6 datos: del formulario, o pregunta hecha en el chat y respuesta del lead.
  const msgs = timeline.filter((t) => t.kind === "mensaje");
  // Respuesta a una pregunta: todos los mensajes del lead desde la pregunta hasta el siguiente mensaje del equipo.
  const replyTo = (ask) => {
    const next = msgs.find((m) => m.at > ask.at && m.dir === "outbound" && m.sender !== "automático" && m !== ask && !d_sameBurst(ask, m));
    const rs = msgs.filter((m) => m.dir === "inbound" && m.at > ask.at && (!next || m.at < next.at));
    return rs.map((m) => m.text).join(" / ").slice(0, 600);
  };
  // Mensajes del equipo mandados en el mismo minuto que la pregunta cuentan como parte de la pregunta.
  const d_sameBurst = (a, b) => Math.abs(b.at - a.at) < 60e3;
  const lastAsk = (re) => [...msgs].reverse().find((m) => m.dir === "outbound" && re.test(norm(m.text)));
  const datos = DATOS.map((d) => {
    const f = fields.find((x) => d.form.test(norm(x.name)));
    const r = { k: d.k, n: d.n, pregunta: d.q, estado: "falta", valor: "", fuente: "" };
    if (d.k === "red") {
      const inMsg = msgs.find((m) => m.dir === "inbound" && /(instagram\.com\/[\w.]+|@[\w.]{3,})/i.test(m.text));
      if (f) Object.assign(r, { estado: "ok", valor: f.value, fuente: `Formulario: ${f.name}` });
      else if (inMsg) Object.assign(r, { estado: "ok", valor: inMsg.text.match(/(instagram\.com\/[\w.]+|@[\w.]{3,})/i)[0], fuente: "Chat" });
      return r;
    }
    const asked = lastAsk(d.chat);
    if (asked) {
      const reply = replyTo(asked);
      if (reply) Object.assign(r, { estado: "ok", valor: reply, fuente: "Chat (respuesta a la pregunta)" });
      else Object.assign(r, { estado: "preguntado", valor: "", fuente: "Chat: preguntado, sin respuesta" });
    }
    if (f) r.form = `${f.name}: ${f.value}`;
    if (f && r.estado !== "ok") Object.assign(r, { estado: "ok", valor: f.value, fuente: `Formulario: ${f.name}` });
    if (d.k === "inversion") {
      // ¿Vio el rango? En el form, si la pregunta mostraba el monto; en el chat, si se le mandó el mensaje de inversión.
      r.vioForm = f ? /\d/.test(f.name) : false;
      r.preguntaForm = f ? f.name : "";
      r.respuestaForm = f ? f.value : "";
      r.vioChat = !!asked;
      r.respuestaChat = asked ? replyTo(asked) : "";
      r.vio = r.vioForm || r.vioChat;
      if (!r.vio) r.estado = r.estado === "ok" ? "sinrango" : r.estado;
    }
    return r;
  });

  // Todas sus oportunidades (para ver, por ejemplo, la etapa en Agendas de un lead que vino del webinar).
  let oportunidades = [];
  try {
    const [os, pm] = await Promise.all([ghl("/opportunities/search", { location_id: GHL_LOCATION, contact_id: cid, limit: 20 }), pipeNames()]);
    oportunidades = (os.opportunities || []).map((o) => ({ pipeline: pm.p[o.pipelineId] || o.pipelineId, etapa: pm.s[o.pipelineStageId] || "", cambio: ms(o.lastStageChangeAt || o.updatedAt), estado: o.status || "" }));
  } catch {}
  return {
    origen, oportunidades,
    contacto: { id: contact.id, nombre: [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.contactName || "", email: contact.email || "", telefono: contact.phone || "", etiquetas: contact.tags || [], alta: ms(contact.dateAdded), fuente: contact.source || "" },
    campos: fields, datos, historial: timeline,
  };
}


/* ---------- Pauta: oportunidades que entraron en un período ---------- */
async function entradas(pipelineId, fromMs, toMs) {
  const pm = await pipeNames();
  const out = [];
  let startAfter, startAfterId;
  for (let page = 0; page < 40; page++) {
    const j = await ghl("/opportunities/search", { location_id: GHL_LOCATION, pipeline_id: pipelineId, limit: 100, startAfter, startAfterId });
    const items = j.opportunities || [];
    for (const o of items) {
      const created = ms(o.createdAt);
      if (created < fromMs || created >= toMs) continue;
      out.push({ cid: o.contactId || o.contact?.id || "", name: o.contact?.name || o.name || "", tags: o.contact?.tags || [],
        source: o.source || "", stage: pm.s[o.pipelineStageId] || "", created, changed: ms(o.lastStageChangeAt || o.createdAt) });
    }
    startAfter = j.meta?.startAfter; startAfterId = j.meta?.startAfterId;
    const oldest = items.length ? Math.min(...items.map((o) => ms(o.createdAt))) : 0;
    if (!items.length || !startAfterId || oldest < fromMs) break;
  }
  return { opps: out };
}

/* ---------- Pauta: respuestas del formulario de varios contactos ---------- */
async function respuestas(ids) {
  const defs = await customFieldNames();
  const out = {};
  for (let i = 0; i < ids.length; i += 8) {
    await Promise.all(ids.slice(i, i + 8).map(async (id) => {
      try {
        const c = (await ghl(`/contacts/${encodeURIComponent(id)}`, {})).contact || {};
        const f = (c.customFields || []).map((x) => ({ n: norm(defs[x.id] || ""), v: Array.isArray(x.value) ? x.value.join(", ") : String(x.value ?? "") })).filter((x) => x.v.trim());
        const pick = (re) => f.find((x) => re.test(x.n))?.v || "";
        out[id] = {
          tags: c.tags || [],
          nicho: pick(/modelo de negocio/) || pick(/a que te dedicas/) || pick(/actividad|nicho/),
          inversion: pick(/inversion|invertir/),
          vip: pick(/webinar vip/),
          campaign: pick(/utm campaign/), medium: pick(/utm medium/), content: pick(/utm content/),
        };
      } catch { out[id] = null; }
    }));
  }
  return { contactos: out };
}

/* ---------- Pauta: la plata de cada lead (formulario + chat) ---------- */
const INV_CHAT = /inversion.*(2000|2 000|2\.000|usd)|(2000|2 000|2\.000|usd).*inversion/;
async function mensajesDe(cid) {
  const cs = await ghl("/conversations/search", { locationId: GHL_LOCATION, contactId: cid, limit: 20 }, "2021-04-15");
  const raw = [];
  for (const cv of cs.conversations || []) {
    let lastMessageId;
    for (let page = 0; page < 5; page++) {
      const j = await ghl(`/conversations/${cv.id}/messages`, { limit: 100, lastMessageId }, "2021-04-15");
      const box = j.messages || {};
      raw.push(...(Array.isArray(box) ? box : box.messages || []));
      lastMessageId = box.lastMessageId;
      if (!box.nextPage || !lastMessageId) break;
    }
  }
  return raw.filter((m) => !m.activity && m.messageType !== "TYPE_INTERNAL_COMMENT")
    .map((m) => ({ at: ms(m.dateAdded), dir: m.direction || "", auto: m.source === "workflow", text: String(m.body || "") }))
    .sort((a, b) => a.at - b.at);
}
async function plata(ids) {
  const defs = await customFieldNames();
  const out = {};
  for (let i = 0; i < ids.length; i += 4) {
    await Promise.all(ids.slice(i, i + 4).map(async (cid) => {
      try {
        const [c, msgs] = await Promise.all([ghl(`/contacts/${encodeURIComponent(cid)}`, {}), mensajesDe(cid)]);
        const f = ((c.contact || {}).customFields || []).map((x) => ({ n: defs[x.id] || "", v: String(x.value ?? "") })).find((x) => /inversion|invertir/.test(norm(x.n)) && x.v.trim());
        // Última vez que el equipo le dijo el monto en el chat, y lo que respondió hasta el siguiente mensaje del equipo.
        const ask = [...msgs].reverse().find((m) => m.dir === "outbound" && INV_CHAT.test(norm(m.text)));
        let resp = "";
        if (ask) {
          const next = msgs.find((m) => m.at > ask.at + 60e3 && m.dir === "outbound" && !m.auto);
          resp = msgs.filter((m) => m.dir === "inbound" && m.at > ask.at && (!next || m.at < next.at)).map((m) => m.text).join(" / ").slice(0, 400);
        }
        out[cid] = { vioForm: !!(f && /\d/.test(f.n)), respForm: f ? f.v : "", vioChat: !!ask, respChat: resp };
      } catch { out[cid] = null; }
    }));
  }
  return { plata: out };
}

export default async (req) => {
  if (!GHL_TOKEN || !PASSWORD) return json(500, { message: "Faltan variables de entorno en Netlify (GHL_TOKEN o DASHBOARD_PASSWORD)." });
  if (!passOk(req.headers.get("x-pass"))) return json(401, { message: "Contraseña incorrecta." });
  const u = new URL(req.url), q = (k) => u.searchParams.get(k) || "";
  try {
    switch (q("paso")) {
      case "meta": return json(200, await meta());
      case "col": return json(200, await col(q("pipelineId"), q("stageId"), Number(q("days")) || 0));
      case "lead": return json(200, await lead(q("cid")));
      case "entradas": return json(200, await entradas(q("pipelineId"), Number(q("from")), Number(q("to"))));
      case "plata": return json(200, await plata(q("ids").split(",").filter(Boolean).slice(0, 12)));
      case "respuestas": return json(200, await respuestas(q("ids").split(",").filter(Boolean).slice(0, 50)));
    }
    return json(400, { message: "Pedido inválido." });
  } catch (e) {
    const m = { http_401: "La llave de GoHighLevel es inválida o venció.", http_403: "A la llave de GoHighLevel le falta un permiso para esta consulta.", http_404: "No se encontró en GoHighLevel." };
    return json(502, { code: e?.code, detail: e?.detail, message: m[e?.code] || `Falló GoHighLevel (${e?.code || e?.message || "error"}).` });
  }
};

export const config = { path: "/api/portal" };
