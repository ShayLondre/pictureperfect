/* Picture Perfect — front end */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, body) {
  const opts = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const r = await fetch(path, opts);
  let data = {};
  try { data = await r.json(); } catch (e) { /* ignore */ }
  if (!r.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

function toast(msg, ms = 3200) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}
const fail = (e) => toast(e.message || String(e), 5000);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function fmtDay(iso) {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const wd = DAYS[new Date(y, m - 1, d).getDay()];
  return `${wd} ${d} ${MONTHS[m - 1]} ${y}`;
}
function fmtWhen(iso) {
  return `${fmtDay(iso)}, ${iso.slice(11, 16)}`;
}
function fmtSize(b) {
  if (!b) return "";
  if (b > 1e9) return (b / 1e9).toFixed(1) + " GB";
  if (b > 1e6) return (b / 1e6).toFixed(1) + " MB";
  return Math.round(b / 1e3) + " KB";
}
const n = (x) => (x || 0).toLocaleString();
const folderOf = (p) => p.split("/").slice(0, -1).join(" › ");
const fileOf = (p) => p.split("/").pop();
const plural = (x, one, many) => `${n(x)} ${x === 1 ? one : (many || one + "s")}`;
const DATE_SOURCE = {
  exif: "", sidecar: "from Google Takeout info", copied: "copied from a duplicate",
  filename: "from the file name — time missing", filename_time: "from the file name",
  file: "no date found — needs one", manual: "set by you", manual_date: "date only, time unknown",
};

/* ------------------------------------------------------------------ state */
const S = { tab: "browse", state: null, lastJobFinished: true };

async function refreshState() {
  const st = await api("/api/state");
  S.state = st;
  const hasLib = !!st.library;
  $("#tabs").hidden = !hasLib;
  $("#top-actions").hidden = !hasLib;
  if (hasLib) {
    $("#btn-lib").textContent = st.library.split("/").filter(Boolean).slice(-2).join(" / ");
    $("#btn-lib").title = st.library + " — click to change";
    const s = st.stats || {};
    $("#b-dupes").textContent = s.dup_groups ? n(s.dup_groups) : "";
    $("#b-loc").textContent = s.no_location ? n(s.no_location) : "";
    $("#b-inbox").textContent = s.inbox ? n(s.inbox) : "";
    // Drive Preview only matters when photos are waiting there (no date, not renamed, or found by a rescan)
    $("#tabs [data-tab=inbox]").hidden = !s.inbox && S.tab !== "inbox";
  }
  renderJob(st.job);
  return st;
}

function renderJob(job) {
  const box = $("#job");
  if (!job) { box.hidden = true; return; }
  box.hidden = false;
  box.classList.toggle("done", job.finished);
  box.classList.toggle("error", !!job.error);
  $("#job-name").textContent = job.finished ? (job.error ? "Something went wrong:" : "Done.") : job.name + " —";
  $("#job-close").hidden = !job.finished;
  const bar = $(".bar", box);
  if (!job.finished) {
    $("#job-phase").textContent = job.phase + (job.total ? ` · ${n(job.done)} of ${n(job.total)}` : "");
    $("#job-msg").textContent = job.message || "";
    bar.classList.toggle("indeterminate", !job.total);
    $("#job-bar").style.width = job.total ? (100 * job.done / job.total).toFixed(1) + "%" : "";
  } else {
    $("#job-phase").textContent = job.error || summarize(job);
    $("#job-msg").textContent = "";
  }
}

function summarize(job) {
  const r = job.result || {};
  const bits = [];
  if (r.import_check) bits.push(`Checked ${plural(r.total, "photo")}: ${n(r.new)} new, ${n(r.exact + r.repeat + r.similar)} you may already have`);
  if (r.copied !== undefined) bits.push(`${plural(r.copied, "photo")} added`, `${n(r.skipped)} left out`);
  if (r.total !== undefined) bits.push(`${plural(r.total, "photo")} in your library`);
  if (r.new_or_changed) bits.push(`${n(r.new_or_changed)} new or changed`);
  if (r.inbox_new) bits.push(`${plural(r.inbox_new, "new photo")} ready to review`);
  if (r.moved !== undefined && r.written !== undefined) {
    bits.push(`${plural(r.moved, "file")} renamed or moved`);
    if (r.synced) bits.push(`${n(r.synced)} dates, places and tags saved into photos`);
    if (r.failed_count) bits.push(`${n(r.failed_count)} couldn't be changed (e.g. ${r.failed[0].name}: ${r.failed[0].error})`);
  } else if (r.moved !== undefined) bits.push(`${plural(r.moved, "copy", "copies")} set aside`);
  if (r.restored !== undefined) bits.push(`${plural(r.restored, "file")} put back`);
  if (r.highlights_added) bits.push(`${plural(r.highlights_added, "photo")} added to highlights`);
  if (r.highlights_removed) bits.push(`${plural(r.highlights_removed, "photo")} taken out of highlights`);
  if (r.faces !== undefined) bits.push(`${plural(r.faces, "face")} found so far — see the People tab`);
  if (r.geotagged !== undefined) bits.push(`Location saved into ${plural(r.geotagged, "photo")}` + (r.failed_count ? ` · ${n(r.failed_count)} couldn't be changed` : ""));
  if (r.map_region) bits.push(`${r.map_region} map downloaded (${fmtSize(r.bytes)}) — it works offline now`);
  if (r.tidied !== undefined) bits.push(`${plural(r.tidied, "photo")} tidied up`);
  if (r.picked !== undefined) {
    bits.push(`${n(r.picked)} kept`, `${n(r.trashed)} moved to the Trash`);
    if (r.set_aside) bits.push(`${n(r.set_aside)} couldn't go to the Trash and are in _Set aside`);
  }
  if (r.places_note) bits.push(r.places_note);
  return bits.join(" · ");
}

async function poll() {
  let running = false;
  try {
    const st = await refreshState();
    const job = st.job;
    running = !!(job && !job.finished);
    if (job && job.finished && job.id !== S.handledJob) {
      S.handledJob = job.id;          // each finished job is handled exactly once
      await loadFilters();
      const res = job.result || {};
      loadAlbums();
      if (job.error && (IM.state === "checking" || IM.state === "running")) importScreen(IM.state === "running" ? "pick" : "start");
      if (res.import_check && !job.error) showImport();
      else if (res.imported_ids !== undefined && !job.error) showImportReview(res);
      else if ((res.geotagged !== undefined || res.map_region) && !job.error) {
        if (res.map_region) plReloadMap();
        if (res.geotagged !== undefined) { PL.sel.clear(); }
        if (S.tab === "locations") loadPlaces();
      }
      else if (res.tidied !== undefined && !job.error) { tuReset(); if (S.tab === "organize") loadTidy(); loadAlbums(); }
      else if (res.inbox_new && !job.error) showTab("inbox");   // new photos found on the drive
      else if (S.tab === "inbox" && R.mode !== "inbox") showTab("inbox", true);
      else showTab(S.tab, true);
    } else if (!job && (IM.state === "checking" || IM.state === "running")) {
      // the job finished and was dismissed before we saw it: pick up where it left off
      if (IM.state === "checking") showImport(); else importScreen("start");
    }
  } catch (e) { /* try again shortly */ }
  setTimeout(poll, running ? 1000 : 4000);
}

/* ------------------------------------------------------------------ setup */
function showSetup(st) {
  $$(".view").forEach(v => (v.hidden = true));
  $("#v-setup").hidden = false;
  $("#setup-error").hidden = !st.error;
  $("#setup-error").textContent = st.error || "";
  $("#exiftool-warn").hidden = st.exiftool;
  $("#btn-pick").hidden = !st.mac;
  $("#recent").innerHTML = (st.recent || []).map(p => `<button data-p="${esc(p)}">${esc(p)}</button>`).join("");
}

async function openLibrary(path) {
  try {
    await api("/api/library", { path });
    // start fresh: nothing chosen in the old folder (selections, imports, edits) carries over
    location.reload();
  } catch (e) { fail(e); }
}

async function pickFolder(prompt) {
  const r = await api("/api/pick-folder", { prompt });
  return r.path;
}

$("#btn-pick").onclick = async () => { const p = await pickFolder("Choose your photo folder"); if (p) openLibrary(p); };
$("#path-form").onsubmit = (e) => { e.preventDefault(); const p = $("#path-input").value.trim(); if (p) openLibrary(p); };
$("#recent").onclick = (e) => { const b = e.target.closest("button"); if (b) openLibrary(b.dataset.p); };
$("#btn-lib").onclick = () => { S.state.error = null; showSetup(S.state); $("#tabs").hidden = true; };
$("#btn-scan").onclick = () => api("/api/scan", {}).then(() => { S.lastJobFinished = false; refreshState(); }).catch(fail);
function starsHtml(value, attr) {
  return [1, 2, 3, 4, 5].map(k => `<button class="${value >= k ? "on" : ""}" ${attr}="${k}" aria-label="${k} star${k > 1 ? "s" : ""}">★</button>`).join("");
}

/* ------------------------------------------------------------------ pick the best (after import) */
const PK = { items: [], keep: {}, rating: {}, label: "", cull: [], ci: 0, groups: [], sort: "time" };

function pickOrder() {
  const list = PK.items.slice();
  if (PK.sort === "fav") list.sort((a, b) => (b.appeal ?? -1) - (a.appeal ?? -1));
  return list;
}

async function loadPickGroups() {
  $("#pk2-back").hidden = true; $("#pk2-set").hidden = true; $("#pk2-done").hidden = true;
  $("#pk2-groups-wrap").hidden = false;
  $("#pk2-title").textContent = "Prune";
  $("#pk2-sub").textContent = "Choose a folder to go through. I'll suggest which photos to delete, and learn what you like as you go.";
  try { PK.groups = await api("/api/groups"); } catch (e) { return fail(e); }
  renderPickGroups();
}
function renderPickGroups() {
  const q = $("#pk2-q").value.trim().toLowerCase();
  const list = PK.groups.filter(g => !q || g.name.toLowerCase().includes(q) || g.start.startsWith(q) || (g.place || "").toLowerCase().includes(q)).slice(0, 150);
  $("#pk2-groups").innerHTML = list.length ? list.map(g => `
    <button class="gp" data-key="${esc(g.key)}">
      <span class="th">${g.thumbs.map(id => `<img loading="lazy" src="/thumb/${id}" alt="">`).join("")}</span>
      <span><b>${esc(g.start.slice(0, 7).replace("-", "."))} ${esc(g.name)}</b>
        <span class="m">${fmtRange(g.start, g.end)} · ${plural(g.count, "item")}</span></span>
    </button>`).join("") : `<p class="muted small">No folders yet. Name some photos and Organize them first.</p>`;
}
$("#pk2-q").addEventListener("input", renderPickGroups);
$("#pk2-groups").onclick = async (e) => {
  const b = e.target.closest(".gp"); if (!b) return;
  const g = PK.groups.find(x => x.key === b.dataset.key);
  try { openPickSet(await api("/api/group-ids", { key: g.key }), `${g.start.slice(0, 7).replace("-", ".")} ${g.name}`); } catch (err) { fail(err); }
};
$("#pk2-back").onclick = () => loadPickGroups();

async function openPickSet(ids, label) {
  showTab("pick", true);
  PK.label = label;
  $("#pk2-groups-wrap").hidden = true; $("#pk2-back").hidden = false;
  $("#pk2-title").textContent = "Prune — " + label;
  $("#pk2-sub").textContent = "Looking at your photos…";
  let r;
  try { r = await api("/api/pick", { ids }); } catch (e) { return fail(e); }
  PK.items = r.items; PK.keep = {}; PK.rating = {};
  PK.items.forEach(i => { PK.keep[i.i] = i.keep !== false; PK.rating[i.i] = i.rating || 0; });
  const t = r.taste || {};
  $("#pk2-taste").textContent = t.learning
    ? `Suggestions include what I've learned from your last ${n(t.choices)} choices.`
    : t.choices ? `Learning your taste — ${n(t.choices)} of ${t.needed} choices so far.` : "Your keep and skip choices teach it what you like.";
  $("#pk2-sub").textContent = `${plural(PK.items.length, "item")}. Nothing moves until you press the button.`;
  $("#pk2-set").hidden = false; $("#pk2-done").hidden = false;
  renderPicks();
}

function renderPicks() {
  renderPickStats();
  $("#pk2-list").innerHTML = pickOrder().map(pickTile).join("");
}
// one click changes one photo: redraw just that tile and the counts, not the whole list
function updatePick(i) {
  const el = $(`#pk2-list .pk[data-i="${i}"]`);
  const it = PK.items.find(x => x.i === i);
  if (el && it) el.outerHTML = pickTile(it);
  renderPickStats();
}
function renderPickStats() {
  const kept = PK.items.filter(i => PK.keep[i.i]).length;
  const skip = PK.items.length - kept;
  const stat = (num, label) => `<div class="stat"><div class="n">${n(num)}</div><div class="l">${label}</div></div>`;
  $("#pk2-stats").innerHTML = stat(kept, "to keep") + stat(skip, "to delete") +
    stat(PK.items.filter(i => PK.rating[i.i]).length, "with stars");
  $("#pk2-done").textContent = skip ? `Keep ${n(kept)}, delete ${n(skip)}` : `Keep all ${n(kept)}`;
}

function pickTile(it) {
  const keep = PK.keep[it.i];
  const b = it.burst;
  const why = !keep ? (it.why || "Marked by you") : (it.rule_skip && it.p != null ? "Kept — you usually keep photos like this" : "");
  return `<div class="pk ${keep ? "keep" : "skip"}" data-i="${it.i}">
    <div class="im" data-cull><img loading="lazy" src="/thumb/${it.i}" alt="">
      <span class="badge2" data-toggle>${keep ? "Keep" : "Delete"}</span>
      ${b ? `<span class="burst ${b.best ? "best" : ""}">${b.best ? "Sharpest of " + b.size : "Same moment · " + b.size}</span>` : ""}
      ${it.kind === "video" ? `<span class="vid">▶ Video</span>` : it.raw ? `<span class="vid">RAW+JPEG</span>` : ""}
      ${it.favorite && keep ? `<span class="fav">★ Likely favorite</span>` : ""}
    </div>
    <div class="cap"><b>${esc(it.name)}</b>
      ${why ? `<div class="why ${/usually/.test(why) ? "learned" : ""}">${esc(why)}</div>` : ""}
      ${!why && it.favorite && it.appeal_why && it.appeal_why.length ? `<div class="fav-why">${esc(it.appeal_why.join(" · "))}</div>` : ""}
      <span class="stars">${starsHtml(PK.rating[it.i] || 0, "data-star")}</span>
    </div>
  </div>`;
}

$("#pk2-list").onclick = (e) => {
  const card = e.target.closest(".pk"); if (!card) return;
  const i = +card.dataset.i;
  const st = e.target.closest("[data-star]");
  if (st) { const v = +st.dataset.star; PK.rating[i] = PK.rating[i] === v ? 0 : v; if (PK.rating[i]) PK.keep[i] = true; return updatePick(i); }
  if (e.target.closest("[data-toggle]")) { PK.keep[i] = !PK.keep[i]; return updatePick(i); }
  if (e.target.closest("[data-cull]")) openCull(i);
};
$("#pk2-keep-all").onclick = () => { PK.items.forEach(i => (PK.keep[i.i] = true)); renderPicks(); };
$("#pk2-reset").onclick = () => { PK.items.forEach(i => (PK.keep[i.i] = i.keep !== false)); renderPicks(); };
$("#pk2-done").onclick = () => {
  const keep = PK.items.filter(i => PK.keep[i.i]).map(i => i.i);
  const skip = PK.items.filter(i => !PK.keep[i.i]).map(i => i.i);
  if (skip.length && !confirm(`Move ${plural(skip.length, "photo")} to the Trash? You can drag them back out of the Trash until you empty it.`)) return;
  const ratings = {};
  PK.items.forEach(i => { if ((PK.rating[i.i] || 0) !== (i.rating || 0)) ratings[i.i] = PK.rating[i.i] || 0; });
  api("/api/pick/commit", { keep, skip, ratings }).then(() => {
    S.lastJobFinished = false; refreshState();
    loadPickGroups();
  }).catch(fail);
};

/* big view with keyboard: K keep, X skip, 1-5 stars */
$("#pk2-sort").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return;
  PK.sort = b.dataset.v;
  $$("#pk2-sort button").forEach(x => x.classList.toggle("on", x === b));
  renderPicks();
};

function openCull(i) {
  PK.cull = pickOrder();
  PK.ci = Math.max(0, PK.cull.findIndex(x => x.i === i));
  $("#cull").hidden = false;
  renderCull();
}
function renderCull() {
  const it = PK.cull[PK.ci]; if (!it) return;
  const keep = PK.keep[it.i];
  $("#cull").classList.toggle("is-keep", keep);
  $("#cull").classList.toggle("is-skip", !keep);
  $("#cu-stage").innerHTML = it.kind === "video"
    ? `<video src="/media/${it.i}" controls autoplay playsinline></video>`
    : `<img src="/media/${it.i}" alt="" onerror="this.src='/thumb/${it.i}'">`;
  $("#cu-name").textContent = it.name + (it.taken ? " · " + fmtWhen(it.taken) : "");
  $("#cu-why").textContent = !keep ? (it.why || "Marked for deleting by you") :
    it.favorite && it.appeal_why && it.appeal_why.length ? "★ Likely favorite — " + it.appeal_why.join(" · ") : (it.burst ? (it.burst.best ? `Sharpest of ${it.burst.size} shots of this moment` : `One of ${it.burst.size} shots of this moment`) : "");
  $("#cu-stars").innerHTML = starsHtml(PK.rating[it.i] || 0, "data-cstar");
  $("#cu-keep").className = keep ? "primary" : "ghost";
  $("#cu-skip").className = keep ? "ghost" : "primary";
  $("#cu-count").textContent = `${PK.ci + 1} of ${n(PK.cull.length)}`;
}
function cullSet(keep, advance) {
  const it = PK.cull[PK.ci]; if (!it) return;
  PK.keep[it.i] = keep;
  if (!keep) PK.rating[it.i] = 0;
  if (advance && PK.ci < PK.cull.length - 1) PK.ci++;
  renderCull();
}
function closeCull() { $("#cull").hidden = true; $("#cu-stage").innerHTML = ""; renderPicks(); }
$("#cu-keep").onclick = () => cullSet(true, true);
$("#cu-skip").onclick = () => cullSet(false, true);
$("#cu-prev").onclick = () => { if (PK.ci > 0) { PK.ci--; renderCull(); } };
$("#cu-next").onclick = () => { if (PK.ci < PK.cull.length - 1) { PK.ci++; renderCull(); } };
$("#cu-close").onclick = closeCull;
$("#cu-stars").onclick = (e) => {
  const b = e.target.closest("[data-cstar]"); if (!b) return;
  const it = PK.cull[PK.ci]; const v = +b.dataset.cstar;
  PK.rating[it.i] = PK.rating[it.i] === v ? 0 : v; if (PK.rating[it.i]) PK.keep[it.i] = true;
  renderCull();
};
document.addEventListener("keydown", (e) => {
  if ($("#cull").hidden) return;
  const k = e.key.toLowerCase();
  if (k === "escape") return closeCull();
  if (k === "arrowright") return $("#cu-next").click();
  if (k === "arrowleft") return $("#cu-prev").click();
  if (k === "k" || k === "p") return cullSet(true, true);
  if (k === "d" || k === "x" || k === "delete" || k === "backspace") { e.preventDefault(); return cullSet(false, true); }
  if ("012345".includes(k)) {
    const it = PK.cull[PK.ci]; PK.rating[it.i] = +k; if (+k) PK.keep[it.i] = true;
    if (+k && PK.ci < PK.cull.length - 1) PK.ci++;
    renderCull();
  }
}, true);

/* ------------------------------------------------------------------ import: rename before importing */
const IM = { items: [], sel: new Set(), filter: "", view: "list", shown: 120, settings: {}, albums: [], source: "", state: "start",
             base: null, over: {}, times: {}, tags: {}, stars: {}, focus: null, q: "", editing: false,
             inuse: {}, asking: new Set(), num: {}, places: {}, bplace: null };
const MATCH_LABEL = { exact: "Already in your library", similar: "Looks like one you have", repeat: "Repeated in this folder" };
const EXT = (n) => { const e = n.slice(n.lastIndexOf(".")).toLowerCase(); return e === ".jpeg" ? ".jpg" : e; };

function setStep(n) {
  $$("#im-steps .st").forEach(st => {
    const k = +st.dataset.s;
    st.classList.toggle("on", k === n);
    st.classList.toggle("done", k < n);
  });
}

function importScreen(state) {
  IM.state = state;
  $("#im-start").hidden = !(state === "start" || state === "checking");
  $("#im-main").hidden = state !== "pick" && state !== "running";
  $("#im-bottom").hidden = state !== "pick" && state !== "running";
  $("#im-review").hidden = state !== "review";
  $("#btn-import").hidden = state === "checking";
  $("#im-start-note").textContent = state === "checking" ? "Looking at your photos and comparing them with your library…" : "";
  $("#im-go").disabled = state === "running";
  $("#im-cancel").hidden = state === "running";
  setStep({ start: 1, checking: 1, pick: 2, running: 3, review: 4 }[state] || 1);
}

async function openImportTab() {
  if (IM.state === "running" || IM.state === "review" || IM.state === "checking") return importScreen(IM.state);
  let r;
  try { r = await api("/api/import/pending"); } catch (e) { r = {}; }
  if (r.items) return showImport(r);
  importScreen("start");
}

async function showImport(r) {
  if (!r) { try { r = await api("/api/import/pending"); } catch (e) { return fail(e); } }
  if (!r.items) return importScreen("start");
  IM.items = r.items.filter(i => i.raw_of === null || i.raw_of === undefined);
  IM.settings = r.settings || {};
  IM.albums = r.albums || [];
  IM.source = r.source;
  IM.token = r.token || Date.now().toString(16);
  IM.shown = 120;
  IM.sel = new Set(IM.items.filter(i => i.status === "new").map(i => i.i));
  IM.over = {}; IM.times = {}; IM.tags = {}; IM.stars = {}; IM.q = ""; IM.editing = false;
  IM.inuse = {}; IM.asking = new Set();   // names on the drive may have changed since the last import
  IM.places = {}; IM.bplace = null;
  IM.focus = (IM.items.find(i => i.status === "new") || IM.items[0] || {}).i;
  $("#im-search").value = ""; $("#im-search").hidden = true;
  $("#im-adv").hidden = true;
  $("#im-folders").value = IM.settings.folders || "month_group";
  $("#im-event").value = "";
  $("#im-format").value = IM.settings.time === "0" ? "0" : "1";
  // only photos with a real time move with the Date & Time box (date-only ones keep their day, as on import)
  IM.dateTouched = false;
  imSetBase();
  $("#im-tags").value = "";
  IM.album = null; IM.albumOf = {};
  $("#pp-albums").innerHTML = [...new Set(IM.albums.map(a => a.name))].map(n => `<option value="${esc(n)}">`).join("");
  $("#op-rename").checked = true;
  $("#op-dupes").checked = true;
  $("#op-delete").checked = false;
  $("#op-delete-note").hidden = true;
  $("#op-delete").closest(".opt").hidden = !S.state.mac;
  $$("#im-filter button").forEach(b => b.classList.toggle("on", b.dataset.k === ""));
  IM.filter = "";
  showTab("import", true);
  importScreen("pick");
  renderImport();
}

