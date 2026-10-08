// Auditoría del camino del lead: formularios → etiqueta → cita → aviso en Slack → pipelines.
// Solo lectura. La página pide los datos por pasos (cada paso es una llamada corta)
// y hace el cruce en el navegador.
import { timingSafeEqual } from "node:crypto";

const env = (k, d) => process.env[k] || d;
const GHL_TOKEN = env("GHL_TOKEN");
const SLACK_TOKEN = env("SLACK_TOKEN");
const SLACK_CHANNEL = env("SLACK_CHANNEL", "C0AFUUR37ND");
const GHL_LOCATION = env("GHL_LOCATION", "x7nYndpXUc1dmpunATsZ");
const PASSWORD = env("DASHBOARD_PASSWORD");
const DAY = 864e5;
const FORM_NAMES = { A: "datos cita vsl founders", B: "datos cita vsl founders ig" };

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
function passOk(given) {
  if (!PASSWORD || !given) return false;
  const a = Buffer.from(String(given)), b = Buffer.from(PASSWORD);
  return a.length === b.length && timingSafeEqual(a, b);
}
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const dayStart = (k) => new Date(k + "T00:00:00-03:00").getTime();
const norm = (s) =>
  (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const ms = (v) => (typeof v === "number" ? v : Date.parse(v || 0) || 0);

async function ghl(path, params) {
  const u = new URL("https://services.leadconnectorhq.com" + path);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(u, { headers: { Authorization: `Bearer ${GHL_TOKEN}`, Version: "2021-07-28", Accept: "application/json" } });
    if (r.status === 429 && attempt < 3) {
      const ra = parseFloat(r.headers.get("retry-after") || "");
      await new Promise((res) => setTimeout(res, Math.min(Number.isFinite(ra) ? ra * 1000 : 800 * (attempt + 1), 2500)));
      continue;
    }
    if (!r.ok) throw { where: "ghl", path, code: `http_${r.status}`, detail: (await r.text()).slice(0, 300) };
    return r.json();
  }
}

/* ---------- paso "meta": formularios, pipelines y calendarios ---------- */
async function meta() {
  const [f, p, c] = await Promise.all([
    ghl("/forms/", { locationId: GHL_LOCATION, limit: 100 }),
    ghl("/opportunities/pipelines", { locationId: GHL_LOCATION }),
    ghl("/calendars/", { locationId: GHL_LOCATION }),
  ]);
  const forms = {};
  for (const x of f.forms || []) {
    const n = norm(x.name);
    if (n === FORM_NAMES.A) forms.A = { id: x.id, name: x.name };
    if (n === FORM_NAMES.B) forms.B = { id: x.id, name: x.name };
  }
  const pipelines = (p.pipelines || []).map((x) => ({ id: x.id, name: x.name, stages: (x.stages || []).map((s) => ({ id: s.id, name: s.name })) }));
  const calendars = (c.calendars || []).map((x) => ({ id: x.id, name: x.name }));
  return { forms, pipelines, calendars };
}

/* ---------- paso "form": respuestas de un formulario ---------- */
async function form(formId, from, to) {
  const out = [];
  for (let page = 1; page <= 40; page++) {
    const j = await ghl("/forms/submissions", { locationId: GHL_LOCATION, formId, startAt: from, endAt: to, limit: 100, page });
    const items = j.submissions || [];
    for (const s of items) {
      const o = s.others || {};
      const answers = [];
      for (const v of Object.values(o)) {
        if (typeof v === "string" && v.length < 300) answers.push(v);
        else if (Array.isArray(v)) v.forEach((x) => typeof x === "string" && answers.push(x));
      }
      out.push({
        cid: s.contactId || o.contactId || "",
        name: (s.name || [o.first_name, o.last_name].filter(Boolean).join(" ") || "").replace(/\s+/g, " ").trim(),
        email: (s.email || o.email || "").trim(),
        phone: o.phone || o.whatsapp || "",
        at: ms(s.createdAt || o.submissionDate),
        answers,
      });
    }
    if (items.length < 100 || !j.meta?.nextPage) break;
  }
  return { submissions: out };
}

