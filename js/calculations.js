/*
 * 入力項目の定義と計算処理。画面表示や PNG 生成には依存しない（DOM に触れない）。
 *
 * 計算式
 *   実労働時間       = 勤務時間（終了 − 開始）− 休憩
 *   人時の合計時間   = 社員の実労働時間の合計 ＋ アルバイトの実労働時間の合計
 *   月間の差額       = 累積実績 − 累積目標
 *   客単価           = 実績 ÷ 来客数（円未満は切り捨て）
 *   ディナー実績     = 合計実績 − ランチ実績
 *   ディナー来客数   = 合計来客数 − ランチ来客数
 *   人時生産高目標   = 合計の当日目標 ÷ 予定の実労働時間（手入力）（円未満は切り捨て）
 *   人時生産高実績   = 合計の当日実績 ÷ 社員とアルバイトの合計時間（円未満は切り捨て）
 */
(function (global) {
  'use strict';

  const App = (global.SalesReport = global.SalesReport || {});

  const STAFF_TYPES = [
    { id: 'employee', label: '社員' },
    { id: 'partTime', label: 'アルバイト' }
  ];

  // kind: 'input' は手入力、'output' は自動計算。表示順は入力の流れ（ランチ → 締めの合計 → ディナー）。
  const SALES_GROUPS = [
    {
      id: 'monthly',
      title: '月間売上',
      items: [
        { id: 'monthlyTarget', label: '目標（税別）', unit: '円', kind: 'input', how: '入力（その月の目標）' },
        { id: 'monthlyCumulativeTarget', label: '累積目標（税別）', unit: '円', kind: 'input', how: '入力（今日までの目標の累計）' },
        { id: 'monthlyCumulativeActual', label: '累積実績（税別）', unit: '円', kind: 'input', how: '入力（今日までの実績の累計）' },
        { id: 'monthlyDifference', label: '差額（実績 − 目標）', unit: '円', kind: 'output', how: '累積実績 − 累積目標' }
      ]
    },
    {
      id: 'lunch',
      title: 'ランチ　当日売上',
      items: [
        { id: 'lunchTarget', label: '目標（税別）', unit: '円', kind: 'input', how: '入力' },
        { id: 'lunchSales', label: '実績（税別）', unit: '円', kind: 'input', how: '入力（税込 ÷ 1.1 した額）' },
        { id: 'lunchGuests', label: '来客数', unit: '人', kind: 'input', how: '入力' },
        { id: 'lunchAverage', label: '客単価', unit: '円', kind: 'output', how: 'ランチ実績 ÷ ランチ来客数（円未満切り捨て）' }
      ]
    },
    {
      id: 'total',
      title: '合計　当日売上',
      items: [
        { id: 'totalTarget', label: '目標（税別）', unit: '円', kind: 'input', how: '入力' },
        { id: 'totalSales', label: '実績（税別）', unit: '円', kind: 'input', how: '入力（税込 ÷ 1.1 した額）' },
        { id: 'totalGuests', label: '来客数', unit: '人', kind: 'input', how: '入力' },
        { id: 'totalAverage', label: '客単価', unit: '円', kind: 'output', how: '合計実績 ÷ 合計来客数（円未満切り捨て）' }
      ]
    },
    {
      id: 'dinner',
      title: 'ディナー　当日売上',
      note: '合計 − ランチ',
      items: [
        { id: 'dinnerTarget', label: '目標（税別）', unit: '円', kind: 'input', how: '入力' },
        { id: 'dinnerSales', label: '実績（税別）', unit: '円', kind: 'output', how: '合計実績 − ランチ実績' },
        { id: 'dinnerGuests', label: '来客数', unit: '人', kind: 'output', how: '合計来客数 − ランチ来客数' },
        { id: 'dinnerAverage', label: '客単価', unit: '円', kind: 'output', how: 'ディナー実績 ÷ ディナー来客数（円未満切り捨て）' }
      ]
    }
  ];

  function isNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  /** "17:30" を 0 時からの分数にする。空や不正な値は null。 */
  function parseTime(text) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(text || '');
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
  }

  /**
   * 実労働時間を分で返す。日付をまたぐ勤務は想定しないので、終了が開始より前なら入力ミスとして扱う。
   * @returns {{minutes: (number|null), error: (string|null)}}
   */
  function workMinutes(row) {
    const start = parseTime(row.start);
    const end = parseTime(row.end);
    if (start === null || end === null) return { minutes: null, error: null };

    const span = end - start;
    if (span < 0) return { minutes: null, error: 'endBeforeStart' };
    const rest = isNumber(row.breakMinutes) ? row.breakMinutes : 0;
    if (rest > span) return { minutes: null, error: 'breakTooLong' };
    return { minutes: span - rest, error: null };
  }

  function difference(a, b) {
    return isNumber(a) && isNumber(b) ? a - b : null;
  }

  function average(sales, guests) {
    return isNumber(sales) && isNumber(guests) && guests > 0 ? Math.trunc(sales / guests) : null;
  }

  /**
   * @param {{sales: Object<string, number>, plannedHours: (number|null), staff: Array<{type: string, start: string, end: string, breakMinutes: (number|null)}>}} inputs
   * @returns {{staff: Array<{workHours: (number|null), error: (string|null)}>,
   *            labor: {employee: (number|null), partTime: (number|null), total: (number|null),
   *                    plannedHours: (number|null), productivityTarget: (number|null), productivityActual: (number|null)},
   *            sales: Object<string, (number|null)>}}
   */
  function calculate(inputs) {
    // 出勤簿と人時（誤差を避けるため分単位で合計してから時間に直す）
    const totals = { employee: 0, partTime: 0 };
    let counted = 0;
    const staff = inputs.staff.map(function (row) {
      const work = workMinutes(row);
      if (work.minutes !== null) {
        totals[row.type] += work.minutes;
        counted += 1;
      }
      return { workHours: work.minutes === null ? null : work.minutes / 60, error: work.error };
    });
    const labor =
      counted === 0
        ? { employee: null, partTime: null, total: null }
        : {
            employee: totals.employee / 60,
            partTime: totals.partTime / 60,
            total: (totals.employee + totals.partTime) / 60
          };

    // 売上高
    const sales = {};
    SALES_GROUPS.forEach(function (group) {
      group.items.forEach(function (item) {
        const value = inputs.sales[item.id];
        sales[item.id] = item.kind === 'input' && isNumber(value) ? value : null;
      });
    });
    sales.monthlyDifference = difference(sales.monthlyCumulativeActual, sales.monthlyCumulativeTarget);
    sales.lunchAverage = average(sales.lunchSales, sales.lunchGuests);
    sales.totalAverage = average(sales.totalSales, sales.totalGuests);
    sales.dinnerSales = difference(sales.totalSales, sales.lunchSales);
    sales.dinnerGuests = difference(sales.totalGuests, sales.lunchGuests);
    sales.dinnerAverage = average(sales.dinnerSales, sales.dinnerGuests);

    // 人時生産高（売上 ÷ 時間。割り算の形は客単価と同じなので同じ関数を使う）
    labor.plannedHours = isNumber(inputs.plannedHours) ? inputs.plannedHours : null;
    labor.productivityTarget = average(sales.totalTarget, labor.plannedHours);
    labor.productivityActual = average(sales.totalSales, labor.total);

    return { staff: staff, labor: labor, sales: sales };
  }

  App.calculations = {
    STAFF_TYPES: STAFF_TYPES,
    SALES_GROUPS: SALES_GROUPS,
    calculate: calculate
  };
})(window);