function imBatchTags() {
  return $("#im-tags").value.split(",").map(x => x.trim()).filter(Boolean);
}
function imShift() {
  if (!IM.base) return 0;
  const d = $("#im-date").value, t = $("#im-time").value || IM.base.slice(11, 16);
  if (!d) return 0;
  const v = d + "T" + t;
  if (v === IM.base) return 0;
  return Math.round((isoToMs(v + ":00") - isoToMs(IM.base + ":00")) / 1000);
}
function shiftIso(iso, sec) {
  if (!sec) return iso;
  const d = new Date(isoToMs(iso) + sec * 1000);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
function albumChosen() { return IM.album || null; }
function imAlbum(it) {   // the album this photo goes into — unless it was given another name
  const al = IM.albumOf[it.i] || IM.album;
  if (!al) return null;
  return imNamePart(it).toLowerCase() === al.name.toLowerCase() ? al : null;
}
function imNamePart(it) {
  if (IM.over[it.i] !== undefined) return IM.over[it.i];
  if (IM.albumOf[it.i]) return IM.albumOf[it.i].name;
  const al = albumChosen();
  if (al) return al.name;
  const ev = $("#im-event").value.trim();
  if (ev) return ev;
  if (it.name_part) return it.name_part;
  const pl = imPlace(it);
  const city = pl ? pl.city : null;
  if (city && city !== "At sea") return city.replace(/^Near /, "");
  return city || "";
}
const placeName = (c) => c.name || (c.label || "").split(",")[0].trim() || "Dropped pin";
function imPlace(it) {   // what location this photo will end up with, and where it came from
  if (IM.places[it.i]) return { label: IM.places[it.i].label || placeName(IM.places[it.i]), city: placeName(IM.places[it.i]), how: "mine" };
  if (it.place) return { label: it.place, city: it.city, how: "gps" };
  if (IM.bplace) return { label: IM.bplace.label || placeName(IM.bplace), city: placeName(IM.bplace), how: "batch" };
  return null;
}
// the Date & Time box starts at the earliest TICKED photo and moves only the ticked photos
function imSetBase() {
  const dated = IM.items.filter(i => IM.sel.has(i.i) && i.taken && i.has_time && !IM.times[i.i]).map(i => i.taken).sort();
  IM.base = dated.length ? dated[0].slice(0, 16) : null;
  if (!IM.dateTouched) {
    $("#im-date").value = IM.base ? IM.base.slice(0, 10) : "";
    $("#im-time").value = IM.base ? IM.base.slice(11, 16) : "";
  }
  $("#im-date").disabled = $("#im-time").disabled = !IM.base;
}
function imTaken(it) {
  if (IM.times[it.i]) return IM.times[it.i];
  if (!it.taken) return null;
  return it.has_time && IM.sel.has(it.i) ? shiftIso(it.taken, imShift()) : it.taken;
}
function imHasTime(it) { return !!IM.times[it.i] || it.has_time; }
function imNewName(it) {
  const t = imTaken(it);
  if (!t) return null;
  const withTime = $("#im-format").value === "1" && imHasTime(it);
  const name = imNamePart(it);
  return t.slice(0, 10).replace(/-/g, ".") + (withTime ? " " + t.slice(11, 13) + t.slice(14, 16) : "") + (name ? " " + name : "") + EXT(it.name);
}
function imGroupStart() {   // a trip or event stays in the month it began
  const starts = {};
  IM.items.filter(i => IM.sel.has(i.i) && i.taken).forEach(i => {
    const k = imNamePart(i).toLowerCase(), t = imTaken(i);
    if (!starts[k] || t < starts[k]) starts[k] = t;
  });
  return starts;
}
function imFolder(it, starts) {
  const t = imTaken(it);
  if (!t) return null;
  const mode = IM.settings.folders || "month_group";
  const name = imNamePart(it);
  if (mode === "year") return [t.slice(0, 4)];
  if (mode === "none") return [];
  if (mode === "year_month") return [t.slice(0, 4), t.slice(0, 7)];
  const al = imAlbum(it);
  if (al) return [al.month, al.folder];   // an album's folder, whatever the photo's own date
  const st = (starts[name.toLowerCase()] || t).slice(0, 7).replace("-", ".");
  return name ? [st, `${st} ${name}`.replace(/[. ]+$/, "")] : [t.slice(0, 7).replace("-", ".")];
}

const shortPlace = (p) => { const a = (p || "").split(",").map(x => x.trim()).filter(Boolean); return a.length > 1 ? `${a[0]}, ${a[a.length - 1]}` : (a[0] || ""); };
function fmtShort(iso) {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  let h = +iso.slice(11, 13); const mi = iso.slice(14, 16);
  const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
  return { d: `${MONTHS[m - 1]} ${d}, ${y}`, t: `${h}:${mi} ${ap}` };
}
function imVisible() {
  const q = IM.q.toLowerCase();
  return IM.items.filter(i => (!IM.filter || (IM.filter === "dup" ? i.status !== "new" : i.status === "new")) &&
    (!q || i.name.toLowerCase().includes(q) || (imFinalName(i) || "").toLowerCase().includes(q) || (i.place || "").toLowerCase().includes(q)));
}
function nameParts(it) {
  const nn = imNewName(it);
  if (!nn) return null;
  const ext = EXT(it.name), np = imNamePart(it);
  const prefix = nn.slice(0, nn.length - ext.length - (np ? np.length + 1 : 0));
  return { prefix, np, ext };
}

/* Photos that would get the same name are numbered at the end — " 2", " 3" — in the order they were
   taken, skipping numbers already used on the drive. The import does exactly the same. */
function computeNumbers() {
  IM.num = {};
  if (!$("#op-rename").checked) return;
  const starts = imGroupStart();
  const groups = {};
  IM.items.filter(i => IM.sel.has(i.i)).forEach(it => {
    const nn = imNewName(it); if (!nn) return;
    const f = imFolder(it, starts) || [];
    const target = [...f, nn].join("/");
    (groups[target.toLowerCase()] = groups[target.toLowerCase()] || { target, items: [] }).items.push(it);
  });
  const missing = [];
  Object.values(groups).forEach(g => {
    const used = new Set(IM.inuse[g.target] || []);
    if (!(g.target in IM.inuse)) missing.push(g.target);
    g.items.sort((a, b) => (imTaken(a) < imTaken(b) ? -1 : imTaken(a) > imTaken(b) ? 1 : a.name < b.name ? -1 : 1));
    let k = 1;
    g.items.forEach(it => {
      while (used.has(k)) k++;
      IM.num[it.i] = k; used.add(k);
    });
  });
  askInUse(missing);
}
let inUseTimer;
function askInUse(targets) {
  const need = targets.filter(t => !IM.asking.has(t));
  if (!need.length) return;
  need.forEach(t => IM.asking.add(t));
  clearTimeout(inUseTimer);
  inUseTimer = setTimeout(async () => {
    const batch = [...IM.asking].filter(t => !(t in IM.inuse));
    if (!batch.length) return;
    try {
      const r = await api("/api/names-in-use", { targets: batch });
      Object.assign(IM.inuse, r);
      batch.forEach(t => { if (!(t in IM.inuse)) IM.inuse[t] = []; IM.asking.delete(t); });
      if (IM.state === "pick") renderImport();
    } catch (e) { batch.forEach(t => IM.asking.delete(t)); }
  }, 250);
}
const numSuffix = (it) => (IM.num[it.i] > 1 ? " " + IM.num[it.i] : "");
function imFinalName(it) {
  const nn = imNewName(it);
  if (!nn) return null;
  const ext = EXT(it.name);
  return nn.slice(0, nn.length - ext.length) + numSuffix(it) + ext;
}

function renderImport() {
  computeNumbers();
  const sel = IM.items.filter(i => IM.sel.has(i.i));
  const size = sel.reduce((a, i) => a + (i.size || 0), 0);
  const dups = IM.items.filter(i => i.status !== "new").length;
  const cams = [...new Set(IM.items.map(i => i.camera).filter(Boolean))];
  const srcName = IM.source.split("/").filter(Boolean).pop();
  $("#im-count").textContent = `${plural(sel.length, "photo")} selected`;
  $("#im-from").innerHTML = `From: ${esc(srcName)}${cams.length === 1 ? " — " + esc(cams[0]) : ""} &nbsp;›&nbsp; Estimated size: ${fmtSize(size) || "0 KB"}`;
  $$("#im-filter button").forEach(b => {
    const k = b.dataset.k;
    const c = k === "new" ? IM.items.length - dups : k === "dup" ? dups : IM.items.length;
    b.textContent = `${k === "new" ? "New" : k === "dup" ? "Duplicates" : "All"} (${n(c)})`;
  });
  const first = sel.find(i => imTaken(i)) || IM.items.find(i => imTaken(i));
  $("#im-preview").textContent = first ? imFinalName(first) : "—";
  if (!IM.dateTouched) imSetBase();
  const sh = imShift();
  const ticked = sel.length;
  $("#im-all-head").textContent = `Applies to the ${plural(ticked, "Ticked Photo", "Ticked Photos")}`;
  $("#im-date-note").textContent = sh ? `The ${plural(ticked, "ticked photo")} move${ticked === 1 ? "s" : ""} by ${fmtShift(sh)}, keeping their order. Unticked photos don't change.` :
    (IM.base ? `Shown: the first ticked photo. Change it to fix a camera clock — all ${plural(ticked, "ticked photo")} move by the same amount. For just one photo, click it and use “Change this photo's date & time”.`
      : "None of the ticked photos have a date yet.");
  $("#im-place").textContent = IM.bplace ? "📍 " + shortPlace(IM.bplace.label || placeName(IM.bplace)) : "+ Add a place";
  $("#im-place-clear").hidden = !IM.bplace;
  $("#im-album").textContent = IM.album ? "📁 " + IM.album.folder : "+ Add to an album…";
  $("#im-album-clear").hidden = !IM.album;
  $("#im-event").disabled = !!IM.album;
  const withGps = sel.filter(i => i.place).length;
  $("#im-place-note").textContent = IM.bplace
    ? `Goes on ${plural(sel.length - withGps - sel.filter(i => IM.places[i.i]).length, "photo")} without a location.${withGps ? ` ${plural(withGps, "photo")} with GPS keep${withGps === 1 ? "s" : ""} ${withGps === 1 ? "its" : "their"} exact spot.` : ""}`
    : (withGps === sel.length && sel.length ? "All selected photos already have a location from GPS." : "For photos without their own location. Photos with GPS keep their exact spot.");
  renderDest();
  renderDetail();
  const list = imVisible();
  $("#im-table").hidden = IM.view !== "list";
  $("#im-grid").hidden = IM.view !== "grid";
  if (IM.view === "list") renderTable(list); else renderGrid(list);
  $("#im-more").hidden = list.length <= IM.shown;
  $("#im-more").textContent = `Show more (${n(list.length - IM.shown)})`;
  const on = $("#op-rename").checked;
  $("#im-go").textContent = sel.length ? `Import ${plural(sel.length, "Photo")}${on ? "" : " (keep names)"}` : "Import";
  $("#im-go").disabled = !sel.length || IM.state === "running";
}

function renderTable(list) {
  const allOn = list.length > 0 && list.every(i => IM.sel.has(i.i));
  const rows = list.slice(0, IM.shown).map(it => {
    const on = IM.sel.has(it.i);
    const np = nameParts(it);
    const t = imTaken(it);
    const when = t ? fmtShort(t) : null;
    const newCell = !np ? `<span class="nodate">No date — <button class="link" data-adddate>add one</button></span>`
      : !$("#op-rename").checked ? `<span class="muted">Keeps its name</span>`
      : `<div class="fname ${IM.over[it.i] !== undefined ? "mine" : ""}"><span>${esc(np.prefix)}</span><input data-name value="${esc(np.np)}" placeholder="name" spellcheck="false">${numSuffix(it) ? `<span class="num" title="Another photo has this name, so this one is numbered">${esc(numSuffix(it))}</span>` : ""}<span>${esc(np.ext)}</span></div>` +
        (imAlbum(it) ? `<div class="albumtag" title="Goes in the album's folder">📁 ${esc(imAlbum(it).folder)}</div>` : "");
    return `<div class="tr ${on ? "" : "off"} ${IM.focus === it.i ? "focus" : ""}" data-i="${it.i}">
      <div class="c-chk"><input type="checkbox" data-sel ${on ? "checked" : ""}></div>
      <div class="c-img"><img loading="lazy" src="/import-thumb/${it.i}?v=${IM.token}" alt=""></div>
      <div class="c-old">${esc(it.name)}${it.raw ? `<span class="tagx">+ ${esc(EXT(it.raw).slice(1).toUpperCase())}</span>` : ""}
        ${it.status !== "new" ? `<span class="tagx warn">${MATCH_LABEL[it.status]}</span>` : it.kind === "video" ? `<span class="tagx">Video</span>` : ""}</div>
      <div class="c-arrow">→</div>
      <div class="c-new">${newCell}</div>
      <div class="c-date">${when ? `${when.d}${imHasTime(it) ? `<br><span class="muted">${when.t}</span>` : `<br><span class="muted">time unknown</span>`}` : `<span class="muted">—</span>`}</div>
      <div class="c-loc ${imPlace(it) && imPlace(it).how !== "gps" ? "set" : ""}">${imPlace(it) ? `<svg viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg><span class="t" title="${esc(imPlace(it).label)}${imPlace(it).how === "gps" ? " (from the photo's GPS)" : " (added by you)"}">${esc(shortPlace(imPlace(it).label))}</span>` : `<button class="link" data-addplace>+ Add</button>`}</div>
      <div class="c-size">${fmtSize(it.size)}</div>
    </div>`;
  }).join("");
  $("#im-table").innerHTML = `<div class="th">
      <div class="c-chk"><input type="checkbox" id="im-all" ${allOn ? "checked" : ""}></div>
      <div class="c-img">Preview</div><div class="c-old">Current Filename</div><div class="c-arrow"></div>
      <div class="c-new">New Filename <span class="muted">(editable)</span></div>
      <div class="c-date">Date &amp; Time</div><div class="c-loc">Location</div><div class="c-size">Size</div>
    </div>` + (rows || `<div class="empty">Nothing here.</div>`);
}

function renderGrid(list) {
  const starts = imGroupStart();
  $("#im-grid").innerHTML = list.slice(0, IM.shown).map(it => {
    const on = IM.sel.has(it.i);
    const nn = imFinalName(it);
    const f = imFolder(it, starts);
    return `<div class="ic ${on ? "on" : ""} ${IM.focus === it.i ? "focus" : ""}" data-i="${it.i}" title="${nn ? esc((f || []).join(" › ")) : ""}">
      <div class="ph"><img loading="lazy" src="/import-thumb/${it.i}?v=${IM.token}" alt=""><span class="tick" data-sel>${on ? "✓" : ""}</span>
        ${it.status !== "new" ? `<span class="tagr warn">${MATCH_LABEL[it.status]}</span>` : it.raw ? `<span class="tagr">RAW+JPEG</span>` : it.kind === "video" ? `<span class="tagr">Video</span>` : ""}</div>
      <div class="oldn">${esc(it.name)}</div>
      ${nn ? ($("#op-rename").checked ? `<div class="newn ${IM.over[it.i] !== undefined ? "mine" : ""}">${esc(nn)}</div>` : `<div class="oldn">Keeps its name for now</div>`) : `<div class="note">No date — add one on the left</div>`}
    </div>`;
  }).join("");
}

function renderDest() {
  const starts = imGroupStart();
  const counts = {};
  IM.items.filter(i => IM.sel.has(i.i)).forEach(i => {
    const f = imFolder(i, starts); if (!f) return;
    const k = f.join("/"); counts[k] = (counts[k] || 0) + 1;
  });
  const keys = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  const lib = S.state.library.split("/").filter(Boolean).pop();
  const folder = `<svg viewBox="0 0 24 24" class="fold"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
  const path = keys.length ? keys[0].split("/").filter(Boolean) : [];
  $("#im-dest").innerHTML = `${folder}<span>${esc(lib)}</span>` + path.map(p => `<i>›</i><span>${esc(p)}</span>`).join("") +
    (keys.length > 1 ? ` <span class="more-f" title="${esc(keys.slice(1).map(k => k.split("/").join(" › ")).join("\n"))}">+ ${plural(keys.length - 1, "more folder")}</span>` : "");
}

function renderDetail() {
  const it = IM.items.find(i => i.i === IM.focus);
  if (!it) { $("#im-detail").innerHTML = ""; return; }
  const t = imTaken(it);
  const when = t ? fmtShort(t) : null;
  const bits = [fmtSize(it.size), it.width ? `${it.width} × ${it.height}` : "", it.camera || ""].filter(Boolean).join(" · ");
  const np = imNamePart(it);
  const tags = IM.tags[it.i] || [];
  $("#im-detail").innerHTML = `
    <div class="dimg"><img src="/import-media/${it.i}?v=${IM.token}" alt="" onerror="this.src='/import-thumb/${it.i}?v=${IM.token}'"></div>
    <div class="dname">${esc(it.name)}</div>
    <div class="dmeta">${esc(bits)}</div>
    <div class="dmeta">${when ? `${when.d}${imHasTime(it) ? " · " + when.t : ""}` : `<span class="nodate">No date yet</span>`}</div>
    ${imAlbum(it) ? `<div class="dmeta">📁 ${esc(imAlbum(it).folder)}</div>` : ""}
    ${imPlace(it) ? `<div class="dmeta">📍 ${esc(shortPlace(imPlace(it).label))}${imPlace(it).how === "gps" ? "" : " <span class='muted'>(added)</span>"}</div>` : ""}
    ${!IM.editing ? `<div class="drow"><button class="ghost small-btn" id="im-time-btn">Change this photo's date &amp; time</button><button class="ghost small-btn" id="im-edit-btn">Edit this photo…</button></div>` : `
    <div class="dedit">
      <div class="panel-head">This photo only</div>
      <label class="fl">Name<input id="ed-name" value="${esc(np)}" placeholder="Event or place"></label>
      <label class="fl">Date &amp; time<input id="ed-time" type="datetime-local" step="60" value="${t ? t.slice(0, 16) : ""}"></label>
      <div class="fl">Location<div class="placerow"><button class="ghost placepick" id="ed-place">${imPlace(it) ? "📍 " + esc(shortPlace(imPlace(it).label)) : "+ Add a place"}</button>${IM.places[it.i] ? `<button class="link" id="ed-place-clear">Clear</button>` : ""}</div></div>
      <div class="fl">Album<div class="placerow"><button class="ghost placepick" id="ed-album">${IM.albumOf[it.i] ? "📁 " + esc(IM.albumOf[it.i].folder) : "+ Add to an album…"}</button>${IM.albumOf[it.i] ? `<button class="link" id="ed-album-clear">Clear</button>` : ""}</div></div>
      <label class="fl">Tags<input id="ed-tags" list="tag-list" value="${esc(tags.join(", "))}" placeholder="e.g. Hugh, Sarah"></label>
      <div class="fl">Rating<span class="stars big" id="ed-stars">${starsHtml(IM.stars[it.i] || 0, "data-estar")}</span></div>
      <div class="drow"><button class="link" id="ed-reset">Reset this photo</button><button class="dark" id="ed-done">Done</button></div>
    </div>`}`;
  const eb = $("#im-edit-btn");
  if (eb) eb.onclick = () => { IM.editing = true; renderDetail(); setTimeout(() => $("#ed-name").focus(), 20); };
  const tb = $("#im-time-btn");
  if (tb) tb.onclick = () => { IM.editing = true; renderDetail(); setTimeout(() => { $("#ed-time").focus(); try { $("#ed-time").showPicker(); } catch (e) { /* ignore */ } }, 20); };
  if (!IM.editing) return;
  const save = () => {
    const v = $("#ed-name").value.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
    delete IM.over[it.i];
    if (v !== imNamePart(it)) IM.over[it.i] = v;
    const tv = $("#ed-time").value;
    if (tv && (!t || tv !== t.slice(0, 16))) IM.times[it.i] = tv + ":00";
    const tg = $("#ed-tags").value.split(",").map(x => x.trim()).filter(Boolean);
    if (tg.length) IM.tags[it.i] = tg; else delete IM.tags[it.i];
    if (!IM.sel.has(it.i) && (IM.times[it.i] || IM.over[it.i] !== undefined)) IM.sel.add(it.i);
  };
  $("#ed-done").onclick = () => { save(); IM.editing = false; renderImport(); };
  $("#ed-place").onclick = () => {
    save();
    openPicker([], "Place for " + it.name, null, imPlace(it) ? imPlace(it).label : "",
               (c) => { IM.places[it.i] = c; IM.sel.add(it.i); renderImport(); });
  };
  $("#ed-album").onclick = () => {
    save();
    openGrouper([], [it], null, (g) => {
      IM.albumOf[it.i] = g; delete IM.over[it.i]; IM.sel.add(it.i); renderImport();
    });
  };
  const ac = $("#ed-album-clear");
  if (ac) ac.onclick = () => { save(); delete IM.albumOf[it.i]; delete IM.over[it.i]; renderImport(); };
  const pc = $("#ed-place-clear");
  if (pc) pc.onclick = () => { save(); delete IM.places[it.i]; renderImport(); };
  ["#ed-name", "#ed-time", "#ed-tags"].forEach(sel => $(sel).addEventListener("keydown", (e) => { if (e.key === "Enter") $("#ed-done").click(); }));
  $("#ed-reset").onclick = () => { delete IM.over[it.i]; delete IM.times[it.i]; delete IM.tags[it.i]; delete IM.stars[it.i]; delete IM.places[it.i]; delete IM.albumOf[it.i]; IM.editing = false; renderImport(); };
  $("#ed-stars").onclick = (e) => {
    const b = e.target.closest("[data-estar]"); if (!b) return;
    const v = +b.dataset.estar;
    IM.stars[it.i] = IM.stars[it.i] === v ? 0 : v;
    $("#ed-stars").innerHTML = starsHtml(IM.stars[it.i], "data-estar");
  };
}

function focusRow(i, edit) {
  if (IM.focus !== i) IM.editing = false;
  IM.focus = i;
  if (edit) IM.editing = true;
  renderImport();
}

$("#im-table").addEventListener("click", (e) => {
  if (IM.state === "running") return;
  if (e.target.id === "im-all") {
    imVisible().forEach(i => (e.target.checked ? IM.sel.add(i.i) : IM.sel.delete(i.i)));
    return renderImport();
  }
  const row = e.target.closest(".tr"); if (!row) return;
  const i = +row.dataset.i;
  if (e.target.matches("[data-sel]")) { e.target.checked ? IM.sel.add(i) : IM.sel.delete(i); return renderImport(); }
  if (e.target.closest("[data-adddate]")) return focusRow(i, true);
  if (e.target.closest("[data-addplace]")) {
    const it = IM.items.find(x => x.i === i);
    IM.focus = i;
    return openPicker([], "Place for " + it.name, null, "", (c) => { IM.places[i] = c; IM.sel.add(i); renderImport(); });
  }
  if (e.target.matches("[data-name]")) { if (IM.focus !== i) { IM.focus = i; IM.editing = false; renderDetail();
      $$("#im-table .tr").forEach(r => r.classList.toggle("focus", +r.dataset.i === i)); } return; }
  focusRow(i);
});
$("#im-table").addEventListener("change", (e) => {
  if (!e.target.matches("[data-name]")) return;
  const i = +e.target.closest(".tr").dataset.i;
  const it = IM.items.find(x => x.i === i);
  const v = e.target.value.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
  delete IM.over[i];
  if (v !== imNamePart(it)) IM.over[i] = v;
  renderImport();
});
$("#im-table").addEventListener("keydown", (e) => {
  if (!e.target.matches("[data-name]")) return;
  if (e.key === "Enter") e.target.blur();
  if (e.key === "Escape") { e.target.value = imNamePart(IM.items.find(x => x.i === +e.target.closest(".tr").dataset.i)); e.target.blur(); }
});
$("#im-grid").onclick = (e) => {
  const c = e.target.closest(".ic"); if (!c || IM.state === "running") return;
  const i = +c.dataset.i;
  if (e.target.closest("[data-sel]")) { IM.sel.has(i) ? IM.sel.delete(i) : IM.sel.add(i); return renderImport(); }
  focusRow(i);
};
$("#im-filter").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; IM.filter = b.dataset.k;
  $$("#im-filter button").forEach(x => x.classList.toggle("on", x === b)); IM.shown = 120; renderImport(); };
$("#im-view").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; IM.view = b.dataset.v;
  $$("#im-view button").forEach(x => x.classList.toggle("on", x === b)); renderImport(); };
$("#im-search-btn").onclick = () => { const s2 = $("#im-search"); s2.hidden = !s2.hidden; if (!s2.hidden) s2.focus(); else { s2.value = ""; IM.q = ""; renderImport(); } };
$("#im-search").addEventListener("input", (e) => { IM.q = e.target.value.trim(); IM.shown = 120; renderImport(); });
$("#im-more").onclick = () => { IM.shown += 120; renderImport(); };
["#im-date", "#im-time"].forEach(sel => $(sel).addEventListener("input", () => { IM.dateTouched = true; }));   // before redrawing
["#im-event", "#im-date", "#im-time", "#im-format"].forEach(sel => $(sel).addEventListener("input", renderImport));
$("#im-place").onclick = () => openPicker([], "Location for these photos", null, IM.bplace ? IM.bplace.label : $("#im-event").value.trim(),
  (c) => { IM.bplace = c; renderImport(); });
$("#im-place-clear").onclick = () => { IM.bplace = null; renderImport(); };
$("#im-adv-btn").onclick = () => { $("#im-adv").hidden = !$("#im-adv").hidden; };
$("#im-folders").onchange = async (e) => {
  IM.settings.folders = e.target.value;
  renderImport();
  try { await api("/api/organize/settings", { folders: e.target.value }); } catch (err) { fail(err); }
};
$("#im-album").onclick = () => {
  const sel = IM.items.filter(i => IM.sel.has(i.i));
  openGrouper([], sel, null, (g) => { IM.album = g; renderImport(); });
};
$("#im-album-clear").onclick = () => { IM.album = null; renderImport(); };
$("#op-rename").onchange = renderImport;
$("#op-dupes").onchange = (e) => {
  IM.items.filter(i => i.status !== "new").forEach(i => (e.target.checked ? IM.sel.delete(i.i) : IM.sel.add(i.i)));
  renderImport();
};
$("#op-delete").onchange = (e) => ($("#op-delete-note").hidden = !e.target.checked);
$("#im-cancel").onclick = async () => { await api("/api/import/cancel", {}); importScreen("start"); };
$("#im-go").onclick = () => {
  const include = IM.items.filter(i => IM.sel.has(i.i)).map(i => i.i);
  if (!include.length) return;
  if ($("#op-delete").checked && !confirm(`After copying, move the ${plural(include.length, "original")} to the Trash? You can drag them back out of the Trash until you empty it.`)) return;
  const al = albumChosen();
  const pick = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => IM.sel.has(+k)));
  const bt = imBatchTags(), tags = pick(IM.tags);
  if (bt.length) include.forEach(i => { tags[i] = [...new Set([...(tags[i] || []), ...bt])]; });
  api("/api/import/commit", {
    include, event: al ? "" : $("#im-event").value.trim(), shift: imShift(), album: al ? al.key : null,
    names: pick(IM.over), times: pick(IM.times), tags, ratings: pick(IM.stars),
    albums: Object.fromEntries(Object.entries(pick(IM.albumOf)).map(([k, g]) => [k, g.key])),
    places: pick(IM.places), batch_place: IM.bplace,
    rename: $("#op-rename").checked, delete_source: $("#op-delete").checked,
  }).then(() => { importScreen("running"); S.lastJobFinished = false; refreshState(); }).catch(fail);
};

