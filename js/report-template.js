/*
 * 日報の描画。Excel テンプレートから作ったレイアウト（report-layout.js）を Canvas にそのまま描き、
 * 入力値と計算結果を対応するセルに書き込む。Canvas に直接描くので file:// でも画像化できる。
 * 計算はしない。渡された値を所定のセルに描くだけ。
 */
(function (global) {
  'use strict';

  const App = (global.SalesReport = global.SalesReport || {});
  const LAYOUT = App.reportLayout;

  const PAGE = { width: 3508, height: 2480 };
  const MARGIN = 110;
  const FONT = '"Yu Gothic", "Hiragino Sans", "Hiragino Kaku Gothic ProN", Meiryo, sans-serif';
  const PT = 4 / 3; // フォントの pt → レイアウト上の px

  // 出勤簿の各行の先頭行番号（Excel の 6〜20 行目に 10 人分）
  const STAFF_ROWS = [6, 7, 9, 10, 12, 13, 15, 16, 18, 19];

  // 「（　　　）円」の括弧の中に値を書くセル
  const LABOR_CELLS = {
    employee: 'B23',
    partTime: 'B25',
    total: 'B27',
    productivityTarget: 'B31',
    productivityActual: 'B34'
  };
  const SALES_CELLS = {
    monthlyTarget: 'M3',
    monthlyCumulativeTarget: 'M5',
    monthlyCumulativeActual: 'M8',
    monthlyDifference: 'M11',
    lunchTarget: 'M14',
    lunchSales: 'M17',
    lunchGuests: 'M20',
    lunchAverage: 'M22',
    dinnerTarget: 'M24',
    dinnerSales: 'M27',
    dinnerGuests: 'M30',
    dinnerAverage: 'M34',
    totalTarget: 'M37',
    totalSales: 'M39',
    totalGuests: 'M43',
    totalAverage: 'M45'
  };
  const HOUR_KEYS = { employee: true, partTime: true, total: true };

  // 罫線の太さ（レイアウト上の px）と点線の間隔
  const LINE_STYLES = {
    hair: { width: 0.5 },
    thin: { width: 0.9 },
    dotted: { width: 0.9, dash: [0.9, 1.6] },
    dashed: { width: 0.9, dash: [3, 2] },
    dashDot: { width: 0.9, dash: [3, 1.5, 1, 1.5] },
    dashDotDot: { width: 0.9, dash: [3, 1.5, 1, 1.5, 1, 1.5] },
    medium: { width: 1.8 },
    mediumDashed: { width: 1.8, dash: [4, 2] },
    mediumDashDot: { width: 1.8, dash: [4, 2, 1.5, 2] },
    mediumDashDotDot: { width: 1.8, dash: [4, 2, 1.5, 2, 1.5, 2] },
    double: { width: 2.4 },
    thick: { width: 2.6 }
  };

  const numberFormat = new Intl.NumberFormat('ja-JP');
  const hoursFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 2 });

  const colX = [0];
  LAYOUT.widths.forEach(function (width, index) {
    colX.push(colX[index] + width);
  });
  const rowY = [0];
  LAYOUT.heights.forEach(function (height, index) {
    rowY.push(rowY[index] + height);
  });
  const SHEET = { width: colX[colX.length - 1], height: rowY[rowY.length - 1] };

  const textByRef = {};
  LAYOUT.texts.forEach(function (cell) {
    textByRef[cell.ref] = cell;
  });

  function isNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function parseRef(ref) {
    const match = /^([A-Z]+)(\d+)$/.exec(ref);
    let c = 0;
    for (let i = 0; i < match[1].length; i += 1) c = c * 26 + match[1].charCodeAt(i) - 64;
    return { r: Number(match[2]), c: c };
  }

  /** セル（結合されていれば結合範囲）の位置と大きさ。 */
  function region(r, c) {
    let rs = 1;
    let cs = 1;
    LAYOUT.merges.forEach(function (m) {
      if (m[0] === r && m[1] === c) {
        rs = m[2];
        cs = m[3];
      }
    });
    return { x: colX[c - 1], y: rowY[r - 1], w: colX[c - 1 + cs] - colX[c - 1], h: rowY[r - 1 + rs] - rowY[r - 1] };
  }

  function setFont(ctx, cell, bold) {
    ctx.font = (bold || cell.bold ? 'bold ' : '') + cell.size * PT + 'px ' + FONT;
  }

  /** セルの配置（左・中央・右／上・中央・下）に合わせて、複数行の文字を描く。 */
  function drawCellText(ctx, cell, text, bold) {
    const box = region(cell.r, cell.c);
    const lines = text.split('\n');
    const size = cell.size * PT;
    const lineHeight = size * 1.25;
    const pad = 2;
    setFont(ctx, cell, bold);
    ctx.fillStyle = cell.color || '#000000';
    ctx.textBaseline = 'middle';

    let y;
    if (cell.v === 'top') y = box.y + pad + lineHeight / 2;
    else if (cell.v === 'bottom') y = box.y + box.h - pad - lineHeight * (lines.length - 0.5);
    else y = box.y + box.h / 2 - (lineHeight * (lines.length - 1)) / 2;

    lines.forEach(function (line, index) {
      let x = box.x + pad;
      ctx.textAlign = 'left';
      if (cell.h === 'center' || cell.h === 'centerContinuous') {
        x = box.x + box.w / 2;
        ctx.textAlign = 'center';
      } else if (cell.h === 'right') {
        x = box.x + box.w - pad;
        ctx.textAlign = 'right';
      }
      ctx.fillText(line, x, y + index * lineHeight, box.w - pad * 2);
    });
  }

  /** 「（　　　）円」の形を保ったまま、括弧の中に値を書く。 */
  function drawBracketValue(ctx, cell, value) {
    const match = /^（([\s　]*)）(.*)$/.exec(cell.text);
    if (!match || value === '') {
      drawCellText(ctx, cell, cell.text);
      return;
    }
    const box = region(cell.r, cell.c);
    setFont(ctx, cell, false);
    const total = ctx.measureText(cell.text).width;
    const open = ctx.measureText('（').width;
    const inner = ctx.measureText('（' + match[1]).width - open;
    let left = box.x + 2;
    if (cell.h === 'center' || cell.h === 'centerContinuous') left = box.x + (box.w - total) / 2;
    else if (cell.h === 'right') left = box.x + box.w - 2 - total;
    const middle = box.y + box.h / 2;

    ctx.fillStyle = cell.color || '#000000';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText('（', left, middle);
    ctx.fillText('）' + match[2], left + open + inner, middle);
    setFont(ctx, cell, true);
    ctx.textAlign = 'center';
    ctx.fillText(value, left + open + inner / 2, middle, inner);
  }

  function drawEdges(ctx) {
    ctx.lineCap = 'butt';
    LAYOUT.edges.forEach(function (edge) {
      const style = LINE_STYLES[edge[3]] || LINE_STYLES.thin;
      ctx.strokeStyle = edge[4];
      ctx.lineWidth = style.width;
      ctx.setLineDash(style.dash || []);
      ctx.beginPath();
      if (edge[0] === 'h') {
        ctx.moveTo(colX[edge[2] - 1], rowY[edge[1] - 1]);
        ctx.lineTo(colX[edge[2]], rowY[edge[1] - 1]);
      } else {
        ctx.moveTo(colX[edge[2] - 1], rowY[edge[1] - 1]);
        ctx.lineTo(colX[edge[2] - 1], rowY[edge[1]]);
      }
      ctx.stroke();
    });
    ctx.setLineDash([]);
  }

  /** セル番地 → そこに書く文字（テンプレートの文字を置き換える）。 */
  function buildOverrides(report) {
    const texts = {};
    const brackets = {};

    if (report.date) {
      texts.A1 = textByRef.A1.text + '　' + report.date.month + '月' + report.date.day + '日（' + report.date.weekday + '）';
    }

    (report.staff || []).slice(0, STAFF_ROWS.length).forEach(function (row, index) {
      const r = STAFF_ROWS[index];
      texts['A' + r] = row.name + (row.start || row.end ? '　' + row.typeLabel : '');
      if (row.start || row.end) texts['E' + r] = (row.start || '') + ' 〜 ' + (row.end || '');
      if (isNumber(row.breakMinutes)) texts['H' + r] = row.breakMinutes + ' 分';
      if (isNumber(row.workHours)) texts['I' + r] = hoursFormat.format(row.workHours) + ' 時間';
    });

    const labor = report.labor || {};
    Object.keys(LABOR_CELLS).forEach(function (key) {
      if (isNumber(labor[key])) brackets[LABOR_CELLS[key]] = (HOUR_KEYS[key] ? hoursFormat : numberFormat).format(labor[key]);
    });
    const sales = report.sales || {};
    Object.keys(SALES_CELLS).forEach(function (key) {
      if (isNumber(sales[key])) brackets[SALES_CELLS[key]] = numberFormat.format(sales[key]);
    });
    return { texts: texts, brackets: brackets };
  }

  // 名前欄のように、テンプレートでは空欄のセルに書くときの書式
  const NAME_STYLE = { size: 7.1, bold: true, color: '#171717', h: 'center', v: 'center' };

  /**
   * 日報を描画する。背景は外観設定に関係なく常に白。
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} width 描画先の幅（px）
   * @param {number} height 描画先の高さ（px）
   * @param {{date: Object, staff: Array<Object>, labor: Object, sales: Object}} [data] 省略すると空欄の日報
   */
  function draw(ctx, width, height, data) {
    const overrides = buildOverrides(data || {});
    const unitX = width / PAGE.width;
    const unitY = height / PAGE.height;
    const scale = Math.min((PAGE.width - MARGIN * 2) / SHEET.width, (PAGE.height - MARGIN * 2) / SHEET.height);

    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.scale(unitX, unitY);
    ctx.translate((PAGE.width - SHEET.width * scale) / 2, (PAGE.height - SHEET.height * scale) / 2);
    ctx.scale(scale, scale);

    LAYOUT.fills.forEach(function (fill) {
      const box = region(fill[0], fill[1]);
      ctx.fillStyle = fill[2];
      ctx.fillRect(box.x, box.y, box.w, box.h);
    });
    drawEdges(ctx);

    LAYOUT.texts.forEach(function (cell) {
      if (overrides.brackets[cell.ref] !== undefined) {
        drawBracketValue(ctx, cell, overrides.brackets[cell.ref]);
      } else {
        const replaced = overrides.texts[cell.ref];
        drawCellText(ctx, cell, replaced === undefined ? cell.text : replaced, replaced !== undefined && cell.ref !== 'A1');
      }
    });
    Object.keys(overrides.texts).forEach(function (ref) {
      if (textByRef[ref]) return;
      const at = parseRef(ref);
      drawCellText(ctx, Object.assign({ r: at.r, c: at.c }, NAME_STYLE), overrides.texts[ref]);
    });

    ctx.restore();
  }

  App.reportTemplate = { PAGE: PAGE, STAFF_CAPACITY: STAFF_ROWS.length, draw: draw };
})(window);
