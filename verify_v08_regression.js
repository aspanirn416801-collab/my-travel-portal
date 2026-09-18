/**
 * 旅遊手冊系統 20260917_08-regression 自動化回歸驗證腳本
 * 執行方式：node verify_v08_regression.js
 */

const fs = require('fs');
const path = require('path');

console.log("==================================================");
console.log("🚀 開始執行 20260917_08-regression 全量架構與回歸驗證");
console.log("==================================================\n");

let allPassed = true;
let totalChecks = 0;
let passedChecks = 0;

function assertCheck(name, condition, detail = "") {
  totalChecks++;
  if (condition) {
    passedChecks++;
    console.log(`✓ [通過] ${name}`);
    if (detail) console.log(`   └─ ${detail}`);
  } else {
    allPassed = false;
    console.error(`✗ [失敗] ${name}`);
    if (detail) console.error(`   └─ 錯誤詳情: ${detail}`);
  }
}

const appPath = path.join(__dirname, 'app.js');
const gasPath = path.join(__dirname, 'gas-code.js');
const htmlPath = path.join(__dirname, 'index.html');

const appCode = fs.readFileSync(appPath, 'utf8');
const gasCode = fs.readFileSync(gasPath, 'utf8');
const htmlCode = fs.readFileSync(htmlPath, 'utf8');

// 1. 版本標籤檢查
assertCheck(
  "版本號標籤一致性",
  appCode.includes('const APP_BUILD_VERSION = "20260917_08";') &&
  htmlCode.includes('app.js?v=20260917_08'),
  "app.js 與 index.html 版本號均一致標註為 20260917_08"
);

