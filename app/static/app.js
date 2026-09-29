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
  if (r.picked !== undefined) {
    bits.push(`${n(r.picked)} kept`, `${n(r.trashed)} moved to the Trash`);
    if (r.set_aside) bits.push(`${n(r.set_aside)} couldn't go to the Trash and are in _Set aside`);
  }
  if (r.places_note) bits.push(r.places_note);
  return bits.join(" · ");
}

async function poll() {
  try {
    const st = await refreshState();
    const running = st.job && !st.job.finished;
    if (!running && !S.lastJobFinished) {
      S.lastJobFinished = true;
      await loadFilters();
      const res = (st.job && st.job.result) || {};
      loadAlbums();
      if (st.job && st.job.error && (IM.state === "checking" || IM.state === "running")) importScreen(IM.state === "running" ? "pick" : "start");
      if (res.import_check && !st.job.error) showImport();
      else if (res.imported_ids !== undefined && !st.job.error) showImportReview(res);
      else if (res.inbox_new && !st.job.error) showTab("inbox");   // new photos found on the drive
      else if (S.tab === "inbox" && R.mode !== "inbox") showTab("inbox", true);
      else showTab(S.tab, true);
    }
    if (running) S.lastJobFinished = false;
    setTimeout(poll, running ? 800 : 4000);
  } catch (e) {
    setTimeout(poll, 4000);
  }
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
    S.lastJobFinished = false;
    await refreshState();
    loadAlbums();
    showTab("browse");
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
  const kept = PK.items.filter(i => PK.keep[i.i]).length;
  const skip = PK.items.length - kept;
  const stat = (num, label) => `<div class="stat"><div class="n">${n(num)}</div><div class="l">${label}</div></div>`;
  $("#pk2-stats").innerHTML = stat(kept, "to keep") + stat(skip, "to delete") +
    stat(PK.items.filter(i => PK.rating[i.i]).length, "with stars");
  $("#pk2-list").innerHTML = pickOrder().map(pickTile).join("");
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
      ${it.kind === "video" ? `<span class="vid">▶ Video</span>` : ""}
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
  if (st) { const v = +st.dataset.star; PK.rating[i] = PK.rating[i] === v ? 0 : v; if (PK.rating[i]) PK.keep[i] = true; return renderPicks(); }
  if (e.target.closest("[data-toggle]")) { PK.keep[i] = !PK.keep[i]; return renderPicks(); }
  if (e.target.closest("[data-cull]")) openCull(i);
};
$("#pk2-keep-all").onclick = () => { PK.items.forEach(i => (PK.keep[i.i] = true)); renderPicks(); };
$("#pk2-reset").onclick = () => { PK.items.forEach(i => (PK.keep[i.i] = i.keep !== false)); renderPicks(); };
$("#pk2-done").onclick = () => {
  const keep = PK.items.filter(i => PK.keep[i.i]).map(i => i.i);
  const skip = PK.items.filter(i => !PK.keep[i.i]).map(i => i.i);
  if (skip.length && !confirm(`Move ${plural(skip.length, "photo")} to the Trash? You can still Put Back from the Trash until you empty it.`)) return;
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
  IM.shown = 120;
  IM.sel = new Set(IM.items.filter(i => i.status === "new").map(i => i.i));
  IM.over = {}; IM.times = {}; IM.tags = {}; IM.stars = {}; IM.q = ""; IM.editing = false;
  IM.places = {}; IM.bplace = null;
  IM.focus = (IM.items.find(i => i.status === "new") || IM.items[0] || {}).i;
  $("#im-search").value = ""; $("#im-search").hidden = true;
  $("#im-adv").hidden = true;
  $("#im-folders").value = IM.settings.folders || "month_group";
  $("#im-event").value = "";
  $("#im-format").value = IM.settings.time === "0" ? "0" : "1";
  const dated = IM.items.filter(i => i.taken).map(i => i.taken).sort();
  IM.base = dated.length ? dated[0].slice(0, 10) : null;
  $("#im-date").value = IM.base || "";
  $("#im-date").disabled = !IM.base;
  $("#op-album-sel").innerHTML = `<option value="">Choose an album…</option>` +
    IM.albums.map(a => `<option value="${esc(a.key)}">${esc(a.start.slice(0, 7).replace("-", "."))} ${esc(a.name)}</option>`).join("");
  $("#pp-albums").innerHTML = [...new Set(IM.albums.map(a => a.name))].map(n => `<option value="${esc(n)}">`).join("");
  $("#op-album").checked = false;
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

function imShift() {
  const v = $("#im-date").value;
  if (!IM.base || !v || v === IM.base) return 0;
  return Math.round((isoToMs(v + "T00:00:00") - isoToMs(IM.base + "T00:00:00")) / 1000);
}
function shiftIso(iso, sec) {
  if (!sec) return iso;
  const d = new Date(isoToMs(iso) + sec * 1000);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
function albumChosen() {
  if (!$("#op-album").checked) return null;
  return IM.albums.find(a => a.key === $("#op-album-sel").value) || null;
}
function imNamePart(it) {
  if (IM.over[it.i] !== undefined) return IM.over[it.i];
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
function imTaken(it) {
  if (IM.times[it.i]) return IM.times[it.i];
  return it.taken ? shiftIso(it.taken, imShift()) : null;
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
  const al = albumChosen();
  if (al) starts[al.name.toLowerCase()] = al.start;
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
  const sh = imShift();
  $("#im-date-note").textContent = sh ? `Every photo moves by ${fmtShift(sh)}, keeping its time of day.` :
    (IM.base ? "Change it to fix a camera clock — every photo moves by the same amount." : "No dates found in these photos.");
  $("#im-place").textContent = IM.bplace ? "📍 " + shortPlace(IM.bplace.label || placeName(IM.bplace)) : "+ Add a place";
  $("#im-place-clear").hidden = !IM.bplace;
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
      : `<div class="fname ${IM.over[it.i] !== undefined ? "mine" : ""}"><span>${esc(np.prefix)}</span><input data-name value="${esc(np.np)}" placeholder="name" spellcheck="false">${numSuffix(it) ? `<span class="num" title="Another photo has this name, so this one is numbered">${esc(numSuffix(it))}</span>` : ""}<span>${esc(np.ext)}</span></div>`;
    return `<div class="tr ${on ? "" : "off"} ${IM.focus === it.i ? "focus" : ""}" data-i="${it.i}">
      <div class="c-chk"><input type="checkbox" data-sel ${on ? "checked" : ""}></div>
      <div class="c-img"><img loading="lazy" src="/import-thumb/${it.i}" alt=""></div>
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
      <div class="ph"><img loading="lazy" src="/import-thumb/${it.i}" alt=""><span class="tick" data-sel>${on ? "✓" : ""}</span>
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
    <div class="dimg"><img src="/import-media/${it.i}" alt="" onerror="this.src='/import-thumb/${it.i}'"></div>
    <div class="dname">${esc(it.name)}</div>
    <div class="dmeta">${esc(bits)}</div>
    <div class="dmeta">${when ? `${when.d}${imHasTime(it) ? " · " + when.t : ""}` : `<span class="nodate">No date yet</span>`}</div>
    ${imPlace(it) ? `<div class="dmeta">📍 ${esc(shortPlace(imPlace(it).label))}${imPlace(it).how === "gps" ? "" : " <span class='muted'>(added)</span>"}</div>` : ""}
    ${!IM.editing ? `<div class="drow"><button class="ghost small-btn" id="im-edit-btn">Edit Metadata…</button></div>` : `
    <div class="dedit">
      <div class="panel-head">This photo only</div>
      <label class="fl">Name<input id="ed-name" value="${esc(np)}" placeholder="Event or place"></label>
      <label class="fl">Date &amp; time<input id="ed-time" type="datetime-local" step="60" value="${t ? t.slice(0, 16) : ""}"></label>
      <div class="fl">Location<div class="placerow"><button class="ghost placepick" id="ed-place">${imPlace(it) ? "📍 " + esc(shortPlace(imPlace(it).label)) : "+ Add a place"}</button>${IM.places[it.i] ? `<button class="link" id="ed-place-clear">Clear</button>` : ""}</div></div>
      <label class="fl">Tags<input id="ed-tags" list="tag-list" value="${esc(tags.join(", "))}" placeholder="e.g. Hugh, Sarah"></label>
      <div class="fl">Rating<span class="stars big" id="ed-stars">${starsHtml(IM.stars[it.i] || 0, "data-estar")}</span></div>
      <div class="drow"><button class="link" id="ed-reset">Reset this photo</button><button class="dark" id="ed-done">Done</button></div>
    </div>`}`;
  const eb = $("#im-edit-btn");
  if (eb) eb.onclick = () => { IM.editing = true; renderDetail(); setTimeout(() => $("#ed-name").focus(), 20); };
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
  const pc = $("#ed-place-clear");
  if (pc) pc.onclick = () => { save(); delete IM.places[it.i]; renderImport(); };
  ["#ed-name", "#ed-time", "#ed-tags"].forEach(sel => $(sel).addEventListener("keydown", (e) => { if (e.key === "Enter") $("#ed-done").click(); }));
  $("#ed-reset").onclick = () => { delete IM.over[it.i]; delete IM.times[it.i]; delete IM.tags[it.i]; delete IM.stars[it.i]; delete IM.places[it.i]; IM.editing = false; renderImport(); };
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
["#im-event", "#im-date", "#im-format"].forEach(sel => $(sel).addEventListener("input", renderImport));
$("#im-place").onclick = () => openPicker([], "Location for these photos", null, IM.bplace ? IM.bplace.label : $("#im-event").value.trim(),
  (c) => { IM.bplace = c; renderImport(); });
$("#im-place-clear").onclick = () => { IM.bplace = null; renderImport(); };
$("#im-adv-btn").onclick = () => { $("#im-adv").hidden = !$("#im-adv").hidden; };
$("#im-folders").onchange = async (e) => {
  IM.settings.folders = e.target.value;
  renderImport();
  try { await api("/api/organize/settings", { folders: e.target.value }); } catch (err) { fail(err); }
};
$("#op-album-sel").addEventListener("change", () => { $("#op-album").checked = !!$("#op-album-sel").value; renderImport(); });
$("#op-album").onchange = renderImport;
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
  if ($("#op-delete").checked && !confirm(`After copying, move the ${plural(include.length, "original")} to the Trash? You can Put Back from the Trash until you empty it.`)) return;
  const al = albumChosen();
  const pick = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => IM.sel.has(+k)));
  api("/api/import/commit", {
    include, event: al ? "" : $("#im-event").value.trim(), shift: imShift(), album: al ? al.key : null,
    names: pick(IM.over), times: pick(IM.times), tags: pick(IM.tags), ratings: pick(IM.stars),
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
  if (tab === "locations") loadLocations(true);
  if (tab === "organize") loadOrganize();
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
      `<option value="none">Needs a date or time</option>`;
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
  if (reset) { B.offset = 0; B.items = []; B.days = {}; }
  const q = new URLSearchParams(Object.assign(browseFilters(), { offset: B.offset, limit: 150 }));
  let r;
  try { r = await api("/api/search?" + q); } catch (e) { return fail(e); }
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
        ${it.lat != null ? `<div class="muted small">${it.lat.toFixed(5)}, ${it.lon.toFixed(5)}${it.gps_source === "nearby" ? " · from a nearby photo" : it.gps_source === "manual" ? " · set by you" : ""}</div>` : ""}
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
  try { r = await api("/api/dupes?kind=" + D.kind); } catch (e) { return fail(e); }
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
    <div class="img"><img loading="lazy" src="/thumb/${f.id}" alt=""><span class="tag">${keep ? "Keep" : "Set aside"}</span></div>
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
  const tileEl = e.target.closest(".dup");
  if (tileEl) {
    const id = +tileEl.dataset.id;
    D.choice[key][id] = !D.choice[key][id];
    tileEl.outerHTML = dupTile(g, g.files.find(f => f.id === id));
    return;
  }
  const act = e.target.closest("[data-act]");
  if (!act) return;
  if (act.dataset.act === "skip") { card.remove(); D.groups = D.groups.filter(x => x.key !== key); if (!D.groups.length) loadDupes(); return; }
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

/* ------------------------------------------------------------------ locations */
const L = { days: [], offset: 0, total: 0 };

async function loadLocations(reset) {
  if (reset) { L.days = []; L.offset = 0; }
  let r;
  try { r = await api("/api/locations?offset=" + L.offset); } catch (e) { return fail(e); }
  L.days = L.days.concat(r.days);
  L.offset = L.days.length;
  L.daysTotal = r.days_total;
  $("#loc-sub").textContent = r.total
    ? `${plural(r.total, "photo")} without a location${r.covered ? ` — ${n(r.covered)} can be filled in from nearby photos` : ""}`
    : "";
  $("#btn-accept-all").hidden = !r.covered;
  $("#btn-accept-all").textContent = `Use all ${n(r.covered)} suggestions`;
  $("#loc-empty").hidden = r.total > 0;
  $("#loc-more").hidden = L.days.length >= r.days_total;
  renderLocations();
}

function renderLocations() {
  $("#loc-list").innerHTML = L.days.map((d, i) => {
    const shown = d.ids.slice(0, 10);
    const extra = d.ids.length - shown.length;
    const sug = d.covered
      ? `<span><span class="dot"></span>Suggested:</span> <span class="place">${esc(d.place || "")}</span>
         <span class="muted small">${esc(d.why || "")}${d.covered < d.count ? ` · covers ${n(d.covered)} of ${n(d.count)}` : ""}</span>`
      : `<span class="muted"><span class="dot none"></span>No nearby photos with a location — choose one.</span>`;
    return `<div class="card" data-i="${i}">
      <div class="card-head"><h3>${fmtDay(d.date)}</h3><span class="muted">${plural(d.count, "photo")}${d.guessed_dates ? ` · ${n(d.guessed_dates)} with guessed dates` : ""}</span></div>
      <div class="suggest">${sug}</div>
      <div class="strip">${shown.map(id => `<img loading="lazy" src="/thumb/${id}" alt="">`).join("")}${extra > 0 ? `<div class="plus">+${n(extra)}</div>` : ""}</div>
      <div class="card-actions">
        ${d.covered ? `<button class="primary" data-act="accept">Use suggestion</button>` : ""}
        <button class="${d.covered ? "ghost" : "primary"}" data-act="choose">Choose place…</button>
        <span class="spacer"></span>
        <button class="link" data-act="skip">Leave without location</button>
      </div>
    </div>`;
  }).join("");
}

$("#loc-list").onclick = async (e) => {
  const act = e.target.closest("[data-act]"); if (!act) return;
  const d = L.days[+act.closest(".card").dataset.i];
  try {
    if (act.dataset.act === "accept") {
      const r = await api("/api/locations/accept", { ids: d.ids });
      toast(`Location added to ${plural(r.updated, "photo")}.`);
    } else if (act.dataset.act === "skip") {
      await api("/api/locations/skip", { ids: d.ids });
    } else {
      return openPicker(d.ids, `Place for ${fmtDay(d.date)} · ${plural(d.count, "photo")}`, () => { refreshState(); loadLocations(true); }, d.place);
    }
    refreshState(); loadLocations(true);
  } catch (e2) { fail(e2); }
};
$("#loc-more").onclick = () => loadLocations(false);
$("#btn-accept-all").onclick = async () => {
  try {
    const r = await api("/api/locations/accept", {});
    toast(`Location added to ${plural(r.updated, "photo")}.`);
    refreshState(); loadLocations(true);
  } catch (e) { fail(e); }
};

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

function ensureMap() {
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
    P.results = await api("/api/places?q=" + encodeURIComponent(q));
    $("#pk-results").innerHTML = P.results.length
      ? P.results.map((p, i) => `<button data-i="${i}">${esc(p.label)}${p.detail ? `<span class="d">${esc(p.detail)}</span>` : ""}</button>`).join("")
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

/* ------------------------------------------------------------------ organize */
const ORG = { offset: 0, groups: [] };
async function loadOrganize(data) {
  let r = data;
  if (!r) {
    $("#org-stats").innerHTML = `<p class="muted">Working out the changes…</p>`;
    try { r = await api("/api/organize?offset=" + ORG.offset); } catch (e) { return fail(e); }
  }
  const s = r.settings;
  $$("#set-folders button").forEach(b => b.classList.toggle("on", b.dataset.v === s.folders));
  $$("#set-time button").forEach(b => b.classList.toggle("on", b.dataset.v === s.time));
  $$("#set-highlights button").forEach(b => b.classList.toggle("on", b.dataset.v === s.highlights));
  $("#org-hl-note").innerHTML = s.highlights === "off"
    ? `<span class="muted small">No highlights folders.</span>`
    : `<span class="muted small">📁 <b>2025 Highlights</b> holds a copy of every ${s.highlights === "5" ? "5-star" : "4- and 5-star"} photo from 2025 — ${plural(r.highlights, "photo")} across all years right now. Originals stay in their folders.</span>`;
  $("#btn-hl").hidden = s.highlights === "off";
  const folder = { month_group: "2025.07 › 2025.07 Spain", year_month: "2025 › 2025-07", year: "2025" }[s.folders] || "";
  $("#org-example").textContent = (folder ? `📁 ${folder} › ` : "") + `2025.07.14${s.time === "1" ? " 1030" : ""} Spain.jpg`;

  const dg = (S.state.stats || {}).dup_groups || 0;
  $("#org-dupes-note").hidden = !dg;
  $("#org-dupes-note").textContent = dg ? `You still have ${plural(dg, "duplicate group")} to review. It's fine to organize now, but clearing them first means fewer files to rename.` : "";

  const stat = (num, label) => `<div class="stat"><div class="n">${n(num)}</div><div class="l">${label}</div></div>`;
  $("#org-stats").innerHTML =
    stat(r.renames, "files to rename or move") +
    stat(r.gps, "locations to save into photos") +
    stat(r.dates, "dates to save into photos") +
    (r.tags ? stat(r.tags, "photos with new tags") : "") +
    (r.needs_date ? `<div class="stat"><div class="n" style="color:var(--warn)">${n(r.needs_date)}</div>
       <div class="l">need a date or time — they wait until you add one</div>
       <button class="link" style="padding-left:0" id="org-needs">Add dates &amp; times ›</button></div>` : "");
  const nb = $("#org-needs");
  if (nb) nb.onclick = () => { R.mode = "needs"; showTab("inbox", true); };
  $("#btn-apply").disabled = !r.total;
  $("#btn-undo").hidden = !r.can_undo;

  ORG.offset = r.group_offset || 0;
  ORG.groups = r.groups || [];
  const pages = r.group_total > 40;
  $("#org-list").innerHTML = r.renames ? `
    <p class="hint org-hint">Grouped by the folder each photo goes into. Change a <b>group name</b> to rename every photo in it, or change one photo's name on its own. Leave a name empty to use the place instead.</p>` +
    ORG.groups.map((g, gi) => `
    <div class="ogroup" data-g="${gi}">
      <div class="ogroup-head">
        <div class="ofolder">📁 ${esc(g.folder.split("/").join(" › ") || "top of drive")}</div>
        <label class="oname">Name for ${g.count === 1 ? "this photo" : `all ${n(g.count)} photos`}
          <input data-gname value="${esc(g.name)}" placeholder="Event or place" spellcheck="false"></label>
      </div>
      ${g.items.map(c => {
        const flags = [c.gps ? "+ location" : "", c.date ? "+ date" : "", c.tags ? "+ tags" : ""].filter(Boolean).join(" ");
        return `<div class="orow" data-id="${c.id}">
          <img loading="lazy" src="/thumb/${c.id}" alt="">
          <div class="oold">${esc(fileOf(c.old))}${c.raw.length ? ` <span class="tagx">+ ${esc(c.raw.join(", "))}</span>` : ""}</div>
          <div class="c-arrow">→</div>
          <div class="fname ${c.own ? "mine" : ""}"><span>${esc(c.prefix)}</span><input data-name value="${esc(c.name)}" placeholder="name" spellcheck="false">${c.suffix ? `<span class="num">${esc(c.suffix)}</span>` : ""}<span>${esc(c.ext)}</span></div>
          ${flags ? `<span class="flags">${flags}</span>` : ""}
        </div>`;
      }).join("")}
      ${g.count > g.items.length ? `<div class="tail">…and ${n(g.count - g.items.length)} more in this folder — the group name changes them all</div>` : ""}
    </div>`).join("") +
    (pages ? `<div class="org-pages">
      <button class="ghost" id="org-prev" ${ORG.offset ? "" : "disabled"}>‹ Previous folders</button>
      <span class="muted small">Folders ${n(ORG.offset + 1)}–${n(Math.min(ORG.offset + 40, r.group_total))} of ${n(r.group_total)}</span>
      <button class="ghost" id="org-next" ${ORG.offset + 40 < r.group_total ? "" : "disabled"}>Next folders ›</button></div>` : "")
    : `<div class="empty"><div class="big-check">✓</div>Everything is already organized.</div>`;
  const pv = $("#org-prev"), nx = $("#org-next");
  if (pv) pv.onclick = () => { ORG.offset = Math.max(0, ORG.offset - 40); loadOrganize(); window.scrollTo(0, 0); };
  if (nx) nx.onclick = () => { ORG.offset += 40; loadOrganize(); window.scrollTo(0, 0); };
}

async function orgRename(ids, title) {
  const y = window.scrollY;
  try {
    await api("/api/edit", { ids, title: title.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim() });
    await loadOrganize();
    window.scrollTo(0, y);
    loadAlbums();
  } catch (e) { fail(e); }
}
$("#org-list").addEventListener("change", (e) => {
  const grp = e.target.closest(".ogroup"); if (!grp) return;
  const g = ORG.groups[+grp.dataset.g];
  if (e.target.matches("[data-gname]")) {
    // everything in this folder — including photos beyond the first 60 shown
    return api(`/api/organize/group-ids?folder=${encodeURIComponent(g.folder)}`).then(ids => orgRename(ids, e.target.value)).catch(fail);
  }
  if (e.target.matches("[data-name]")) orgRename([+e.target.closest(".orow").dataset.id], e.target.value);
});
$("#org-list").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches("input")) e.target.blur();
});

async function saveSetting(key, value) {
  try { loadOrganize(await api("/api/organize/settings", { [key]: value })); } catch (e) { fail(e); }
}
$("#set-folders").onclick = (e) => { const b = e.target.closest("button"); if (b) saveSetting("folders", b.dataset.v); };
$("#set-time").onclick = (e) => { const b = e.target.closest("button"); if (b) saveSetting("time", b.dataset.v); };
$("#set-highlights").onclick = (e) => { const b = e.target.closest("button"); if (b) saveSetting("highlights", b.dataset.v); };
$("#btn-hl").onclick = () => api("/api/highlights", {}).then(() => { S.lastJobFinished = false; refreshState(); }).catch(fail);
$("#btn-apply").onclick = () => {
  if (!confirm("Rename and move your photos now? You can undo the renaming afterwards.")) return;
  api("/api/organize/apply", {}).then(() => { S.lastJobFinished = false; refreshState(); }).catch(fail);
};
$("#btn-undo").onclick = () => {
  if (!confirm("Put the files from the last organize back to their old names and folders?")) return;
  api("/api/organize/undo", {}).then(() => { S.lastJobFinished = false; refreshState(); }).catch(fail);
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
      (waiting ? ` ${plural(waiting, "photo needs", "photos need")} a date or time first.` : "");
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
        <span class="fixed">${it.needs === "date" ? `<span class="needs">Date needed</span>` : esc(p.fixed.slice(0, 10))}${it.needs === "time" ? ` <span class="needs">time?</span>` : it.needs ? "" : esc(p.fixed.slice(10))}</span>
        <input data-f="title" value="${esc(it.name_part || "")}" placeholder="${esc(it.default_name || "Add a place or event")}" aria-label="Name">
        <span class="ext">${esc(p.ext)}</span>
      </div>
      <div class="dest">${it.needs === "date" ? "Gets its name and folder once it has a date" : p.folder ? "📁 Goes in folder " + esc(folderOf(it.new)) : "Stays at the top of the drive"}</div>
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

function updateSel() {
  const total = R.items.length, k = R.sel.size;
  $("#rv-all").checked = k === total && total > 0;
  $("#rv-all").indeterminate = k > 0 && k < total;
  $("#rv-count").textContent = k === total ? `All ${n(total)} selected` : `${n(k)} of ${n(total)} selected`;
  $$("[data-bulk]").forEach(b => (b.disabled = !k));
  const ready = R.items.filter(i => !i.needs).length;
  $("#rv-save").textContent = R.mode === "inbox" ? `Save & file ${plural(ready, "photo")}` : "Save changes";
  $("#rv-save").disabled = !ready;
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

$("#rv-all").onchange = (e) => {
  R.sel = new Set(e.target.checked ? R.items.map(i => i.id) : []);
  renderReview();
};
$("#rv-prune-go").onclick = () => { const ids = R.justFiled; R.justFiled = null; $("#rv-prune").hidden = true; openPickSet(ids, "just filed"); };
$("#rv-back").onclick = () => { const to = R.mode === "needs" ? "organize" : "browse"; R.mode = "inbox"; showTab(to); };
$("#rv-save").onclick = () => {
  if (R.mode === "inbox") R.justFiled = R.items.filter(i => !i.needs).map(i => i.id);
  const waiting = R.items.filter(i => i.needs).length;
  if (waiting && !confirm(`${plural(waiting, "photo still needs", "photos still need")} a date or time and will wait here. Save and file the others now?`)) return;
  const ids = R.items.filter(i => !i.needs).map(i => i.id);
  api("/api/organize/apply", { ids }).then(() => { S.lastJobFinished = false; refreshState(); }).catch(fail);
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

async function openGrouper(ids, items, done) {
  G.ids = ids; G.items = items; G.done = done; G.chosen = null;
  $("#gp-title").textContent = `Add ${items.length === 1 ? (items[0].kind === "video" ? "this video" : "this photo") : plural(items.length, "item")} to a group`;
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
      <span><b>${esc(g.name)}</b>
        <span class="m">${fmtRange(g.start, g.end)} · ${plural(g.count, "item")}${g.place ? " · " + esc(g.place) : ""}</span></span>
    </button>`).join("")
    : `<p class="muted small">No groups match. Groups are photos that share a name — give some photos a name first.</p>`;
}

$("#gp-q").addEventListener("input", renderGroups);
$("#gp-list").onclick = (e) => {
  const b = e.target.closest(".gp"); if (!b) return;
  G.chosen = G.groups.find(g => g.key === b.dataset.key);
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

/* ------------------------------------------------------------------ start */
(async function start() {
  try {
    const st = await refreshState();
    if (!st.library) showSetup(st);
    else {
      if (st.job && !st.job.finished) S.lastJobFinished = false;
      await loadFilters();
      loadAlbums();
      showTab("browse");
    }
  } catch (e) { fail(e); }
  poll();
})();