function showImportReview(res) {
  showTab("import", true);
  importScreen("review");
  const n1 = res.copied || 0;
  $("#rv2-title").textContent = `${plural(n1, "photo")} imported`;
  $("#rv2-sub").textContent = res.renamed
    ? "Renamed, filed, and everything saved into the photos."
    : "Copied to Drive Preview — rename and file them there when you're ready.";
  $("#rv2-tree").innerHTML = (res.folders || []).map(f => `<div class="t">${esc(f.split("/").join(" › "))}</div>`).join("");
  $("#rv2-wait").hidden = !res.waiting;
  $("#rv2-wait").textContent = res.waiting ? `${plural(res.waiting, "photo has", "photos have")} no date yet and ${res.waiting === 1 ? "is" : "are"} waiting in Drive Preview.` : "";
  $("#rv2-preview").hidden = !(res.waiting || !res.renamed);
  IM.lastIds = res.imported_ids || [];
  $("#rv2-prune").hidden = !IM.lastIds.length;
  loadAlbums();
}
$("#rv2-prune").onclick = () => openPickSet(IM.lastIds, "just imported");
$("#rv2-library").onclick = () => { IM.state = "start"; showTab("browse"); };
$("#rv2-preview").onclick = () => { IM.state = "start"; showTab("inbox"); };
$("#rv2-again").onclick = () => importScreen("start");

$("#btn-import").onclick = async () => {
  let p = S.state.mac ? await pickFolder("Choose the folder or card with your photos") : prompt("Folder with new photos:");
  if (!p) return;
  api("/api/import", { path: p }).then(() => { importScreen("checking"); S.lastJobFinished = false; refreshState(); }).catch(fail);
};

/* ------------------------------------------------------------------ albums in the sidebar */
async function loadAlbums() {
  if (!S.state || !S.state.library) return;
  let g;
  try { g = await api("/api/groups"); } catch (e) { return; }
  $("#albums").hidden = !g.length;
  $("#album-list").innerHTML = g.slice(0, 8).map(a => `
    <button class="album" data-name="${esc(a.name)}">
      <img src="/thumb/${a.thumbs[0]}" alt="">
      <span><b>${esc(a.start.slice(0, 7).replace("-", "."))} ${esc(a.name)}</b><span>${plural(a.count, "photo")}</span></span>
    </button>`).join("");
}
$("#album-list").onclick = (e) => {
  const b = e.target.closest(".album"); if (!b) return;
  showTab("browse", true);
  $("#f-place").value = ""; $("#f-year").value = ""; $("#f-rating").value = ""; $("#f-name").value = b.dataset.name;
  loadBrowse(true);
};

$("#job-close").onclick = () => api("/api/job/dismiss", {}).then(refreshState);

/* ------------------------------------------------------------------ tabs */
$("#tabs").onclick = (e) => { const b = e.target.closest("button"); if (b) showTab(b.dataset.tab); };

function showTab(tab, soft) {
  if (!S.state || !S.state.library) return showSetup(S.state || {});
  S.tab = tab;
  $$("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
  const view = tab === "favorites" ? "browse" : tab;
  $$(".view").forEach(v => (v.hidden = v.id !== "v-" + view));
  if (tab === "favorites") {
    $("#f-place").value = ""; $("#f-name").value = ""; $("#f-year").value = ""; $("#f-rating").value = "4";
    loadBrowse(true); return;
  }
  if (tab === "browse" && !soft && $("#f-rating").value === "4") $("#f-rating").value = "";
  if (tab === "import") { if (!soft) openImportTab(); return; }
  if (tab === "inbox") { if (!soft) R.mode = "inbox"; loadReview(); }
  if (tab === "browse") loadBrowse(true, soft);
  if (tab === "dupes") loadDupes();
  if (tab === "pick" && !soft) loadPickGroups();
  if (tab === "people") { if (!soft) PP.detail = null; PP.detail ? openDetail(PP.detail) : loadPeople(); }
  if (tab === "locations") loadPlaces();
  if (tab === "organize") loadTidy();
}

/* ------------------------------------------------------------------ browse */
const B = { offset: 0, items: [], days: {}, total: 0 };

async function loadFilters() {
  if (!S.state || !S.state.library) return;
  try {
    const f = await api("/api/filters");
    $("#places").innerHTML = f.places.map(p => `<option value="${esc(p)}">`).join("");
    $("#tag-list").innerHTML = (f.tags || []).map(t => `<option value="${esc(t)}">`).join("");
    const sel = $("#f-year"), cur = sel.value;
    sel.innerHTML = `<option value="">Any year</option>` + f.years.map(y => `<option>${y}</option>`).join("") +
      `<option value="none">Date needs attention</option>`;
    sel.value = cur;
  } catch (e) { /* ignore */ }
}

function browseFilters() {
  return { place: $("#f-place").value.trim(), year: $("#f-year").value, month: $("#f-month").value,
           name: $("#f-name").value.trim(), rating: $("#f-rating").value };
}

async function checkUnorganized() {
  try {
    const r = await api("/api/unorganized");
    $("#browse-unorg").hidden = !r.count;
    $("#browse-unorg-text").innerHTML = `<b>${plural(r.count, "photo")} on your drive still ${r.count === 1 ? "has its" : "have their"} old name${r.count === 1 ? "" : "s"}.</b> To give ${r.count === 1 ? "it" : "them"} the same style as your imports, go to Tidy Up — nothing changes until you press Apply.`;
  } catch (e) { /* ignore */ }
}
$("#browse-unorg-go").onclick = () => showTab("organize");  // Tidy Up

async function loadBrowse(reset, soft) {
  if (reset) checkUnorganized();
  if (!reset && B.loading) return;               // "Show more" clicked twice
  const seq = B.seq = (B.seq || 0) + 1;
  const offset = reset ? 0 : B.offset;
  B.loading = true;
  const q = new URLSearchParams(Object.assign(browseFilters(), { offset, limit: 150 }));
  let r;
  try { r = await api("/api/search?" + q); } catch (e) { B.loading = false; return fail(e); }
  if (seq !== B.seq) return;                      // a newer search replaced this one
  B.loading = false;
  if (reset) { B.items = []; B.days = {}; }
  B.total = r.total;
  B.items = B.items.concat(r.items);
  Object.assign(B.days, r.days);
  B.offset = B.items.length;
  renderBrowse();
}

function renderBrowse() {
  const grid = $("#grid");
  const byDay = [];
  for (const it of B.items) {
    const d = it.taken.slice(0, 10);
    if (!byDay.length || byDay[byDay.length - 1].day !== d) byDay.push({ day: d, items: [] });
    byDay[byDay.length - 1].items.push(it);
  }
  let idx = 0;
  grid.innerHTML = byDay.map(g => {
    const info = B.days[g.day] || {};
    const title = info.name || "";
    const meta = [info.place && info.place !== title ? info.place : "", plural(info.count || g.items.length, "photo")].filter(Boolean).join(" · ");
    return `<div class="day">
        <h3>${fmtDay(g.day)}</h3>
        ${title ? `<span class="dname">${esc(title)}</span>` : ""}
        <span class="dmeta">${esc(meta)}</span>
        <button class="link" data-name-day="${g.day}">${title ? "Rename day" : "Name this day"}</button>
        <button class="link" data-edit-day="${g.day}">Edit photos</button>
      </div>
      <div class="tiles">${g.items.map(it => tile(it, idx++)).join("")}</div>`;
  }).join("");
  const f = browseFilters();
  const what = [f.month && f.year ? `${MONTH_NAMES[+f.month - 1]} ${f.year}` : f.year && f.year !== "none" ? f.year : "",
                f.place, f.name].filter(Boolean).join(" · ");
  $("#browse-count").textContent = B.total ? `${plural(B.total, "photo")}${what ? " — " + what : ""}` : "";
  const filtered = !!(f.place || f.year || f.name || f.rating);
  $("#browse-edit").hidden = !B.total || !filtered;
  $("#browse-pick").hidden = !B.total || !filtered;
  $("#browse-edit").textContent = `Edit these ${plural(B.total, "photo")}`;
  $("#browse-more").hidden = B.items.length >= B.total;
  $("#browse-empty").hidden = B.total > 0;
}

function tile(it, i) {
  return `<div class="tile" data-i="${i}" title="${esc(it.name)}">
    <img loading="lazy" src="/thumb/${it.id}" alt="">
    ${it.kind === "video" ? `<span class="vid">▶ Video</span>` : ""}
    ${it.rating ? `<span class="vid" style="left:6px;right:auto;color:#f3c34a">${"★".repeat(it.rating)}</span>` : ""}
    ${it.raw ? `<span class="vid" style="top:6px;bottom:auto">RAW+JPEG</span>` : ""}
  </div>`;
}

$("#grid").onclick = (e) => {
  const nd = e.target.closest("[data-name-day]");
  if (nd) return openNamer(nd.dataset.nameDay);
  const ed = e.target.closest("[data-edit-day]");
  if (ed) return openDay(ed.dataset.editDay);
  const t = e.target.closest(".tile");
  if (t) openViewer(B.items, +t.dataset.i);
};
$("#browse-more").onclick = () => loadBrowse(false);
let fTimer;
["#f-place", "#f-name"].forEach(s => $(s).addEventListener("input", () => { clearTimeout(fTimer); fTimer = setTimeout(() => loadBrowse(true), 300); }));
$("#f-year").onchange = () => {
  const y = $("#f-year").value;
  $("#f-month-wrap").hidden = !y || y === "none";
  $("#f-month").innerHTML = `<option value="">Any month</option>` + MONTH_NAMES.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("");
  loadBrowse(true);
};
$("#f-month").onchange = () => loadBrowse(true);
$("#f-rating").onchange = () => loadBrowse(true);
$("#f-clear").onclick = () => { $("#f-place").value = ""; $("#f-name").value = ""; $("#f-year").value = ""; $("#f-month").value = ""; $("#f-rating").value = ""; $("#f-month-wrap").hidden = true; loadBrowse(true); };
$("#browse-pick").onclick = async () => {
  try {
    const ids = await api("/api/search?" + new URLSearchParams(Object.assign(browseFilters(), { ids: "1" })));
    openPickSet(ids, $("#browse-count").textContent.split(" — ")[1] || "your selection");
  } catch (e) { fail(e); }
};
$("#browse-edit").onclick = async () => {
  try {
    const ids = await api("/api/search?" + new URLSearchParams(Object.assign(browseFilters(), { ids: "1" })));
    R.mode = "set"; R.ids = ids; R.setLabel = $("#browse-count").textContent.split(" — ")[1] || "";
    showTab("inbox", true);
  } catch (e) { fail(e); }
};

/* ------------------------------------------------------------------ name a day */
let namingDay = null;
function openNamer(day) {
  namingDay = day;
  const info = B.days[day] || {};
  $("#nm-title").textContent = "Name " + fmtDay(day);
  $("#nm-input").value = info.name || info.place || "";
  $("#namer").hidden = false;
  updateNamePreview();
  setTimeout(() => $("#nm-input").select(), 30);
}
function updateNamePreview() {
  const v = $("#nm-input").value.trim();
  $("#nm-preview").textContent = `${namingDay.replace(/-/g, ".")} 1432${v ? " " + v : ""}.jpg`;
}
$("#nm-input").addEventListener("input", updateNamePreview);
$("#nm-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#nm-save").click(); });
$("#nm-close").onclick = () => ($("#namer").hidden = true);
$("#nm-save").onclick = async () => {
  try {
    const r = await api("/api/name-day", { date: namingDay, title: $("#nm-input").value });
    $("#namer").hidden = true;
    toast(`Named ${plural(r.updated, "photo")}. Apply it from the Organize tab.`);
    loadBrowse(true);
  } catch (e) { fail(e); }
};

/* ------------------------------------------------------------------ viewer */
const V = { list: [], i: 0 };
function openViewer(list, i) { V.list = list; V.i = i; $("#viewer").hidden = false; renderViewer(); }
function closeViewer() { $("#viewer").hidden = true; $("#v-stage").innerHTML = ""; }
function renderViewer() {
  const it = V.list[V.i];
  if (!it) return closeViewer();
  $("#v-stage").innerHTML = it.kind === "video"
    ? `<video src="/media/${it.id}" controls autoplay playsinline></video>`
    : `<img src="/media/${it.id}" alt="" onerror="this.src='/thumb/${it.id}'">`;
  const ds = DATE_SOURCE[it.date_source] || "";
  $("#v-info").innerHTML = `
    <h3>${esc(it.name)}</h3>
    <dl>
      <div><dt>Taken</dt><dd>${fmtWhen(it.taken)}${ds ? `<div class="${it.date_source === "file" ? "note" : "muted small"}">${ds}</div>` : ""}</dd></div>
      <div><dt>Place</dt><dd>${it.place ? esc(it.place) : `<span class="muted">No location</span>`}
        ${it.lat != null ? `<div class="muted small v-ll">${fmtLatLon(it.lat, it.lon)}
            <button class="link" id="v-copy" title="Copy coordinates">Copy</button><button class="link" id="v-onmap">Show on map</button></div>
          <div><button class="ghost small-btn" id="v-uselocation" style="margin-top:6px">Use this location for other photos…</button></div>
          <div class="muted small">${it.gps_source === "nearby" ? "From a nearby photo" : it.gps_source === "manual" ? "Set by you" : "From the camera's GPS"}${it.precision && it.precision !== "exact" ? " · approximate" : ""}</div>` : ""}
        ${it.city && it.place && !it.place.startsWith(it.city) ? `<div class="muted small">Filed under ${esc(it.city)}</div>` : ""}</dd></div>
      ${it.camera ? `<div><dt>Camera</dt><dd>${esc(it.camera)}</dd></div>` : ""}
      ${it.people && it.people.length ? `<div><dt>People</dt><dd>${it.people.map(t => `<span class="chip" style="padding-right:10px">${esc(t)}</span>`).join(" ")}</dd></div>` : ""}
      ${it.tags && it.tags.length ? `<div><dt>Tags</dt><dd>${it.tags.map(t => `<span class="chip" style="padding-right:10px">${esc(t)}</span>`).join(" ")}</dd></div>` : ""}
      <div><dt>Rating</dt><dd><span class="stars big" id="v-stars">${starsHtml(it.rating || 0, "data-vstar")}</span></dd></div>
      <div><dt>Size</dt><dd>${it.width ? `${it.width} × ${it.height} · ` : ""}${fmtSize(it.size)}</dd></div>
      ${it.raw ? `<div><dt>Also saved as RAW</dt><dd>${esc(it.raw)}<div class="muted small">Kept together with this photo — same name, dates, place and tags.</div></dd></div>` : ""}
      <div><dt>Folder</dt><dd>${esc(it.folder || "(top of drive)")}</dd></div>
    </dl>
    <div class="actions">
      ${S.state.mac ? `<button class="ghost" id="v-reveal">Show in Finder</button>` : ""}
      <button class="ghost" id="v-place">${it.place ? "Change place…" : "Set place…"}</button>
      <button class="ghost" id="v-group">Add to group…</button>
      ${it.kind === "photo" ? `<button class="ghost" id="v-match">Find matches…</button>` : ""}
      ${it.kind === "photo" && ["file", "filename", "manual_date"].includes(it.date_source) ? `<button class="ghost" id="v-guess">Guess date…</button>` : ""}
    </div>
    <p class="muted small" style="margin-top:14px">${V.i + 1} of ${n(V.list.length)} · ← → to move, Esc to close</p>`;
  const rv = $("#v-reveal");
  if (rv) rv.onclick = () => api("/api/reveal/" + it.id, {});
  const vc = $("#v-copy");
  if (vc) vc.onclick = () => copyText(`${it.lat.toFixed(6)}, ${it.lon.toFixed(6)}`);
  const vu = $("#v-uselocation");
  if (vu) vu.onclick = async () => {
    closeViewer(); showTab("locations");
    await loadPlaces();
    plUseLocationOf(it, true);
  };
  const vo = $("#v-onmap");
  if (vo) vo.onclick = () => { closeViewer(); openPlaces([it.id], true); };
  const vg = $("#v-guess");
  if (vg) vg.onclick = () => openGuesser(it, () => { api("/api/file/" + it.id).then(f => { Object.assign(it, f); renderViewer(); }); });
  const vm = $("#v-match");
  if (vm) vm.onclick = () => openMatcher(it, () => { api("/api/file/" + it.id).then(f => { Object.assign(it, f); renderViewer(); }).catch(() => closeViewer()); });
  $("#v-stars").onclick = async (e) => {
    const b = e.target.closest("[data-vstar]"); if (!b) return;
    const v = +b.dataset.vstar === it.rating ? 0 : +b.dataset.vstar;
    try { await api("/api/edit", { ids: [it.id], rating: v }); it.rating = v || null; renderViewer();
          toast(v ? `Rated ${"★".repeat(v)} — saved into the photo next time you Save or Organize.` : "Rating removed."); } catch (err) { fail(err); }
  };
  $("#v-group").onclick = () => openGrouper([it.id], [it], (r) => {
    // outside Drive Preview, rename and file it straight away
    const ids = r.items.map(x => x.id);
    api("/api/organize/apply", { ids }).then(() => {
      S.lastJobFinished = false; refreshState();
      toast(`Added to “${r.group}” — renaming it now.`);
      closeViewer();
    }).catch(fail);
  });
  $("#v-place").onclick = () => openPicker([it.id], "Place for this photo", () => {
    api("/api/file/" + it.id).then(f => { Object.assign(it, f); renderViewer(); });
  });
}
$("#v-close").onclick = closeViewer;
$("#v-prev").onclick = () => { if (V.i > 0) { V.i--; renderViewer(); } };
$("#v-next").onclick = () => { if (V.i < V.list.length - 1) { V.i++; renderViewer(); } };
document.addEventListener("keydown", (e) => {
  if (!$("#picker").hidden || !$("#namer").hidden || !$("#bulk").hidden || !$("#grouper").hidden || !$("#matcher").hidden || !$("#guesser").hidden) {
    if (e.key === "Escape") { ["#picker", "#namer", "#bulk", "#grouper", "#matcher", "#guesser"].forEach(x => ($(x).hidden = true)); }
    return;
  }
  if ($("#viewer").hidden || !$("#cull").hidden) return;
  if (e.key === "Escape") closeViewer();
  if (e.key === "ArrowLeft") $("#v-prev").click();
  if (e.key === "ArrowRight") $("#v-next").click();
  if ("012345".includes(e.key) && V.list[V.i] && !e.target.matches("input")) {
    const it = V.list[V.i];
    api("/api/edit", { ids: [it.id], rating: +e.key }).then(() => { it.rating = +e.key || null; renderViewer(); }).catch(fail);
  }
});

/* ------------------------------------------------------------------ duplicates */
const D = { kind: "", groups: [], total: 0, choice: {} };

async function loadDupes() {
  let r;
  D.skipped = D.skipped || new Set();
  try { r = await api("/api/dupes", { kind: D.kind, skip: [...D.skipped] }); } catch (e) { return fail(e); }
  D.groups = r.groups; D.total = r.total;
  D.choice = {};
  for (const g of D.groups) {
    D.choice[g.key] = {};
    g.files.forEach(f => (D.choice[g.key][f.id] = f.id === g.keep));
  }
  const all = r.exact + r.similar;
  $("#dupes-sub").textContent = all
    ? `${plural(all, "group")} to review — ${n(r.exact)} exact, ${n(r.similar)} look-alike`
    : "";
  $("#dupes-auto").hidden = !r.exact;
  $("#dupes-auto-n").textContent = plural(r.exact, "group") ;
  $("#dupes-empty").hidden = r.total > 0;
  const aside = (S.state.stats || {}).set_aside || 0;
  $("#aside-foot").hidden = !aside;
  $("#aside-n").textContent = `${plural(aside, "photo")} set aside so far.`;
  renderDupes();
}

