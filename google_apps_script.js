/**
 * Google Apps Script - CB 發行資訊彙整 API
 *
 * 部署步驟：
 * 1. 前往 https://script.google.com/ 建立新專案
 * 2. 將此程式碼貼上
 * 3. 點選「部署」→「新增部署作業」
 * 4. 類型選「網頁應用程式」
 * 5. 執行身份：「我」
 * 6. 存取權限：「所有人」
 * 7. 部署後取得網址，貼到 config.js 的 APPS_SCRIPT_URL
 */

const ISSUANCE_SHEET_ID = '1-9O7y6LCc7mMaM_QBZCeywj8q96EOXFr3PigERJXZJU';

function doGet(e) {
  try {
    const data = getAllCBIssuanceInfo();
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'ok', data, timestamp: new Date().toISOString() }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'error', message: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function getAllCBIssuanceInfo() {
  const ss = SpreadsheetApp.openById(ISSUANCE_SHEET_ID);
  const sheets = ss.getSheets();
  const results = [];

  for (const sheet of sheets) {
    try {
      const name = sheet.getName();

      // 讀取關鍵儲存格
      const a1 = sheet.getRange('A1').getValue(); // 公司名稱 + 債券名稱
      const d7 = sheet.getRange('D7').getValue(); // 轉(交)換期間 (有些在D7,有些在D8)
      const d8 = sheet.getRange('D8').getValue(); // 轉(交)換期間
      const d9 = sheet.getRange('D9').getValue(); // 最新轉(交)換價格
      const a6 = sheet.getRange('A6').getValue(); // 發行日期
      const a7 = sheet.getRange('A7').getValue(); // 到期日期
      const d6 = sheet.getRange('D6').getValue(); // 發行時轉換價格
      const d4 = sheet.getRange('D4').getValue(); // 發行面額/張數
      const b2 = sheet.getRange('B2').getValue(); // 資料來源(含bond_id)

      // 從 A1 提取 CB 名稱中的代碼
      // 從 B2 的 URL 提取 bond_id
      const bondIdMatch = String(b2).match(/bond_id=(\d+)/);
      const bondId = bondIdMatch ? bondIdMatch[1] : '';

      // 提取轉換期間 (可能在 D7 或 D8)
      let convPeriod = '';
      const d8Str = String(d8);
      const d7Str = String(d7);
      if (d8Str.includes('轉') && d8Str.includes('期間')) {
        convPeriod = d8Str.replace(/轉\(交\)換期間[：:]\s*/, '');
      } else if (d7Str.includes('轉') && d7Str.includes('期間')) {
        convPeriod = d7Str.replace(/轉\(交\)換期間[：:]\s*/, '');
      }

      // 提取最新轉換價格
      let convPrice = null;
      const d9Str = String(d9);
      if (d9Str.includes('轉') && d9Str.includes('價格')) {
        const priceMatch = d9Str.match(/([\d,]+\.?\d*)\s*元/);
        if (priceMatch) convPrice = parseFloat(priceMatch[1].replace(/,/g, ''));
      }

      // 提取發行時轉換價格
      let issueConvPrice = null;
      const d6Str = String(d6);
      const issuePriceMatch = d6Str.match(/([\d,]+\.?\d*)\s*元/);
      if (issuePriceMatch) issueConvPrice = parseFloat(issuePriceMatch[1].replace(/,/g, ''));

      // 提取到期日期
      let maturityDate = '';
      const a7Str = String(a7);
      const maturityMatch = a7Str.match(/(\d{2,3}\/\d{2}\/\d{2})/);
      if (maturityMatch) maturityDate = maturityMatch[1];

      // 提取股票代碼 (bond_id前4碼)
      const stockCode = bondId ? bondId.substring(0, 4) : '';

      results.push({
        cbCode: bondId,
        stockCode,
        sheetName: name,
        title: String(a1),
        conversionPeriod: convPeriod,
        conversionPrice: convPrice,
        issueConversionPrice: issueConvPrice,
        maturityDate
      });
    } catch (e) {
      // 跳過無法讀取的分頁
      continue;
    }
  }

  return results;
}

// 測試用
function testRun() {
  const data = getAllCBIssuanceInfo();
  Logger.log(JSON.stringify(data.slice(0, 3), null, 2));
  Logger.log('Total sheets: ' + data.length);
}
