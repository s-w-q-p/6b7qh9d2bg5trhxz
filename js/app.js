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
  const MIN_TIME = 7 * 60; // 選べる時刻は 7:00〜23:00
  const MAX_TIME = 23 * 60;
  const HOURS = []; // ダイヤルの「時」：7〜23
  for (let h = MIN_TIME / 60; h <= MAX_TIME / 60; h += 1) HOURS.push(h);
  const MINUTES = [0, 15, 30, 45]; // ダイヤルの「分」
  const WHEEL_ITEM = 32; // ダイヤル 1 段の高さ（px）。style.css の .wheel-item と合わせる
  const WHEEL_ANGLE = 20; // 1 段ごとの傾き（度）。円筒に数字が並んでいるように見せる
  const WHEEL_RADIUS = WHEEL_ITEM / (WHEEL_ANGLE * Math.PI / 180); // 円筒の半径（中央付近の間隔が 1 段分になる）
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
  let clipboard = null; // 出勤簿の「コピー」で覚えた勤務時間・休憩（メモリだけ）
  let rowRefreshers = [];

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

  /**
   * スマホの時刻ピッカーのような縦スクロールのダイヤル。
   * 指で回して止まった位置、またはタップした数字を onPick(値) で知らせる。表示の更新は show(番号) で行う。
   */
  function createWheel(values, format, ariaLabel, onPick) {
    const wheel = element('div', 'wheel');
    wheel.tabIndex = 0;
    wheel.setAttribute('role', 'spinbutton');
    wheel.setAttribute('aria-label', ariaLabel);
    wheel.setAttribute('aria-valuemin', String(values[0]));
    wheel.setAttribute('aria-valuemax', String(values[values.length - 1]));

    let index = 0;
    let touching = false;
    let timer = null;

    const items = values.map(function (value, i) {
      // 止まる位置（スナップ）がずれないよう、傾けるのは中の文字だけにする
      const item = element('div', 'wheel-item');
      item.append(element('span', 'wheel-text', format(value)));
      item.addEventListener('click', function () {
        onPick(values[i]);
      });
      wheel.append(item);
      return item;
    });

    function nearest() {
      return Math.max(0, Math.min(values.length - 1, Math.round(wheel.scrollTop / WHEEL_ITEM)));
    }
    function highlight(i) {
      items.forEach(function (item, k) {
        item.classList.toggle('is-selected', k === i);
      });
    }
    // 回し終わって止まったら、その位置の値を選ぶ（指が触れている間は選ばない）
    function settleLater() {
      clearTimeout(timer);
      timer = setTimeout(function () {
        // 別の画面に切り替えて隠れている間は位置が 0 に戻るので、値として読まない
        if (touching || wheel.clientHeight === 0) return;
        const i = nearest();
        if (i !== index) onPick(values[i]);
      }, 140);
    }

    // 中央から離れた数字ほど傾けて間隔を詰め、薄くする（iPhone の時刻ピッカー風）
    let frame = 0;
    function paint() {
      frame = 0;
      const top = wheel.scrollTop;
      items.forEach(function (item, k) {
        const offset = (k * WHEEL_ITEM - top) / WHEEL_ITEM;
        const angle = offset * WHEEL_ANGLE;
        const text = item.firstChild;
        if (Math.abs(angle) >= 90) {
          text.style.visibility = 'hidden';
          return;
        }
        const shift = WHEEL_RADIUS * Math.sin(angle * Math.PI / 180) - offset * WHEEL_ITEM;
        const fade = Math.max(0.12, 1 - Math.abs(offset) * 0.3) * (item.classList.contains('is-disabled') ? 0.35 : 1);
        text.style.visibility = '';
        text.style.transform = 'perspective(500px) translateY(' + shift.toFixed(1) + 'px) rotateX(' + (-angle).toFixed(1) + 'deg)';
        text.style.opacity = fade.toFixed(2);
      });
    }

    wheel.addEventListener('scroll', function () {
      highlight(nearest());
      if (!frame) frame = global.requestAnimationFrame(paint);
      settleLater();
    }, { passive: true });
    wheel.addEventListener('touchstart', function () {
      touching = true;
    }, { passive: true });
    ['touchend', 'touchcancel'].forEach(function (type) {
      wheel.addEventListener(type, function () {
        touching = false;
        settleLater();
      }, { passive: true });
    });
    wheel.addEventListener('keydown', function (event) {
      const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      onPick(values[Math.max(0, Math.min(values.length - 1, index + step))]);
    });

    function show(i) {
      index = i;
      wheel.setAttribute('aria-valuenow', String(values[i]));
      wheel.setAttribute('aria-valuetext', format(values[i]));
      highlight(i);
      // 画面に出ていない間は位置を合わせられないので、表示したときにもう一度呼ぶ
      if (Math.abs(wheel.scrollTop - i * WHEEL_ITEM) > 1) wheel.scrollTop = i * WHEEL_ITEM;
      paint();
    }

    return { element: wheel, items: items, show: show, paint: paint };
  }

  /** 開始・終了の 1 欄（時と分のダイヤル）。未入力の間は標準の時刻を薄く表示し、触れると確定する。 */
  function createTimeField(index, key, onCommit) {
    const data = state.staff[index];
    const name = staffName(index);
    const label = TIME_LABELS[key];

    const box = element('div', 'time-box');
    box.dataset.timeKey = key;
    const head = element('div', 'time-head');
    head.append(element('span', 'time-label', label), element('span', 'time-empty', '未入力'));

    const shown = function () {
      return toMinutes(data[key] || initialTime(index, key));
    };
    const commit = function (total) {
      data[key] = formatTime(clampTime(total));
      onCommit();
    };
    const hourWheel = createWheel(HOURS, String, name + ' の' + label + '（時）', function (h) {
      commit(h * 60 + (shown() % 60));
    });
    const minuteWheel = createWheel(MINUTES, pad2, name + ' の' + label + '（分）', function (m) {
      commit(Math.floor(shown() / 60) * 60 + m);
    });
    hourWheel.element.id = 'staff-' + key + '-hour-' + index;
    minuteWheel.element.id = 'staff-' + key + '-minute-' + index;

    const pair = element('div', 'wheel-pair');
    pair.append(hourWheel.element, minuteWheel.element);
    box.append(head, pair);

    function sync() {
      const total = shown();
      const hour = Math.floor(total / 60);
      box.dataset.time = data[key];
      box.classList.toggle('is-empty', !data[key]);
      hourWheel.show(HOURS.indexOf(hour));
      minuteWheel.show(MINUTES.indexOf(total % 60));
      // 23 時台は 23:00 だけ選べる
      minuteWheel.items.forEach(function (item, k) {
        item.classList.toggle('is-disabled', hour * 60 + MINUTES[k] > MAX_TIME);
      });
      minuteWheel.paint();
    }

    return { element: box, sync: sync };
  }

  function createStaffRowElement(index) {
    const data = state.staff[index];
    const name = staffName(index);

    const row = element('div', 'staff-row');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', name);
    row.id = 'staff-row-' + index;

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
    row.append(top);

    // 勤務時間：開始・終了を横に並べ、それぞれ時・分のダイヤルで選ぶ
    const times = element('div', 'time-grid');
    const fields = Object.keys(TIME_LABELS).map(function (key) {
      const field = createTimeField(index, key, function () {
        refresh();
        afterChange();
      });
      times.append(field.element);
      return field;
    });
    row.append(times);

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
        refresh();
        afterChange();
      });
      breakLine.append(button);
      return button;
    });
    row.append(breakLine);

    // コピー・貼り付け・クリア
    const actions = element('div', 'staff-actions');
    const copy = element('button', 'action-button', 'コピー');
    copy.type = 'button';
    copy.id = 'staff-copy-' + index;
    copy.setAttribute('aria-label', name + ' の勤務時間と休憩をコピー');
    copy.addEventListener('click', function () {
      clipboard = { from: name, start: data.start, end: data.end, breakMinutes: data.breakMinutes };
      renderPasteButtons();
      copy.textContent = 'コピーしました';
      setTimeout(function () {
        copy.textContent = 'コピー';
      }, 1200);
    });

    const paste = element('button', 'action-button paste-button');
    paste.type = 'button';
    paste.id = 'staff-paste-' + index;
    paste.addEventListener('click', function () {
      if (!clipboard) return;
      data.start = clipboard.start;
      data.end = clipboard.end;
      data.breakMinutes = clipboard.breakMinutes;
      refresh();
      afterChange();
    });

    const clear = element('button', 'clear-button', 'クリア');
    clear.type = 'button';
    clear.id = 'staff-clear-' + index;
    clear.setAttribute('aria-label', name + ' の勤務時間と休憩をクリア');
    clear.addEventListener('click', function () {
      data.start = '';
      data.end = '';
      data.breakMinutes = null;
      refresh();
      afterChange();
    });
    actions.append(copy, paste, clear);
    row.append(actions);

    function refresh() {
      fields.forEach(function (field) {
        field.sync();
      });
      breakButtons.forEach(function (button) {
        button.setAttribute('aria-pressed', String(Number(button.dataset.break) === data.breakMinutes));
      });
      copy.disabled = !data.start && !data.end && data.breakMinutes === null;
    }
    rowRefreshers.push(refresh);
    return row;
  }

  /** 貼り付けボタンの表示を、いまコピーしている内容に合わせる。 */
  function renderPasteButtons() {
    doc.querySelectorAll('.paste-button').forEach(function (button) {
      button.disabled = !clipboard;
      button.textContent = clipboard ? clipboard.from + ' を貼り付け' : '貼り付け';
      button.setAttribute('aria-label', clipboard ? clipboard.from + ' の勤務時間と休憩を貼り付け' : '貼り付け（先にコピーしてください）');
    });
  }

  /** ダイヤルの位置などを入力内容に合わせ直す（行を作り直したときや、画面を表示したとき）。 */
  function refreshStaffRows() {
    rowRefreshers.forEach(function (refresh) {
      refresh();
    });
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function formatTime(minutes) {
    return pad2(Math.floor(minutes / 60)) + ':' + pad2(minutes % 60);
  }

  function toMinutes(time) {
    const parts = time.split(':');
    return Number(parts[0]) * 60 + Number(parts[1]);
  }

  /** 未入力の欄に表示する時刻。終了は、開始が入っていればそれに合わせる。 */
  function initialTime(index, key) {
    const data = state.staff[index];
    return key === 'end' && data.start ? data.start : formatTime(DEFAULT_TIME);
  }

  /** 選べる範囲（7:00〜23:00）に収める。 */
  function clampTime(minutes) {
    return Math.min(MAX_TIME, Math.max(MIN_TIME, minutes));
  }

  function renderStaffRows() {
    const list = byId('staff-list');
    list.textContent = '';
    rowRefreshers = [];
    state.staff.forEach(function (unused, index) {
      list.append(createStaffRowElement(index));
    });
    refreshStaffRows();
    renderPasteButtons();
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
      label.append(element('small', 'how', item.how));
      row.append(label, wrap);
    } else {
      const term = element('dt', '', item.label);
      term.append(element('span', 'chip', '自動'), element('small', 'how', item.how));
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
    clipboard = null;
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
    if (name === 'summary') refreshStaffRows();
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

    // 数字のキーボードが出ている間は下のタブを隠す（iPhone ではスクロールするとキーボードの上に浮いてくるため）
    const isTyping = function (node) {
      return Boolean(node && node.matches && node.matches('input[type="text"]'));
    };
    doc.addEventListener('focusin', function (event) {
      if (isTyping(event.target)) doc.body.classList.add('is-typing');
    });
    doc.addEventListener('focusout', function () {
      // 次の入力欄へ移るときに一瞬だけ表示されないよう、移動先が決まってから判定する
      setTimeout(function () {
        doc.body.classList.toggle('is-typing', isTyping(doc.activeElement));
      }, 0);
    });

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