function renderDupes() {
  $("#dupe-list").innerHTML = D.groups.map(g => `
    <div class="card" data-key="${g.key}">
      <div class="card-head">
        <div><span class="kind">${g.kind === "exact" ? "Exact copies" : "Look-alikes"}</span>${plural(g.files.length, "file")}</div>
        <span class="muted">${fmtWhen(g.taken)}</span>
      </div>
      <div class="dups">${g.files.map(f => dupTile(g, f)).join("")}</div>
      <div class="card-actions">
        <button class="primary" data-act="done">Done</button>
        <button class="ghost" data-act="all">They're different — keep all</button>
        <button class="ghost" data-act="compare">⤢ Compare large</button>
        <span class="spacer"></span>
        <button class="link" data-act="skip">Skip for now</button>
      </div>
    </div>`).join("");
}

function dupTile(g, f) {
  const keep = D.choice[g.key][f.id];
  const bits = [];
  if (f.width) bits.push(`${f.width}×${f.height}`);
  bits.push(fmtSize(f.size));
  return `<div class="dup ${keep ? "keep" : "aside"}" data-id="${f.id}">
    <div class="img"><img loading="lazy" src="/thumb/${f.id}" alt=""><span class="tag">${keep ? "Keep" : "Set aside"}</span>
      <button class="zoomb" data-zoom title="See them large, side by side">⤢</button></div>
    <div class="meta">
      <b>${esc(f.name)}</b><br>
      ${esc(f.folder || "(top of drive)")}<br>
      ${bits.join(" · ")}${f.id === g.keep ? ` · <span class="best">best copy</span>` : ""}<br>
      ${f.place ? esc(f.place) : "No location"}${f.date_source === "file" ? " · date guessed" : ""}
    </div>
  </div>`;
}

$("#dupe-list").onclick = async (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  const key = card.dataset.key;
  const g = D.groups.find(x => x.key === key);
  if (e.target.closest("[data-zoom]") || (e.target.closest("[data-act]") || {}).dataset?.act === "compare") return openCompare(key);
  const tileEl = e.target.closest(".dup");
  if (tileEl) {
    const id = +tileEl.dataset.id;
    D.choice[key][id] = !D.choice[key][id];
    tileEl.outerHTML = dupTile(g, g.files.find(f => f.id === id));
    return;
  }
  const act = e.target.closest("[data-act]");
  if (!act) return;
  if (act.dataset.act === "skip") { D.skipped = D.skipped || new Set(); D.skipped.add(key); card.remove(); D.groups = D.groups.filter(x => x.key !== key); if (!D.groups.length) loadDupes(); return; }
  let keep = g.files.filter(f => D.choice[key][f.id]).map(f => f.id);
  let aside = g.files.filter(f => !D.choice[key][f.id]).map(f => f.id);
  if (act.dataset.act === "all") { keep = g.files.map(f => f.id); aside = []; }
  if (!keep.length) return toast("Keep at least one copy.");
  try {
    const r = await api("/api/dupes/resolve", { key, keep, aside });
    card.remove();
    D.groups = D.groups.filter(x => x.key !== key);
    if (r.moved) toast(`${plural(r.moved, "copy", "copies")} set aside.`);
    refreshState();
    if (!D.groups.length) loadDupes();
  } catch (e2) { fail(e2); }
};
$("#dupe-list").ondblclick = (e) => { const card = e.target.closest(".card"); if (card && e.target.closest(".dup")) openCompare(card.dataset.key); };

/* compare look-alikes large, side by side, zooming into the same spot in each */
const CMP = { key: null, zoom: false };
function openCompare(key) {
  CMP.key = key; CMP.zoom = false;
  $("#cmp").hidden = false; $("#cmp").classList.remove("zoomed");
  renderCompare();
}
function renderCompare() {
  const g = D.groups.find(x => x.key === CMP.key);
  if (!g) return closeCompare();
  const i = D.groups.indexOf(g);
  $("#cmp-title").textContent = `${g.kind === "exact" ? "Exact copies" : "Look-alikes"} · ${plural(g.files.length, "file")} · ${fmtWhen(g.taken)} · group ${i + 1} of ${D.groups.length}`;
  $("#cmp-prev").disabled = i === 0; $("#cmp-next").disabled = i === D.groups.length - 1;
  $("#cmp-body").innerHTML = g.files.map(f => {
    const keep = D.choice[g.key][f.id];
    return `<div class="cmp-p ${keep ? "keep" : "aside"}" data-id="${f.id}">
      <div class="cmp-img"><img src="/media/${f.id}" alt="" onerror="this.src='/thumb/${f.id}'"></div>
      <div class="cmp-info"><div class="grow"><b>${esc(f.name)}</b><br>
        <span class="muted">${[f.width ? `${f.width}×${f.height}` : "", fmtSize(f.size)].filter(Boolean).join(" · ")}${f.id === g.keep ? ` · <span class="best">best copy</span>` : ""}</span><br>
        <span class="muted">${esc(f.folder || "(top of drive)")}${f.place ? " · " + esc(f.place.split(",")[0]) : ""}</span></div>
        <button class="cmp-tag" data-toggle>${keep ? "Keep" : "Set aside"}</button></div>
    </div>`;
  }).join("");
}
function closeCompare() { $("#cmp").hidden = true; $("#cmp-body").innerHTML = ""; if (D.groups.length) renderDupes(); }
$("#cmp-body").onclick = (e) => {
  const p = e.target.closest(".cmp-p"); if (!p) return;
  const g = D.groups.find(x => x.key === CMP.key);
  if (e.target.closest("[data-toggle]")) {
    const id = +p.dataset.id;
    D.choice[g.key][id] = !D.choice[g.key][id];
    return renderCompare();
  }
  const box = e.target.closest(".cmp-img"); if (!box) return;
  CMP.zoom = !CMP.zoom;
  $("#cmp").classList.toggle("zoomed", CMP.zoom);
  const img = box.querySelector("img"), r = img.getBoundingClientRect();
  const ox = ((e.clientX - r.left) / r.width) * 100, oy = ((e.clientY - r.top) / r.height) * 100;
  $$("#cmp-body .cmp-img img").forEach(im => {   // same spot in every copy, to compare sharpness
    im.style.transformOrigin = `${ox}% ${oy}%`;
    im.style.transform = CMP.zoom ? "scale(3)" : "";
  });
};
$("#cmp-x").onclick = closeCompare;
$("#cmp-prev").onclick = () => { const i = D.groups.findIndex(x => x.key === CMP.key); if (i > 0) { CMP.key = D.groups[i - 1].key; CMP.zoom = false; $("#cmp").classList.remove("zoomed"); renderCompare(); } };
$("#cmp-next").onclick = () => { const i = D.groups.findIndex(x => x.key === CMP.key); if (i < D.groups.length - 1) { CMP.key = D.groups[i + 1].key; CMP.zoom = false; $("#cmp").classList.remove("zoomed"); renderCompare(); } };
async function cmpResolve(all) {
  const g = D.groups.find(x => x.key === CMP.key); if (!g) return;
  let keep = g.files.filter(f => D.choice[g.key][f.id]).map(f => f.id);
  let aside = g.files.filter(f => !D.choice[g.key][f.id]).map(f => f.id);
  if (all) { keep = g.files.map(f => f.id); aside = []; }
  if (!keep.length) return toast("Keep at least one copy.");
  try {
    const r = await api("/api/dupes/resolve", { key: g.key, keep, aside });
    const i = D.groups.indexOf(g);
    D.groups = D.groups.filter(x => x.key !== g.key);
    if (r.moved) toast(`${plural(r.moved, "copy", "copies")} set aside.`);
    refreshState();
    const next = D.groups[Math.min(i, D.groups.length - 1)];
    if (next) { CMP.key = next.key; CMP.zoom = false; $("#cmp").classList.remove("zoomed"); renderCompare(); }
    else { closeCompare(); loadDupes(); }
  } catch (e) { fail(e); }
}
$("#cmp-done").onclick = () => cmpResolve(false);
$("#cmp-all").onclick = () => cmpResolve(true);
document.addEventListener("keydown", (e) => {
  if ($("#cmp").hidden) return;
  if (e.key === "Escape") closeCompare();
  else if (e.key === "ArrowRight") $("#cmp-next").click();
  else if (e.key === "ArrowLeft") $("#cmp-prev").click();
});

$("#dupes-seg").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return;
  D.kind = b.dataset.k;
  $$("#dupes-seg button").forEach(x => x.classList.toggle("on", x === b));
  loadDupes();
};
$("#btn-auto").onclick = () => {
  if (!confirm("Keep the best copy of every exact duplicate and move the others to “_Set aside”?")) return;
  api("/api/dupes/auto-exact", {}).then(() => { S.lastJobFinished = false; refreshState(); }).catch(fail);
};
$("#btn-restore").onclick = () => {
  if (!confirm("Move every set-aside photo back to where it was?")) return;
  api("/api/dupes/restore", {}).then(() => { S.lastJobFinished = false; refreshState(); }).catch(fail);
};

/* ------------------------------------------------------------------ Places: offline map + geotagging */
const PL = { map: null, mapReady: false, src: "none", photos: [], total: 0, sel: new Set(), last: null, shown: 240,
  pin: null, pinMarker: null, info: null, placeId: null, prec: "exact", tags: [], starred: false, mine: [],
  points: [], show: "photos", mode: "map", online: false, ids: [], thumbs: new Map(), mineMarkers: [], sugg: null };

function loadScript(src) {
  return new Promise((ok) => {
    const sc = document.createElement("script"); sc.src = src; sc.async = false;
    sc.onload = () => ok(true); sc.onerror = () => ok(false);
    document.head.appendChild(sc);
  });
}
async function loadMapLibs() {
  if (window.maplibregl && window.pmtiles && window.basemaps) return true;
  if (!loadMapLibs.p) {
    const css = document.createElement("link"); css.rel = "stylesheet"; css.href = "/static/vendor/map/maplibre-gl.css";
    document.head.appendChild(css);
    loadMapLibs.p = Promise.all(["maplibre-gl.js", "pmtiles.js", "basemaps.js"].map(f => loadScript("/static/vendor/map/" + f)))
      .then(r => r.every(Boolean) && !!window.maplibregl);
  }
  return loadMapLibs.p;
}

function mapStyle(info) {
  const origin = location.origin;
  // a calm, photo-first palette on top of the Protomaps "light" style
  const flavor = Object.assign({}, basemaps.namedFlavor("light"), {
    background: "#eef0ea", earth: "#eef0ea", water: "#a6c8da", ocean_label: "#557a92",
    park_a: "#dde8d6", park_b: "#cfe2c8", wood_a: "#d8e5d2", wood_b: "#c7dcc0", scrub_a: "#e1e9d8", scrub_b: "#d3e2cc",
    sand: "#efeadb", beach: "#f1ebd6", glacier: "#f7f7f5", buildings: "#d9d5ce", hospital: "#ebe5e2", school: "#ebe7e0",
    industrial: "#e3e5e3", aerodrome: "#e4e5e5", zoo: "#dde6db", pedestrian: "#ecebe4", military: "#e6e6e3",
    boundaries: "#b9b6b0", city_label: "#4d5452", state_label: "#a9aca8", country_label: "#8f9491",
  });
  flavor.landcover = { grassland: "#e3ebd9", barren: "#efece2", urban_area: "#e8e7e2", farmland: "#e7ecdc",
    glacier: "#f8f8f6", scrub: "#e4eada", forest: "#d6e4d1" };
  const style = { version: 8, glyphs: origin + "/static/vendor/map/fonts/{fontstack}/{range}.pbf",
    sprite: origin + "/static/vendor/map/sprites/light", sources: {}, layers: [] };
  const maps = [];
  if (info.world) maps.push({ key: "world", name: "world" });
  (info.regions || []).forEach(r => maps.push({ key: "r_" + r.id.replace(/[^a-z0-9]/gi, "_"), name: r.id }));
  maps.forEach((m, i) => {
    style.sources[m.key] = { type: "vector", url: `pmtiles://${origin}/maps/${m.name}.pmtiles`,
      attribution: '<a href="https://openstreetmap.org/copyright">© OpenStreetMap</a> · Protomaps' };
    basemaps.layers(m.key, flavor, { lang: "en" }).forEach(l => {
      if (l.type === "background" && i > 0) return;   // one background for the whole map
      style.layers.push(Object.assign({}, l, { id: m.key + ":" + l.id }));
    });
  });
  if (!maps.length) style.layers.push({ id: "bg", type: "background", paint: { "background-color": "#e9eef0" } });
  return style;
}

/* online when there's internet (full detail, satellite), offline map otherwise */
const ONLINE_STYLE = "https://tiles.openfreemap.org/styles/liberty";
async function plCheckOnline() {
  if (!navigator.onLine) return (PL.online = false);
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch(ONLINE_STYLE, { signal: ctl.signal, cache: "no-store" });
    clearTimeout(t);
    if (!r.ok) throw new Error(r.status);
    PL.onlineStyle = await r.json();
    PL.online = true;
  } catch (e) { PL.online = false; }
  return PL.online;
}
function plStyle() {
  if (PL.online && PL.mode === "satellite") {
    return { version: 8, glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
      sources: { sat: { type: "raster", tileSize: 256, maxzoom: 19,
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        attribution: "Imagery © Esri, Maxar, Earthstar Geographics" } },
      layers: [{ id: "sat", type: "raster", source: "sat" }] };
  }
  if (PL.online && PL.onlineStyle) return JSON.parse(JSON.stringify(PL.onlineStyle));
  return mapStyle(PL.mapInfo || {});
}
function plCountFont() { return PL.online ? ["Noto Sans Bold"] : ["Noto Sans Medium"]; }
function plNetLabel() {
  const el = $("#pl-net");
  el.classList.toggle("on", PL.online);
  el.textContent = PL.online ? "Online map" : "Offline map";
  el.title = PL.online ? "Full detail from the internet. Areas you save stay available offline."
    : "No internet: showing the built-in world map and the areas you saved.";
  $$("#pl-show button").forEach(b => { b.classList.toggle("on", b.dataset.v === PL.mode); if (b.dataset.v === "satellite") b.disabled = !PL.online; });
  if (!PL.online) $("#pl-show button[data-v=satellite]").title = "Satellite needs internet";
}
function plApplyStyle() {
  if (!PL.map) return;
  PL.mapReady = false;
  PL.thumbs.forEach(m => m.remove()); PL.thumbs.clear();
  PL.map.setStyle(plStyle(), { diff: false });
  PL.map.once("style.load", () => { PL.mapReady = true; addPhotoLayers(); renderPoints(); plRadius(); plDetailHint(); });
  plNetLabel();
}
async function plRecheck() {
  const was = PL.online;
  await plCheckOnline();
  if (was !== PL.online) plApplyStyle(); else plNetLabel();
}
window.addEventListener("online", plRecheck);
window.addEventListener("offline", plRecheck);

