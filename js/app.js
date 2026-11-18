/*
 * 画面の制御：画面切り替え、入力、入力状態の管理、初期化、プレビュー、動作状態の表示。
 * 計算は calculations.js、日報の描画は report-template.js、PNG 出力は report-export.js が担当する。
 */
(function (global) {
  'use strict';

  const App = global.SalesReport;
  const calc = App.calculations;
  const doc = global.document;

  const APP_VERSION = '1.0';
  const DEFAULT_STAFF_COUNT = 5;
  const DEFAULT_EMPLOYEE_COUNT = 2;
  const MAX_STAFF_COUNT = App.reportTemplate.STAFF_CAPACITY; // 日報の出勤簿の行数（10 人）
  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
  const VIEW_TITLES = { summary: '集計', report: '日報プレビュー', info: '設定・情報' };

  const TIME_LABELS = { start: '開始', end: '終了' };
  const DEFAULT_TIME = 17 * 60; // 未入力の欄に最初に入れる時刻（17:00）
  const MIN_TIME = 8 * 60; // 選べる時刻は 8:00〜23:00
  const MAX_TIME = 23 * 60;
  const TIME_STEP = 15;
  const TIME_STEPS = [
    { minutes: -TIME_STEP, amount: '−15', unit: '分', spoken: '15 分戻す' },
    { minutes: TIME_STEP, amount: '+15', unit: '分', spoken: '15 分進める' }
  ];
  const BREAK_OPTIONS = [
    { minutes: 15, label: '15分' },
    { minutes: 30, label: '30分' },
    { minutes: 45, label: '45分' },
    { minutes: 60, label: '1時間' }
  ];

  const STAFF_ERRORS = {
    breakTooLong: '休憩が長すぎます',
    endBeforeStart: '終了が開始より前です'
  };

  // 入力は保存しないので、区分の初期値を固定しておく（A・B は社員、C 以降はアルバイト）
  function createStaffRow(index) {
    return {
      type: index < DEFAULT_EMPLOYEE_COUNT ? 'employee' : 'partTime',
      start: '',
      end: '',
      breakMinutes: null
    };
  }

  function createInitialState() {
    const staff = [];
    for (let i = 0; i < DEFAULT_STAFF_COUNT; i += 1) staff.push(createStaffRow(i));
    return { sales: {}, plannedHours: null, staff: staff };
  }

  // 入力値は実行中のメモリだけで保持する。localStorage などには保存しない。
  let state = createInitialState();
  let currentView = 'summary';
  let todayText = '';
  let errorCount = 0;

  const numberFormat = new Intl.NumberFormat('ja-JP');
  const hoursFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 2 });
  const darkQuery = global.matchMedia('(prefers-color-scheme: dark)');

  function byId(id) {
    return doc.getElementById(id);
  }

  function element(tag, className, textContent) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (textContent !== undefined) node.textContent = textContent;
    return node;
  }

  function staffName(index) {
    return String.fromCharCode(65 + index);
  }

  /** 全角数字を半角にし、数字以外と先頭の余分な 0 を取り除く。 */
  function toDigits(text, maxLength) {
    return text
      .replace(/[０-９]/g, function (ch) {
        return String.fromCharCode(ch.charCodeAt(0) - 0xfee0);
      })
      .replace(/[^0-9]/g, '')
      .replace(/^0+(?=[0-9])/, '')
      .slice(0, maxLength);
  }

  /** 小数（小数第 2 位まで）を入力できる欄を整え、数値（未入力なら null）を返す。 */
  function readDecimal(input) {
    const parts = input.value
      .replace(/[０-９．]/g, function (ch) {
        return String.fromCharCode(ch.charCodeAt(0) - 0xfee0);
      })
      .replace(/[^0-9.]/g, '')
      .split('.');
    const whole = parts[0].replace(/^0+(?=[0-9])/, '').slice(0, 3);
    const text = parts.length > 1 ? (whole || '0') + '.' + parts.slice(1).join('').slice(0, 2) : whole;
    if (input.value !== text) input.value = text;
    return text === '' ? null : Number(text);
  }

  /** 数字だけの入力欄を整え、数値（未入力なら null）を返す。 */
  function readNumber(input, maxLength) {
    const digits = toDigits(input.value, maxLength);
    if (input.value !== digits) input.value = digits;
    return digits === '' ? null : Number(digits);
  }

  function createNumberInput(maxLength, onChange) {
    const input = doc.createElement('input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    // 日本語入力の変換中は値を書き換えず、確定時にまとめて処理する
    input.addEventListener('input', function (event) {
      if (!event.isComposing) onChange(readNumber(input, maxLength));
    });
    input.addEventListener('compositionend', function () {
      onChange(readNumber(input, maxLength));
    });
    return input;
  }

  function afterChange() {
    byId('summary-status').textContent = '';
    renderComputed();
  }

  // ---- 出勤簿 ----

  function createStaffRowElement(index) {
    const data = state.staff[index];
    const name = staffName(index);

    const row = element('div', 'staff-row');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', name);

    const top = element('div', 'staff-line');
    const segmented = element('span', 'segmented');
    segmented.setAttribute('role', 'radiogroup');
    segmented.setAttribute('aria-label', name + ' の区分');
    calc.STAFF_TYPES.forEach(function (type) {
      const label = doc.createElement('label');
      const radio = doc.createElement('input');
      radio.type = 'radio';
      radio.name = 'staff-type-' + index;
      radio.value = type.id;
      radio.checked = data.type === type.id;
      radio.addEventListener('change', function () {
        if (radio.checked) data.type = type.id;
        afterChange();
      });
      label.append(radio, element('span', '', type.label));
      segmented.append(label);
    });
    const hours = element('output', 'staff-hours');
    hours.id = 'staff-hours-' + index;
    top.append(element('span', 'staff-name', name), segmented, hours);

    row.id = 'staff-row-' + index;
    row.append(top);

    // 勤務時間：時・分の選択欄と、15 分刻みの微調整ボタン
    const timeSync = {};
    Object.keys(TIME_LABELS).forEach(function (key) {
      const label = TIME_LABELS[key];
      const line = element('div', 'time-line');
      line.dataset.timeKey = key;

      // 選べる時刻を 8:00〜23:00・15 分刻みに限るため、時と分を別々の選択欄にする
      const hour = doc.createElement('select');
      hour.id = 'staff-' + key + '-hour-' + index;
      hour.setAttribute('aria-label', name + ' の' + label + '（時）');
      hour.append(new Option('--', ''));
      for (let h = MIN_TIME / 60; h <= MAX_TIME / 60; h += 1) hour.append(new Option(String(h), String(h)));

      const minute = doc.createElement('select');
      minute.id = 'staff-' + key + '-minute-' + index;
      minute.setAttribute('aria-label', name + ' の' + label + '（分）');
      minute.append(new Option('--', ''));
      for (let m = 0; m < 60; m += TIME_STEP) minute.append(new Option(String(m).padStart(2, '0'), String(m)));

      const sync = function () {
        const total = data[key] ? toMinutes(data[key]) : null;
        const hourStart = total === null ? null : Math.floor(total / 60) * 60;
        line.dataset.time = data[key];
        hour.value = total === null ? '' : String(hourStart / 60);
        minute.value = total === null ? '' : String(total - hourStart);
        // 23 時台は 23:00 だけ選べる
        Array.from(minute.options).forEach(function (option) {
          option.disabled = hourStart !== null && option.value !== '' && hourStart + Number(option.value) > MAX_TIME;
        });
      };
      timeSync[key] = sync;

      const commit = function (value) {
        data[key] = value;
        sync();
        afterChange();
      };
      const fromSelect = function () {
        const base = toMinutes(data[key] || initialTime(index, key));
        const h = hour.value === '' ? Math.floor(base / 60) : Number(hour.value);
        const m = minute.value === '' ? 0 : Number(minute.value);
        commit(formatTime(clampTime(h * 60 + m)));
      };
      [hour, minute].forEach(function (select) {
        select.addEventListener('change', fromSelect);
        // 未入力の欄は、触れた時点で標準の時刻を入れておく（一覧が 17:00 の位置から開く）
        select.addEventListener('pointerdown', function () {
          if (!data[key]) commit(initialTime(index, key));
        });
      });
      sync();

      line.append(element('span', 'time-label', label), hour, element('span', 'time-colon', ':'), minute);
      TIME_STEPS.forEach(function (step) {
        const button = element('button', 'step-button');
        button.type = 'button';
        button.dataset.step = key + ':' + step.minutes;
        button.setAttribute('aria-label', name + ' の' + label + 'を ' + step.spoken);
        button.append(element('b', '', step.amount), element('small', '', step.unit));
        button.addEventListener('click', function () {
          commit(stepTime(data[key] || initialTime(index, key), step.minutes));
        });
        line.append(button);
      });
      row.append(line);
    });

    // 休憩：決まった長さから選ぶ。選択中のボタンをもう一度押すと「休憩なし」に戻る
    const breakLine = element('div', 'break-line');
    breakLine.append(element('span', 'time-label', '休憩'));
    const breakButtons = BREAK_OPTIONS.map(function (option) {
      const button = element('button', 'chip-button', option.label);
      button.type = 'button';
      button.dataset.break = String(option.minutes);
      button.setAttribute('aria-label', name + ' の休憩 ' + option.label);
      button.addEventListener('click', function () {
        data.breakMinutes = data.breakMinutes === option.minutes ? null : option.minutes;
        syncBreak();
        afterChange();
      });
      breakLine.append(button);
      return button;
    });
    function syncBreak() {
      breakButtons.forEach(function (button) {
        button.setAttribute('aria-pressed', String(Number(button.dataset.break) === data.breakMinutes));
      });
    }
    syncBreak();

    const clear = element('button', 'clear-button', 'クリア');
    clear.type = 'button';
    clear.id = 'staff-clear-' + index;
    clear.setAttribute('aria-label', name + ' の勤務時間と休憩をクリア');
    clear.addEventListener('click', function () {
      data.start = '';
      data.end = '';
      data.breakMinutes = null;
      timeSync.start();
      timeSync.end();
      syncBreak();
      afterChange();
    });
    breakLine.append(clear);
    row.append(breakLine);
    return row;
  }

  function formatTime(minutes) {
    return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
  }

  function toMinutes(time) {
    const parts = time.split(':');
    return Number(parts[0]) * 60 + Number(parts[1]);
  }

  /** 未入力の欄に最初に入れる時刻。終了は、開始が入っていればそれに合わせる。 */
  function initialTime(index, key) {
    const data = state.staff[index];
    return key === 'end' && data.start ? data.start : formatTime(DEFAULT_TIME);
  }

  /** 選べる範囲（8:00〜23:00）に収める。 */
  function clampTime(minutes) {
    return Math.min(MAX_TIME, Math.max(MIN_TIME, minutes));
  }

  function stepTime(time, step) {
    return formatTime(clampTime(toMinutes(time) + step));
  }

  function renderStaffRows() {
    const list = byId('staff-list');
    list.textContent = '';
    state.staff.forEach(function (unused, index) {
      list.append(createStaffRowElement(index));
    });
    byId('add-staff-button').disabled = state.staff.length >= MAX_STAFF_COUNT;
    byId('remove-staff-button').hidden = state.staff.length <= DEFAULT_STAFF_COUNT;
    renderComputed();
  }

  function addStaffRow() {
    if (state.staff.length >= MAX_STAFF_COUNT) return;
    state.staff.push(createStaffRow(state.staff.length));
    renderStaffRows();
    byId('staff-row-' + (state.staff.length - 1)).scrollIntoView({ block: 'nearest' });
  }

  function removeStaffRow() {
    if (state.staff.length <= DEFAULT_STAFF_COUNT) return;
    state.staff.pop();
    renderStaffRows();
  }

  // ---- 売上高 ----

  function createSalesRow(item) {
    const row = element('div', 'row');
    if (item.kind === 'input') {
      const label = element('label', '', item.label);
      label.htmlFor = 'input-' + item.id;
      const input = createNumberInput(12, function (value) {
        if (value === null) {
          delete state.sales[item.id];
        } else {
          state.sales[item.id] = value;
        }
        afterChange();
      });
      input.id = 'input-' + item.id;
      input.placeholder = '0';
      const wrap = element('span', 'field');
      wrap.append(input, element('span', 'unit', item.unit));
      row.append(label, wrap);
    } else {
      const term = element('dt', '', item.label);
      term.append(element('span', 'chip', '自動'));
      const value = element('dd');
      value.id = 'output-' + item.id;
      row.append(term, value);
    }
    return row;
  }

  function buildSalesGroups() {
    const container = byId('sales-groups');
    calc.SALES_GROUPS.forEach(function (group) {
      const card = element('section', 'card');
      const head = element('div', 'card-head');
      const title = element('h2', '', group.title);
      title.id = 'group-' + group.id;
      head.append(title);
      if (group.note) head.append(element('span', 'badge', group.note));
      card.setAttribute('aria-labelledby', title.id);

      const rows = element('div', 'rows');
      group.items.forEach(function (item) {
        rows.append(createSalesRow(item));
      });
      card.append(head, rows);
      container.append(card);
    });
  }

  // ---- 計算結果の表示 ----

  function setOutput(id, value, unit, format) {
    const node = byId('output-' + id);
    if (value === null) {
      node.textContent = '—';
      node.className = '';
    } else {
      node.textContent = format.format(value) + ' ' + unit;
      node.className = 'has-value';
    }
  }

  function renderComputed() {
    const result = calc.calculate(state);

    result.staff.forEach(function (item, index) {
      const node = byId('staff-hours-' + index);
      if (!node) return;
      if (item.error) {
        node.textContent = STAFF_ERRORS[item.error];
        node.className = 'staff-hours is-error';
      } else if (item.workHours === null) {
        node.textContent = '— 時間';
        node.className = 'staff-hours';
      } else {
        node.textContent = hoursFormat.format(item.workHours) + ' 時間';
        node.className = 'staff-hours has-value';
      }
    });

    setOutput('laborEmployee', result.labor.employee, '時間', hoursFormat);
    setOutput('laborPartTime', result.labor.partTime, '時間', hoursFormat);
    setOutput('laborTotal', result.labor.total, '時間', hoursFormat);
    setOutput('productivityTarget', result.labor.productivityTarget, '円', numberFormat);
    setOutput('productivityActual', result.labor.productivityActual, '円', numberFormat);

    calc.SALES_GROUPS.forEach(function (group) {
      group.items.forEach(function (item) {
        if (item.kind === 'output') setOutput(item.id, result.sales[item.id], item.unit, numberFormat);
      });
    });
  }

  // ---- 初期化 ----

  function resetInputs() {
    state = createInitialState();
    doc.querySelectorAll('#sales-groups input, #input-plannedHours').forEach(function (input) {
      input.value = '';
    });
    renderStaffRows();
    byId('summary-status').textContent = '入力を初期化しました。';
  }

  function requestReset() {
    const dialog = byId('reset-dialog');
    if (typeof dialog.showModal === 'function') {
      dialog.returnValue = 'cancel';
      dialog.showModal();
    } else if (global.confirm('入力した内容をすべて消去します。よろしいですか？')) {
      resetInputs();
    }
  }

  // ---- 日付（端末の時計から自動表示） ----

  function renderToday() {
    const now = new Date();
    const text = now.getMonth() + 1 + '月' + now.getDate() + '日（' + WEEKDAYS[now.getDay()] + '）';
    if (text === todayText) return;
    todayText = text;
    byId('today').textContent = text;
    if (currentView === 'report') renderPreview();
  }

  // ---- 画面切り替え ----

  function showView(name) {
    currentView = name;
    Object.keys(VIEW_TITLES).forEach(function (key) {
      byId('view-' + key).hidden = key !== name;
    });
    doc.querySelectorAll('.tab').forEach(function (tab) {
      if (tab.dataset.view === name) {
        tab.setAttribute('aria-current', 'page');
      } else {
        tab.removeAttribute('aria-current');
      }
    });
    byId('screen-title').textContent = VIEW_TITLES[name];
    global.scrollTo(0, 0);
    if (name === 'report') renderPreview();
  }

  // ---- 日報プレビューと PNG 出力 ----

  /** 現在の入力と計算結果を、日報に載せる形にまとめる。 */
  function buildReportData() {
    const result = calc.calculate(state);
    const now = new Date();
    const typeLabels = {};
    calc.STAFF_TYPES.forEach(function (type) {
      typeLabels[type.id] = type.label;
    });
    return {
      date: { month: now.getMonth() + 1, day: now.getDate(), weekday: WEEKDAYS[now.getDay()] },
      staff: state.staff.map(function (row, index) {
        return {
          name: staffName(index),
          typeLabel: typeLabels[row.type],
          start: row.start,
          end: row.end,
          breakMinutes: row.breakMinutes,
          workHours: result.staff[index].workHours
        };
      }),
      labor: result.labor,
      sales: result.sales
    };
  }

  function renderPreview() {
    const canvas = byId('report-canvas');
    const data = buildReportData();
    App.reportTemplate.draw(canvas.getContext('2d'), canvas.width, canvas.height, data);
    // 保存ボタンを押したらすぐ共有メニューを開けるよう、PNG を先に作っておく
    global.setTimeout(function () {
      if (currentView === 'report') App.reportExport.prepare(data).catch(function () {});
    }, 0);
  }

  function formatBytes(bytes) {
    return numberFormat.format(Math.max(1, Math.round(bytes / 1024))) + ' KB';
  }

  function handleExport() {
    const button = byId('export-button');
    const status = byId('export-status');
    button.disabled = true;
    status.textContent = 'PNG を作成しています…';
    App.reportExport
      .exportPng(buildReportData())
      .then(function (info) {
        const detail = '（' + info.width + ' × ' + info.height + ' px、' + formatBytes(info.bytes) + '）';
        if (info.method === 'share') status.textContent = '共有しました' + detail;
        else if (info.method === 'cancelled') status.textContent = '保存をやめました。';
        else status.textContent = '保存しました：' + info.fileName + detail;
      })
      .catch(function (error) {
        // 共有メニューは押した直後にしか開けない。PNG はもうできているので、もう一度押せば開く
        status.textContent =
          error && error.name === 'NotAllowedError'
            ? '準備ができました。もう一度「PNG として保存」を押してください。'
            : '保存できませんでした：' + (error && error.message ? error.message : error);
      })
      .then(function () {
        button.disabled = false;
      });
  }

  // ---- 動作状態（設定・情報画面） ----

  function renderRuntimeStatus() {
    byId('info-theme').textContent =
      (darkQuery.matches ? 'ダーク' : 'ライト') + '（システム設定に追従）';
    byId('info-errors').textContent = errorCount === 0 ? 'なし' : errorCount + ' 件';
  }

  function countError() {
    errorCount += 1;
    renderRuntimeStatus();
  }

  // ---- ホーム画面アプリ・オフライン対応 ----

  /**
   * https（または localhost）で開いたときだけ、ホーム画面に追加するための設定（manifest）と
   * オフライン用のキャッシュ（Service Worker）を有効にする。file:// ではどちらも使えない。
   */
  function setupOffline() {
    const node = byId('info-offline');
    if (!global.isSecureContext || global.location.protocol === 'file:') {
      node.textContent = '無効（ファイルを直接開いているため）';
      return;
    }
    const manifest = doc.createElement('link');
    manifest.rel = 'manifest';
    manifest.href = 'manifest.webmanifest';
    doc.head.append(manifest);

    if (!('serviceWorker' in global.navigator)) {
      node.textContent = '無効（このブラウザは非対応）';
      return;
    }
    node.textContent = '準備中…';
    global.navigator.serviceWorker
      .register('sw.js')
      .then(function () {
        return global.navigator.serviceWorker.ready;
      })
      .then(function () {
        node.textContent = '有効（通信なしで使えます）';
      })
      .catch(function (error) {
        node.textContent = '無効（' + error.message + '）';
      });
  }

  // ---- 起動 ----

  function init() {
    global.addEventListener('error', countError);
    global.addEventListener('unhandledrejection', countError);

    buildSalesGroups();
    renderStaffRows();

    doc.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        showView(tab.dataset.view);
      });
    });

    const planned = byId('input-plannedHours');
    const fromPlanned = function (event) {
      if (event.isComposing) return;
      state.plannedHours = readDecimal(planned);
      afterChange();
    };
    planned.addEventListener('input', fromPlanned);
    planned.addEventListener('compositionend', fromPlanned);

    byId('add-staff-button').addEventListener('click', addStaffRow);
    byId('remove-staff-button').addEventListener('click', removeStaffRow);
    byId('reset-button').addEventListener('click', requestReset);
    byId('reset-dialog').addEventListener('close', function (event) {
      if (event.target.returnValue === 'confirm') resetInputs();
    });
    byId('export-button').addEventListener('click', handleExport);

    const page = App.reportTemplate.PAGE;
    byId('export-size').textContent = page.width + ' × ' + page.height + ' px';
    byId('info-version').textContent = APP_VERSION;
    byId('info-environment').textContent =
      global.location.protocol === 'file:' ? 'ローカルファイル（file://）' : global.location.host;

    setupOffline();
    darkQuery.addEventListener('change', renderRuntimeStatus);
    renderRuntimeStatus();

    // 日付が変わったら（0 時をまたいだら）表示も自動で切り替わる
    renderToday();
    global.setInterval(renderToday, 1000);
  }

  init();
})(window);
