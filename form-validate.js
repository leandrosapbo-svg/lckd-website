/* LCKD form helpers: country-aware phone input, email and date-of-birth validation. No dependencies. */
(function () {
  // [name, dial code, regex for the national number (no leading 0), example]
  var C = [
    ['Qatar','974',/^[3567]\d{7}$/,'5512 3456'], ['United Arab Emirates','971',/^5\d{8}$/,'50 123 4567'],
    ['Saudi Arabia','966',/^5\d{8}$/,'50 123 4567'], ['Kuwait','965',/^[569]\d{7}$/,'5012 3456'],
    ['Bahrain','973',/^[36]\d{7}$/,'3612 3456'], ['Oman','968',/^[79]\d{7}$/,'9212 3456'],
    ['Egypt','20',/^1[0125]\d{8}$/,'100 123 4567'], ['Jordan','962',/^7[789]\d{7}$/,'79 123 4567'],
    ['Lebanon','961',/^(3\d{6}|7[0169]\d{6}|81\d{6})$/,'71 123 456'], ['Syria','963',/^9\d{8}$/,'944 567 890'],
    ['Iraq','964',/^7\d{9}$/,'750 123 4567'], ['Palestine','970',/^5[69]\d{7}$/,'599 123 456'],
    ['Yemen','967',/^7\d{8}$/,'712 345 678'], ['Morocco','212',/^[67]\d{8}$/,'612 345 678'],
    ['Algeria','213',/^[567]\d{8}$/,'551 234 567'], ['Tunisia','216',/^[2459]\d{7}$/,'20 123 456'],
    ['Sudan','249',/^[19]\d{8}$/,'91 234 5678'], ['Turkey','90',/^5\d{9}$/,'501 234 5678'], ['Iran','98',/^9\d{9}$/,'912 345 6789'],
    ['United Kingdom','44',/^7\d{9}$/,'7400 123456'], ['Ireland','353',/^8\d{8}$/,'85 012 3456'],
    ['France','33',/^[67]\d{8}$/,'6 12 34 56 78'], ['Germany','49',/^1[567]\d{8,9}$/,'1512 3456789'],
    ['Italy','39',/^3\d{8,9}$/,'312 345 6789'], ['Spain','34',/^[67]\d{8}$/,'612 34 56 78'],
    ['Netherlands','31',/^6\d{8}$/,'6 12345678'], ['Portugal','351',/^9\d{8}$/,'912 345 678'], ['Russia','7',/^9\d{9}$/,'912 345 6789'],
    ['United States','1',/^[2-9]\d{2}[2-9]\d{6}$/,'201 555 0123'], ['Canada','1',/^[2-9]\d{2}[2-9]\d{6}$/,'204 555 0123'],
    ['Brazil','55',/^[1-9]{2}9?\d{8}$/,'11 91234 5678'], ['Australia','61',/^4\d{8}$/,'412 345 678'],
    ['India','91',/^[6-9]\d{9}$/,'98123 45678'], ['Pakistan','92',/^3\d{9}$/,'300 1234567'],
    ['Bangladesh','880',/^1[3-9]\d{8}$/,'1712 345678'], ['Sri Lanka','94',/^7\d{8}$/,'71 234 5678'],
    ['Nepal','977',/^9[78]\d{8}$/,'984 123 4567'], ['Philippines','63',/^9\d{9}$/,'917 123 4567'],
    ['Indonesia','62',/^8\d{8,11}$/,'812 3456 7890'], ['Malaysia','60',/^1\d{8,9}$/,'12 345 6789'],
    ['Singapore','65',/^[89]\d{7}$/,'8123 4567'], ['China','86',/^1[3-9]\d{9}$/,'131 2345 6789'],
    ['Japan','81',/^[789]0\d{8}$/,'90 1234 5678'], ['South Korea','82',/^1\d{8,9}$/,'10 1234 5678'],
    ['South Africa','27',/^[678]\d{8}$/,'71 234 5678'], ['Nigeria','234',/^[789]\d{9}$/,'802 123 4567'],
    ['Kenya','254',/^[17]\d{8}$/,'712 345 678'], ['Ethiopia','251',/^9\d{8}$/,'91 234 5678']
  ];
  var OTHER = C.length; // index of the "Other country" entry

  function digits(s) { return String(s || '').replace(/[\s\-().]/g, ''); }

  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

  function errBox(after) {
    var p = el('p', 'sv-fielderr'); p.hidden = true; p.setAttribute('role', 'alert');
    after.parentNode.insertBefore(p, after.nextSibling); return p;
  }
  function setErr(box, msg) { box.textContent = msg || ''; box.hidden = !msg; }

  // ---- phone ----
  function phoneCheck(w) {
    var raw = digits(w.num.value), req = w.hidden.hasAttribute('data-req');
    var c = C[w.sel.value];
    if (!raw) { w.hidden.value = ''; return req ? 'Please enter a phone number.' : ''; }
    if (/[^\d+]/.test(raw)) { w.hidden.value = ''; return 'Use numbers only.'; }
    var dial, national;
    if (w.sel.value == OTHER) {
      dial = digits(w.dial.value).replace(/^\+/, '');
      if (!/^\d{1,4}$/.test(dial)) { w.hidden.value = ''; return 'Enter the country dial code (for example 33).'; }
      national = raw.replace(/^0+/, '');
      if (!/^\d{6,14}$/.test(national)) { w.hidden.value = ''; return 'Enter a valid phone number for this country.'; }
    } else {
      dial = c[1]; national = raw;
      if (national.charAt(0) === '+') {
        if (national.indexOf('+' + dial) === 0) national = national.slice(dial.length + 1);
        else { w.hidden.value = ''; return 'This number starts with a different country code. Pick the right country above.'; }
      } else if (national.indexOf('00' + dial) === 0) national = national.slice(dial.length + 2);
      national = national.replace(/^0+/, '');
      if (!c[2].test(national)) { w.hidden.value = ''; return 'Enter a valid ' + c[0] + ' mobile number, for example ' + c[3] + '.'; }
    }
    w.hidden.value = '(+' + dial + ') ' + national;
    return '';
  }

  function buildPhone(hidden) {
    var wrap = el('div', 'sv-phone');
    var sel = el('select'); sel.setAttribute('aria-label', 'Country');
    C.forEach(function (c, i) { var o = el('option', '', c[0] + ' (+' + c[1] + ')'); o.value = i; sel.appendChild(o); });
    var oo = el('option', '', 'Other country'); oo.value = OTHER; sel.appendChild(oo);
    var dial = el('input'); dial.type = 'tel'; dial.placeholder = 'Dial code, e.g. 33'; dial.maxLength = 5; dial.hidden = true;
    var num = el('input'); num.type = 'tel'; num.autocomplete = 'tel-national'; num.inputMode = 'tel'; num.maxLength = 20;
    num.placeholder = hidden.getAttribute('data-ph') || 'Phone number';
    wrap.appendChild(sel); wrap.appendChild(dial); wrap.appendChild(num);
    hidden.parentNode.insertBefore(wrap, hidden);
    var box = errBox(hidden);
    var w = { hidden: hidden, sel: sel, dial: dial, num: num, box: box, touched: false };
    function placeholder() { if (sel.value != OTHER) num.placeholder = 'e.g. ' + C[sel.value][3]; else num.placeholder = 'Phone number'; dial.hidden = sel.value != OTHER; }
    function run(show) { var m = phoneCheck(w); if (show || w.touched) setErr(box, m); return !m; }
    sel.addEventListener('change', function () { placeholder(); run(false); });
    dial.addEventListener('input', function () { run(false); });
    num.addEventListener('input', function () { run(false); });
    num.addEventListener('blur', function () { w.touched = true; run(true); });
    w.validate = function () { w.touched = true; return run(true); };
    placeholder();
    hidden._w = w;
    return w;
  }

  // ---- email ----
  var EMAIL = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}$/;
  function emailCheck(input) {
    var v = input.value.trim();
    if (!v) return input.hasAttribute('data-req') ? 'Please enter your email.' : '';
    if (v.length > 100 || v.indexOf('..') > -1 || !EMAIL.test(v)) return 'Please enter a valid email address, like name@example.com.';
    return '';
  }

  // ---- date of birth ----
  function dobCheck(input) {
    var v = input.value;
    if (!v) return input.hasAttribute('data-req') ? 'Please enter your date of birth.' : '';
    var d = new Date(v + 'T00:00:00'), now = new Date();
    if (isNaN(d) || d > now) return 'Date of birth cannot be in the future.';
    var age = (now - d) / 31557600000;
    if (age < 10) return 'Please check the date of birth.';
    if (age > 110) return 'Please check the date of birth.';
    return '';
  }

  function init(form) {
    var items = [];
    form.querySelectorAll('input[data-phone]').forEach(function (h) { items.push({ w: buildPhone(h) }); });
    form.querySelectorAll('input[type="email"]').forEach(function (i) {
      var box = errBox(i), touched = false;
      function run(show) { var m = emailCheck(i); if (show || touched) setErr(box, m); return !m; }
      i.addEventListener('input', function () { run(false); });
      i.addEventListener('blur', function () { touched = true; run(true); });
      items.push({ validate: function () { touched = true; return run(true); } });
    });
    form.querySelectorAll('input[data-dob]').forEach(function (i) {
      i.max = new Date().toISOString().slice(0, 10);
      var box = errBox(i), touched = false;
      function run(show) { var m = dobCheck(i); if (show || touched) setErr(box, m); return !m; }
      i.addEventListener('change', function () { touched = true; run(true); });
      items.push({ validate: function () { touched = true; return run(true); } });
    });
    return {
      // Validates every phone/email/date field; returns true when all are valid.
      validateAll: function () {
        var ok = true;
        items.forEach(function (it) { var r = it.w ? it.w.validate() : it.validate(); if (!r) ok = false; });
        return ok;
      }
    };
  }

  window.LCKDForm = { init: init };
})();
