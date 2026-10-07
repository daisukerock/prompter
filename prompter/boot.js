// 起動の見張り役。app.js が動き出せなかったとき(更新の直後に古いファイルが混ざった、
// 読み込みに失敗した、など)に、読み込み直しを案内する。
// どのブラウザでも動くように、モジュールを使わない古い書き方にしている
(function () {
  var started = false;

  function panel() {
    return document.getElementById('bootError');
  }

  function show() {
    if (started) return;
    var box = panel();
    if (box) box.hidden = false;
  }

  // app.js が起動を終えたら呼ぶ。遅れて起動したときは、案内を消す
  window.__prompterStarted = function () {
    started = true;
    var box = panel();
    if (box) box.hidden = true;
  };

  // 起動前のエラー(読み込みの失敗も含む)だけを見る。起動後のエラーは app.js が扱う
  window.addEventListener('error', function () {
    if (!started) setTimeout(show, 0);
  }, true);

  // 10秒たっても起動しなければ、案内を出す
  setTimeout(show, 10000);

  document.addEventListener('DOMContentLoaded', function () {
    var button = document.getElementById('bootReload');
    if (button) button.addEventListener('click', function () { location.reload(); });
  });
})();