async function initMap() {
  if (PL.map) return true;
  const ok = await loadMapLibs();
  let info = {};
  try { info = await api("/api/map/info"); } catch (e) { /* ignore */ }
  PL.mapInfo = info;
  if (!ok) {
    $("#pl-nomap").hidden = false;
    $("#pl-nomap").innerHTML = `<div><b>The map isn't included in this copy of the app.</b><br>Search, My Places and typing coordinates still work.</div>`;
    return false;
  }
  if (!PL.protocol) { PL.protocol = new pmtiles.Protocol(); maplibregl.addProtocol("pmtiles", PL.protocol.tile); }
  await plCheckOnline();
  plNetLabel();
  const map = PL.map = new maplibregl.Map({ container: "pl-map", style: plStyle(), center: [-61.7, 13.5], zoom: 3,
    attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
  map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-left");
  map.on("load", () => { PL.mapReady = true; addPhotoLayers(); renderPoints(); renderMine(); plShowPin(); });
  map.on("mousemove", (e) => { $("#pl-coords").textContent = fmtLatLon(e.lngLat.lat, e.lngLat.lng); });
  map.on("mouseout", () => { $("#pl-coords").textContent = ""; });
  map.on("click", (e) => {
    if (map.getLayer("pl-clusters")) {
      const hit = map.queryRenderedFeatures(e.point, { layers: ["pl-clusters", "pl-dots"] });
      if (hit.length) return plClickPhotos(hit[0]);
    }
    plSetPin(e.lngLat.lat, e.lngLat.lng, { prec: "exact" });
  });
  map.on("moveend", plThumbs);
  map.on("moveend", plDetailHint);
  map.on("mouseenter", "pl-clusters", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "pl-clusters", () => (map.getCanvas().style.cursor = ""));
  if (!PL.online && !info.world && !(info.regions || []).length) {
    $("#pl-nomap").hidden = false;
    $("#pl-nomap").innerHTML = `<div><b>No map downloaded yet.</b><br>Use Offline Maps to add one. Search and coordinates still work.</div>`;
  }
  return true;
}

function addPhotoLayers() {
  const map = PL.map;
  map.addSource("pl-photos", { type: "geojson", data: { type: "FeatureCollection", features: [] }, cluster: true, clusterRadius: 48, clusterMaxZoom: 16 });
  map.addLayer({ id: "pl-clusters", type: "circle", source: "pl-photos", filter: ["has", "point_count"],
    paint: { "circle-color": "#1f6f6a", "circle-opacity": 0.88, "circle-stroke-color": "#fff", "circle-stroke-width": 2,
      "circle-radius": ["step", ["get", "point_count"], 14, 20, 18, 200, 23, 1000, 28] } });
  map.addLayer({ id: "pl-count", type: "symbol", source: "pl-photos", filter: ["has", "point_count"],
    layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": plCountFont(), "text-size": 12, "text-allow-overlap": true },
    paint: { "text-color": "#fff" } });
  map.addLayer({ id: "pl-dots", type: "circle", source: "pl-photos", filter: ["!", ["has", "point_count"]],
    paint: { "circle-radius": 6, "circle-color": ["case", ["==", ["get", "p"], "exact"], "#1f6f6a", "#ffffff"],
      "circle-stroke-color": "#1f6f6a", "circle-stroke-width": 2 } });
  map.addSource("pl-radius", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "pl-radius", type: "fill", source: "pl-radius", paint: { "fill-color": "#e0533d", "fill-opacity": 0.12 } });
  map.addLayer({ id: "pl-radius-line", type: "line", source: "pl-radius", paint: { "line-color": "#e0533d", "line-width": 1.5, "line-dasharray": [2, 2] } });
}

function renderPoints() {
  if (!PL.mapReady) return;
  PL.map.getSource("pl-photos").setData({ type: "FeatureCollection", features: PL.points.map(p => ({
    type: "Feature", geometry: { type: "Point", coordinates: [p[2], p[1]] }, properties: { id: p[0], p: p[3] } })) });
  setTimeout(plThumbs, 300);
}

// close up, single photos show as little thumbnails at their spot
function plThumbs() {
  if (!PL.mapReady) return;
  const map = PL.map, want = new Map();
  if (map.getZoom() >= 11) {
    for (const f of map.queryRenderedFeatures({ layers: ["pl-dots"] })) {
      if (want.size >= 150) break;
      want.set(f.properties.id, f);
    }
  }
  for (const [id, m] of PL.thumbs) if (!want.has(id)) { m.remove(); PL.thumbs.delete(id); }
  for (const [id, f] of want) {
    if (PL.thumbs.has(id)) continue;
    const el = document.createElement("div");
    el.className = "pl-thumb" + (f.properties.p !== "exact" ? " approx" : "");
    el.style.backgroundImage = `url(/thumb/${id})`;
    el.title = "Click to see the photos here";
    el.onclick = (ev) => { ev.stopPropagation(); plShowSource("here", [id]); };
    PL.thumbs.set(id, new maplibregl.Marker({ element: el }).setLngLat(f.geometry.coordinates).addTo(map));
  }
}

async function plClickPhotos(f) {
  if (f.properties.cluster) {
    const src = PL.map.getSource("pl-photos");
    const leaves = await src.getClusterLeaves(f.properties.cluster_id, 5000, 0);
    plShowSource("here", leaves.map(l => l.properties.id));
    const z = await src.getClusterExpansionZoom(f.properties.cluster_id);
    PL.map.easeTo({ center: f.geometry.coordinates, zoom: z });
  } else plShowSource("here", [f.properties.id]);
}

function renderMine() {
  PL.mineMarkers.forEach(m => m.remove()); PL.mineMarkers = [];
  if (!PL.mapReady) return;
  for (const p of PL.mine) {
    if (p.id === PL.placeId && PL.pin) continue;   // the pin already shows this one
    const el = document.createElement("div");
    el.className = "pl-mine";
    el.innerHTML = `<i>${p.starred ? "★" : "◆"}</i>${esc(p.name)}`;
    el.onclick = (ev) => { ev.stopPropagation(); plUseMine(p, true); };
    PL.mineMarkers.push(new maplibregl.Marker({ element: el, anchor: "left", offset: [-10, 0] }).setLngLat([p.lon, p.lat]).addTo(PL.map));
  }
}

async function copyText(txt) {
  try { await navigator.clipboard.writeText(txt); toast("Copied " + txt); }
  catch (e) { prompt("Copy these coordinates:", txt); }
}
function fmtLatLon(lat, lon) {
  return `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? "E" : "W"}`;
}

async function loadPlaces() {
  api("/api/places/warm", {}).catch(() => {});
  const [mine, pts] = await Promise.all([api("/api/places/mine").catch(() => []), api("/api/places/points").catch(() => [])]);
  PL.mine = mine; PL.points = pts;
  await plLoadPhotos();
  await initMap();
  if (PL.map) { PL.map.resize(); renderPoints(); renderMine(); }
  renderInsp();
}

async function plLoadPhotos() {
  let r;
  try {
    r = PL.src === "none" ? await api("/api/places/photos")
      : PL.src === "located" ? await api("/api/places/photos", { mode: "located", q: $("#pl-filter").value.trim() })
      : await api("/api/places/photos", { ids: PL.ids });
  } catch (e) { return fail(e); }
  PL.photos = r.items; PL.total = r.total;
  const have = new Set(PL.photos.map(p => p.id));
  PL.sel = new Set([...PL.sel].filter(id => have.has(id)));
  renderFilm();
}

function plShowSource(src, ids) {
  PL.src = src;
  if (ids) PL.ids = ids;
  $$("#pl-src button").forEach(b => { b.classList.toggle("on", b.dataset.v === src); if (b.dataset.v === src) b.hidden = false; });
  PL.sel = new Set(src === "none" || src === "located" ? [] : PL.ids);
  PL.shown = 240;
  $("#pl-filter").hidden = src !== "located";
  if (src === "located") $("#pl-filter").focus();
  plLoadPhotos().then(async () => {
    renderInsp();
    if (src !== "none" && src !== "located") {
      if (PL.focusOnLoad) { PL.focusOnLoad = false; await initMap(); const p = PL.photos.find(x => x.lat != null);
        if (p && PL.map) PL.map.jumpTo({ center: [p.lon, p.lat], zoom: 15 }); }
      else plFit();
    }
  });
}

// open Places with particular photos chosen, e.g. from Tidy Up
function openPlaces(ids, focus) {
  showTab("locations");
  plShowSource("ids", ids);
  if (focus) PL.focusOnLoad = true;
}

function renderFilm() {
  const list = PL.photos.slice(0, PL.shown);
  let html = "", day = null;
  list.forEach((p, i) => {
    const d = p.taken ? p.taken.slice(0, 10) : "";
    if (d !== day) { day = d; html += `<div class="day">${d ? fmtDay(d) : "No date"}</div>`; }
    const tag = p.lat != null ? `<span class="tag">${esc(shortPlace(p.place || "") || "Has a location")}${p.precision && p.precision !== "exact" ? " (approx.)" : ""}</span>`
      : p.suggest ? `<span class="tag sug" title="Suggested from ${esc(p.suggest.why)}">≈ ${esc(shortPlace(p.suggest.place || ""))}</span>` : "";
    const tip = p.name + (p.lat != null ? `\n${p.place || ""}\n${fmtLatLon(p.lat, p.lon)}` : "");
    html += `<div class="pl-ph ${PL.sel.has(p.id) ? "on" : ""}" data-i="${i}" data-id="${p.id}" title="${esc(tip)}">
      <img loading="lazy" src="/thumb/${p.id}" alt=""><span class="ck"></span>${p.kind === "video" ? `<span class="vid">▶</span>` : ""}${tag}</div>`;
  });
  if (PL.photos.length > PL.shown) html += `<button class="ghost more" id="pl-more">Show ${n(Math.min(240, PL.photos.length - PL.shown))} more</button>`;
  if (!PL.photos.length) html = `<div class="empty2">${PL.src === "none" ? "✓ Every photo has a location. To change some, use Has a location, or click a group of photos on the map."
    : PL.src === "located" ? "No photos with a location match that." : "No photos here."}</div>`;
  $("#pl-film").innerHTML = html;
  plSelChanged();
}

function plSelChanged() {
  const k = PL.sel.size;
  $("#pl-count").textContent = PL.src === "none" || PL.src === "located"
    ? `${n(k)} of ${plural(PL.total, "photo")} selected${PL.total > PL.photos.length ? ` (showing ${n(PL.photos.length)} newest)` : ""}`
    : `${n(k)} of ${plural(PL.photos.length, "photo")} selected`;
  $("#pl-apply").textContent = `Apply to ${plural(k, "Photo", "Photos")}`;
  $("#pl-apply").disabled = !k || !PL.pin;
  // suggestions from photos taken nearby in time
  const sug = PL.photos.filter(p => PL.sel.has(p.id) && p.suggest);
  const box = $("#pl-sugg");
  if (sug.length) {
    const top = Object.entries(sug.reduce((a, p) => ((a[p.suggest.place] = (a[p.suggest.place] || 0) + 1), a), {})).sort((a, b) => b[1] - a[1])[0][0];
    box.hidden = false;
    box.innerHTML = `<b>${plural(sug.length, "selected photo")}</b> ${sug.length === 1 ? "was" : "were"} taken close in time to photos at <b>${esc(shortPlace(top))}</b>${sug.length > 1 ? " and nearby places" : ""}.<br>
      <button class="link" id="pl-use-sugg">Use those locations</button>`;
  } else box.hidden = true;
  if (!PL.pin) { $("#pl-insp-empty").hidden = false; $("#pl-form").hidden = true; $("#pl-insp-empty").appendChild(box); }
  else $("#pl-form").appendChild(box);
}

$("#pl-film").onclick = (e) => {
  if (e.target.id === "pl-more") { PL.shown += 240; return renderFilm(); }
  const el = e.target.closest(".pl-ph"); if (!el) return;
  const i = +el.dataset.i, id = +el.dataset.id;
  if (e.shiftKey && PL.last != null) {
    const [a, b] = [Math.min(PL.last, i), Math.max(PL.last, i)];
    const on = !PL.sel.has(id) || true;
    for (let j = a; j <= b; j++) on ? PL.sel.add(PL.photos[j].id) : PL.sel.delete(PL.photos[j].id);
    renderFilm(); if (!PL.pin) renderInsp();
  } else {
    PL.sel.has(id) ? PL.sel.delete(id) : PL.sel.add(id);
    el.classList.toggle("on", PL.sel.has(id));
    if (!PL.pin) renderInsp(); else plSelChanged();
  }
  PL.last = i;
};
$("#pl-film").ondblclick = (e) => {
  const el = e.target.closest(".pl-ph"); if (!el) return;
  openViewer(PL.photos, +el.dataset.i);
};
$("#pl-film").addEventListener("wheel", (e) => {   // a mouse wheel scrolls the filmstrip sideways
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { $("#pl-film").scrollLeft += e.deltaY; e.preventDefault(); }
}, { passive: false });
$("#pl-all").onclick = () => { PL.photos.forEach(p => PL.sel.add(p.id)); renderFilm(); if (!PL.pin) renderInsp(); };
$("#pl-none").onclick = () => { PL.sel.clear(); renderFilm(); if (!PL.pin) renderInsp(); };
$("#pl-src").onclick = (e) => { const b = e.target.closest("button"); if (b) plShowSource(b.dataset.v); };
let plFilterTimer;
$("#pl-filter").addEventListener("input", () => { clearTimeout(plFilterTimer); plFilterTimer = setTimeout(() => { PL.sel.clear(); plLoadPhotos().then(plFit); }, 300); });
$("#pl-show").onclick = async (e) => {
  const b = e.target.closest("button"); if (!b || b.disabled) return;
  PL.mode = b.dataset.v;
  await plCheckOnline();
  plApplyStyle();
};

/* the pin and the inspector */
async function plSetPin(lat, lon, opts = {}) {
  PL.pin = { lat, lon };
  if (opts.prec) plSetPrec(opts.prec);
  if (opts.radius) $("#pl-radius").value = String(opts.radius);
  if (opts.name !== undefined) $("#pl-name").value = opts.name;
  if (!opts.keepPlace && PL.placeId) { PL.placeId = null; $("#pl-del-place").hidden = true; renderMine(); }
  plShowPin();
  renderInsp();
  try { PL.info = await api(`/api/places/details?lat=${lat}&lon=${lon}`); } catch (e) { PL.info = null; }
  renderInsp();
}

function plShowPin() {
  if (!PL.mapReady) return;
  if (!PL.pin) { if (PL.pinMarker) { PL.pinMarker.remove(); PL.pinMarker = null; } plRadius(); return; }
  if (!PL.pinMarker) {
    const el = document.createElement("div");
    el.className = "pl-pin";
    el.innerHTML = `<svg viewBox="0 0 30 40"><path d="M15 39s12-13.2 12-23A12 12 0 0 0 3 16c0 9.8 12 23 12 23z" fill="#e0533d" stroke="#fff" stroke-width="2"/><circle cx="15" cy="16" r="4.5" fill="#fff"/></svg><span class="pl-pin-label" hidden></span>`;
    PL.pinMarker = new maplibregl.Marker({ element: el, draggable: true, anchor: "bottom" }).setLngLat([PL.pin.lon, PL.pin.lat]).addTo(PL.map);
    PL.pinMarker.on("dragend", () => { const ll = PL.pinMarker.getLngLat(); plSetPin(ll.lat, ll.lng, { keepPlace: false }); });
  }
  PL.pinMarker.setLngLat([PL.pin.lon, PL.pin.lat]);
  const label = PL.pinMarker.getElement().querySelector(".pl-pin-label");
  label.textContent = $("#pl-name").value.trim(); label.hidden = !label.textContent;
  plRadius();
}

function plRadius() {
  if (!PL.mapReady) return;
  const src = PL.map.getSource("pl-radius"); if (!src) return;
  if (!PL.pin || PL.prec === "exact") return src.setData({ type: "FeatureCollection", features: [] });
  const r = +$("#pl-radius").value, pts = [];
  for (let k = 0; k <= 64; k++) {
    const a = (k / 64) * 2 * Math.PI;
    const dLat = (r / 111320) * Math.sin(a), dLon = (r / (111320 * Math.cos(PL.pin.lat * Math.PI / 180))) * Math.cos(a);
    pts.push([PL.pin.lon + dLon, PL.pin.lat + dLat]);
  }
  src.setData({ type: "Feature", geometry: { type: "Polygon", coordinates: [pts] } });
}

function plSetPrec(v) {
  PL.prec = v;
  $$("#pl-prec button").forEach(b => b.classList.toggle("on", b.dataset.v === v));
  $("#pl-radius-row").hidden = v === "exact";
  if (v === "place" && +$("#pl-radius").value < 2000) $("#pl-radius").value = "10000";
  plRadius();
}

// where the selected photos are now (so a wrong place is easy to spot and fix)
function plCurrentHtml() {
  const located = PL.photos.filter(p => PL.sel.has(p.id) && p.lat != null);
  if (!located.length) return "";
  const groups = new Map();
  located.forEach(p => { const k = `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`; if (!groups.has(k)) groups.set(k, { p, n: 0 }); groups.get(k).n++; });
  const first = [...groups.values()][0].p;
  const head = groups.size === 1
    ? `<b>${esc((first.place || "").split(",")[0].trim() || "Current location")}</b><div>${esc((first.place || "").split(",").slice(1).join(",").trim())}</div>
       <div class="ll">${fmtLatLon(first.lat, first.lon)}</div>`
    : `<b>${plural(located.length, "selected photo")} in ${n(groups.size)} different places</b>
       <div class="ll">${[...groups.values()].slice(0, 4).map(g => esc(shortPlace(g.p.place || "") || fmtLatLon(g.p.lat, g.p.lon)) + ` (${g.n})`).join(" · ")}</div>`;
  return `<div class="pl-cur"><div class="muted small">${located.length === 1 ? "This photo is at" : groups.size === 1 ? `These ${plural(located.length, "photo")} are at` : "Now at"}</div>${head}
    <div class="row2">${groups.size === 1 ? `<button class="link" data-cur="edit">Use this location</button><button class="link" data-cur="copy">Copy coordinates</button>` : ""}
    <button class="link" data-cur="show">Show on map</button></div></div>`;
}

// copy one photo's location onto others: the pin goes exactly where that photo is
function plUseLocationOf(p, switchToNeeding) {
  const mine = p.place_id ? PL.mine.find(m => m.id === p.place_id) : null;
  if (mine) plUseMine(mine, true);
  else {
    $("#pl-name").value = ""; PL.tags = []; $("#pl-type").value = ""; $("#pl-notes").value = "";
    plSetPin(p.lat, p.lon, { prec: p.precision || "exact", radius: p.radius || undefined,
      name: (p.place || "").split(",")[0].trim() });
    if (PL.map) PL.map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(PL.map.getZoom(), 15) });
  }
  PL.copiedFrom = p.id;
  if (switchToNeeding) plShowSource("none");
  else { PL.sel.delete(p.id); renderFilm(); }
  toast("Location copied. Now select the photos that should get it — e.g. under Need a location — then press Apply.", 6000);
}

function renderInsp() {
  const has = !!PL.pin;
  $("#pl-form").hidden = !has;
  $("#pl-insp-empty").hidden = has;
  if (!has) {
    $("#pl-form").appendChild($("#pl-sugg"));   // keep the suggestion box safe while the empty panel is redrawn
    const list = PL.mine.length
      ? `<div class="pl-minelist"><h5>My Places</h5>${PL.mine.map(p => `<button class="ghost" data-mine="${p.id}">${p.starred ? "★ " : ""}${esc(p.name)}<span class="muted small"> · ${plural(p.photos, "photo")}</span></button>`).join("")}</div>` : "";
    $("#pl-insp-empty").innerHTML = `<div class="pl-empty-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg></div>
      <b>Choose a location</b>
      <p>Select photos below, then search for a place (or type coordinates), pick one of My Places, or click the map to drop a pin. Drag the pin to fine-tune it.</p>${plCurrentHtml()}${list}`;
    return plSelChanged();
  }
  const i = PL.info || {};
  $("#pl-addr").innerHTML = [i.city && (i.city_km > 3 ? "Near " + i.city : i.city), [i.region, i.state].filter(Boolean).join(", "), i.country]
    .filter(Boolean).map(esc).join("<br>") || (PL.info ? "Out at sea" : "…");
  $("#pl-ll").textContent = fmtLatLon(PL.pin.lat, PL.pin.lon);
  const rows = [["Country", i.country], ["State", i.state], ["Region", i.region], ["Nearest City", i.city ? `${i.city}${i.city_km != null ? ` (${i.city_km} km)` : ""}` : null],
    ["Accuracy", { exact: "Exact spot", approx: `Within about ${$("#pl-radius").selectedOptions[0].text}`, place: "Somewhere in this area" }[PL.prec]]];
  $("#pl-dl").innerHTML = rows.filter(r => r[1]).map(r => `<dt>${r[0]}</dt><dd>${esc(r[1])}</dd>`).join("");
  $("#pl-tags").innerHTML = PL.tags.map((t, k) => `<span>${esc(t)}<button data-k="${k}" aria-label="Remove">×</button></span>`).join("");
  $("#pl-star").textContent = PL.starred ? "★" : "☆";
  plSelChanged();
}

$("#pl-insp").onclick = (e) => {
  const m = e.target.closest("[data-mine]");
  if (m) { const p = PL.mine.find(x => x.id === +m.dataset.mine); if (p) plUseMine(p, true); return; }
  if (e.target.id === "pl-use-sugg") return plUseSugg();
  const cur = e.target.closest("[data-cur]");
  if (cur) {
    const located = PL.photos.filter(p => PL.sel.has(p.id) && p.lat != null);
    const p = located[0]; if (!p) return;
    if (cur.dataset.cur === "copy") return copyText(`${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`);
    if (cur.dataset.cur === "show") return plFit();
    return plUseLocationOf(p, false);
  }
  const t = e.target.closest("#pl-tags button");
  if (t) { PL.tags.splice(+t.dataset.k, 1); renderInsp(); }
};
$("#pl-prec").onclick = (e) => { const b = e.target.closest("button"); if (b) { plSetPrec(b.dataset.v); renderInsp(); } };
$("#pl-radius").onchange = () => { plRadius(); renderInsp(); };
$("#pl-name").addEventListener("input", plShowPin);
$("#pl-star").onclick = () => { PL.starred = !PL.starred; renderInsp(); };
$("#pl-tag-in").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== ",") return;
  e.preventDefault();
  const v = e.target.value.trim().replace(/,$/, "");
  if (v && !PL.tags.some(t => t.toLowerCase() === v.toLowerCase())) PL.tags.push(v);
  e.target.value = ""; renderInsp();
});
$("#pl-copy").onclick = async () => {
  if (!PL.pin) return;
  const txt = `${PL.pin.lat.toFixed(6)}, ${PL.pin.lon.toFixed(6)}`;
  try { await navigator.clipboard.writeText(txt); toast("Copied " + txt); } catch (e) { prompt("Coordinates", txt); }
};

function plUseMine(p, fly) {
  $("#pl-name").value = p.name; $("#pl-type").value = p.type || ""; $("#pl-notes").value = p.notes || "";
  PL.tags = [...(p.tags || [])]; PL.starred = !!p.starred;
  plSetPin(p.lat, p.lon, { prec: p.precision || "exact", radius: p.radius, keepPlace: true });
  PL.placeId = p.id; $("#pl-del-place").hidden = false; renderMine();
  if (fly && PL.map) PL.map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(PL.map.getZoom(), 15) });
}

$("#pl-save-place").onclick = async () => {
  if (!PL.pin) return;
  try {
    const p = await api("/api/places/save", { id: PL.placeId, name: $("#pl-name").value, lat: PL.pin.lat, lon: PL.pin.lon,
      precision: PL.prec, radius: PL.prec === "exact" ? null : +$("#pl-radius").value, type: $("#pl-type").value,
      tags: PL.tags, notes: $("#pl-notes").value, starred: PL.starred, cover_id: [...PL.sel][0] || null });
    PL.placeId = p.id; $("#pl-del-place").hidden = false;
    PL.mine = await api("/api/places/mine"); renderMine(); plShowPin();
    toast(`Saved “${p.name}” to My Places.`);
  } catch (e) { fail(e); }
};
$("#pl-del-place").onclick = async () => {
  if (!PL.placeId || !confirm("Remove this place from My Places? Photos keep their location.")) return;
  try { await api("/api/places/delete", { id: PL.placeId }); PL.placeId = null; $("#pl-del-place").hidden = true;
    PL.mine = await api("/api/places/mine"); renderMine(); renderInsp(); } catch (e) { fail(e); }
};

function plReset() {
  PL.pin = null; PL.info = null; PL.placeId = null; PL.tags = []; PL.starred = false;
  $("#pl-name").value = ""; $("#pl-type").value = ""; $("#pl-notes").value = "";
  plSetPrec("exact"); plShowPin(); renderInsp();
}
$("#pl-cancel").onclick = () => { plReset(); PL.sel.clear(); renderFilm(); };
$("#pl-add").onclick = () => {
  const c = PL.map ? PL.map.getCenter() : { lat: 13.5, lng: -61.7 };
  plReset(); plSetPin(c.lat, c.lng, { prec: "exact" });
  $("#pl-name").focus();
  toast("Drag the pin to the spot, name it, then Save to My Places.");
};
$("#pl-fit").onclick = plFit;
function plFit() {
  if (!PL.map) return;
  const pts = PL.photos.filter(p => p.lat != null && (!PL.sel.size || PL.sel.has(p.id)));
  const use = pts.length ? pts.map(p => [p.lon, p.lat]) : PL.points.map(p => [p[2], p[1]]);
  if (!use.length) return;
  const b = use.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(use[0], use[0]));
  PL.map.fitBounds(b, { padding: 60, maxZoom: 15, duration: 600 });
}

$("#pl-apply").onclick = () => {
  const ids = [...PL.sel];
  if (!ids.length || !PL.pin) return;
  const had = PL.photos.filter(p => PL.sel.has(p.id) && p.lat != null).length;
  if (had && !confirm(`${plural(had, "of these photos already has", "of these photos already have")} a location. Replace it with this one?`)) return;
  api("/api/places/apply", { ids, lat: PL.pin.lat, lon: PL.pin.lon, name: $("#pl-name").value.trim() || null,
    precision: PL.prec, radius: PL.prec === "exact" ? null : +$("#pl-radius").value, place_id: PL.placeId })
    .then(() => refreshState()).catch(fail);
};

async function plUseSugg() {
  const ids = PL.photos.filter(p => PL.sel.has(p.id) && p.suggest).map(p => p.id);
  try {
    const r = await api("/api/locations/accept", { ids });
    toast(`Location added to ${plural(r.updated, "photo")}. It's saved into the files next time you Tidy Up or file them.`);
    PL.sel.clear(); refreshState(); loadPlaces();
  } catch (e) { fail(e); }
}

/* search */
let plTimer, plSeq = 0;
$("#pl-q").addEventListener("input", () => {
  PL.searchedOnline = false;
  $("#pl-q-x").hidden = !$("#pl-q").value;
  clearTimeout(plTimer); plTimer = setTimeout(plSearch, 220);
});
$("#pl-q").addEventListener("keydown", (e) => {
  const list = $$("#pl-results button[data-r]"); if (!list.length) return;
  let k = list.findIndex(b => b.classList.contains("on"));
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault(); k = e.key === "ArrowDown" ? Math.min(list.length - 1, k + 1) : Math.max(0, k - 1);
    list.forEach((b, j) => b.classList.toggle("on", j === k));
  } else if (e.key === "Enter") { e.preventDefault(); (list[k] || list[0]).click(); }
  else if (e.key === "Escape") $("#pl-results").hidden = true;
});
$("#pl-q-x").onclick = () => { $("#pl-q").value = ""; $("#pl-q-x").hidden = true; $("#pl-results").hidden = true; };
async function plSearch() {
  const q = $("#pl-q").value.trim();
  if (q.length < 2) { $("#pl-results").hidden = true; return; }
  const seq = ++plSeq;
  let r = [];
  try { r = await api(`/api/places/search?q=${encodeURIComponent(q)}`); } catch (e) { r = []; }
  if (seq !== plSeq) return;
  PL.results = r;
  plShowResults(q);
}
function plShowResults(q, note) {
  const r = PL.results;
  $("#pl-results").hidden = false;
  $("#pl-results").innerHTML = (r.length ? r.map((x, i) => `<button data-r="${i}"><span><b>${esc(x.name)}</b><span class="d">${esc(x.label || "")}</span></span>
      <span class="k ${x.kind === "My place" ? "mine" : ""}">${esc(x.kind || "")}</span></button>`).join("")
    : `<div class="none">Nothing found offline for “${esc(q)}”. Try a nearby town, or paste coordinates like 39.0963, -120.0324.</div>`)
    + (note ? `<div class="none">${esc(note)}</div>` : "")
    + (PL.online && !PL.searchedOnline ? `<button data-online="1"><span><b>Search online for “${esc(q)}”</b><span class="d">Street addresses, businesses and more</span></span><span class="k">Online</span></button>` : "");
}
async function plSearchOnline() {
  const q = $("#pl-q").value.trim(); if (!q) return;
  PL.searchedOnline = true;
  let r = [], note = "";
  try { r = await api(`/api/places/online?q=${encodeURIComponent(q)}`); } catch (e) { note = e.message; }
  if (!r.length && !note) note = "Nothing more found online.";
  PL.results = r.concat(PL.results.filter(x => !r.some(y => y.lat === x.lat && y.lon === x.lon)));
  plShowResults(q, note);
}
$("#pl-results").onclick = (e) => {
  if (e.target.closest("[data-online]")) { e.stopPropagation(); return plSearchOnline(); }
  const b = e.target.closest("[data-r]"); if (!b) return;
  const x = PL.results[+b.dataset.r];
  $("#pl-results").hidden = true;
  if (x.place_id) { const p = PL.mine.find(m => m.id === x.place_id); if (p) return plUseMine(p, true); }
  if (PL.map) PL.map.flyTo({ center: [x.lon, x.lat], zoom: x.zoom || 12 });
  const exact = x.kind === "Coordinates";
  plSetPin(x.lat, x.lon, exact ? { prec: "exact" } : { prec: "place", name: x.name, radius: x.zoom >= 14 ? 500 : x.zoom >= 11 ? 2000 : 10000 });
};
document.addEventListener("click", (e) => {
  if (!e.target.closest(".pl-search")) $("#pl-results").hidden = true;
  if (!e.target.closest(".pl-dd")) $("#pl-offline-menu").hidden = true;
});

/* "only main roads here" — offer to download the area on screen */
function plCovered(lat, lon) {
  return (PL.mapInfo && PL.mapInfo.regions || []).some(r => r.maxzoom >= 13 &&
    lon >= r.bbox[0] && lon <= r.bbox[2] && lat >= r.bbox[1] && lat <= r.bbox[3]);
}
function plDetailHint() {
  const box = $("#pl-detail");
  if (!PL.map || PL.detailOff) { box.hidden = true; return; }
  const c = PL.map.getCenter();
  const show = (PL.forceSave || (!PL.online && PL.map.getZoom() >= 8 && !plCovered(c.lat, c.lng))) && PL.mapInfo && PL.mapInfo.tool;
  if (show && box.hidden) { $("#pl-detail b").textContent = "Only main roads here."; $("#pl-detail-go").disabled = false; $("#pl-detail-go").textContent = "Download this area";
    $("#pl-detail-t").textContent = "Download this area to see every road, street and building — it then works offline too."; PL.detailArea = null; }
  box.hidden = !show;
}
$("#pl-detail-x").onclick = () => { PL.detailOff = !PL.forceSave; PL.forceSave = false; $("#pl-detail").hidden = true; };
$("#pl-save-area").onclick = () => {
  if (!PL.mapInfo || !PL.mapInfo.tool) return toast("Saving maps isn't available in this copy of the app.");
  PL.forceSave = true; PL.detailOff = false; $("#pl-detail").hidden = true; plDetailHint();
  $("#pl-detail b").textContent = plCovered(PL.map.getCenter().lat, PL.map.getCenter().lng) ? "Already saved nearby." : "Save this area for offline use.";
  $("#pl-detail-t").textContent = "Keeps every road, street and building on screen available without internet. It's saved on your photo drive.";
};
$("#pl-detail-go").onclick = async () => {
  const btn = $("#pl-detail-go"), t = $("#pl-detail-t");
  if (PL.detailArea) {   // second click: size is known, download it
    try { await api("/api/map/download", PL.detailArea); $("#pl-detail").hidden = true; PL.detailArea = null; PL.forceSave = false; refreshState(); }
    catch (e) { t.textContent = e.message; }
    return;
  }
  const b = PL.map.getBounds(), c = b.getCenter();
  // at least a small town's worth around the middle, at most what's on screen
  const w = Math.max(b.getEast() - b.getWest(), 0.12), h = Math.max(b.getNorth() - b.getSouth(), 0.08);
  const bbox = [c.lng - w / 2, c.lat - h / 2, c.lng + w / 2, c.lat + h / 2];
  btn.disabled = true; t.textContent = "Checking how big this area is… (needs internet)";
  let name = "Area";
  try { const d = await api(`/api/places/details?lat=${c.lat}&lon=${c.lng}`); if (d.city) name = "Around " + d.city; } catch (e) { /* ignore */ }
  try {
    const r = await api("/api/map/estimate", { bbox, maxzoom: 15 });
    const size = r.bytes || 0;
    if (size > 2.5e9) { t.textContent = `This area is large (about ${fmtSize(size)}). Zoom in closer to download a smaller area.`; btn.disabled = false; return; }
    PL.detailArea = { name, bbox, maxzoom: 15 };
    t.textContent = `${name}: about ${fmtSize(size)}. It's saved on your photo drive.`;
    btn.textContent = "Download"; btn.disabled = false;
  } catch (e) { t.textContent = e.message; btn.disabled = false; }
};

