/*
 * 日報の PNG 出力。出力用の Canvas を別に作って描くので、
 * 画面の表示サイズやライト・ダークモードの影響を受けない。
 *
 * 保存のしかた
 *   iPhone・iPad・Android：共有メニューを開く（「画像を保存」で写真に保存できる）
 *   パソコン：PNG ファイルとしてダウンロードする
 * 共有メニューはボタンを押した直後にしか開けないので、日報画面を開いた時点で PNG を作っておく。
 */
(function (global) {
  'use strict';

  const App = (global.SalesReport = global.SalesReport || {});
  const nav = global.navigator;

  let prepared = null; // { key, promise, result }

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  function buildFileName(date) {
    return (
      '売上日報_' +
      date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) +
      '_' + pad(date.getHours()) + pad(date.getMinutes()) +
      '.png'
    );
  }

  /** 出力サイズ（3508 x 2480 px）の Canvas に日報を描いて返す。 */
  function renderCanvas(data) {
    const page = App.reportTemplate.PAGE;
    const canvas = global.document.createElement('canvas');
    canvas.width = page.width;
    canvas.height = page.height;
    App.reportTemplate.draw(canvas.getContext('2d'), canvas.width, canvas.height, data);
    return canvas;
  }

  /** 日報の PNG を作っておく。同じ内容なら作り直さない。 */
  function prepare(data) {
    const key = JSON.stringify(data);
    if (prepared && prepared.key === key) return prepared.promise;
    const entry = { key: key, result: null };
    entry.promise = new Promise(function (resolve, reject) {
      const canvas = renderCanvas(data);
      canvas.toBlob(function (blob) {
        if (!blob) {
          reject(new Error('PNG の生成に失敗しました。'));
          return;
        }
        entry.result = { blob: blob, width: canvas.width, height: canvas.height };
        resolve(entry.result);
      }, 'image/png');
    });
    entry.promise.catch(function () {
      if (prepared === entry) prepared = null;
    });
    prepared = entry;
    return entry.promise;
  }

  /** スマートフォン・タブレットなら共有メニューで保存する。 */
  function canShareFile(file) {
    const mobile = nav.maxTouchPoints > 0 && /iPhone|iPad|iPod|Android|Macintosh/.test(nav.userAgent);
    return mobile && typeof nav.share === 'function' && typeof nav.canShare === 'function' && nav.canShare({ files: [file] });
  }

  function download(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = global.document.createElement('a');
    link.href = url;
    link.download = fileName;
    global.document.body.appendChild(link);
    link.click();
    link.remove();
    global.setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 10000);
  }

  function save(result) {
    const fileName = buildFileName(new Date());
    const info = { fileName: fileName, width: result.width, height: result.height, bytes: result.blob.size };
    const file = new File([result.blob], fileName, { type: 'image/png' });
    if (canShareFile(file)) {
      return nav.share({ files: [file] }).then(
        function () {
          info.method = 'share';
          return info;
        },
        function (error) {
          if (error && error.name === 'AbortError') {
            info.method = 'cancelled';
            return info;
          }
          throw error;
        }
      );
    }
    download(result.blob, fileName);
    info.method = 'download';
    return Promise.resolve(info);
  }

  /**
   * 日報を PNG として保存する。PNG が作ってあれば、押した操作のうちにすぐ共有メニューを開く。
   * @param {Object} data 日報に載せる値（report-template.js の draw と同じ形）
   * @returns {Promise<{method: string, fileName: string, width: number, height: number, bytes: number}>}
   */
  function exportPng(data) {
    const key = JSON.stringify(data);
    if (prepared && prepared.key === key && prepared.result) return save(prepared.result);
    return prepare(data).then(save);
  }

  App.reportExport = { renderCanvas: renderCanvas, prepare: prepare, exportPng: exportPng };
})(window);
