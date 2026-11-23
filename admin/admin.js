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

  var state = { date: null, data: null, reqId: 0, open: null, lastFocus: null, loadedAt: 0, autoScroll: false, hist: {}, studentsScroll: 0 };

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
    $('main').hidden = true;
    $('login').hidden = false;
    $('loginError').hidden = true;
    setTimeout(function () { $('user').focus(); }, 50);
  }
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

  function renderSkeleton() {
    $('content').innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>';
  }

  function renderError(msg) {
    $('content').innerHTML = '<div class="errbox">' + esc(msg) + '<br><button type="button" id="retry">Try again</button></div>';
    $('retry').addEventListener('click', function () { load(false); });
  }

  function timeText(iso) {
    return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Qatar' });
  }

  function render() {
    var d = state.data;
    if (!d || d.date !== state.date) return;
    $('sampleBanner').hidden = d.source !== 'sample';
    var cap = d.capacity, zones = d.zones;
    var classes = d.classes;

    if (d.noData) {
      $('content').innerHTML = '<div class="empty">No bookings saved for this day yet.</div>';
      return;
    }
    if (!classes.length) {
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

    // How old are these numbers? (they come from a snapshot, so this matters)
    var ageMin = Math.max(0, Math.round((Date.now() - Date.parse(d.updated)) / 60000));
    var stale = isToday && ageMin > STALE_MINUTES;
    var upd = 'Updated ' + timeText(d.updated) + (stale ? ' · ' + (ageMin >= 120 ? Math.round(ageMin / 60) + ' h' : ageMin + ' min') + ' ago' : '');

    var html = '<div class="summary">' +
      '<div class="sum-top"><div class="sum-main"><span class="sum-n">' + dayTotal + '</span><span class="sum-l">booked in ' + classes.length + ' classes</span></div></div>' +
      typeGrid(dayTypes) +
      '<p class="upd' + (stale ? ' stale' : '') + '">' + upd + '</p></div>';

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

    if (state.open) {
      var open = findClass(state.open.id);
      if (!open) closeSheet();
      else if (state.open.mode !== 'student') fillSheet(open, state.open.mode); // a student's history view is left alone
    }
  }

  /* ---------- Popup ---------- */
  function findClass(id) {
    var list = (state.data && state.data.classes) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function fillSheet(c, mode) {
    var d = state.data, cap = d.capacity, s = stats(c, d.zones), total = s.total, left = cap - total;
    var ladies = c.kind === 'Ladies only' && s.men === 0;
    $('sheetTitle').textContent = c.time + ' · ' + c.kind;
    $('sheetSub').textContent = labelFor(d.date) + ' · ' + (left > 0 ? left + ' spots left' : 'Full');
    $('sheetKind').textContent = mode === 'students' ? 'Students' : 'Class details';

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

  function studentRow(p) {
    var g = p.gender === 'F' ? 'w' : p.gender === 'M' ? 'm' : 'u';
    return '<div class="stu"><span class="spot">' + esc(p.zone || '') + ' ' + esc(p.spot || '') + '</span>' +
      '<span class="stu-name"><i class="dot ' + g + '"></i><span>' + esc(p.name) + '</span></span>' +
      (p.status === 'noshow' ? '<span class="ttag ns">No show</span>' : '') +
      '<span class="ttag ' + esc(p.type) + '">' + esc(typeShort(p.type)) + '</span>' +
      (p.pid ? '<button type="button" class="info" data-pid="' + esc(p.pid) + '" data-name="' + esc(p.name) + '" aria-label="History of ' + esc(p.name) + '">i</button>' : '') +
      '</div>';
  }

  /* ---------- One student's history ---------- */
  var STATUS_LABEL = { completed: 'Attended', noshow: 'No show', booked: 'Booked', cancelled: 'Cancelled' };
  var ZONE_NAME = { S: 'Strength', C: 'Cardio', H: 'Hybrid' };

  function dayMonth(d) {
    return new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  }

  function openStudent(pid, name) {
    if (!state.open) return;
    var c = findClass(state.open.id);
    state.open = { id: state.open.id, mode: 'student', pid: pid, name: name };
    $('sheetKind').textContent = 'Student history';
    $('sheetTitle').textContent = name;
    $('sheetSub').textContent = c ? c.time + ' · ' + c.kind + ' · ' + labelFor(state.data.date) : '';
    $('sheetBody').innerHTML = backButton() + '<div class="skel" style="height:120px"></div><div class="skel" style="height:200px"></div>';
    $('sheetPanel').scrollTop = 0;

    if (state.hist[pid]) { renderStudent(state.hist[pid]); return; }
    api('/api/admin/student?pid=' + encodeURIComponent(pid)).then(function (r) {
      if (r.status === 401) { showLogin(); return; }
      if (!state.open || state.open.pid !== pid) return;
      if (!r.ok) { $('sheetBody').innerHTML = backButton() + '<p class="none">' + esc(r.body.error || 'Could not load the history.') + '</p>'; return; }
      state.hist[pid] = r.body;
      renderStudent(r.body);
    }).catch(function () {
      if (state.open && state.open.pid === pid) $('sheetBody').innerHTML = backButton() + '<p class="none">No connection.</p>';
    });
  }

  function backButton() {
    return '<button type="button" class="back" data-back>‹ Back to students</button>';
  }

  function backToStudents() {
    if (!state.open) return;
    var c = findClass(state.open.id);
    if (!c) { closeSheet(); return; }
    state.open = { id: state.open.id, mode: 'students' };
    fillSheet(c, 'students');
    $('sheetPanel').scrollTop = state.studentsScroll || 0;
  }

  function renderStudent(h) {
    var s = h.summary || {};
    var html = backButton();

    // plan
    if (h.plan && h.plan.length) {
      html += '<div class="plans">' + h.plan.map(function (p) {
        return '<span class="plan ' + esc(p.kind) + '">' + esc(p.name) + (p.until ? ' · until ' + esc(dayMonth(p.until)) : '') + '</span>';
      }).join('') + '</div>';
    }

    if (!s.booked) {
      html += '<p class="none">No classes found for this student yet.</p>';
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
    } else if (!h.hasProfile && !s.booked) {
      html += '<p class="note">History appears after the next sync.</p>';
    }
    $('sheetBody').innerHTML = html;
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

  /* ---------- Events ---------- */
  $('content').addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-act]') : null;
    if (btn) openSheet(btn.getAttribute('data-id'), btn.getAttribute('data-act'));
  });

  $('sheet').addEventListener('click', function (e) {
    var t = e.target.closest ? e.target : null;
    if (!t) return;
    if (t.closest('[data-close]')) { closeSheet(); return; }
    var back = t.closest('[data-back]');
    if (back) { backToStudents(); return; }
    var info = t.closest('.info');
    if (info) {
      state.studentsScroll = $('sheetPanel').scrollTop;
      openStudent(info.getAttribute('data-pid'), info.getAttribute('data-name'));
    }
  });

  document.addEventListener('keydown', function (e) {
    if ($('sheet').hidden) return;
    if (e.key === 'Escape') closeSheet();
    if (e.key === 'Tab') {
      // keep keyboard focus inside the popup
      var f = [].slice.call($('sheetPanel').querySelectorAll('button')).filter(function (b) { return !b.disabled && b.offsetParent !== null; });
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

  $('logout').addEventListener('click', function () {
    api('/api/admin/logout', { method: 'POST' }).then(showLogin, showLogin);
  });

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
  var h = location.hash.replace('#', '');
  setDate(validDate(h) ? h : dohaToday(), true);
  load(false);
})();