/* offline maps */
$("#pl-offline").onclick = async () => {
  const menu = $("#pl-offline-menu");
  if (!menu.hidden) { menu.hidden = true; return; }
  let info;
  try { info = PL.mapInfo = await api("/api/map/info"); } catch (e) { return fail(e); }
  menu.innerHTML = `<h4>On this drive</h4>
    ${info.world ? `<div class="row"><div class="grow">World overview<small>Countries, cities and main roads — built in</small></div></div>` : ""}
    ${info.regions.map(r => `<div class="row"><div class="grow">${esc(r.name)}<small>${fmtSize(r.size)} · ${r.maxzoom >= 15 ? "streets & buildings" : "roads & towns"}</small></div>
      <button class="link danger" data-del="${esc(r.id)}">Delete</button></div>`).join("") || `<p class="note">No detailed maps yet.</p>`}
    <h4 style="margin-top:14px">Add a detailed map</h4>
    ${info.tool ? `<select id="pl-dl-region"><option value="view">The area on screen now</option>${info.presets.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join("")}</select>
    <select id="pl-dl-zoom"><option value="15">Streets & buildings (best for finding a house)</option><option value="13">Roads & towns (smaller)</option></select>
    <div class="dl-row"><button class="ghost" id="pl-dl-size">Check size</button><button class="dark" id="pl-dl-go">Download</button></div>
    <p class="note" id="pl-dl-note">Maps are saved on your photo drive, so they work offline and travel with your photos. Downloading needs internet.</p>`
    : `<p class="note">Downloading more maps isn't available in this copy of the app.</p>`}`;
  menu.hidden = false;
};
function plRegionChoice() {
  const v = $("#pl-dl-region").value;
  if (v === "view") {
    if (!PL.map) throw new Error("The map isn't showing.");
    const b = PL.map.getBounds();
    return { name: "Area near " + (PL.info && PL.info.city ? PL.info.city : `${b.getCenter().lat.toFixed(2)}, ${b.getCenter().lng.toFixed(2)}`),
      bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] };
  }
  return PL.mapInfo.presets[+v];
}
$("#pl-offline-menu").onclick = async (e) => {
  e.stopPropagation();
  const del = e.target.closest("[data-del]");
  if (del) {
    if (!confirm("Delete this map from the drive? You can download it again later.")) return;
    try { await api("/api/map/delete", { id: del.dataset.del }); plReloadMap(); $("#pl-offline-menu").hidden = true; } catch (e2) { fail(e2); }
    return;
  }
  if (e.target.id === "pl-dl-size") {
    $("#pl-dl-note").textContent = "Checking…";
    try {
      const c = plRegionChoice();
      const r = await api("/api/map/estimate", { bbox: c.bbox, maxzoom: +$("#pl-dl-zoom").value });
      $("#pl-dl-note").textContent = r.bytes ? `${c.name}: about ${fmtSize(r.bytes)}.` : "Couldn't work out the size.";
    } catch (e2) { $("#pl-dl-note").textContent = e2.message; }
  }
  if (e.target.id === "pl-dl-go") {
    try {
      const c = plRegionChoice();
      await api("/api/map/download", { name: c.name, bbox: c.bbox, maxzoom: +$("#pl-dl-zoom").value });
      $("#pl-offline-menu").hidden = true; refreshState();
    } catch (e2) { fail(e2); }
  }
};
function plReloadMap() {
  if (!PL.map) return;
  PL.thumbs.forEach(m => m.remove()); PL.thumbs.clear();
  PL.mineMarkers.forEach(m => m.remove()); PL.mineMarkers = [];
  if (PL.pinMarker) { PL.pinMarker.remove(); PL.pinMarker = null; }
  const c = PL.map.getCenter(), z = PL.map.getZoom();
  PL.map.remove(); PL.map = null; PL.mapReady = false;
  $("#pl-nomap").hidden = true;
  initMap().then(() => { if (PL.map) PL.map.jumpTo({ center: c, zoom: z }); plDetailHint(); });
}

/* ------------------------------------------------------------------ place picker */
const P = { ids: [], chosen: null, map: null, marker: null, done: null, results: [] };

function openPicker(ids, title, done, initial, onPick) {
  P.ids = ids; P.done = done; P.chosen = null; P.onPick = onPick || null;
  $("#pk-title").textContent = title;
  $("#pk-q").value = initial && initial !== "At sea" ? initial.split(",")[0].replace(/^Near /, "") : "";
  $("#pk-results").innerHTML = "";
  $("#pk-chosen").textContent = "";
  $("#pk-save").disabled = true;
  $("#picker").hidden = false;
  setTimeout(() => {
    ensureMap();
    $("#pk-q").focus();
    if ($("#pk-q").value) searchPlaces();
  }, 30);
}

// the map library is loaded only when a map is opened, so a slow connection never holds up the app
function loadLeaflet() {
  if (window.L) return Promise.resolve(true);
  if (loadLeaflet.p) return loadLeaflet.p;
  const add = (css, js) => new Promise((ok) => {
    const l = document.createElement("link"); l.rel = "stylesheet"; l.href = css; document.head.appendChild(l);
    const sc = document.createElement("script"); sc.src = js; sc.async = true;
    const t = setTimeout(() => ok(false), 15000);
    sc.onload = () => { clearTimeout(t); ok(!!window.L); }; sc.onerror = () => { clearTimeout(t); ok(false); };
    document.head.appendChild(sc);
  });
  loadLeaflet.p = add("/static/vendor/leaflet/leaflet.css", "/static/vendor/leaflet/leaflet.js").then(ok => ok ||
    add("https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css", "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"))
    .then(ok => { if (!ok) loadLeaflet.p = null; return ok; });
  return loadLeaflet.p;
}

async function ensureMap() {
  if (!window.L) await loadLeaflet();
  if (!window.L) { $("#pk-map").innerHTML = `<p class="muted small" style="padding:14px">Map needs an internet connection. Search still works.</p>`; return; }
  if (!P.map) {
    P.map = window.L.map("pk-map", { worldCopyJump: true }).setView([14, -62], 5);
    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18, attribution: "© OpenStreetMap",
    }).addTo(P.map);
    P.map.on("click", (e) => choose({ name: null, label: "Dropped pin", lat: e.latlng.lat, lon: e.latlng.lng }, false));
  }
  setTimeout(() => P.map.invalidateSize(), 50);
}

function choose(place, fly = true) {
  P.chosen = place;
  $("#pk-chosen").textContent = place.label + ` (${place.lat.toFixed(4)}, ${place.lon.toFixed(4)})`;
  $("#pk-save").disabled = false;
  if (P.map) {
    if (!P.marker) P.marker = window.L.marker([place.lat, place.lon]).addTo(P.map);
    P.marker.setLatLng([place.lat, place.lon]);
    if (fly) P.map.setView([place.lat, place.lon], 12);
  }
}

let pkTimer;
$("#pk-q").addEventListener("input", () => { clearTimeout(pkTimer); pkTimer = setTimeout(searchPlaces, 500); });
async function searchPlaces() {
  const q = $("#pk-q").value.trim();
  if (q.length < 2) return;
  $("#pk-results").innerHTML = `<p class="muted small">Searching…</p>`;
  try {
    // offline first: My Places, coordinates, towns, islands, bays… (online results only if nothing is found)
    P.results = await api(`/api/places/search?q=${encodeURIComponent(q)}${navigator.onLine ? "&online=1" : ""}`);
    $("#pk-results").innerHTML = P.results.length
      ? P.results.map((p, i) => `<button data-i="${i}">${esc(p.name || p.label)}<span class="d">${esc([p.kind, p.label].filter(Boolean).join(" · "))}</span></button>`).join("")
      : `<p class="muted small">Nothing found. Try a nearby town, or click the map.</p>`;
  } catch (e) { $("#pk-results").innerHTML = `<p class="muted small">${esc(e.message)}</p>`; }
}
$("#pk-results").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return;
  $$("#pk-results button").forEach(x => x.classList.toggle("on", x === b));
  choose(P.results[+b.dataset.i]);
};
$("#pk-close").onclick = () => ($("#picker").hidden = true);
$("#pk-save").onclick = async () => {
  const c = P.chosen; if (!c) return;
  if (P.onPick) {   // choosing a place for photos that haven't been imported yet
    $("#picker").hidden = true;
    P.onPick({ lat: c.lat, lon: c.lon, name: c.name, label: c.label });
    return;
  }
  try {
    const r = await api("/api/locations/set", { ids: P.ids, lat: c.lat, lon: c.lon, name: c.name, label: c.label });
    $("#picker").hidden = true;
    toast(`Saved “${r.place}” for ${plural(r.updated, "photo")}.`);
    if (P.done) P.done();
  } catch (e) { fail(e); }
};

/* ------------------------------------------------------------------ tidy up (photos already on the drive) */
const TU = { folder: "", q: "", photos: [], folders: [], info: {}, sel: new Set(), names: {}, pv: {}, pvList: [],
             waiting: 0, filter: "", tab: "name", place: null, when: "", all: false, settings: {}, albums: [] };
const TU_FOLDER_NOTE = {
  month_group: "A folder for each month, and inside it one for each trip or event.",
  year_month: "A folder for each year, with a folder for each month inside.",
  year: "One folder per year.",
  none: "No folders — every photo together, sorted by name.",
};

$("#tu-to-places").onclick = () => {
  if (!TU.sel.size) return toast("Select some photos first.");
  openPlaces([...TU.sel]);
};
$("#tu-more").onclick = () => { TU.limit = (TU.limit || 600) + 600; loadTidy(); };
async function loadTidy() {
  let r;
  TU.limit = TU.limit || 600;
  try { r = await api(`/api/tidy/browse?${new URLSearchParams({ folder: TU.folder, q: TU.q, limit: TU.limit })}`); } catch (e) { return fail(e); }
  TU.total = r.total;
  TU.photos = r.photos; TU.folders = r.folders; TU.settings = r.settings; TU.albums = r.albums;
  r.photos.forEach(p => (TU.info[p.id] = p));
  $("#tu-format").value = r.settings.time === "0" ? "0" : "1";
  $("#tu-folders").value = r.settings.folders || "month_group";
  $("#tu-folders-note").textContent = TU_FOLDER_NOTE[r.settings.folders || "month_group"] + " The same setting is used when you import.";
  $("#org-hl").value = r.settings.highlights || "5";
  $("#org-hl-note").textContent = r.settings.highlights === "off" ? "No Highlights folders are made."
    : `A "2025 Highlights" folder holds a copy of every ${r.settings.highlights === "4" ? "4- and 5-star" : "5-star"} photo from that year. The originals stay where they are.`;
  $("#btn-hl").hidden = r.settings.highlights === "off";
  const cur = $("#tu-album").value;
  $("#tu-album").innerHTML = `<option value="">— none —</option>` + r.albums.map(a => `<option value="${esc(a.key)}">${esc(a.start.slice(0, 7).replace("-", "."))} ${esc(a.name)}</option>`).join("");
  $("#tu-album").value = cur;
  $("#pp-albums").innerHTML = [...new Set(r.albums.map(a => a.name))].map(n => `<option value="${esc(n)}">`).join("");
  try { const o = await api("/api/organize"); $("#btn-undo").hidden = !o.can_undo; } catch (e) { /* ignore */ }
  renderTidy();
}

function tuCrumbs() {
  const parts = TU.folder ? TU.folder.split("/") : [];
  const lib = (S.state.library || "").split("/").filter(Boolean).pop() || "Library";
  let html = `<button data-f="">${esc(lib)}</button>`;
  parts.forEach((p, i) => { html += `<i>›</i><button data-f="${esc(parts.slice(0, i + 1).join("/"))}">${esc(p)}</button>`; });
  if (TU.q) html += `<i>›</i><span>Search: “${esc(TU.q)}”</span>`;
  $("#tu-crumbs").innerHTML = html;
}

function tuShown() {
  return TU.photos.filter(p => !TU.filter || (TU.filter === "sel" ? TU.sel.has(p.id) : tuEdited(p.id)));
}
const tuEdited = (id) => TU.names[id] !== undefined || (TU.sel.has(id) && (tuShift() || TU.place || $("#tu-place-off").checked || $("#tu-name-all").value.trim() || $("#tu-album").value || $("#tu-tags").value.trim()));

function renderTidy() {
  tuCrumbs();
  const parts = TU.folder ? TU.folder.split("/") : [];
  $("#tu-folder-title").textContent = TU.q ? "Search results" : (parts.length ? parts[parts.length - 1] : "Library");
  const selHere = TU.photos.filter(p => TU.sel.has(p.id)).length;
  $("#tu-more").hidden = !(TU.total > TU.photos.length);
  $("#tu-more").textContent = `Show more (${n(TU.total - TU.photos.length)})`;
  $("#tu-folder-sub").textContent = `${TU.total > TU.photos.length ? `Showing ${n(TU.photos.length)} of ` : ""}${plural(TU.total || TU.photos.length, "photo")}${TU.folders.length ? " · " + plural(TU.folders.length, "folder") : ""} · ${n(TU.sel.size)} selected` +
    (TU.photos.length && TU.photos.every(p => p.tidy) ? " · all already tidy" : "");
  $$("#tu-filter button").forEach(b => {
    const k = b.dataset.k;
    const c = k === "sel" ? TU.sel.size : k === "edit" ? TU.photos.filter(p => tuEdited(p.id)).length : TU.photos.length;
    b.textContent = `${k === "sel" ? "Selected" : k === "edit" ? "Edited" : "All"} (${n(c)})`;
  });
  const selectable = TU.photos.filter(p => !p.needs);
  $("#tu-all").checked = selectable.length > 0 && selectable.every(p => TU.sel.has(p.id));
  $("#tu-folder-cards").hidden = !!TU.q || !TU.folders.length;
  $("#tu-folder-cards").innerHTML = TU.folders.map(f => `
    <button class="fcard" data-f="${esc(f.path)}">
      <span class="fimg">${f.cover ? `<img loading="lazy" src="/thumb/${f.cover}" alt="">` : ""}</span>
      <span class="fname2"><svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>${esc(f.name)}</span>
      <span class="muted small">${plural(f.count, "photo")}</span>
    </button>`).join("");
  const list = tuShown();
  $("#tu-none").hidden = list.length > 0 || TU.folders.length > 0;
  $("#tu-grid").innerHTML = list.map(p => {
    const on = TU.sel.has(p.id);
    const v = TU.pv[p.id] || p;
    const np = TU.names[p.id] !== undefined ? TU.names[p.id] : v.np;
    const same = !TU.pv[p.id] && p.tidy && TU.names[p.id] === undefined;
    return `<div class="tcard ${on ? "on" : ""}" data-id="${p.id}">
      <div class="ph"><img loading="lazy" src="/thumb/${p.id}" alt=""><span class="tick" data-sel>${on ? "✓" : ""}</span>
        ${p.raw ? `<span class="tagr">RAW+JPEG</span>` : p.kind === "video" ? `<span class="tagr">Video</span>` : ""}</div>
      <div class="oldn" title="${esc(p.path)}">${esc(p.name)}</div>
      <div class="loc ${p.lat == null ? "none" : ""}" title="${p.lat != null ? esc((p.place || "") + "\n" + fmtLatLon(p.lat, p.lon)) : ""}">${p.lat != null ? "📍 " + esc((p.place || "").split(",")[0].trim() || "Location") + ` · ${fmtLatLon(p.lat, p.lon)}` : "No location"}</div>
      ${p.needs ? `<div class="note">${p.date_alt ? "Dates don't match — pick one in Drive Preview" : "Needs a date first — add one in Drive Preview"}</div>`
        : `<div class="fname ${TU.names[p.id] !== undefined ? "mine" : ""} ${same ? "same" : ""}" title="${same ? "Already has the Picture Perfect name" : esc((v.folder_new || "").split("/").join(" › "))}"><span>${esc(v.prefix)}</span><input data-name value="${esc(np)}" spellcheck="false">${v.suffix ? `<span class="num">${esc(v.suffix)}</span>` : ""}<span>${esc(v.ext)}</span></div>`}
    </div>`;
  }).join("");
  renderTidyPanel();
}

function tuBaseWhen() {   // the earliest selected photo, before any change
  const t = [...TU.sel].map(id => TU.info[id]).filter(p => p && !p.needs).map(p => p.taken).sort();
  return t[0] || null;
}
function tuShift() {
  const base = tuBaseWhen(), v = $("#tu-when").value;
  if (!base || !v || v === base.slice(0, 16)) return 0;
  return Math.round((isoToMs(v + ":00") - isoToMs(base)) / 1000);
}

function renderTidyPanel() {
  const k = TU.sel.size;
  $("#tu-empty").hidden = k > 0;
  $("#tu-edit").hidden = k === 0;
  $("#tu-title").textContent = k ? `Tidy Up ${plural(k, "Photo")}` : "Tidy Up";
  $("#tu-sub").textContent = k ? "Make changes to names, dates, places and keywords. Nothing happens until you press Save Changes."
    : "Select photos on the right, then rename them, fix dates and places, and file them.";
  $("#tu-save").disabled = !k;
  $("#tu-save").textContent = k ? `Save Changes (${n(k)})` : "Save Changes";
  $$("#tu-tabs button").forEach(b => b.classList.toggle("on", b.dataset.t === TU.tab));
  $$("#tu-edit [data-pane]").forEach(p => (p.hidden = p.dataset.pane !== TU.tab));
  const base = tuBaseWhen();
  if (!$("#tu-when").value && base) $("#tu-when").value = base.slice(0, 16);
  const sh = tuShift();
  $("#tu-when-note").textContent = !base ? "None of the selected photos have a date yet."
    : sh ? `Every selected photo moves by ${fmtShift(sh)}, keeping its order.` : "Change it to fix a camera clock — every selected photo moves by the same amount.";
  $("#tu-place").textContent = TU.place ? "📍 " + shortPlace(TU.place.label || placeName(TU.place)) : "+ Add a place";
  $("#tu-place-clear").hidden = !TU.place;
  const withGps = [...TU.sel].filter(id => TU.info[id] && TU.info[id].lat != null).length;
  const off = $("#tu-place-off").checked;
  $("#tu-place-keep-l").textContent = `Keep the location on photos that already have one${withGps ? ` (${n(withGps)} of the selected)` : ""}`;
  $("#tu-place-keep").closest(".opt").hidden = !withGps || off;
  $("#tu-place").disabled = off;
  const keep = $("#tu-place-keep").checked;
  $("#tu-place-note").textContent = off
    ? `The location will be taken off ${plural(withGps, "photo")}${withGps ? " (and out of the files)" : ""}. Names that were just the town name are cleared too.`
    : TU.place
    ? (keep && withGps ? `Goes on ${plural(k - withGps, "photo")} without a location; ${plural(withGps, "photo")} keep${withGps === 1 ? "s its" : " their"} own.`
      : `Goes on all ${plural(k, "selected photo")}${withGps ? `, replacing the location ${withGps === 1 ? "one already has" : `${n(withGps)} already have`}` : ""}. Names that were just the old town name follow the new place.`)
    : `Choose the place for ${k ? `all ${plural(k, "selected photo")}` : "the selected photos"}: search for it or drop a pin on the map.`;
  $("#tu-fr-go").disabled = !$("#tu-find").value.trim() || !k;
  // preview
  const L2 = TU.pvList;
  const changing = L2.filter(x => x.changes).length;
  $("#tu-prev-head").textContent = `Preview (${plural(L2.length, "file")}${L2.length && changing < L2.length ? `, ${n(L2.length - changing)} unchanged` : ""})`;
  const show = TU.showAll ? L2 : L2.slice(0, 8);
  $("#tu-preview").innerHTML = (show.map(x => `
    <div class="pvrow ${x.changes ? "" : "same"}"><img src="/thumb/${x.id}" alt="">
      <span class="o" title="${esc(x.old)}">${esc(fileOf(x.old))}</span><span class="a">→</span>
      <span class="nw" title="${esc(x.new)}">${esc(fileOf(x.new))}</span></div>`).join("") || `<div class="hint">Working it out…</div>`) +
    (TU.waiting ? `<div class="hint warnrow">${plural(TU.waiting, "photo")} without a date (or with two dates that don't match) will be left as they are.</div>` : "");
  $("#tu-prev-more").hidden = L2.length <= 8;
  $("#tu-prev-more").textContent = TU.showAll ? "Show fewer" : `Show all ${n(L2.length)} files…`;
}

let tuTimer;
function tuPayload() {
  const nameAll = $("#tu-name-all").value.trim();
  const names = {};
  Object.entries(TU.names).forEach(([id, v]) => { if (TU.sel.has(+id)) names[id] = v; });
  const al = $("#tu-album").value;
  const alb = al ? TU.albums.find(a => a.key === al) : null;
  return { ids: [...TU.sel], title: alb ? alb.name : (nameAll || null), names, shift: tuShift(), place: TU.place,
           replace_place: !$("#tu-place-keep").checked, remove_place: $("#tu-place-off").checked, tags: $("#tu-tags").value.split(",").map(t => t.trim()).filter(Boolean),
           album: al || null };
}
function tuRefresh() {
  renderTidyPanel();
  clearTimeout(tuTimer);
  if (!TU.sel.size) { TU.pv = {}; TU.pvList = []; TU.waiting = 0; return renderTidy(); }
  const seq = TU.pvSeq = (TU.pvSeq || 0) + 1;
  tuTimer = setTimeout(async () => {
    try {
      const r = await api("/api/tidy/preview", tuPayload());
      if (seq !== TU.pvSeq) return;   // edits moved on (or were cancelled) while this was loading
      TU.pv = {}; r.items.forEach(x => (TU.pv[x.id] = x));
      TU.pvList = r.items; TU.waiting = r.waiting;
      const y = window.scrollY;
      const focused = document.activeElement && document.activeElement.matches("#tu-grid [data-name]") ? +document.activeElement.closest(".tcard").dataset.id : null;
      if (focused === null) renderTidy(); else renderTidyPanel();
      window.scrollTo(0, y);
    } catch (e) { fail(e); }
  }, 250);
}
function tuReset() {
  clearTimeout(tuTimer); TU.pvSeq = (TU.pvSeq || 0) + 1;
  TU.sel = new Set(); TU.names = {}; TU.pv = {}; TU.pvList = []; TU.place = null; TU.showAll = false;
  $("#tu-name-all").value = ""; $("#tu-when").value = ""; $("#tu-tags").value = ""; $("#tu-album").value = ""; $("#tu-place-keep").checked = false;
  $("#tu-place-off").checked = false; $("#tu-find").value = ""; $("#tu-repl").value = "";
}