/* ---------- paso "opps": oportunidades de una etapa ---------- */
async function opps(pipelineId, stageId, sinceMs) {
  const out = [];
  let startAfter, startAfterId;
  for (let page = 0; page < 30; page++) {
    const j = await ghl("/opportunities/search", { location_id: GHL_LOCATION, pipeline_id: pipelineId, pipeline_stage_id: stageId, limit: 100, startAfter, startAfterId });
    const items = j.opportunities || [];
    for (const o of items) {
      out.push({
        cid: o.contactId || o.contact?.id || "",
        name: o.contact?.name || o.name || "",
        email: o.contact?.email || "",
        tags: o.contact?.tags || [],
        pipelineId, stageId,
        created: ms(o.createdAt), changed: ms(o.lastStageChangeAt || o.createdAt),
        source: o.source || "",
      });
    }
    startAfter = j.meta?.startAfter; startAfterId = j.meta?.startAfterId;
    const oldest = items.length ? Math.min(...items.map((o) => ms(o.createdAt))) : 0;
    if (!items.length || !startAfterId || oldest < sinceMs) break;
  }
  return { opps: out.filter((o) => o.created >= sinceMs) };
}

/* ---------- paso "citas": citas de un calendario ---------- */
async function citas(calendarId, from, to) {
  const start = dayStart(from), end = dayStart(to) + 60 * DAY; // una cita se puede tomar para semanas después
  const j = await ghl("/calendars/events", { locationId: GHL_LOCATION, calendarId, startTime: start, endTime: end });
  const events = (j.events || []).map((e) => ({
    id: e.id, cid: e.contactId || "", title: e.title || "", calendarId,
    start: ms(e.startTime), added: ms(e.dateAdded || e.createdAt), status: e.appointmentStatus || e.status || "",
  }));
  return { events };
}

/* ---------- paso "slack": avisos del canal ---------- */
async function slack(from, to) {
  if (!SLACK_TOKEN) throw { where: "slack", code: "no_token" };
  const out = [];
  let cursor = "";
  for (let page = 0; page < 20; page++) {
    const u = new URL("https://slack.com/api/conversations.history");
    u.searchParams.set("channel", SLACK_CHANNEL);
    u.searchParams.set("oldest", String(dayStart(from) / 1000));
    u.searchParams.set("latest", String((dayStart(to) + 2 * DAY) / 1000));
    u.searchParams.set("limit", "200");
    if (cursor) u.searchParams.set("cursor", cursor);
    const r = await fetch(u, { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } });
    const j = await r.json();
    if (!j.ok) throw { where: "slack", code: j.error };
    for (const m of j.messages || []) {
      let t = m.text || "";
      for (const b of m.blocks || []) if (b.text?.text) t += "\n" + b.text.text;
      const mt = /T[ií]tulo:?\*?:?\s*([^\n]+)/i.exec(t);
      if (mt) out.push({ title: mt[1].replace(/\*/g, "").trim(), at: Math.round(parseFloat(m.ts) * 1000) });
    }
    cursor = j.response_metadata?.next_cursor || "";
    if (!j.has_more || !cursor) break;
  }
  return { messages: out };
}

export default async (req) => {
  if (!GHL_TOKEN || !PASSWORD) return json(500, { message: "Faltan variables de entorno en Netlify (GHL_TOKEN o DASHBOARD_PASSWORD)." });
  if (!passOk(req.headers.get("x-pass"))) return json(401, { message: "Contraseña incorrecta." });
  const u = new URL(req.url), q = (k) => u.searchParams.get(k) || "";
  const from = q("from"), to = q("to");
  try {
    switch (q("paso")) {
      case "meta": return json(200, await meta());
      case "form": if (!isDay(from) || !isDay(to)) break; return json(200, await form(q("formId"), from, to));
      case "opps": return json(200, await opps(q("pipelineId"), q("stageId"), Number(q("since")) || 0));
      case "citas": if (!isDay(from) || !isDay(to)) break; return json(200, await citas(q("calendarId"), from, to));
      case "slack": if (!isDay(from) || !isDay(to)) break; return json(200, await slack(from, to));
    }
    return json(400, { message: "Pedido inválido." });
  } catch (e) {
    const m = {
      http_401: "La llave de GoHighLevel es inválida o venció.",
      http_403: "A la llave de GoHighLevel le falta un permiso para esta consulta.",
      no_token: "Falta la variable SLACK_TOKEN en Netlify.",
      not_in_channel: "La app de Slack no está en #comercial-agenda.",
      invalid_auth: "El token de Slack es inválido.",
    };
    return json(502, { where: e?.where, path: e?.path, code: e?.code, detail: e?.detail, message: m[e?.code] || `Falló ${e?.where === "slack" ? "Slack" : "GoHighLevel"} (${e?.code || e?.message || "error"}).` });
  }
};

export const config = { path: "/api/auditoria" };
