// Runs inside the sandboxed message frame: reports its height to the app and
// makes links open in a new tab. Served as a file so the app's strict CSP
// (script-src 'self') allows it; mail HTML cannot add scripts of its own.
(function () {
  var id = document.documentElement.getAttribute('data-id');
  var send = function () {
    parent.postMessage({ postino: 'h', id: id, h: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) }, '*');
  };
  if (window.ResizeObserver) new ResizeObserver(send).observe(document.body);
  window.addEventListener('load', send);
  setTimeout(send, 50);
  setTimeout(send, 400);
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (a && a.href) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
  });
})();