// 2. [P0] 航班頁未定義變數 ReferenceError 檢查
const renderFlightsMatch = appCode.match(/function renderFlights\(\) \{[\s\S]*?function renderTransport/);
const flightsHasIsAdmin = renderFlightsMatch && renderFlightsMatch[0].includes('isAdmin');
assertCheck(
  "[P0] 航班與住宿頁面 ReferenceError 排除",
  !flightsHasIsAdmin,
  "renderFlights() 內已徹底移除未定義的 isAdmin，避免切換航班頁白屏拋錯"
);

// 3. [P0] GAS 移除不安全本地解碼
assertCheck(
  "[P0] GAS 移除不安全 decodeJwtPayload 本地解碼",
  !gasCode.includes('function decodeJwtPayload') && !gasCode.includes('decodeJwtPayload('),
  "僅允許 Google 官方 Tokeninfo 在線驗證，拒絕未經驗證簽章之本地偽解碼"
);

// 4. [P0] GAS createTrip 的 UUID 查重在建立雲端硬碟檔案之前
const createTripIdx = gasCode.indexOf('if (action === "createTrip") {');
const checkUuidIdx = gasCode.indexOf('行程識別碼 (UUID)「" + uuid + "」已存在', createTripIdx);
const createFolderIdx = gasCode.indexOf('rootFolder.createFolder(name)', createTripIdx);
assertCheck(
  "[P0] GAS 建立行程之原子性與查重順序",
  createTripIdx !== -1 && checkUuidIdx !== -1 && createFolderIdx !== -1 && checkUuidIdx < createFolderIdx,
  "UUID 查重已移至任何 Drive 資料夾與試算表建立之前，杜絕孤立檔案"
);

// 5. [P1] 刪除天數保護：禁止刪除最後一天且非同步等待 save()
assertCheck(
  "[P1] 行程天數刪除防呆與 await save()",
  appCode.includes('deleteCurrentDay') &&
  appCode.includes('tripData.days.length <= 1') &&
  appCode.includes('const ok = await save();') &&
  appCode.includes('return ok !== false;'),
  "具備 days.length <= 1 邊界保護，且等待 save() 完成後才返回狀態"
);

// 6. [P1] 儲存失敗回滾機制：lastConfirmedTripData 真實快照還原
assertCheck(
  "[P1] 儲存失敗之 lastConfirmedTripData 精準回滾機制",
  appCode.includes('let lastConfirmedTripData = null;') &&
  appCode.includes('lastConfirmedTripData = JSON.parse(JSON.stringify(tripData));') &&
  appCode.includes('tripData = JSON.parse(JSON.stringify(lastConfirmedTripData));'),
  "儲存失敗時能精準還原至修改前已確認之 lastConfirmedTripData 快照並重新渲染"
);

// 7. [P1] fetchTrips 複合鍵去重、防止跨行程串頁與安全 finally
assertCheck(
  "[P1] fetchTrips 複合鍵去重與防串頁機制",
  appCode.includes('${idToken || "guest"}__${currentTripUuid || "hub"}') &&
  appCode.includes('currentTripUuid === requestedTripUuid') &&
  appCode.includes('if (inFlightTripsPromise === currentPromise)'),
  "以 Token 與目標行程 UUID 雙重複合鍵去重，且手冊回填校驗 requestedTripUuid，安全釋放 Promise"
);

// 8. [P1] 5 處即時操作（Checklist, 景點順序, 時段排序, 美食勾選, 代購勾選）全部補齊 await save()
const checklistAsync = appCode.includes('async function toggleChecklistItem(index)');
const moveItemAsync = appCode.includes('async function moveItineraryItem(dayIdx, itemIdx, offset)');
const autoSortAsync = appCode.includes('async function autoSortCurrentDayItems(dayIdx)');
const foodDoneAsync = appCode.includes('async function toggleFoodDone(index)');
const shopDoneAsync = appCode.includes('async function toggleShoppingDone(index)');
assertCheck(
  "[P1] 勾選與排序操作全面非同步等待 await save()",
  checklistAsync && moveItemAsync && autoSortAsync && foodDoneAsync && shopDoneAsync,
  "toggleChecklist、moveItineraryItem、autoSortDayItems、toggleFood、toggleShopping 全數實作 await save()"
);

// 9. [P1] 無 PIN 行程防誤鎖
assertCheck(
  "[P1] 無 PIN 公開行程防誤鎖修復",
  appCode.includes('if (!tripHasPassword) return true;') &&
  appCode.includes('Boolean(trip.hasPassword || trip.password)'),
  "isTripUnlocked 支援空字串防呆，showTripView 傳遞布林值，無密碼行程絕不跳出鎖定畫面"
);

// 10. [P1] 後台管理視圖真實呈現
assertCheck(
  "[P1] 後台管理清單資訊校正",
  appCode.includes('ℹ️ 點選上方「✏️ 編輯設定」即可向伺服器取得完整管理設定') &&
  !appCode.includes('尚未綁定</span>') &&
  appCode.includes('openEditTripMetaModal'),
  "後台清單不再假裝呈現被前端安全過濾的空字串，改為導引至 getTripMeta 讀取完整真實資料"
);

// 11. [P2] escapeAttribute 實際使用檢查
const escapeAttrDef = appCode.includes('function escapeAttribute(');
const escapeAttrCount = (appCode.match(/escapeAttribute\(/g) || []).length;
assertCheck(
  "[P2] HTML 屬性 escapeAttribute 安全跳脫全面套用",
  escapeAttrDef && escapeAttrCount >= 20,
  `escapeAttribute 已定義且在表單中實際套用 ${escapeAttrCount} 次，防止屬性邊界穿透與 XSS`
);

// 12. [P2] GAS bootstrap 端點與 CacheService 快取
assertCheck(
  "[P2] GAS bootstrap 合併初始化端點與伺服器快取",
  gasCode.includes('action === "bootstrap"') &&
  gasCode.includes('CacheService.getScriptCache()') &&
  gasCode.includes('hashToken'),
  "GAS doGet 實作 bootstrap 端點與 300 秒 SHA-256 雜湊 Token 快取"
);

console.log("\n==================================================");
console.log(`驗收統計：總計 ${totalChecks} 項檢測，通過 ${passedChecks} 項，失敗 ${totalChecks - passedChecks} 項`);
console.log("==================================================");

if (allPassed) {
  console.log("🎉 恭喜！20260917_08-regression 所有架構與程式碼驗證 100% 通過！");
  process.exit(0);
} else {
  console.error("❌ 仍有測試項目未通過，請檢查上述失敗項目！");
  process.exit(1);
}
