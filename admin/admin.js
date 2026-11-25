(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  // How a person booked (label for the Details popup, short label for the Students list)
  var TYPES = [
    ['trial', 'Free trials', 'Trial'],
    ['walkin', 'Walk-ins', 'Walk-in'],
    ['membership', 'Memberships', 'Member'],
    ['pack', 'Class packs', 'Pack'],
    ['g8ts', 'G8TS app', 'G8TS']
  ];
  var CLASS_MINUTES = 60; // a class counts as "now" for this long after it starts
  var MIN_DAYS = -120, MAX_DAYS = 60;
  var STALE_MINUTES = 45; // warn when today's numbers are older than this
  var HIST_CACHE_MS = 2 * 60 * 1000; // a student's history is reused for this long, then read again
  var SEARCH_DELAY = 220;            // wait for a pause in typing before searching

  var state = { date: null, data: null, reqId: 0, open: null, lastFocus: null, loadedAt: 0, autoScroll: false, hist: {}, studentsScroll: 0, me: null, meLoading: false, auth: null, coaches: [] };
  var pendingNotice = ''; // a message for the login screen (set when Google sends the coach back with a problem)
  var search = { id: 0, timer: 0, openIfOne: false, shown: 0 };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- Doha dates ---------- */
  function dohaToday() {
    // built from parts, because the "en-CA" shortcut formats dates differently in different browsers
    var o = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Qatar', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date()).forEach(function (p) { o[p.type] = p.value; });
    return o.year + '-' + o.month + '-' + o.day;
  }
  function dohaMinutes() {
    var h = 0, m = 0;
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Qatar', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date()).forEach(function (p) {
        if (p.type === 'hour') h = +p.value;
        if (p.type === 'minute') m = +p.value;
      });
    return h * 60 + m;
  }
  function addDays(d, n) {
    var x = new Date(d + 'T00:00:00Z');
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  }
  function diffDays(d, from) {
    return Math.round((Date.parse(d) - Date.parse(from)) / 86400000);
  }
  function labelFor(d) {
    return new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  }
  function startMinutes(time) {
    var p = time.split(':');
    return (+p[0]) * 60 + (+p[1]);
  }
  function validDate(d) {
    return /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + 'T00:00:00Z'));
  }

  /* ---------- API ---------- */
  function api(path, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        return { status: r.status, ok: r.ok, body: body };
      });
    });
  }

  /* ---------- Views ---------- */
  function showLogin() {
    closeSheet();
    state.data = null;
    state.hist = {};
    state.me = null;
    resetSearch();
    $('main').hidden = true;
    $('login').hidden = false;
    $('loginError').hidden = true;
    $('loginNotice').textContent = pendingNotice;
    $('loginNotice').hidden = !pendingNotice;
    pendingNotice = '';
    applyLogin(state.auth);
    loadAuth().then(function (a) {
      applyLogin(a);
      if (!a.google && a.password) setTimeout(function () { $('user').focus(); }, 50);
    });
  }

  // What the login screen offers: the Google button and/or the shared password (the Worker says which are set up)
  function loadAuth() {
    if (state.auth) return Promise.resolve(state.auth);
    return api('/api/admin/auth/options').then(function (r) {
      if (r.ok) { state.auth = r.body; return state.auth; }
      return { google: false, password: true };
    }).catch(function () { return { google: false, password: true }; });
  }
  function applyLogin(a) {
    a = a || { google: false, password: true };
    $('googleBtn').hidden = !a.google;
    $('pwBox').hidden = !a.password;
    $('pwBox').open = !a.google; // the password form is the only way in: show it
    if (!a.google && !a.password) {
      $('loginNotice').textContent = 'Sign-in is not set up yet.';
      $('loginNotice').hidden = false;
    }
  }
  var SIGNIN_MESSAGES = {
    notallowed: 'That Google account is not on the coach list. Ask the owner to add your email.',
    cancelled: 'Google sign-in was cancelled.',
    expired: 'That sign-in took too long or was opened twice. Please try again.',
    failed: 'Google sign-in did not work. Please try again.',
    notsetup: 'Google sign-in is not set up yet.'
  };
  function showMain() {
    $('login').hidden = true;
    $('main').hidden = false;
  }

  /* ---------- Loading ---------- */
  function setSpin(on) { $('refresh').classList.toggle('spin', on); }

  function load(silent) {
    var id = ++state.reqId;
    var date = state.date;
    if (!silent || !state.data || state.data.date !== date) renderSkeleton();
    setSpin(true);
    return api('/api/admin/bookings?date=' + encodeURIComponent(date)).then(function (r) {
      if (id !== state.reqId) return;
      if (r.status === 401) { showLogin(); return; }
      if (!r.ok) throw new Error(r.body.error || 'Could not load bookings.');
      showMain();
      if (!state.me) loadMe();
      state.data = r.body;
      state.loadedAt = Date.now();
      render();
    }).catch(function (e) {
      if (id !== state.reqId) return;
      showMain();
      if (!silent || !state.data) renderError(e.message === 'Failed to fetch' ? 'No connection.' : e.message);
    }).then(function () {
      if (id === state.reqId) setSpin(false);
    });
  }

  function setDate(d, replace) {
    var today = dohaToday();
    if (!validDate(d)) d = today;
    var n = diffDays(d, today);
    if (n < MIN_DAYS || n > MAX_DAYS) return;
    state.date = d;
    state.autoScroll = d === today;
    if (!replace) window.scrollTo(0, 0);
    try { history.replaceState(null, '', d === today ? location.pathname : '#' + d); } catch (e) { /* ignore */ }
    updateNav();
    if (!replace) load(false);
  }

  function updateNav() {
    var today = dohaToday();
    var n = diffDays(state.date, today);
    $('dayName').textContent = labelFor(state.date);
    var tag = $('dayTag');
    tag.className = 'day-tag';
    if (n === 0) { tag.textContent = 'Today'; tag.classList.add('today'); tag.disabled = true; }
    else { tag.textContent = 'Back to today'; tag.disabled = false; }
    var pick = $('datePick');
    pick.min = addDays(today, MIN_DAYS);
    pick.max = addDays(today, MAX_DAYS);
    pick.value = state.date;
    $('prev').disabled = n <= MIN_DAYS;
    $('next').disabled = n >= MAX_DAYS;
    document.title = labelFor(state.date) + ' | LCKD Admin';
  }

  /* ---------- Numbers ---------- */
  // Everything on screen is worked out from the list of students, so the cards,
  // the details and the student list can never disagree.
  function stats(c, zones) {
    var s = { total: 0, women: 0, men: 0, unk: 0, zone: {}, types: {}, other: [] };
    zones.forEach(function (z) { s.zone[z.key] = { n: 0, women: 0, men: 0, unk: 0, list: [] }; });
    TYPES.forEach(function (t) { s.types[t[0]] = { women: 0, men: 0, unk: 0 }; });
    (c.students || []).forEach(function (p) {
      var g = p.gender === 'F' ? 'women' : p.gender === 'M' ? 'men' : 'unk';
      s.total++; s[g]++;
      var z = s.zone[p.zone];
      if (z) { z.n++; z[g]++; z.list.push(p); } else { s.other.push(p); }
      if (!s.types[p.type]) s.types[p.type] = { women: 0, men: 0, unk: 0 };
      s.types[p.type][g]++;
    });
    return s;
  }

  /* ---------- Rendering ---------- */
  function pct(n, of) { return of > 0 ? Math.max(0, Math.min(100, (n / of) * 100)) : 0; }

  function gbar(w, m, u, of) {
    return '<span class="gbar"><i class="w" style="width:' + pct(w, of) + '%"></i><i class="m" style="width:' + pct(m, of) + '%"></i>' +
      (u ? '<i class="u" style="width:' + pct(u, of) + '%"></i>' : '') + '</span>';
  }

  // Zone bar on the cards: just how full it is (no gender colours)
  function fillbar(n, of) {
    return '<span class="gbar"><i class="f" style="width:' + pct(n, of) + '%"></i></span>';
  }

  // One cell per way of booking: Trial / Walk-in / Member / Pack / G8TS
  function typeGrid(types) {
    return '<div class="tgrid">' + TYPES.map(function (t) {
      var v = types[t[0]] || { women: 0, men: 0, unk: 0 };
      var n = v.women + v.men + v.unk;
      return '<div class="tcell t-' + t[0] + (n ? '' : ' zero') + '"><b>' + n + '</b><span>' + t[2] + '</span></div>';
    }).join('') + '</div>';
  }

  function chips(w, m, u, hideMen) {
    return '<span class="chips"><span class="chip w">Women <b>' + w + '</b></span>' +
      (hideMen ? '' : '<span class="chip m">Men <b>' + m + '</b></span>') +
      (u ? '<span class="chip u">Unknown <b>' + u + '</b></span>' : '') + '</span>';
  }

  // "(47 bookings)" next to the title: all the bookings of the day on screen. null = nothing to show yet.
  function setDayTotal(n, date) {
    var el = $('dayTotal');
    if (n == null) { el.hidden = true; el.textContent = ''; return; }
    // the word "bookings" is dropped on very narrow phones (css), leaving "(47)"
    el.innerHTML = '(' + Number(n) + '<span class="dt-w"> ' + (n === 1 ? 'booking' : 'bookings') + '</span>)';
    el.title = Number(n) + (n === 1 ? ' booking' : ' bookings') + ' on ' + labelFor(date);
    el.hidden = false;
  }

  // "Updated 14:32" under the title: the hour and minutes (Doha time) when the bookings were last copied over from G8TS.
  // It stays on every day, because it says how fresh the data is, not which day is on screen. When today's numbers
  // are getting old it turns amber and says how long ago.
  function setUpdated(d) {
    var el = $('updatedAt');
    var when = d && (d.synced || d.updated);
    if (!when || isNaN(Date.parse(when))) { el.hidden = true; el.textContent = ''; el.className = 'updatedat'; return; }
    var t = timeText(when);
    var ageMin = Math.max(0, Math.round((Date.now() - Date.parse(when)) / 60000));
    var ago = ageMin >= 120 ? Math.round(ageMin / 60) + ' h ago' : ageMin + ' min ago';
    var stale = d.date === dohaToday() && ageMin > STALE_MINUTES;
    el.textContent = 'Updated ' + t;
    if (stale) {
      var s = document.createElement('span');
      s.className = 'ago';
      s.textContent = ' · ' + ago; // (hidden on very narrow phones, the amber colour still warns)
      el.appendChild(s);
    }
    el.className = 'updatedat' + (stale ? ' stale' : '');
    el.title = 'Bookings last copied from G8TS at ' + t + ' (' + ago + ')';
    el.hidden = false;
  }

  function renderSkeleton() {
    setSpecial(0);
    setDayTotal(null);
    $('content').innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>';
  }

  function renderError(msg) {
    setSpecial(0);
    setDayTotal(null);
    setUpdated(null);
    $('content').innerHTML = '<div class="errbox">' + esc(msg) + '<br><button type="button" id="retry">Try again</button></div>';
    $('retry').addEventListener('click', function () { load(false); });
  }

  function timeText(iso) {
    return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Qatar' });
  }

  function render() {
    var d = state.data;
    if (!d || d.date !== state.date) return;
    setUpdated(d);
    setSpecial(celebrants(d).length); // the gift icon shows up when someone booked this day is celebrating
    $('sampleBanner').hidden = d.source !== 'sample';
    var cap = d.capacity, zones = d.zones;
    var classes = d.classes;

    if (d.noData) {
      setDayTotal(null);
      $('content').innerHTML = '<div class="empty">No bookings saved for this day yet.</div>';
      return;
    }
    if (!classes.length) {
      setDayTotal(0, d.date);
      $('content').innerHTML = '<div class="empty">No classes on this day.</div>';
      return;
    }

    var all = classes.map(function (c) { return stats(c, zones); });
    var dayTotal = 0, dayTypes = {};
    all.forEach(function (s) {
      dayTotal += s.total;
      Object.keys(s.types).forEach(function (k) {
        var a = dayTypes[k] || (dayTypes[k] = { women: 0, men: 0, unk: 0 }), b = s.types[k];
        a.women += b.women; a.men += b.men; a.unk += b.unk;
      });
    });
    setDayTotal(dayTotal, d.date);

    var isToday = d.date === dohaToday();
    var now = dohaMinutes();
    var highlight = -1;
    var states = classes.map(function (c, i) {
      if (!isToday) return '';
      var s = startMinutes(c.time);
      if (s + CLASS_MINUTES <= now) return 'done';
      if (highlight < 0) highlight = i;
      return s <= now ? 'live' : '';
    });

    // (how old these numbers are is shown in the header: setUpdated)
    var html = '<div class="summary">' +
      '<div class="sum-top"><div class="sum-main"><span class="sum-n">' + dayTotal + '</span><span class="sum-l">booked in ' + classes.length + ' classes</span></div></div>' +
      typeGrid(dayTypes) +
      '</div>';

    classes.forEach(function (c, i) {
      var s = all[i], st = states[i], total = s.total;
      var tag = '';
      if (total >= cap) tag = '<em class="tag full">Full</em>';
      else if (st === 'done') tag = '<em class="tag done">Done</em>';
      else if (st === 'live') tag = '<em class="tag">Now</em>';
      else if (i === highlight) tag = '<em class="tag">Next</em>';

      var zhtml = zones.map(function (z) {
        var zs = s.zone[z.key];
        return '<div class="zone' + (zs.n >= z.capacity ? ' full' : '') + '">' +
          '<span class="zname">' + esc(z.name) + '</span>' +
          '<span class="zn"><b>' + zs.n + '</b>/' + z.capacity + '</span>' +
          fillbar(zs.n, z.capacity) + '</div>';
      }).join('');

      html += '<div class="cls' + (st === 'done' ? ' past' : '') + (i === highlight ? ' next' : '') + '">' +
        '<div class="cls-top"><span class="cls-time">' + esc(c.time) + '</span>' +
        '<span class="cls-kind">' + esc(c.kind) + ' ' + tag + '</span>' +
        '<span class="cls-count"><b>' + total + '</b> / ' + cap + '</span></div>' +
        '<div class="zones">' + zhtml + '</div>' +
        typeGrid(s.types) +
        '<div class="acts">' +
        '<button type="button" class="act" data-act="details" data-id="' + esc(c.id) + '">Class details</button>' +
        '<button type="button" class="act" data-act="students" data-id="' + esc(c.id) + '">Students</button>' +
        '</div></div>';
    });

    $('content').innerHTML = html;
    if (state.autoScroll) {
      state.autoScroll = false;
      // Today: make sure the class that is on now / up next is visible without scrolling
      var nextEl = $('content').querySelector('.cls.next');
      if (nextEl) {
        var r = nextEl.getBoundingClientRect();
        if (r.bottom > window.innerHeight - 16) window.scrollBy(0, r.top - $('main').querySelector('.top').offsetHeight - 12);
      }
    }

    // (a student opened from the search box or the celebrations list does not belong to a class, so it is left alone)
    if (state.open) {
      var from = state.open.from;
      if (state.open.mode === 'special') fillSpecial(); // the celebrations list follows the fresh numbers
      else if (state.open.mode === 'account' || state.open.mode === 'coaches') { /* not about the classes: leave it alone */ }
      else if (!(state.open.mode === 'student' && (from === 'search' || from === 'special'))) {
        var open = findClass(state.open.id);
        if (!open) closeSheet();
        else if (state.open.mode !== 'student') fillSheet(open, state.open.mode); // a student's history view is left alone
      }
    }
  }

  /* ---------- Popup ---------- */
  function findClass(id) {
    var list = (state.data && state.data.classes) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function fillSheet(c, mode) {
    setSheetActions('');
    var d = state.data, cap = d.capacity, s = stats(c, d.zones), total = s.total, left = cap - total;
    var ladies = c.kind === 'Ladies only' && s.men === 0;
    $('sheetTitle').textContent = c.time + ' · ' + c.kind;
    $('sheetSub').textContent = labelFor(d.date) + ' · ' + (left > 0 ? left + ' spots left' : 'Full');
    $('sheetKind').textContent = mode === 'students' ? 'Students' : 'Class details';
    $('sheetClose').setAttribute('aria-label', 'Close');

    var html = '';
    if (mode === 'students') {
      html += '<div class="big"><b>' + total + '</b><span>students booked</span></div>';
      d.zones.forEach(function (z) {
        var zs = s.zone[z.key];
        html += '<h3 class="zh"><span>' + esc(z.name) + '</span><span>' + zs.n + ' / ' + z.capacity + '</span></h3>';
        if (!zs.n) { html += '<p class="none">No one booked</p>'; return; }
        zs.list.slice().sort(function (a, b) { return a.spot - b.spot; }).forEach(function (p) { html += studentRow(p); });
      });
      if (s.other.length) {
        html += '<h3 class="zh"><span>No spot yet</span><span>' + s.other.length + '</span></h3>';
        s.other.forEach(function (p) { html += studentRow(p); });
      }
    } else {
      html += '<div class="big"><b>' + total + '</b><span>of ' + cap + ' booked</span></div>' +
        gbar(s.women, s.men, s.unk, cap) + chips(s.women, s.men, s.unk, ladies) +
        '<h3>How they booked</h3>';
      TYPES.forEach(function (t) {
        var v = s.types[t[0]] || { women: 0, men: 0, unk: 0 };
        var n = v.women + v.men + v.unk;
        html += '<div class="type-row' + (n ? '' : ' zero') + '"><span class="type-name">' + t[1] + '</span><span class="type-n">' + n + '</span>' +
          (n ? gbar(v.women, v.men, v.unk, total) : '') +
          (n > 0 ? '<span class="type-split"><span class="w">Women ' + v.women + '</span>' +
            ((ladies && v.men === 0) ? '' : '<span class="m">Men ' + v.men + '</span>') +
            (v.unk ? '<span class="z">Unknown ' + v.unk + '</span>' : '') + '</span>' : '') +
          '</div>';
      });
    }
    $('sheetBody').innerHTML = html;
  }

  function typeShort(key) {
    for (var i = 0; i < TYPES.length; i++) if (TYPES[i][0] === key) return TYPES[i][2];
    return key;
  }

  /* ---------- Celebrations: birthdays and special class numbers ---------- */
  // The sync marks a student with bd (their birthday is on this day) and cn (this booking is their 10th / 25th / 50th ... class).
  function ordinal(n) {
    var v = n % 100;
    var suffix = (v >= 11 && v <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
    return n + suffix;
  }
  function celebrations(p) {
    var out = [];
    if (p.bd) out.push({ kind: 'bd', icon: '🎂', text: 'Birthday' });
    if (p.cn) out.push({ kind: 'cn', icon: '🏅', text: ordinal(p.cn) + ' class' });
    return out;
  }
  function celText(cel) { return cel.map(function (c) { return c.icon + ' ' + c.text; }).join(' · '); }

  // Everyone celebrating on this day, once each, in the order of their first class: [{ name, pid, cel: [...], rows: [{ c, p }] }]
  function celebrants(d) {
    var by = {}, list = [];
    ((d && d.classes) || []).forEach(function (c) {
      (c.students || []).forEach(function (p) {
        var cel = celebrations(p);
        if (!cel.length) return;
        var key = p.pid || ('n:' + p.name);
        var g = by[key];
        if (!g) { g = by[key] = { name: p.name, pid: p.pid || '', cel: [], rows: [] }; list.push(g); }
        cel.forEach(function (x) { if (!g.cel.some(function (y) { return y.text === x.text; })) g.cel.push(x); });
        g.rows.push({ c: c, p: p });
      });
    });
    return list;
  }

  function setSpecial(n) {
    $('special').hidden = !n;
    $('specialN').textContent = n ? String(n) : '';
    $('special').setAttribute('aria-label', n ? 'Celebrations: ' + n + (n === 1 ? ' student' : ' students') : 'Celebrations');
  }

  function bookingLine(r) {
    var p = r.p, c = r.c;
    var where = p.zone ? (ZONE_NAME[p.zone] || p.zone) + (p.spot ? ' ' + p.spot : '') : '';
    var parts = ['<b>' + esc(c.time) + '</b>'];
    if (c.kind === 'Ladies only') parts.push('Ladies only');
    if (where) parts.push(esc(where));
    if (p.status === 'completed') parts.push('Attended');
    if (p.status === 'noshow') parts.push('No show');
    return '<span class="cbook">' + parts.join(' · ') + '</span>';
  }

  // The list behind the gift icon: who is celebrating what, and which class they are booked into
  function fillSpecial() {
    setSheetActions('');
    var d = state.data;
    var list = celebrants(d);
    $('sheetKind').textContent = 'Celebrations';
    $('sheetTitle').textContent = labelFor(d.date);
    $('sheetSub').textContent = list.length ? list.length + (list.length === 1 ? ' student is' : ' students are') + ' celebrating' : 'No one is celebrating';
    $('sheetClose').setAttribute('aria-label', 'Close');
    if (!list.length) { $('sheetBody').innerHTML = '<p class="none">Nothing to celebrate on this day.</p>'; return; }
    $('sheetBody').innerHTML = list.map(function (g) {
      var inner = '<span class="ctext"><span class="cname">' + esc(g.name) + '</span>' +
        '<span class="cchips">' + g.cel.map(function (x) { return '<span class="cchip">' + x.icon + ' ' + esc(x.text) + '</span>'; }).join('') + '</span>' +
        g.rows.map(bookingLine).join('') + '</span>';
      return g.pid
        ? '<button type="button" class="crow" data-pid="' + esc(g.pid) + '" data-name="' + esc(g.name) + '" data-sub="' + esc(celText(g.cel)) + '">' + inner + CHEVRON.replace('class="rgo"', 'class="cgo"') + '</button>'
        : '<div class="crow plain">' + inner + '</div>';
    }).join('');
  }

  function openSpecial() {
    if (!state.data || state.data.date !== state.date) return;
    state.open = { id: null, mode: 'special' };
    state.lastFocus = document.activeElement;
    fillSpecial();
    $('sheetPanel').scrollTop = 0;
    $('sheet').hidden = false;
    document.body.classList.add('locked');
    $('sheet').querySelector('.sheet-head .icon').focus();
  }

  function studentRow(p) {
    var g = p.gender === 'F' ? 'w' : p.gender === 'M' ? 'm' : 'u';
    var cel = celebrations(p);
    return '<div class="stu' + (p.first ? ' first' : '') + (cel.length ? ' cel' : '') + '"><span class="spot">' + esc(p.zone || '') + ' ' + esc(p.spot || '') + '</span>' +
      '<span class="stu-name"><i class="dot ' + g + '"></i><span class="nm"><span class="nm-t">' + esc(p.name) + '</span>' +
      (p.first ? '<small class="firstcap">First class ever</small>' : '') +
      (cel.length ? '<small class="celcap">' + esc(celText(cel)) + '</small>' : '') + '</span></span>' +
      noteBadge(p) +
      (p.status === 'noshow' ? '<span class="ttag ns">No show</span>' : '') +
      '<span class="ttag ' + esc(p.type) + '">' + esc(typeShort(p.type)) + '</span>' +
      (p.pid ? '<button type="button" class="info" data-pid="' + esc(p.pid) + '" data-name="' + esc(p.name) + '" aria-label="History of ' + esc(p.name) + '">i</button>' : '') +
      '</div>';
  }

  /* ---------- Coach notes: the little icon in the student list ---------- */
  var NOTE_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L3 20.5l1.5-4.9A8 8 0 1 1 21 12z"/></svg>';

  // The bookings answer carries notes: { pid: { n, inj } } for the students of that day who have notes.
  function noteInfo(pid) {
    return (pid && state.data && state.data.notes && state.data.notes[pid]) || null;
  }
  function noteBadge(p) {
    var nt = noteInfo(p.pid);
    if (!nt) return '';
    return '<button type="button" class="nbadge' + (nt.inj ? ' inj' : '') + '" data-pid="' + esc(p.pid) + '" data-name="' + esc(p.name) + '" aria-label="' +
      nt.n + (nt.n === 1 ? ' coach note' : ' coach notes') + (nt.inj ? ', includes an injury or health note' : '') + ' about ' + esc(p.name) + '">' + NOTE_SVG + '<b>' + nt.n + '</b></button>';
  }
  // after a note is added or deleted, keep the icon data of the open day in step
  function setLocalNotes(pid, list) {
    if (!state.data) return;
    var notes = state.data.notes || (state.data.notes = {});
    if (!list.length) { delete notes[pid]; return; }
    notes[pid] = { n: list.length, inj: list.some(function (c) { return c.category === 'injury'; }) };
  }

  /* ---------- One student's history ---------- */
  var STATUS_LABEL = { completed: 'Attended', noshow: 'No show', booked: 'Booked', cancelled: 'Cancelled' };
  var ZONE_NAME = { S: 'Strength', C: 'Cardio', H: 'Hybrid' };

  function dayMonth(d) {
    return new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  }

  // from = 'class' (the "i" button in a class's student list), 'search' (a result of the search box at the top)
  // or 'special' (a row of the celebrations list); sub = the line under the name for the last two
  function openStudent(pid, name, from, sub) {
    var fromSearch = from === 'search', fromSpecial = from === 'special';
    var c = null;
    if (fromSearch) {
      if ($('sheet').hidden) {
        state.lastFocus = document.activeElement;
        $('sheet').hidden = false;
        document.body.classList.add('locked');
      }
      state.open = { id: null, mode: 'student', pid: pid, name: name, from: 'search' };
    } else if (fromSpecial) {
      if (!state.open) return;
      state.open = { id: null, mode: 'student', pid: pid, name: name, from: 'special' };
    } else {
      if (!state.open) return;
      c = findClass(state.open.id);
      state.open = { id: state.open.id, mode: 'student', pid: pid, name: name, from: 'class' };
    }
    $('sheetKind').textContent = 'Student history';
    $('sheetClose').setAttribute('aria-label', fromSearch ? 'Close' : fromSpecial ? 'Back to celebrations' : 'Back to students');
    $('sheetTitle').textContent = name;
    $('sheetSub').textContent = fromSearch ? (sub || 'No phone number saved') : fromSpecial ? (sub || '') : (c ? c.time + ' · ' + c.kind + ' · ' + labelFor(state.data.date) : '');
    state.open.sub = $('sheetSub').textContent; // (the notes view changes the header; closing it puts these back)
    state.open.closeLabel = $('sheetClose').getAttribute('aria-label');
    setSheetActions('');
    $('sheetBody').innerHTML = backButton() + '<div class="skel" style="height:120px"></div><div class="skel" style="height:200px"></div>';
    $('sheetPanel').scrollTop = 0;
    if (fromSearch) $('sheet').querySelector('.sheet-head .icon').focus();

    var cached = state.hist[pid];
    if (cached && Date.now() - cached.at < HIST_CACHE_MS) { renderStudent(cached.data); return; }
    api('/api/admin/student?pid=' + encodeURIComponent(pid)).then(function (r) {
      if (r.status === 401) { showLogin(); return; }
      if (!state.open || state.open.pid !== pid) return;
      if (!r.ok) { $('sheetBody').innerHTML = backButton() + '<p class="none">' + esc(r.body.error || 'Could not load the history.') + '</p>'; return; }
      state.hist[pid] = { at: Date.now(), data: r.body };
      renderStudent(r.body);
    }).catch(function () {
      if (state.open && state.open.pid === pid) $('sheetBody').innerHTML = backButton() + '<p class="none">No connection.</p>';
    });
  }

  function backButton() {
    var from = state.open && state.open.from;
    return '<button type="button" class="back" data-back>‹ ' + (from === 'search' ? 'Back to search' : from === 'special' ? 'Back to celebrations' : 'Back to students') + '</button>';
  }

  function backToStudents() {
    if (!state.open) return;
    if (state.open.from === 'search') { closeSheet(); return; } // the search results are still there underneath
    if (state.open.from === 'special') {
      state.open = { id: null, mode: 'special' };
      fillSpecial();
      $('sheetPanel').scrollTop = state.studentsScroll || 0;
      return;
    }
    var c = findClass(state.open.id);
    if (!c) { closeSheet(); return; }
    state.open = { id: state.open.id, mode: 'students' };
    fillSheet(c, 'students');
    $('sheetPanel').scrollTop = state.studentsScroll || 0;
  }

  function renderStudent(h) {
    var s = h.summary || {};
    var html = backButton();

    // gender first, then the plan(s)
    var gk = h.gender === 'F' ? 'w' : h.gender === 'M' ? 'm' : 'u';
    html += '<div class="plans"><span class="plan gen ' + gk + '"><i class="dot ' + gk + '"></i>' +
      (h.gender === 'F' ? 'Female' : h.gender === 'M' ? 'Male' : 'Gender not on file') + '</span>' +
      (h.plan || []).map(function (p) {
        return '<span class="plan ' + esc(p.kind) + '">' + esc(p.name) + (p.until ? ' · until ' + esc(dayMonth(p.until)) : '') + '</span>';
      }).join('') + '</div>';
    setSheetActions(whatsappButton(h));
    html += '<section class="notes" id="notes" aria-live="polite"><div class="skel" style="height:72px"></div></section>';

    if (!s.booked) {
      // hasProfile = we did read their G8TS profile, and it really has no classes. Otherwise we simply have not read it yet.
      html += h.hasProfile
        ? '<p class="none">No classes booked yet.</p>'
        : '<p class="none"><b>History not loaded yet.</b><br>This student\'s G8TS profile has not been read yet. It is collected in the background, newest sign-ups first. Check again in a few minutes.</p>';
    } else {
      html += '<div class="big"><b>' + s.attended + '</b><span>classes attended</span></div>' +
        '<div class="stats">' +
        stat('Member for', memberFor(s.firstClass), s.firstClass ? 'since ' + dayMonth(s.firstClass) : '') +
        stat('Last visit', s.lastVisit ? dayMonth(s.lastVisit) : 'Not yet') +
        stat('Usual time', s.usualTime || '-') +
        stat('Favorite zone', s.favZone ? (ZONE_NAME[s.favZone] || s.favZone) : '-') +
        '</div>';

      var types = {};
      Object.keys(s.types || {}).forEach(function (k) { types[k] = { women: s.types[k], men: 0, unk: 0 }; });
      html += '<h3>How they booked</h3>' + typeGrid(types);
    }

    if (h.recent && h.recent.length) {
      // (no "first class ever" highlight here: that only belongs in a class's student list)
      html += '<h3>Recent classes</h3>' + h.recent.map(function (r) {
        var where = [r.zone ? r.zone + (r.spot ? ' ' + r.spot : '') : '', r.kind === 'Ladies only' ? 'Ladies only' : ''].filter(Boolean).join(' · ');
        return '<div class="hrow"><div class="hdate"><b>' + esc(labelFor(r.date)) + '</b><span>' + esc(r.time) + (where ? ' · ' + esc(where) : '') + '</span></div>' +
          (r.type ? '<span class="ttag ' + esc(r.type) + '">' + esc(typeShort(r.type)) + '</span>' : '') +
          '<span class="ttag st-' + esc(r.status || 'booked') + '">' + esc(STATUS_LABEL[r.status] || 'Booked') + '</span></div>';
      }).join('');
      if (h.total > h.recent.length) html += '<p class="none">Showing the latest ' + h.recent.length + ' of ' + h.total + ' classes.</p>';
    }

    if (h.limitedSince) {
      html += '<p class="note">Booked through the G8TS app, so there is no full profile. History only goes back to ' + esc(dayMonth(h.limitedSince)) + ', when we first saved it.</p>';
    }
    $('sheetBody').innerHTML = html;
    if (state.open && state.open.pid) {
      if (noteState && noteState.pid === state.open.pid) fillNotesSummary(); // show what we already have, then refresh it
      loadNotes(state.open.pid);
    }
  }

  /* ---------- WhatsApp message about their booking ---------- */
  var WA_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.16-.17.2-.35.22-.64.08-.3-.15-1.26-.46-2.4-1.48-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.6.13-.14.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.03-.52-.07-.15-.67-1.61-.92-2.2-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48 0 1.46 1.07 2.88 1.21 3.07.15.2 2.1 3.2 5.08 4.49.71.3 1.26.49 1.7.63.71.23 1.36.2 1.87.12.57-.09 1.76-.72 2-1.41.25-.7.25-1.29.17-1.41-.07-.13-.27-.2-.57-.35m-5.42 7.4h-.01a9.87 9.87 0 0 1-5.03-1.38l-.36-.21-3.74.98 1-3.65-.24-.37a9.86 9.86 0 0 1-1.51-5.26c0-5.45 4.44-9.88 9.89-9.88 2.64 0 5.12 1.03 6.99 2.9a9.82 9.82 0 0 1 2.89 6.99c0 5.45-4.44 9.88-9.88 9.88m8.41-18.3A11.82 11.82 0 0 0 12.05 0C5.5 0 .16 5.34.16 11.89c0 2.1.55 4.14 1.59 5.95L.06 24l6.3-1.65a11.88 11.88 0 0 0 5.68 1.45h.01c6.55 0 11.89-5.34 11.89-11.89 0-3.18-1.24-6.17-3.48-8.41"/></svg>';

  // "Tuesday 24 Nov at 08:15, Mixed class, Strength zone, spot 6"
  function waLine(b) {
    var weekday = new Date(b.date + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
    var parts = [weekday + ' ' + dayMonth(b.date) + ' at ' + b.time];
    if (b.kind) parts.push(b.kind + ' class');
    if (b.zone && ZONE_NAME[b.zone]) parts.push(ZONE_NAME[b.zone] + ' zone' + (b.spot ? ', spot ' + b.spot : ''));
    return parts.join(', ');
  }

  // The booking(s) the message is about: the class the coach opened the student from, that student's classes on the
  // day being viewed (celebrations list), or their next upcoming classes (opened from the search box).
  function bookingsForMessage(h) {
    var o = state.open || {}, out = [];
    if ((o.from === 'class' || o.from === 'special') && state.data) {
      (state.data.classes || []).forEach(function (c) {
        if (o.from === 'class' && c.id !== o.id) return;
        (c.students || []).forEach(function (s) {
          if (s.pid === o.pid) out.push({ date: state.data.date, time: c.time, kind: c.kind, zone: s.zone, spot: s.spot });
        });
      });
    }
    if (!out.length) {
      var today = dohaToday();
      out = (h.recent || []).filter(function (r) { return r.status === 'booked' && r.date >= today; })
        .sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time); })
        .slice(0, 3);
    }
    return out;
  }

  function waMessage(name, list) {
    var first = String(name || '').trim().split(/\s+/)[0] || 'there';
    var head = 'Hi ' + first + ', this is LCKD';
    if (!list.length) return head + '.';
    if (list.length === 1) return head + ' about your booking: ' + waLine(list[0]) + '.';
    return head + ' about your bookings:\n' + list.map(function (b) { return '- ' + waLine(b); }).join('\n');
  }

  // Round button in the sheet header, only when we have a usable phone number for them
  function setSheetActions(html) { $('sheetActions').innerHTML = html || ''; }
  function whatsappButton(h) {
    if (!h.wa) return '';
    var list = bookingsForMessage(h);
    var first = firstNameOf(state.open && state.open.name);
    var url = 'https://wa.me/' + h.wa + '?text=' + encodeURIComponent(waMessage(state.open && state.open.name, list));
    return '<a class="wabtn" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" aria-label="Message ' + esc(first) + ' on WhatsApp' + (list.length ? ' about their booking' : '') +
      '" title="WhatsApp ' + esc(h.phone || '+' + h.wa) + (list.length ? ' · with their booking' + (list.length > 1 ? 's' : '') : '') + '">' + WA_ICON + '</a>';
  }
  function firstNameOf(name) { return String(name || '').trim().split(/\s+/)[0] || 'this student'; }

  /* ---------- Coach notes: a summary on the student page, the full list in its own view ---------- */
  // Every coach sees every note. Notes are kept forever (deleting one only hides it; editing keeps the old text).
  var noteState = null; // { pid, cats, list, canWrite, composing, editing (note id or 0), cat }
  var NSUM_CHEV = '<svg class="nchev" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>';

  function noteWhen(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Qatar' });
  }

  function catLabel(key) {
    var cats = (noteState && noteState.cats) || [];
    for (var i = 0; i < cats.length; i++) if (cats[i].key === key) return cats[i].label;
    return 'General';
  }

  function loadNotes(pid) {
    if (noteState && noteState.pid !== pid) noteState = null;
    api('/api/admin/comments?pid=' + encodeURIComponent(pid)).then(function (r) {
      if (r.status === 401) { showLogin(); return; }
      if (!state.open || state.open.pid !== pid) return;
      if (state.open.notes) return; // the notes view is open and has its own up-to-date list: never redraw it under someone typing
      if (!$('notes')) return;
      if (!r.ok) { $('notes').innerHTML = '<p class="none">' + esc(r.body.error || 'Could not load the notes.') + '</p>'; return; }
      noteState = { pid: pid, cats: r.body.categories || [], list: r.body.comments || [], canWrite: !!r.body.canWrite, composing: false, editing: 0, cat: 'general' };
      setLocalNotes(pid, noteState.list);
      fillNotesSummary();
    }).catch(function () {
      if (state.open && state.open.pid === pid && $('notes') && !state.open.notes) $('notes').innerHTML = '<p class="none">No connection. The notes could not be loaded.</p>';
    });
  }

  // The short version on the student page: how many, which kinds, and the latest one. Tap = the full notes.
  function fillNotesSummary() {
    var el = $('notes'), n = noteState;
    if (!el || !n || !state.open || state.open.pid !== n.pid || state.open.notes) return;
    var list = n.list;
    if (!list.length) {
      el.innerHTML = '<button type="button" class="nsum nsum-empty" data-notes-open' + (n.canWrite ? '' : ' disabled') + '>' +
        '<span class="nsum-top"><b>Coach notes</b></span><span class="nsum-last">' + (n.canWrite ? 'No notes yet. Tap to add the first one.' : 'No notes yet.') + '</span>' + (n.canWrite ? NSUM_CHEV : '') + '</button>';
      return;
    }
    var counts = {};
    list.forEach(function (c) { counts[c.category] = (counts[c.category] || 0) + 1; });
    var chips = n.cats.filter(function (c) { return counts[c.key]; }).map(function (c) {
      return '<span class="ntag c-' + esc(c.key) + '">' + esc(c.label) + ' · ' + counts[c.key] + '</span>';
    }).join('');
    var last = list[0];
    var preview = String(last.body).replace(/\s+/g, ' ').trim();
    if (preview.length > 110) preview = preview.slice(0, 107).replace(/\s+\S*$/, '') + '…';
    el.innerHTML = '<button type="button" class="nsum' + (counts.injury ? ' inj' : '') + '" data-notes-open>' +
      '<span class="nsum-top"><b>Coach notes</b><span class="nsum-n">' + list.length + '</span></span>' +
      '<span class="nsum-cats">' + chips + '</span>' +
      '<span class="nsum-last">“' + esc(preview) + '”<small>' + esc(last.author) + ' · ' + esc(noteWhen(last.at)) + '</small></span>' + NSUM_CHEV + '</button>';
  }

  // the student page (summary) or the notes view, whichever is showing
  function fillNotes() {
    if (!noteState || !state.open || state.open.pid !== noteState.pid) return;
    if (state.open.notes) fillNotesView(); else fillNotesSummary();
  }

  function restoreStudentHead() {
    var o = state.open;
    if (!o) return;
    $('sheetKind').textContent = 'Student history';
    $('sheetTitle').textContent = o.name;
    $('sheetSub').textContent = o.sub || '';
    $('sheetClose').setAttribute('aria-label', o.closeLabel || 'Back to students');
  }

  function openNotes() {
    var n = noteState;
    if (!state.open || state.open.mode !== 'student' || !n || state.open.pid !== n.pid) return;
    state.open.notes = true;
    n.editing = 0;
    n.composing = n.canWrite && !n.list.length; // nothing there yet: go straight to writing the first one
    n.cat = 'general';
    fillNotesView();
    $('sheetPanel').scrollTop = 0;
  }

  function closeNotes() {
    if (!state.open) return;
    state.open.notes = false;
    if (noteState) { noteState.composing = false; noteState.editing = 0; }
    restoreStudentHead();
    var cached = state.hist[state.open.pid];
    if (cached) renderStudent(cached.data);
    $('sheetPanel').scrollTop = 0;
  }

  // the category buttons + the text box (used to write a new note and to edit one)
  function noteForm(text, saveLabel, first) {
    var n = noteState;
    return '<div class="composer"><div class="cats" role="radiogroup" aria-label="Category">' + n.cats.map(function (c) {
      return '<button type="button" class="ncat c-' + esc(c.key) + (c.key === n.cat ? ' on' : '') + '" role="radio" aria-checked="' + (c.key === n.cat) + '" data-cat="' + esc(c.key) + '">' + esc(c.label) + '</button>';
    }).join('') + '</div>' +
      '<textarea id="noteText" rows="4" maxlength="1500" placeholder="Write a note about ' + esc(first) + '" aria-label="Note">' + esc(text) + '</textarea>' +
      '<p id="noteErr" class="error" role="alert" hidden></p>' +
      '<div class="nbtns"><button type="button" class="ghost" data-note-cancel>Cancel</button><button type="button" class="nsave" data-note-save>' + esc(saveLabel) + '</button></div></div>';
  }

  function noteItem(c) {
    return '<div class="note-item c-' + esc(c.category) + '"><div class="nmeta"><span class="ntag c-' + esc(c.category) + '">' + esc(catLabel(c.category)) + '</span>' +
      '<span class="nwho">' + esc(c.author) + '</span><span class="nwhen">' + esc(noteWhen(c.at)) + '</span>' +
      (c.edited ? '<span class="nwhen nedited">edited ' + esc(noteWhen(c.edited)) + '</span>' : '') +
      '<span class="nacts">' +
      (c.canEdit ? '<button type="button" class="nact" data-note-edit="' + Number(c.id) + '">Edit</button>' : '') +
      (c.canDelete ? '<button type="button" class="nact" data-note-del="' + Number(c.id) + '">Delete</button>' : '') +
      '</span></div><p class="nbody">' + esc(c.body) + '</p></div>';
  }

  // The full notes: add a new one, edit or delete your own (the owner can delete any)
  function fillNotesView() {
    var n = noteState;
    if (!n || !state.open || !state.open.notes) return;
    var first = firstNameOf(state.open.name);
    $('sheetKind').textContent = 'Coach notes';
    $('sheetTitle').textContent = state.open.name;
    $('sheetSub').textContent = n.list.length ? n.list.length + (n.list.length === 1 ? ' note' : ' notes') : 'No notes yet';
    $('sheetClose').setAttribute('aria-label', 'Back to ' + first);
    setSheetActions('');
    var html = '<button type="button" class="back" data-notes-back>‹ Back to ' + esc(first) + '</button>';
    if (n.canWrite && !n.composing && !n.editing) html += '<button type="button" class="nadd wide" data-note-add>+ Add note</button>';
    if (n.composing) html += noteForm('', 'Save note', first);
    if (!n.list.length && !n.composing) html += '<p class="none">No notes yet.' + (n.canWrite ? '' : ' Sign in with Google to write one.') + '</p>';
    html += n.list.map(function (c) {
      if (n.editing === c.id) return '<div class="note-item editing c-' + esc(c.category) + '">' + noteForm(c.body, 'Save changes', first) + '</div>';
      return noteItem(c);
    }).join('');
    $('sheetBody').innerHTML = html;
    if (n.composing || n.editing) {
      var ta = $('noteText');
      if (ta) { ta.focus(); try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) { /* ignore */ } }
    }
  }

  function noteRequest(body) {
    return api('/api/admin/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  function saveNote() {
    var n = noteState, ta = $('noteText'), err = $('noteErr'), btn = document.querySelector('[data-note-save]');
    if (!n || !ta || !err || !btn) return;
    var text = ta.value.trim(), editing = n.editing;
    err.hidden = true;
    if (!text) { err.textContent = 'Write something first.'; err.hidden = false; ta.focus(); return; }
    if (editing) {
      // nothing changed: just close the editor
      var orig = n.list.filter(function (c) { return c.id === editing; })[0];
      if (orig && orig.body === text && orig.category === n.cat) { n.editing = 0; fillNotesView(); return; }
    }
    var pid = n.pid, label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    noteRequest(editing ? { action: 'edit', pid: pid, id: editing, category: n.cat, body: text } : { action: 'add', pid: pid, category: n.cat, body: text }).then(function (r) {
      if (r.status === 401) { showLogin(); return; }
      if (!noteState || noteState.pid !== pid || !$('noteErr')) return;
      if (!r.ok) { $('noteErr').textContent = r.body.error || 'Could not save the note.'; $('noteErr').hidden = false; btn.disabled = false; btn.textContent = label; return; }
      noteState.list = r.body.comments || [];
      noteState.composing = false;
      noteState.editing = 0;
      setLocalNotes(pid, noteState.list);
      fillNotes();
    }).catch(function () {
      if (!$('noteErr')) return;
      $('noteErr').textContent = 'No connection. Your note is still here: try again.';
      $('noteErr').hidden = false;
      btn.disabled = false;
      btn.textContent = label;
    });
  }

  function deleteNote(id) {
    var n = noteState;
    if (!n || !id) return;
    if (!window.confirm('Delete this note? It disappears for every coach.')) return;
    var pid = n.pid;
    noteRequest({ action: 'delete', pid: pid, id: id }).then(function (r) {
      if (r.status === 401) { showLogin(); return; }
      if (!noteState || noteState.pid !== pid) return;
      if (!r.ok) { window.alert(r.body.error || 'Could not delete the note.'); return; }
      noteState.list = r.body.comments || [];
      noteState.editing = 0;
      setLocalNotes(pid, noteState.list);
      fillNotes();
    }).catch(function () { window.alert('No connection. Try again.'); });
  }

  function stat(label, value, sub) {
    return '<div class="stat"><span>' + esc(label) + '</span><b>' + esc(value) + '</b>' + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</div>';
  }

  // "3 weeks", "5 days" ... how long since their first class
  function memberFor(first) {
    if (!first) return '-';
    var days = Math.round((Date.parse(dohaToday()) - Date.parse(first)) / 86400000);
    if (days < 1) return 'New';
    if (days < 14) return days + (days === 1 ? ' day' : ' days');
    if (days < 60) return Math.floor(days / 7) + ' weeks';
    var m = Math.floor(days / 30.4);
    return m + (m === 1 ? ' month' : ' months');
  }

  function openSheet(id, mode) {
    var c = findClass(id);
    if (!c) return;
    state.open = { id: id, mode: mode };
    state.lastFocus = document.activeElement;
    fillSheet(c, mode);
    $('sheetPanel').scrollTop = 0;
    $('sheet').hidden = false;
    document.body.classList.add('locked');
    $('sheet').querySelector('.sheet-head .icon').focus();
  }

  function closeSheet() {
    if ($('sheet').hidden) return;
    $('sheet').hidden = true;
    state.open = null;
    document.body.classList.remove('locked');
    if (state.lastFocus && state.lastFocus.focus) { try { state.lastFocus.focus(); } catch (e) { /* ignore */ } }
  }

  /* ---------- Who is signed in, and the coach list (owner only) ---------- */
  var PERSON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>';

  function initials(name, email) {
    var w = String(name || '').trim().split(/\s+/).filter(Boolean);
    var s = w.length > 1 ? w[0].charAt(0) + w[w.length - 1].charAt(0) : (w[0] || email || '?').slice(0, 2);
    return s.toUpperCase();
  }

  function setAccountButton() {
    var me = state.me, b = $('account');
    if (me && me.kind === 'coach') {
      b.innerHTML = '<span class="avatar">' + esc(initials(me.name, me.email)) + '</span>';
      b.setAttribute('aria-label', 'Account: ' + (me.name || me.email));
    } else {
      b.innerHTML = '<span class="avatar">' + PERSON_SVG + '</span>';
      b.setAttribute('aria-label', 'Account');
    }
  }

  function loadMe() {
    if (state.meLoading) return;
    state.meLoading = true;
    api('/api/admin/me').then(function (r) {
      if (r.ok) { state.me = r.body; setAccountButton(); }
    }).catch(function () { /* the button keeps its plain look */ }).then(function () { state.meLoading = false; });
  }

  function signOut() {
    api('/api/admin/logout', { method: 'POST' }).then(showLogin, showLogin);
  }

  function openAccount() {
    state.open = { id: null, mode: 'account' };
    state.lastFocus = document.activeElement;
    fillAccount();
    $('sheetPanel').scrollTop = 0;
    $('sheet').hidden = false;
    document.body.classList.add('locked');
    $('sheet').querySelector('.sheet-head .icon').focus();
    if (!state.auth) loadAuth().then(function () { if (state.open && state.open.mode === 'account') fillAccount(); });
  }

  function fillAccount() {
    setSheetActions('');
    var me = state.me || { kind: 'shared' };
    var coach = me.kind === 'coach';
    $('sheetKind').textContent = 'Account';
    $('sheetTitle').textContent = coach ? (me.name || me.email) : 'Shared login';
    $('sheetSub').textContent = coach ? me.email : 'Signed in with the shared password';
    $('sheetClose').setAttribute('aria-label', 'Close');
    var html = '';
    if (coach) {
      html += '<div class="plans"><span class="plan">' + (me.role === 'owner' ? 'Owner' : 'Coach') + '</span></div>';
      if (me.role === 'owner') html += '<button type="button" class="sbtn" data-coaches>Manage coaches</button>';
    } else {
      html += '<p class="note">You are signed in with the shared password, so nothing you do can be tied to a person.' +
        (state.auth && state.auth.google ? ' Sign in with Google to put your own name on what you do.' : '') + '</p>';
      if (state.auth && state.auth.google) html += '<a class="sbtn solid" href="/api/admin/auth/google">Sign in with Google</a>';
    }
    html += '<button type="button" class="sbtn" data-signout>Sign out</button>';
    $('sheetBody').innerHTML = html;
  }

  function openCoaches() {
    state.open = { id: null, mode: 'coaches' };
    fillCoaches();
    $('sheetPanel').scrollTop = 0;
    api('/api/admin/coaches').then(function (r) {
      if (r.status === 401) { showLogin(); return; }
      if (!state.open || state.open.mode !== 'coaches') return;
      if (!r.ok) { $('sheetBody').innerHTML = coachesBack() + '<p class="none">' + esc(r.body.error || 'Could not load the coaches.') + '</p>'; return; }
      state.coaches = r.body.coaches || [];
      fillCoaches();
    }).catch(function () {
      if (state.open && state.open.mode === 'coaches') $('sheetBody').innerHTML = coachesBack() + '<p class="none">No connection.</p>';
    });
  }

  function coachesBack() { return '<button type="button" class="back" data-acct-back>‹ Back to account</button>'; }

  // msg = { text, bad } shown under the form after an add / remove
  function fillCoaches(msg) {
    setSheetActions('');
    var list = state.coaches || [], me = state.me || {};
    $('sheetKind').textContent = 'Account';
    $('sheetTitle').textContent = 'Coaches';
    $('sheetSub').textContent = list.length ? list.length + (list.length === 1 ? ' person can' : ' people can') + ' sign in' : 'Loading…';
    $('sheetClose').setAttribute('aria-label', 'Close');
    var html = coachesBack() + '<div class="coaches">' + list.map(function (c) {
      var self = c.email === me.email;
      return '<div class="coach"><span class="ctxt"><b>' + esc(c.name || c.email) + (self ? ' (you)' : '') + '</b>' +
        '<small>' + (c.name ? esc(c.email) : 'has not signed in yet') + '</small></span>' +
        (c.role === 'owner' ? '<span class="plan">Owner</span>'
          : '<button type="button" class="coach-x" data-remove="' + esc(c.email) + '" data-name="' + esc(c.name || c.email) + '">Remove</button>') +
        '</div>';
    }).join('') + '</div>' +
      '<form id="coachForm" class="addcoach" autocomplete="off"><h3>Add a coach</h3>' +
      '<p class="note">Type the email of their Google account. They can sign in as soon as you add them.</p>' +
      '<input id="coachEmail" type="text" inputmode="email" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="Their Google email" maxlength="254" aria-label="Google email of the new coach" required>' +
      '<input id="coachName" type="text" placeholder="Name (optional)" maxlength="80" aria-label="Name of the new coach">' +
      '<button type="submit" class="primary" id="coachAdd">Add coach</button></form>' +
      (msg ? '<p class="' + (msg.bad ? 'error' : 'okmsg') + '" role="status">' + esc(msg.text) + '</p>' : '');
    $('sheetBody').innerHTML = html;
  }

  function changeCoach(body, okText) {
    return api('/api/admin/coaches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) {
      if (r.status === 401) { showLogin(); return; }
      if (!state.open || state.open.mode !== 'coaches') return;
      if (!r.ok) {
        fillCoaches({ text: r.body.error || 'That did not work.', bad: true });
        if (body.action === 'add') { $('coachEmail').value = body.email || ''; $('coachName').value = body.name || ''; } // keep what was typed
        return;
      }
      state.coaches = r.body.coaches || [];
      fillCoaches({ text: okText });
    }).catch(function () {
      if (state.open && state.open.mode === 'coaches') fillCoaches({ text: 'No connection. Try again.', bad: true });
    });
  }

  /* ---------- Student search (name or phone number) ---------- */
  var CHEVRON = '<svg class="rgo" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>';

  function showResults(html) {
    var r = $('results');
    r.innerHTML = html;
    r.hidden = !html;
    fitResults();
  }
  function closeResults() { $('results').hidden = true; }
  function rmsg(html) { return '<p class="rmsg">' + html + '</p>'; }

  // keep the list inside the part of the screen that is left when the phone keyboard is open
  function fitResults() {
    var r = $('results');
    if (r.hidden) return;
    var vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    r.style.maxHeight = Math.max(160, Math.min(520, vh - r.getBoundingClientRect().top - 12)) + 'px';
  }

  function resetSearch() {
    clearTimeout(search.timer);
    search.id++;
    search.openIfOne = false;
    $('q').value = '';
    $('qClear').hidden = true;
    showResults('');
  }

  // text with letters -> a name (2+ letters); only digits -> a phone number (3+ digits)
  function searchReady(q) {
    var hasLetter = /[^\d\s+().-]/.test(q);
    return hasLetter ? q.replace(/\s/g, '').length >= 2 : q.replace(/\D/g, '').length >= 3;
  }

  function runSearch() {
    clearTimeout(search.timer);
    var q = $('q').value.trim();
    $('qClear').hidden = !$('q').value;
    var id = ++search.id;
    if (!q) { showResults(''); return; }
    if (!searchReady(q)) { search.shown = 0; showResults(rmsg('Type at least 2 letters of a name, or 3 digits of a phone number.')); return; }
    if ($('results').hidden || !search.shown) showResults(rmsg('Searching…'));
    api('/api/admin/search?q=' + encodeURIComponent(q)).then(function (r) {
      if (id !== search.id) return;
      if (r.status === 401) { showLogin(); return; }
      if (!r.ok) { search.shown = 0; showResults(rmsg('Could not search. Try again.')); return; }
      renderResults(r.body, q);
    }).catch(function () {
      if (id === search.id) { search.shown = 0; showResults(rmsg('No connection.')); }
    });
  }

  function renderResults(b, q) {
    var list = b.results || [];
    search.shown = list.length;
    if (!b.ready) {
      showResults(rmsg('The student list has not been synced yet. It appears after the next sync.'));
      return;
    }
    if (!list.length) {
      showResults(rmsg('No student found for <b>' + esc(q) + '</b>.<br>Try fewer letters, or the phone number.'));
      return;
    }
    var html = list.map(function (p) {
      return '<button type="button" class="rrow" data-pid="' + esc(p.pid) + '" data-name="' + esc(p.name) + '" data-phone="' + esc(p.phone || '') + '">' +
        '<span class="rtext"><span class="rname">' + esc(p.name) + '</span>' +
        '<span class="rphone' + (p.phone ? '' : ' none') + '">' + (p.phone ? esc(p.phone) : 'No phone number') + '</span></span>' + CHEVRON + '</button>';
    }).join('');
    if (b.total > list.length) html += '<p class="rmore">Showing ' + list.length + ' of ' + b.total + '. Type more to narrow it down.</p>';
    showResults(html);
    // Enter on a search that has exactly one answer goes straight to that student
    if (search.openIfOne && list.length === 1) {
      search.openIfOne = false;
      openStudent(list[0].pid, list[0].name, 'search', list[0].phone);
    }
  }

  $('q').addEventListener('input', function () {
    search.openIfOne = false;
    $('qClear').hidden = !this.value;
    clearTimeout(search.timer);
    if (!this.value.trim()) { search.id++; showResults(''); return; }
    search.timer = setTimeout(runSearch, SEARCH_DELAY);
  });
  $('q').addEventListener('focus', function () {
    if (this.value.trim() && $('results').innerHTML) { $('results').hidden = false; fitResults(); }
  });
  $('q').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      search.openIfOne = true;
      runSearch();
      this.blur(); // hides the phone keyboard so the list is fully visible
    } else if (e.key === 'Escape') {
      if (!$('results').hidden) closeResults(); else if (this.value) resetSearch();
    } else if (e.key === 'ArrowDown') {
      var first = $('results').querySelector('.rrow');
      if (first) { e.preventDefault(); first.focus(); }
    }
  });
  $('qClear').addEventListener('click', function () { resetSearch(); $('q').focus(); });

  $('results').addEventListener('click', function (e) {
    var row = e.target.closest ? e.target.closest('.rrow') : null;
    if (row) openStudent(row.getAttribute('data-pid'), row.getAttribute('data-name'), 'search', row.getAttribute('data-phone'));
  });
  $('results').addEventListener('keydown', function (e) {
    var rows = [].slice.call($('results').querySelectorAll('.rrow'));
    var i = rows.indexOf(document.activeElement);
    if (i < 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (rows[i + 1]) rows[i + 1].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (i > 0) rows[i - 1].focus(); else $('q').focus(); }
    else if (e.key === 'Escape') { closeResults(); $('q').focus(); }
  });
  // tapping anywhere else (but not inside the student popup) puts the list away; the typed text stays
  document.addEventListener('click', function (e) {
    if (!$('results').hidden && e.target.closest && !e.target.closest('#searchRow, #sheet')) closeResults();
  });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', fitResults);

  /* ---------- Events ---------- */
  $('content').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-act]') : null;
    if (btn) openSheet(btn.getAttribute('data-id'), btn.getAttribute('data-act'));
  });

  $('sheet').addEventListener('click', function (e) {
    var t = e.target.closest ? e.target : null;
    if (!t) return;
    var closer = t.closest('[data-close]');
    if (closer) {
      // the X on a student's history goes back to the student list; tapping outside still closes everything
      if (state.open && state.open.mode === 'student' && closer.classList.contains('icon')) { if (state.open.notes) closeNotes(); else backToStudents(); }
      else closeSheet();
      return;
    }
    var back = t.closest('[data-back]');
    if (back) { backToStudents(); return; }
    if (t.closest('[data-notes-open]')) { openNotes(); return; }
    if (t.closest('[data-notes-back]')) { closeNotes(); return; }
    if (t.closest('[data-note-add]')) { if (noteState) { noteState.composing = true; noteState.editing = 0; noteState.cat = 'general'; fillNotesView(); } return; }
    var noteEdit = t.closest('[data-note-edit]');
    if (noteEdit && noteState) {
      var eid = Number(noteEdit.getAttribute('data-note-edit'));
      var enote = noteState.list.filter(function (c) { return c.id === eid; })[0];
      if (enote) { noteState.editing = eid; noteState.composing = false; noteState.cat = enote.category; fillNotesView(); }
      return;
    }
    if (t.closest('[data-note-cancel]')) { if (noteState) { noteState.composing = false; noteState.editing = 0; fillNotesView(); } return; }
    var catBtn = t.closest('[data-cat]');
    if (catBtn && noteState) {
      noteState.cat = catBtn.getAttribute('data-cat');
      [].forEach.call(catBtn.parentNode.querySelectorAll('.ncat'), function (b) { var on = b === catBtn; b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); });
      return;
    }
    if (t.closest('[data-note-save]')) { saveNote(); return; }
    var noteDel = t.closest('[data-note-del]');
    if (noteDel) { deleteNote(Number(noteDel.getAttribute('data-note-del'))); return; }
    if (t.closest('[data-signout]')) { signOut(); return; }
    if (t.closest('[data-coaches]')) { openCoaches(); return; }
    if (t.closest('[data-acct-back]')) { state.open = { id: null, mode: 'account' }; fillAccount(); return; }
    var rm = t.closest('[data-remove]');
    if (rm) {
      var who = rm.getAttribute('data-name');
      if (window.confirm('Remove ' + who + ' from the coach list? They are signed out right away and cannot sign in again until you add them back.')) {
        changeCoach({ action: 'remove', email: rm.getAttribute('data-remove') }, who + ' was removed.');
      }
      return;
    }
    var info = t.closest('.info, .nbadge');
    if (info) {
      state.studentsScroll = $('sheetPanel').scrollTop;
      openStudent(info.getAttribute('data-pid'), info.getAttribute('data-name'), 'class');
      return;
    }
    var crow = t.closest('.crow[data-pid]');
    if (crow) {
      state.studentsScroll = $('sheetPanel').scrollTop;
      openStudent(crow.getAttribute('data-pid'), crow.getAttribute('data-name'), 'special', crow.getAttribute('data-sub'));
    }
  });
  $('special').addEventListener('click', openSpecial);
  $('account').addEventListener('click', openAccount);
  $('sheet').addEventListener('submit', function (e) {
    if (!e.target || e.target.id !== 'coachForm') return;
    e.preventDefault();
    var email = $('coachEmail').value.trim(), name = $('coachName').value.trim();
    $('coachAdd').disabled = true;
    changeCoach({ action: 'add', email: email, name: name }, email + ' can sign in with Google now.');
  });

  document.addEventListener('keydown', function (e) {
    if ($('sheet').hidden) return;
    // Escape inside the note box only cancels the note (it must not throw the student's page away with the draft)
    if (e.key === 'Escape' && e.target && e.target.id === 'noteText') { if (noteState) { noteState.composing = false; noteState.editing = 0; fillNotes(); } return; }
    if (e.key === 'Escape') { if (state.open && state.open.mode === 'student') { if (state.open.notes) closeNotes(); else backToStudents(); } else closeSheet(); }
    if (e.key === 'Tab') {
      // keep keyboard focus inside the popup
      var f = [].slice.call($('sheetPanel').querySelectorAll('button, input, textarea, a[href]')).filter(function (b) { return !b.disabled && b.offsetParent !== null; });
      if (!f.length) return;
      var i = f.indexOf(document.activeElement);
      e.preventDefault();
      f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
    }
  });

  $('prev').addEventListener('click', function () { setDate(addDays(state.date, -1)); });
  $('next').addEventListener('click', function () { setDate(addDays(state.date, 1)); });

  // Date picker: the invisible date input is what gets tapped on phones; the button covers keyboards
  function showPicker(input) {
    try { if (input.showPicker) input.showPicker(); } catch (e) { /* the browser opens it by itself */ }
  }
  $('dayBtn').addEventListener('click', function () { showPicker($('datePick')); });
  $('datePick').addEventListener('click', function () { showPicker(this); });
  $('datePick').addEventListener('change', function () {
    if (this.value && validDate(this.value) && this.value !== state.date) setDate(this.value);
    else this.value = state.date;
  });
  $('dayTag').addEventListener('click', function () { setDate(dohaToday()); });
  $('refresh').addEventListener('click', function () { load(true); });

  // Swipe left / right on the list to change day
  (function () {
    var sx = 0, sy = 0, st = 0, tracking = false;
    var el = $('content');
    el.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) { tracking = false; return; }
      tracking = true; sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now();
    }, { passive: true });
    el.addEventListener('touchend', function (e) {
      if (!tracking || !$('sheet').hidden) return;
      tracking = false;
      var t = e.changedTouches[0];
      var dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) > 70 && Math.abs(dx) > 2 * Math.abs(dy) && Date.now() - st < 700) {
        setDate(addDays(state.date, dx < 0 ? 1 : -1));
      }
    }, { passive: true });
  })();

  // Login form
  $('togglePass').addEventListener('click', function () {
    var show = $('pass').type === 'password';
    $('pass').type = show ? 'text' : 'password';
    this.textContent = show ? 'Hide' : 'Show';
    this.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });

  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('loginBtn'), err = $('loginError');
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    api('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('user').value, password: $('pass').value })
    }).then(function (r) {
      if (r.ok) {
        $('pass').value = '';
        showMain();
        load(false);
      } else {
        err.textContent = r.body.error || 'Could not sign in.';
        err.hidden = false;
      }
    }).catch(function () {
      err.textContent = 'No connection. Try again.';
      err.hidden = false;
    }).then(function () {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    });
  });

  // Keep numbers fresh while a coach has the page open
  setInterval(function () {
    if (!document.hidden && !$('main').hidden) load(true);
  }, 60000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && !$('main').hidden && Date.now() - state.loadedAt > 20000) load(true);
  });
  window.addEventListener('hashchange', function () {
    var h = location.hash.replace('#', '');
    if (validDate(h) && h !== state.date && !$('main').hidden) setDate(h);
  });

  /* ---------- Start ---------- */
  // Google sends the coach back to /admin/?signin=<code> when something went wrong; show it on the login screen
  var signinCode = new URLSearchParams(location.search).get('signin');
  if (signinCode) {
    pendingNotice = SIGNIN_MESSAGES[signinCode] || 'Could not sign in.';
    try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) { /* ignore */ }
  }
  var h = location.hash.replace('#', '');
  setDate(validDate(h) ? h : dohaToday(), true);
  load(false);
})();