$("#tu-crumbs").onclick = (e) => { const b = e.target.closest("[data-f]"); if (!b) return; TU.folder = b.dataset.f; TU.q = ""; $("#tu-q").value = ""; TU.limit = 600; loadTidy(); };
$("#tu-folder-cards").onclick = (e) => { const b = e.target.closest(".fcard"); if (!b) return; TU.folder = b.dataset.f; TU.limit = 600; loadTidy(); window.scrollTo(0, 0); };
let tuQTimer;
$("#tu-q").addEventListener("input", (e) => { clearTimeout(tuQTimer); tuQTimer = setTimeout(() => { TU.q = e.target.value.trim(); TU.limit = 600; loadTidy(); }, 350); });
$("#tu-filter").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; TU.filter = b.dataset.k;
  $$("#tu-filter button").forEach(x => x.classList.toggle("on", x === b)); renderTidy(); };
$("#tu-all").onchange = (e) => { TU.photos.filter(p => !p.needs).forEach(p => (e.target.checked ? TU.sel.add(p.id) : TU.sel.delete(p.id))); $("#tu-when").value = ""; renderTidy(); tuRefresh(); };
$("#tu-grid").addEventListener("click", (e) => {
  const c = e.target.closest(".tcard"); if (!c) return;
  const id = +c.dataset.id;
  if (e.target.matches("input")) return;
  if (TU.info[id] && TU.info[id].needs) return;
  TU.sel.has(id) ? TU.sel.delete(id) : TU.sel.add(id);
  $("#tu-when").value = "";
  renderTidy(); tuRefresh();
});
$("#tu-grid").addEventListener("change", (e) => {
  if (!e.target.matches("[data-name]")) return;
  const id = +e.target.closest(".tcard").dataset.id;
  const p = TU.info[id];
  const v = e.target.value.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
  if (v === (p.np || "") && !TU.sel.has(id)) delete TU.names[id]; else TU.names[id] = v;
  TU.sel.add(id);
  renderTidy(); tuRefresh();
});
$("#tu-grid").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("input")) e.target.blur(); });
$("#tu-tabs").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; TU.tab = b.dataset.t; renderTidyPanel(); };
["#tu-name-all", "#tu-when", "#tu-tags"].forEach(sel => $(sel).addEventListener("input", tuRefresh));
["#tu-album", "#tu-place-keep", "#tu-place-off"].forEach(sel => $(sel).addEventListener("change", tuRefresh));
$("#tu-place-off").addEventListener("change", (e) => { if (e.target.checked) TU.place = null; });
$("#tu-find").addEventListener("input", renderTidyPanel);
// find & replace inside the name part of every selected photo
$("#tu-fr-go").onclick = () => {
  const find = $("#tu-find").value.trim(), repl = $("#tu-repl").value;
  if (!find) return;
  const rx = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  let changed = 0;
  for (const id of TU.sel) {
    const p = TU.info[id]; if (!p) continue;
    const cur = TU.names[id] !== undefined ? TU.names[id] : ((TU.pv[id] || p).np || "");
    const next = cur.replace(rx, repl).replace(/\s+/g, " ").trim();
    if (next !== cur) { TU.names[id] = next; changed++; }
  }
  $("#tu-fr-note").textContent = changed ? `Changed ${plural(changed, "name")} — check the preview, then Save Changes.` : `No selected names contain “${find}”.`;
  renderTidy(); tuRefresh();
};
$("#tu-place").onclick = () => openPicker([], "Location for the selected photos", null, TU.place ? TU.place.label : "", (c) => { TU.place = c; tuRefresh(); });
$("#tu-place-clear").onclick = () => { TU.place = null; tuRefresh(); };
$("#tu-prev-more").onclick = () => { TU.showAll = !TU.showAll; renderTidyPanel(); };
$("#tu-format").onchange = async (e) => { try { await api("/api/organize/settings", { time: e.target.value }); await loadTidy(); tuRefresh(); } catch (err) { fail(err); } };
$("#tu-folders").onchange = async (e) => { try { await api("/api/organize/settings", { folders: e.target.value }); await loadTidy(); tuRefresh(); } catch (err) { fail(err); } };
$("#org-hl").onchange = async (e) => { try { await api("/api/organize/settings", { highlights: e.target.value }); loadTidy(); } catch (err) { fail(err); } };
$("#btn-hl").onclick = () => api("/api/highlights", {}).then(() => { S.lastJobFinished = false; refreshState(); }).catch(fail);
$("#btn-undo").onclick = () => {
  if (!confirm("Put the photos from the last save back to their old names and folders?")) return;
  api("/api/organize/undo", {}).then(() => { S.lastJobFinished = false; refreshState(); }).catch(fail);
};
$("#tu-cancel").onclick = () => { tuReset(); renderTidy(); };
$("#tu-save").onclick = () => {
  const p = tuPayload();
  if (!p.ids.length) return;
  const moving = TU.pvList.filter(x => x.changes).length;
  if (!confirm(`Rename, move and update ${plural(p.ids.length, "photo")} on your drive${moving < p.ids.length ? ` (${n(p.ids.length - moving)} keep their name)` : ""}? You can undo the renaming afterwards.`)) return;
  api("/api/tidy/save", p).then(() => { S.lastJobFinished = false; refreshState(); }).catch(fail);
};

/* ------------------------------------------------------------------ inbox / edit photos */
const R = { mode: "inbox", day: null, items: [], sel: new Set() };

function openDay(day) {
  R.mode = "day"; R.day = day;
  showTab("inbox", true);
}

async function loadReview() {
  let r;
  try {
    r = await api("/api/review", R.mode === "day" ? { day: R.day } : R.mode === "needs" ? { needs: true }
                                 : R.mode === "set" ? { ids: R.ids } : {});
  } catch (e) { return fail(e); }
  const keep = new Set(R.sel);
  const firstLoad = !R.items.length || R.loadedFor !== (R.mode + R.day + (R.mode === "set" ? R.ids.length : ""));
  R.items = r.items;
  R.loadedFor = R.mode + R.day + (R.mode === "set" ? R.ids.length : "");
  R.sel = new Set(firstLoad ? R.items.map(i => i.id) : R.items.filter(i => keep.has(i.id)).map(i => i.id));
  $("#tag-list").innerHTML = (r.tags || []).map(t => `<option value="${esc(t)}">`).join("");
  $$("#tabs button").forEach(b => b.classList.toggle("on", R.mode === "inbox" && b.dataset.tab === "inbox"));
  $("#rv-back").hidden = R.mode === "inbox";
  $("#rv-steps").hidden = true;
  $("#rv-back").textContent = R.mode === "needs" ? "‹ Back to Organize" : "‹ Back to Browse";
  $("#rv-title").textContent = R.mode === "day" ? "Edit " + fmtDay(R.day) : R.mode === "needs" ? "Photos that need a date or time"
    : R.mode === "set" ? `Edit ${plural(R.ids.length, "photo")}${R.setLabel ? " — " + R.setLabel : ""}` : "Drive Preview";
  const count = R.items.length;
  const waiting = R.items.filter(i => i.needs).length;
  $("#rv-sub").textContent = !count ? "" : R.mode === "needs"
    ? "Add the date and time each was taken. Select several to set them together."
    : R.mode === "day" || R.mode === "set"
    ? "Tick the ones you want (all are ticked), use Name… to name them together, then Save changes."
    : `${plural(count, "new photo")} copied to ${S.state.library.split("/").filter(Boolean).slice(-1)[0]} › _Drive Preview, still with their old names. Check what each will be renamed to, fix anything, then press Save & file.` +
      (waiting ? ` ${plural(waiting, "photo needs", "photos need")} a date, a time or a date check first.` : "");
  $("#rv-empty").hidden = count > 0;
  const jf = R.mode === "inbox" && R.justFiled && R.justFiled.length && !(S.state.job && !S.state.job.finished);
  $("#rv-prune").hidden = !jf;
  if (jf) $("#rv-prune-text").innerHTML = `<b>${plural(R.justFiled.length, "photo")} filed.</b> Want to go through them now and delete the ones you don't need?`;
  $("#rv-bulk").hidden = !count;
  $("#rv-save").hidden = !count;
  $("#rv-foot").hidden = !count || R.mode === "day";
  renderReview();
}

function renderReview() {
  R.shown = Math.max(R.shown || 0, 150);
  const more = R.items.length - R.shown;
  $("#rv-list").innerHTML = R.items.slice(0, R.shown).map(rvRow).join("") +
    (more > 0 ? `<div class="more"><button class="ghost" id="rv-more">Show ${n(Math.min(more, 150))} more of ${n(more)}</button></div>` : "");
  const mb = $("#rv-more");
  if (mb) mb.onclick = () => { R.shown += 150; renderReview(); };
  updateSel();
}

function splitName(it) {
  // new path like 2026/2026-03/2026.03.14 1030 Bequia Regatta.jpg -> pieces for the editor
  const file = it.new.split("/").pop();
  const dot = file.lastIndexOf(".");
  const ext = file.slice(dot);
  const m = file.slice(0, dot).match(/^(\d{4}\.\d{2}\.\d{2})(?: (\d{4}))?/);
  const fixed = m ? m[0] : "";
  const folder = it.new.includes("/") ? it.new.slice(0, it.new.length - file.length) : "";
  return { fixed, ext, folder };
}

function rvRow(it) {
  const p = splitName(it);
  const sel = R.sel.has(it.id);
  const pills = [
    it.needs === "date" ? `<span class="pill warn">no date — add one to file it</span>` : "",
    it.needs === "time" ? `<span class="pill warn">no time — add one, or keep date only</span>` : "",
    it.needs === "check" ? `<span class="pill warn">dates don't match — pick one to file it</span>` : "",
    it.dupe ? `<span class="pill warn">looks like a duplicate</span>` : "",
    it.pending && !it.needs ? `<span class="pill ok">changes not saved to photo yet</span>` : "",
  ].join("");
  return `<div class="rv ${sel ? "" : "off"}" data-id="${it.id}">
    <input type="checkbox" data-sel ${sel ? "checked" : ""} aria-label="Select">
    <div class="ph" data-open><img loading="lazy" src="/thumb/${it.id}" alt=""></div>
    <div>
      <div class="nowname">Now: <b>${esc(it.name)}</b>${it.raw ? " + " + esc(it.raw) : ""} <span class="muted">in ${esc(folderOf(it.path) || "top of drive")}</span></div>
      <div class="willbe">Will be renamed to:</div>
      <div class="nm">
        <span class="fixed">${it.needs === "date" ? `<span class="needs">Date needed</span>` : it.needs === "check" ? `<span class="needs">Which date?</span>` : esc(p.fixed.slice(0, 10))}${it.needs === "time" ? ` <span class="needs">time?</span>` : it.needs ? "" : esc(p.fixed.slice(10))}</span>
        <input data-f="title" value="${esc(it.name_part || "")}" placeholder="${esc(it.default_name || "Add a place or event")}" aria-label="Name">
        <span class="ext">${esc(p.ext)}</span>
      </div>
      <div class="dest">${it.needs === "date" ? "Gets its name and folder once it has a date" : it.needs === "check" ? "Gets its name and folder once you pick the right date" : p.folder ? "📁 Goes in folder " + esc(folderOf(it.new)) : "Stays at the top of the drive"}</div>
      ${it.needs === "check" ? clashHtml(it) : ""}
      <div class="fields">
        <label>Date &amp; time <input type="datetime-local" step="60" data-f="taken" class="${it.needs ? "needs-in" : ""}" value="${it.needs === "date" ? "" : it.taken.slice(0, 16)}"></label>
        ${it.needs && it.kind === "photo" ? `<button class="link fix" data-guess>Guess date…</button>` : ""}
        ${it.needs === "date" ? `<button class="link fix" data-fix="file">Use file date (${fmtDay(it.taken)})</button>` : ""}
        ${it.needs === "time" ? `<button class="link fix" data-fix="dateonly">Time unknown — date only</button>` : ""}
        <span class="stars">${starsHtml(it.rating || 0, "data-rstar")}</span>
        <button class="placebtn ${it.place ? "" : "empty"}" data-f="place">${it.place ? "📍 " + esc(it.place) : "+ Add place"}</button>
        <span class="tags">
          ${(it.tags || []).map(t => `<span class="chip">${esc(t)}<button data-untag="${esc(t)}" aria-label="Remove">×</button></span>`).join("")}
          <input data-f="tag" list="tag-list" placeholder="+ tag">
        </span>
      </div>
      <div class="orig">${it.raw ? `<span class="pill ok">RAW + JPEG pair</span>` : ""}${it.camera ? esc(it.camera) : ""}${pills}
        ${it.kind === "photo" ? `${it.raw || it.camera || pills.trim() ? " · " : ""}<button class="link fix" data-match style="padding:0">Find matches…</button>` : ""}</div>
    </div>
  </div>`;
}

const fmtAlt = (d) => d.length > 10 ? fmtWhen(d) : fmtDay(d);

