// One smart app link: send phones straight to their store, desktops to /app/
(function () {
  var ua = navigator.userAgent || '';
  var isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isAndroid = /Android/i.test(ua);
  if (!isIOS && !isAndroid) return;
  var url = isIOS
    ? 'https://apps.apple.com/qa/app/lckd-qatar/id6814395255'
    : 'https://play.google.com/store/apps/details?id=com.g8ts.android.LCDK';
  document.querySelectorAll('[data-app-link]').forEach(function (a) {
    a.href = url;
  });
})();

const navToggle = document.getElementById('navToggle');
const nav = document.getElementById('nav');

navToggle.addEventListener('click', () => {
  nav.classList.toggle('open');
});

nav.querySelectorAll('a').forEach(link => {
  link.addEventListener('click', () => nav.classList.remove('open'));
});