function clashHtml(it) {
  // the file name and the photo disagree about when it was taken
  const later = it.taken.slice(0, 10) > it.date_alt.slice(0, 10);
  return `<div class="clash">
    <div>The file name says <b>${fmtAlt(it.date_alt)}</b>, but the date saved inside the photo is <b>${fmtWhen(it.taken)}</b>.
      ${later ? `<span class="muted">The date inside is later — that's often when a photo was downloaded, copied or edited.</span>` : ""}</div>
    <div class="clash-btns">
      <button class="ghost" data-clash="name">Use ${fmtDay(it.date_alt)} <span class="muted">(file name)</span></button>
      <button class="ghost" data-clash="inside">Keep ${fmtDay(it.taken)} <span class="muted">(inside photo)</span></button>
    </div>
  </div>`;
}

async function resolveDates(ids, use) {
  try {
    const r = await api("/api/resolve-dates", { ids, use });
    replaceItems(r.items);
    toast(`${plural(r.resolved, "photo")} ${use === "name" ? "now use the date from the file name" : "keep the date saved inside"}.`);
    renderClashBar();
    refreshState();
  } catch (e) { fail(e); }
}

function renderClashBar() {
  const all = R.items.filter(i => i.needs === "check");
  const picked = all.filter(i => R.sel.has(i.id));
  $("#rv-clash").hidden = !all.length;
  if (!all.length) return;
  const byName = picked.filter(i => i.taken.slice(0, 10) > i.date_alt.slice(0, 10)).length;
  $("#rv-clash-text").innerHTML = `<b>${plural(all.length, "photo has", "photos have")} a different date in ${all.length === 1 ? "its" : "their"} file name than inside.</b>
    ${picked.length ? `For the ${n(picked.length)} selected${byName ? ` (${n(byName)} with a later date inside, like a download date)` : ""}:` : "Select some to choose for all of them at once."}`;
  $("#rv-clash-name").disabled = $("#rv-clash-inside").disabled = !picked.length;
}

function updateSel() {
  const total = R.items.length, k = R.sel.size;
  $("#rv-all").checked = k === total && total > 0;
  $("#rv-all").indeterminate = k > 0 && k < total;
  $("#rv-count").textContent = k === total ? `All ${n(total)} selected` : `${n(k)} of ${n(total)} selected`;
  $$("[data-bulk]").forEach(b => (b.disabled = !k));
  const ready = (R.mode === "inbox" ? R.items : R.items.filter(i => R.sel.has(i.id))).filter(i => !i.needs).length;
  $("#rv-save").textContent = R.mode === "inbox" ? `Save & file ${plural(ready, "photo")}` : `Save changes (${n(ready)})`;
  $("#rv-save").disabled = !ready;
  renderClashBar();
}

function replaceItems(updated) {
  const byId = new Map(updated.map(i => [i.id, i]));
  R.items = R.items.map(i => byId.has(i.id) ? Object.assign({}, i, byId.get(i.id), { dupe: i.dupe }) : i);
  R.items.sort((a, b) => (a.taken < b.taken ? -1 : a.taken > b.taken ? 1 : 0));
  renderReview();
}

async function edit(ids, body, msg) {
  try {
    const r = await api("/api/edit", Object.assign({ ids }, body));
    replaceItems(r.items);
    if (msg) toast(msg);
    loadFilters();
  } catch (e) { fail(e); }
}

const rowOf = (el) => R.items.find(i => i.id === +el.closest(".rv").dataset.id);

$("#rv-list").addEventListener("click", (e) => {
  const row = e.target.closest(".rv"); if (!row) return;
  const it = rowOf(row);
  if (e.target.matches("[data-sel]")) {
    e.target.checked ? R.sel.add(it.id) : R.sel.delete(it.id);
    row.classList.toggle("off", !e.target.checked);
    return updateSel();
  }
  if (e.target.closest("[data-open]")) return openViewer(R.items, R.items.indexOf(it));
  if (e.target.closest("[data-match]")) return openMatcher(it, () => { loadReview(); refreshState(); });
  if (e.target.closest("[data-guess]")) return openGuesser(it, () => { loadReview(); refreshState(); });
  const rs = e.target.closest("[data-rstar]");
  if (rs) return edit([it.id], { rating: +rs.dataset.rstar === it.rating ? 0 : +rs.dataset.rstar });
  const cl = e.target.closest("[data-clash]");
  if (cl) return resolveDates([it.id], cl.dataset.clash);
  const fx = e.target.closest("[data-fix]");
  if (fx) return edit([it.id], fx.dataset.fix === "file" ? { use_file_date: true } : { date_only: true });
  const un = e.target.closest("[data-untag]");
  if (un) return edit([it.id], { remove_tags: [un.dataset.untag] });
  if (e.target.closest('[data-f="place"]')) {
    return openPicker([it.id], "Place for " + it.name, reloadRows([it.id]), it.place);
  }
});
$("#rv-list").addEventListener("change", (e) => {
  const f = e.target.dataset.f; if (!f) return;
  const it = rowOf(e.target);
  if (f === "title" && e.target.value !== (it.name_part || "")) edit([it.id], { title: e.target.value });
  if (f === "taken" && e.target.value && (it.needs || e.target.value !== it.taken.slice(0, 16))) edit([it.id], { taken: e.target.value });
});
$("#rv-list").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const f = e.target.dataset.f;
  if (f === "title") e.target.blur();
  if (f === "tag") {
    const it = rowOf(e.target);
    const tags = e.target.value.split(",").map(t => t.trim()).filter(Boolean);
    if (tags.length) edit([it.id], { add_tags: tags });
  }
});

function reloadRows(ids) {
  return async () => {
    try { replaceItems((await api("/api/review", { ids })).items); refreshState(); } catch (e) { fail(e); }
  };
}

$("#rv-clash-name").onclick = () => resolveDates(R.items.filter(i => i.needs === "check" && R.sel.has(i.id)).map(i => i.id), "name");
$("#rv-clash-inside").onclick = () => resolveDates(R.items.filter(i => i.needs === "check" && R.sel.has(i.id)).map(i => i.id), "inside");
$("#rv-all").onchange = (e) => {
  R.sel = new Set(e.target.checked ? R.items.map(i => i.id) : []);
  renderReview();
};
$("#rv-prune-go").onclick = () => { const ids = R.justFiled; R.justFiled = null; $("#rv-prune").hidden = true; openPickSet(ids, "just filed"); };
$("#rv-back").onclick = () => { const to = R.mode === "needs" ? "organize" : "browse"; R.mode = "inbox"; showTab(to); };
$("#rv-save").onclick = () => {
  // Drive Preview files everything; the other views save only the ticked photos
  const pool = R.mode === "inbox" ? R.items : R.items.filter(i => R.sel.has(i.id));
  const waiting = pool.filter(i => i.needs).length;
  if (waiting && !confirm(`${plural(waiting, "photo still needs", "photos still need")} a date, a time or a date check and will wait here. Save and file the others now?`)) return;
  const ids = pool.filter(i => !i.needs).map(i => i.id);
  if (!ids.length) return;
  api("/api/organize/apply", { ids }).then(() => {
    if (R.mode === "inbox") R.justFiled = ids;
    refreshState();
  }).catch(fail);
};
$("#rv-later").onclick = async () => {
  if (!confirm("Take these photos out of Drive Preview without renaming them? You can still organize them later.")) return;
  try { await api("/api/review/done", { ids: R.items.map(i => i.id) }); refreshState(); loadReview(); } catch (e) { fail(e); }
};

/* bulk actions */
const selected = () => R.items.filter(i => R.sel.has(i.id));
let bulkSave = null;
function openBulk(title, html, note, save) {
  $("#bk-title").textContent = title;
  $("#bk-body").innerHTML = html;
  $("#bk-note").textContent = note || "";
  bulkSave = save;
  $("#bulk").hidden = false;
  setTimeout(() => { const i = $("#bk-body input"); if (i) i.focus(); }, 30);
}
$("#bk-close").onclick = () => ($("#bulk").hidden = true);
$("#bk-save").onclick = async () => { if (bulkSave) { await bulkSave(); } $("#bulk").hidden = true; };
$("#bk-body").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#bk-save").click(); });

function isoToMs(v) {  // local wall-clock -> comparable number, no time zone surprises
  const [d, t] = v.split("T");
  const [y, m, dd] = d.split("-").map(Number);
  const [hh, mm, ss] = (t || "0:0:0").split(":").map(Number);
  return Date.UTC(y, m - 1, dd, hh, mm, ss || 0);
}

$("#rv-bulk").addEventListener("click", (e) => {
  const b = e.target.closest("[data-bulk]"); if (!b) return;
  const items = selected(); if (!items.length) return;
  const ids = items.map(i => i.id);
  const who = items.length === 1 ? "this photo" : `these ${n(items.length)} photos`;
  if (b.dataset.bulk === "name") {
    const current = items[0].name_part || items[0].default_name || "";
    openBulk("Name " + who,
      `<div class="bk-row"><label>Location and event</label><input id="bk-in" value="${esc(current)}" placeholder="e.g. Bequia Regatta"></div>`,
      "Leave blank to use the place name.",
      () => edit(ids, { title: $("#bk-in").value }, `Named ${plural(ids.length, "photo")}.`));
  }
  if (b.dataset.bulk === "date") {
    const first = items[0];
    const many = items.length > 1;
    openBulk("Date & time for " + who,
      `<div class="bk-row"><label>${many ? `The earliest selected photo says <b>${fmtWhen(first.taken)}</b>. It should be:` : "Taken on:"}</label>
       <input id="bk-in" type="datetime-local" step="60" value="${first.taken.slice(0, 16)}"></div>`,
      many ? "The others move by the same amount, so they stay in order — handy when the camera clock was wrong." : "",
      () => {
        const v = $("#bk-in").value; if (!v) return;
        if (!many) return edit(ids, { taken: v }, "Date updated.");
        const shift = Math.round((isoToMs(v + ":00") - isoToMs(first.taken)) / 1000);
        if (shift) return edit(ids, { shift }, `Moved ${plural(ids.length, "photo")} by ${fmtShift(shift)}.`);
      });
  }
  if (b.dataset.bulk === "place") {
    openPicker(ids, "Place for " + who, reloadRows(ids), items[0].place);
  }
  if (b.dataset.bulk === "group") {
    return openGrouper(ids, items, (r) => { replaceItems(r.items); toast(`Added ${plural(ids.length, "item")} to “${r.group}”.`); refreshState(); });
  }
  if (b.dataset.bulk === "tag") {
    const have = [...new Set(items.flatMap(i => i.tags || []))];
    openBulk("Tag " + who,
      `<div class="bk-row"><label>People or anything else — separate with commas</label>
       <input id="bk-in" list="tag-list" placeholder="e.g. Hugh, Sarah"></div>
       ${have.length ? `<div class="bk-row"><label>Already on some of them (click to remove from all selected)</label>
       <div class="tags">${have.map(t => `<span class="chip">${esc(t)}<button data-bk-untag="${esc(t)}">×</button></span>`).join("")}</div></div>` : ""}`,
      "",
      () => {
        const tags = $("#bk-in").value.split(",").map(t => t.trim()).filter(Boolean);
        if (tags.length) return edit(ids, { add_tags: tags }, `Tagged ${plural(ids.length, "photo")}.`);
      });
  }
});
$("#bk-body").addEventListener("click", (e) => {
  const u = e.target.closest("[data-bk-untag]"); if (!u) return;
  edit(selected().map(i => i.id), { remove_tags: [u.dataset.bkUntag] }, `Removed “${u.dataset.bkUntag}”.`);
  u.closest(".chip").remove();
});

function fmtShift(sec) {
  const sign = sec < 0 ? "−" : "+";
  let a = Math.abs(sec);
  const d = Math.floor(a / 86400); a -= d * 86400;
  const h = Math.floor(a / 3600); a -= h * 3600;
  const m = Math.round(a / 60);
  return sign + [d ? d + "d" : "", h ? h + "h" : "", m ? m + "m" : ""].filter(Boolean).join(" ");
}

/* ------------------------------------------------------------------ add to group */
const G = { ids: [], items: [], groups: [], chosen: null, done: null };

async function openGrouper(ids, items, done, pick) {
  // with `pick`, just choose an album (e.g. while importing) and hand it back
  G.ids = ids; G.items = items; G.done = done; G.chosen = null; G.pick = pick || null;
  const what = items.length === 1 ? (items[0].kind === "video" ? "this video" : "this photo") : plural(items.length, "item");
  $("#gp-title").textContent = pick ? `Add ${what} to an album` : `Add ${what} to a group`;
  $("#gp-q").value = "";
  $("#gp-opts").hidden = true;
  $("#gp-save").disabled = true;
  $("#gp-list").innerHTML = `<p class="muted small">Loading your groups…</p>`;
  $("#grouper").hidden = false;
  setTimeout(() => $("#gp-q").focus(), 30);
  try { G.groups = await api("/api/groups"); } catch (e) { return fail(e); }
  renderGroups();
}

function fmtRange(a, b) {
  const d1 = fmtDay(a), d2 = fmtDay(b);
  return d1 === d2 ? d1 : `${d1} – ${d2}`;
}

function renderGroups() {
  const q = $("#gp-q").value.trim().toLowerCase();
  const list = G.groups.filter(g => !q || g.name.toLowerCase().includes(q) || (g.place || "").toLowerCase().includes(q) || g.start.startsWith(q)).slice(0, 80);
  $("#gp-list").innerHTML = list.length ? list.map(g => `
    <button class="gp ${G.chosen && G.chosen.key === g.key ? "on" : ""}" data-key="${esc(g.key)}">
      <span class="th">${g.thumbs.map(id => `<img loading="lazy" src="/thumb/${id}" alt="">`).join("")}</span>
      <span><b>${esc(g.name)}</b>${G.pick ? ` <span class="m">📁 ${esc(g.folder)}</span>` : ""}
        <span class="m">${fmtRange(g.start, g.end)} · ${plural(g.count, "item")}${g.place ? " · " + esc(g.place) : ""}</span></span>
    </button>`).join("")
    : `<p class="muted small">No groups match. Groups are photos that share a name — give some photos a name first.</p>`;
}

$("#gp-q").addEventListener("input", renderGroups);
$("#gp-list").onclick = (e) => {
  const b = e.target.closest(".gp"); if (!b) return;
  G.chosen = G.groups.find(g => g.key === b.dataset.key);
  if (G.pick) { $("#grouper").hidden = true; return G.pick(G.chosen); }
  renderGroups();
  $("#gp-opts").hidden = false;
  $("#gp-chosen").textContent = `${G.chosen.name} · ${fmtRange(G.chosen.start, G.chosen.end)}`;
  $("#gp-when").value = G.chosen.start.slice(0, 16);
  $("#gp-when-note").textContent = G.items.length > 1
    ? "The earliest one goes here; the rest follow in their original order and spacing."
    : "Change the time if you know when it was taken.";
  $("#gp-save").disabled = false;
  $("#gp-save").textContent = `Add to “${G.chosen.name}”`;
};
$("#gp-close").onclick = () => ($("#grouper").hidden = true);
$("#gp-save").onclick = async () => {
  if (!G.chosen) return;
  const keep = $('input[name="gp-date"]:checked').value === "keep";
  try {
    const r = await api("/api/add-to-group", { ids: G.ids, key: G.chosen.key, taken: keep ? null : $("#gp-when").value, keep_dates: keep });
    $("#grouper").hidden = true;
    if (G.done) G.done(r);
  } catch (e) { fail(e); }
};

/* ------------------------------------------------------------------ find matches */
const MT = { me: null, done: null, res: null };

function openMatcher(it, done) {
  MT.me = it; MT.done = done;
  $("#mt-me").src = "/thumb/" + it.id;
  $("#mt-sub").textContent = "";
  $("#mt-list").innerHTML = "";
  $("#matcher").hidden = false;
  setTimeout(() => $("#mt-name").focus(), 30);
}
async function runMatcher() {
  $("#mt-sub").textContent = "Looking…";
  $("#mt-list").innerHTML = "";
  try {
    MT.res = await api("/api/matches", { id: MT.me.id, name: $("#mt-name").value.trim(),
                                          year: $("#mt-year").value.trim(), place: $("#mt-place").value.trim() });
  } catch (e) { $("#mt-sub").textContent = e.message; return; }
  const r = MT.res;
  const good = r.matches.filter(m => m.score >= 0.55);
  $("#mt-sub").textContent = `Compared with ${plural(r.looked_at, "photo")}. ` +
    (good.length ? "Closest first — rotated scans count too." : "Nothing looks like this photo there.");
  const dims = (o) => [o.width ? `${o.width}×${o.height}` : "", fmtSize(o.size)].filter(Boolean).join(" · ");
  $("#mt-list").innerHTML = good.map(m => `
    <div class="mt" data-id="${m.id}">
      <img src="/thumb/${m.id}" alt="">
      <div>
        <div class="lbl2 ${m.score >= 0.9 ? "hi" : ""}">${m.label} · ${Math.round(m.score * 100)}%</div>
        <div class="meter"><div style="width:${Math.round(m.score * 100)}%"></div></div>
        <div class="small"><b>${esc(m.name)}</b> <span class="muted">${esc(folderOf(m.folder + "/x"))}</span></div>
        <div class="small muted">${m.date_source === "file" ? "no date" : fmtWhen(m.taken)} · ${dims(m)}${m.place ? " · " + esc(m.place) : ""}${m.tags.length ? " · " + esc(m.tags.join(", ")) : ""}</div>
        <div class="acts">
          <button class="ghost" data-act="copy">Copy its date &amp; place to yours</button>
          <button class="ghost" data-act="keepme">Same photo — keep yours</button>
          <button class="ghost" data-act="keepit">Same photo — keep this one</button>
        </div>
      </div>
    </div>`).join("");
}
$("#mt-go").onclick = runMatcher;
["#mt-name", "#mt-year", "#mt-place"].forEach(s => $(s).addEventListener("keydown", (e) => { if (e.key === "Enter") runMatcher(); }));
$("#mt-close").onclick = () => ($("#matcher").hidden = true);
$("#mt-list").onclick = async (e) => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const other = +b.closest(".mt").dataset.id, me = MT.me.id;
  const key = [me, other].sort((a, c) => a - c).join(",");
  try {
    if (b.dataset.act === "copy") {
      await api("/api/copy-details", { to: me, from: other });
      toast("Copied its date, place and name to your photo.");
    } else if (b.dataset.act === "keepme") {
      await api("/api/dupes/resolve", { key, keep: [me], aside: [other] });
      toast("Kept yours. The other copy is in _Set aside — anything useful from it was copied over.");
    } else {
      await api("/api/dupes/resolve", { key, keep: [other], aside: [me] });
      toast("Kept the one already in your library. Yours is in _Set aside.");
    }
    $("#matcher").hidden = true;
    refreshState();
    if (MT.done) MT.done();
  } catch (err) { fail(err); }
};

/* ------------------------------------------------------------------ guess a date */
const GS = { me: null, done: null };
function openGuesser(it, done) {
  GS.me = it; GS.done = done;
  $("#gs-me").src = "/thumb/" + it.id;
  $("#gs-sub").textContent = ""; $("#gs-list").innerHTML = "";
  $("#guesser").hidden = false;
  runGuesser();
}
async function runGuesser() {
  $("#gs-sub").textContent = "Looking for photos like this one…";
  $("#gs-list").innerHTML = "";
  let r;
  try {
    r = await api("/api/guess-date", { id: GS.me.id, name: $("#gs-name").value.trim(),
                                        year: $("#gs-year").value.trim(), place: $("#gs-place").value.trim() });
  } catch (e) { $("#gs-sub").textContent = e.message; return; }
  $("#gs-sub").textContent = r.guesses.length
    ? `Compared with ${plural(r.looked_at, "dated photo")}. Most likely first — check the thumbnails and pick one, or adjust the date.`
    : `Compared with ${plural(r.looked_at, "dated photo")} and nothing looked like it. Try a different tag, or clear the filters to look everywhere.`;
  $("#gs-list").innerHTML = r.guesses.map((g, k) => `
    <div class="gs">
      <div class="gs-head">
        <b>${k === 0 ? "Best guess: " : ""}${g.from === g.to ? fmtDay(g.from) : "Around " + fmtRange(g.from, g.to)}</b>
        <span class="muted small">${plural(g.count, "similar photo")}${g.name ? " · " + esc(g.name) : ""} · ${Math.round(g.best * 100)}% alike</span>
      </div>
      <div class="strip">${g.photos.map(p => `<img src="/thumb/${p.id}" title="${esc(p.name)} — ${fmtDay(p.taken)}" alt="">`).join("")}</div>
      <div class="gs-use">
        <input type="date" value="${g.date}" data-date>
        <button class="primary" data-use>Use this date</button>
        <span class="muted small">Saved as date only — add a time later if you know it.</span>
      </div>
    </div>`).join("");
}
$("#gs-go").onclick = runGuesser;
["#gs-name", "#gs-year", "#gs-place"].forEach(s => $(s).addEventListener("keydown", (e) => { if (e.key === "Enter") runGuesser(); }));
$("#gs-close").onclick = () => ($("#guesser").hidden = true);
$("#gs-list").onclick = async (e) => {
  const b = e.target.closest("[data-use]"); if (!b) return;
  const d = b.closest(".gs").querySelector("[data-date]").value;
  if (!d) return;
  try {
    await api("/api/set-date-only", { ids: [GS.me.id], date: d });
    $("#guesser").hidden = true;
    toast(`Dated ${fmtDay(d)}.`);
    refreshState();
    if (GS.done) GS.done();
  } catch (err) { fail(err); }
};

/* ------------------------------------------------------------------ people */
const PP = { o: null, detail: null, sel: {} };

async function loadPeople() {
  $("#pp-main").hidden = false; $("#pp-detail").hidden = true;
  let o;
  try { o = PP.o = await api("/api/people"); } catch (e) { return fail(e); }
  $("#pp-setup").hidden = o.on;
  $("#pp-scan").hidden = !o.on;
  $("#pp-sub").textContent = o.on
    ? `Faces found in ${n(o.scanned)} of ${plural(o.photos, "photo")} · ${plural(o.faces, "face")}` + (o.ready ? "" : " · face recognition isn't available in this copy of Picture Perfect — download the latest version")
    : "Tag the people in your photos automatically.";
  // suggestions to check
  const sug = o.people.filter(p => p.suggested > 0);
  $("#pp-check-wrap").hidden = !sug.length;
  $("#b-people").textContent = sug.length || o.groups.length ? n(sug.reduce((a, p) => a + p.suggested, 0) + o.groups.length) : "";
  $("#pp-check").innerHTML = sug.map(p => `
    <div class="checkrow" data-pid="${p.id}">
      <div class="fstrip" data-sug-strip="${p.id}"></div>
      <div class="q"><b>Is this ${esc(p.name)}?</b><br><span class="small muted">${plural(p.suggested, "new photo")}</span></div>
      <button class="ghost" data-act="review">Check them</button>
      <button class="primary" data-act="yesall">Yes to all</button>
    </div>`).join("");
  sug.forEach(async p => {
    const faces = await api("/api/people/faces", { person: p.id, status: "suggested" });
    const el = $(`[data-sug-strip="${p.id}"]`);
    if (el) el.innerHTML = faces.slice(0, 8).map(f => `<img src="/face/${f.id}" alt="">`).join("");
    p._faces = faces;
  });
  // people
  const named = o.people.filter(p => p.photos > 0 || p.suggested > 0);
  $("#pp-people-wrap").hidden = !named.length;
  $("#pp-people").innerHTML = named.map(p => `
    <div class="person" data-pid="${p.id}">
      ${p.cover ? `<img src="/face/${p.cover}" alt="">` : `<img src="/static/placeholder.svg" alt="">`}
      <b>${esc(p.name)}</b>
      <span class="m">${plural(p.photos, "photo")}${p.suggested ? ` · <span class="sug">${n(p.suggested)} to check</span>` : ""}</span>
    </div>`).join("");
  // unnamed groups
  $("#pp-groups-wrap").hidden = !o.groups.length;
  const names = o.people.map(p => `<option value="${esc(p.name)}">`).join("");
  $("#tag-list").insertAdjacentHTML("beforeend", "");
  $("#pp-groups").innerHTML = o.groups.map(g => `
    <div class="pgroup" data-cluster="${g.cluster}">
      <div class="fstrip">${g.faces.map(f => `<img src="/face/${f}" alt="">`).join("")}</div>
      <div class="namebox">
        <input placeholder="Who is this?" list="pp-names" data-name>
        <button class="primary" data-act="name">Save</button>
        <button class="ghost" data-act="check">Check faces</button>
        <button class="link" data-act="ignore">Don't know them</button>
      </div>
      <div class="cnt">${plural(g.count, "photo")}</div>
    </div>`).join("") + `<datalist id="pp-names">${names}</datalist>`;
  $("#pp-singles").textContent = o.singles ? `${plural(o.singles, "other face")} ${o.singles === 1 ? "appears" : "appear"} only once — they'll join a group when more photos of them turn up.` : "";
}

$("#pp-setup-go").onclick = () => api("/api/people/setup", {}).then(() => { S.lastJobFinished = false; refreshState(); toast("Setting up — you can keep using the app while it looks for faces."); }).catch(fail);
$("#pp-scan").onclick = () => api("/api/people/scan", {}).then(() => { S.lastJobFinished = false; refreshState(); }).catch(fail);

$("#pp-check").onclick = async (e) => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const pid = +b.closest(".checkrow").dataset.pid;
  const p = PP.o.people.find(x => x.id === pid);
  if (b.dataset.act === "review") return openDetail({ kind: "suggested", pid, name: p.name });
  const faces = p._faces || await api("/api/people/faces", { person: pid, status: "suggested" });
  try { await api("/api/people/confirm", { faces: faces.map(f => f.id), yes: true }); toast(`Tagged ${plural(faces.length, "photo")} as ${p.name}.`); loadPeople(); }
  catch (err) { fail(err); }
};
$("#pp-people").onclick = (e) => {
  const c = e.target.closest(".person"); if (!c) return;
  const p = PP.o.people.find(x => x.id === +c.dataset.pid);
  openDetail({ kind: "person", pid: p.id, name: p.name });
};
$("#pp-groups").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("[data-name]")) e.target.closest(".pgroup").querySelector('[data-act="name"]').click(); });
$("#pp-groups").onclick = async (e) => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const card = b.closest(".pgroup"); const cluster = +card.dataset.cluster;
  try {
    if (b.dataset.act === "name") {
      const name = card.querySelector("[data-name]").value.trim();
      if (!name) return toast("Type a name first.");
      const r = await api("/api/people/name", { cluster, name });
      toast(`Tagged ${plural(r.named, "photo")} as ${name}.`);
      loadPeople();
    } else if (b.dataset.act === "ignore") {
      await api("/api/people/ignore", { cluster });
      card.remove();
    } else {
      openDetail({ kind: "cluster", cluster, name: card.querySelector("[data-name]").value.trim() });
    }
  } catch (err) { fail(err); }
};

async function openDetail(d) {
  PP.detail = d; PP.sel = {};
  $("#pp-main").hidden = true; $("#pp-detail").hidden = false;
  let faces;
  try {
    faces = d.kind === "cluster" ? await api("/api/people/faces", { cluster: d.cluster })
      : await api("/api/people/faces", { person: d.pid, status: d.kind === "suggested" ? "suggested" : "confirmed" });
  } catch (e) { return fail(e); }
  d.faces = faces;
  faces.forEach(f => (PP.sel[f.id] = true));
  if (d.kind === "person") {
    $("#pp-d-title").textContent = d.name;
    $("#pp-d-sub").textContent = `${plural(faces.length, "photo")}. Click × on any face that isn't ${d.name}.`;
    $("#pp-d-actions").innerHTML = `<input id="pp-rename" value="${esc(d.name)}" list="pp-names">
      <button class="ghost" data-dact="rename">Rename</button>
      <button class="ghost" data-dact="browse">See their photos</button>
      <button class="link" data-dact="forget">Forget ${esc(d.name)}</button>`;
  } else if (d.kind === "suggested") {
    $("#pp-d-title").textContent = `Is this ${d.name}?`;
    $("#pp-d-sub").textContent = "Untick any that aren't them, then save.";
    $("#pp-d-actions").innerHTML = `<button class="primary" data-dact="confirm">Save</button>`;
  } else {
    $("#pp-d-title").textContent = "Who is this?";
    $("#pp-d-sub").textContent = "Untick any faces that don't belong, then give the rest a name.";
    $("#pp-d-actions").innerHTML = `<input id="pp-cname" placeholder="Name" list="pp-names" value="${esc(d.name || "")}">
      <button class="primary" data-dact="namesel">Name ticked faces</button>
      <button class="link" data-dact="ignoresel">Don't know them</button>`;
  }
  renderDetailGrid();
}
function renderDetailGrid() {
  const d = PP.detail;
  const toggles = d.kind !== "person";
  $("#pp-d-grid").innerHTML = d.faces.map(f => `
    <div class="fc ${PP.sel[f.id] ? "" : "off"}" data-face="${f.id}" data-file="${f.file_id}">
      <img src="/face/${f.id}" alt="" data-open>
      ${toggles ? `<button class="${PP.sel[f.id] ? "fy" : "fx"}" data-toggle>${PP.sel[f.id] ? "✓" : "×"}</button>`
                : `<button class="fx" data-notthem title="Not ${esc(d.name)}">×</button>`}
    </div>`).join("");
}
$("#pp-d-grid").onclick = async (e) => {
  const fc = e.target.closest(".fc"); if (!fc) return;
  const fid = +fc.dataset.face;
  if (e.target.closest("[data-open]")) {
    try { const f = await api("/api/file/" + fc.dataset.file); openViewer([f], 0); } catch (err) { fail(err); }
    return;
  }
  if (e.target.closest("[data-toggle]")) { PP.sel[fid] = !PP.sel[fid]; return renderDetailGrid(); }
  if (e.target.closest("[data-notthem]")) {
    try { await api("/api/people/confirm", { faces: [fid], yes: false }); fc.remove(); toast(`Removed from ${PP.detail.name}.`); }
    catch (err) { fail(err); }
  }
};
$("#pp-d-actions").onclick = async (e) => {
  const b = e.target.closest("[data-dact]"); if (!b) return;
  const d = PP.detail;
  const on = d.faces.filter(f => PP.sel[f.id]).map(f => f.id);
  const off = d.faces.filter(f => !PP.sel[f.id]).map(f => f.id);
  try {
    if (b.dataset.dact === "rename") {
      const name = $("#pp-rename").value.trim();
      const r = await api("/api/people/rename", { person: d.pid, name });
      toast(r.person !== d.pid ? `Merged into ${name}.` : `Renamed to ${name}.`);
      return openDetail({ kind: "person", pid: r.person, name });
    }
    if (b.dataset.dact === "browse") {
      PP.detail = null; showTab("browse");
      $("#f-name").value = d.name; return loadBrowse(true);
    }
    if (b.dataset.dact === "forget") {
      if (!confirm(`Remove the name ${d.name} from all photos? The faces stay, unnamed.`)) return;
      await api("/api/people/forget", { person: d.pid });
    }
    if (b.dataset.dact === "confirm") {
      if (on.length) await api("/api/people/confirm", { faces: on, yes: true });
      if (off.length) await api("/api/people/confirm", { faces: off, yes: false });
      toast(`Tagged ${plural(on.length, "photo")} as ${d.name}.`);
    }
    if (b.dataset.dact === "namesel") {
      const name = $("#pp-cname").value.trim();
      if (!name) return toast("Type a name first.");
      if (!on.length) return toast("Tick at least one face.");
      await api("/api/people/name", { faces: on, name });
      toast(`Tagged ${plural(on.length, "photo")} as ${name}.`);
    }
    if (b.dataset.dact === "ignoresel") {
      await api("/api/people/ignore", { faces: on });
    }
    PP.detail = null; loadPeople();
  } catch (err) { fail(err); }
};
$("#pp-back").onclick = () => { PP.detail = null; loadPeople(); };

/* ------------------------------------------------------------------ updates */
// A newer version downloads by itself in the background; one click restarts into it.
async function checkUpdate() {
  let u;
  try { u = await api("/api/update"); } catch (e) { return setTimeout(checkUpdate, 60000); }
  const box = $("#upd");
  if (u.status === "downloading") {
    box.hidden = false; $("#upd-go").hidden = true;
    $("#upd-text").innerHTML = `<b>Getting version ${esc(u.latest)}…</b><span class="muted">${u.progress ? u.progress + "% downloaded · " : ""}you can keep working</span>`;
  } else if (u.status === "ready") {
    box.hidden = false; $("#upd-go").hidden = false;
    $("#upd-text").innerHTML = `<b>Version ${esc(u.latest)} is ready</b><span class="muted">You have ${esc(u.current || "an older version")}. Restarting takes a few seconds.</span>`;
  } else if (u.status === "available") {
    box.hidden = false; $("#upd-go").hidden = true;
    $("#upd-text").innerHTML = `<b>Version ${esc(u.latest)} is out</b><span class="muted">Download it from the Releases page.</span>`;
  } else box.hidden = true;
  if (u.status !== "ready") setTimeout(checkUpdate, u.status === "downloading" || u.status === "checking" ? 3000 : 10 * 60000);
}
$("#upd-go").onclick = async () => {
  if (S.state && S.state.job && !S.state.job.finished) return toast(`Please wait until “${S.state.job.name}” has finished.`);
  try {
    await api("/api/update/install", {});
    $("#upd-text").innerHTML = "<b>Updating…</b><span class='muted'>Picture Perfect will open again in a moment.</span>";
    $("#upd-go").hidden = true;
  } catch (e) { fail(e); }
};

/* ------------------------------------------------------------------ start */
(async function start() {
  try {
    const st = await refreshState();
    if (!st.library) showSetup(st);
    else {
      if (st.job && st.job.finished) S.handledJob = st.job.id;   // finished before this window opened
      await loadFilters();
      loadAlbums();
      showTab("browse");
    }
  } catch (e) { fail(e); }
  poll();
  setTimeout(checkUpdate, 8000);
})();
