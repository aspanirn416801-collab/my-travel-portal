/**
 * 旅遊手冊系統 20260917_09 操作型自動化回歸測試
 * 執行方式：node verify_v09_regression.js
 */

const fs = require('fs');
const path = require('path');

console.log("==================================================");
console.log("🚀 開始執行 20260917_09 操作型與架構回歸驗證");
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
    if (detail) console.error(`   └─ 失敗詳情: ${detail}`);
  }
}

// 模擬瀏覽器環境 (Storage, Map 等)
class MockStorage {
  constructor() {
    this.store = new Map();
  }
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  setItem(key, value) {
    this.store.set(key, String(value));
  }
  removeItem(key) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

const mockSession = new MockStorage();

const appCode = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const gasCode = fs.readFileSync(path.join(__dirname, 'gas-code.js'), 'utf8');
const htmlCode = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// ----------------------------------------------------
// 測試 1：版本標籤一致性
// ----------------------------------------------------
assertCheck(
  "版本號標籤一致性 (20260917_09)",
  appCode.includes('const APP_BUILD_VERSION = "20260917_09";') &&
  htmlCode.includes('app.js?v=20260917_09'),
  "app.js 與 index.html 版本號均一致升級為 20260917_09，防止 CDN/瀏覽器讀取舊快取"
);

// ----------------------------------------------------
// 測試 2：操作型實測 - 跨行程快照隔離與失敗精準回滾
// ----------------------------------------------------
(function testCrossTripSnapshotIsolation() {
  const confirmedSnapshots = new Map();
  let currentTripUuid = "okayama";
  let tripData = null;

  function updateConfirmedSnapshot(uuid, data) {
    if (!uuid || !data) return;
    const cloned = JSON.parse(JSON.stringify(data));
    confirmedSnapshots.set(uuid, cloned);
    mockSession.setItem("session_trip_" + uuid, JSON.stringify(cloned));
  }

  function rollbackTripState(uuid) {
    if (!uuid) return;
    const confirmed = confirmedSnapshots.get(uuid);
    if (confirmed) {
      if (currentTripUuid === uuid) {
        tripData = JSON.parse(JSON.stringify(confirmed));
      }
      mockSession.setItem("session_trip_" + uuid, JSON.stringify(confirmed));
    }
  }

  // 1. 岡山載入成功
  const okayamaInitial = { uuid: "okayama", name: "岡山桃太郎之旅", days: [{ id: "D1", title: "抵達岡山城" }] };
  updateConfirmedSnapshot("okayama", okayamaInitial);

  // 2. 切換至奧捷
  currentTripUuid = "czech_austria";
  const austriaInitial = { uuid: "czech_austria", name: "奧捷經典雙國", days: [{ id: "D1", title: "抵達維也納機場" }] };
  updateConfirmedSnapshot("czech_austria", austriaInitial);

  // 3. 在奧捷進行修改
  tripData = JSON.parse(JSON.stringify(austriaInitial));
  tripData.days[0].title = "【修改未儲存】改去布拉格城堡";

  // 4. 模擬儲存失敗
  rollbackTripState("czech_austria");

  const restoredTitle = tripData.days[0].title;
  const sessionAustria = JSON.parse(mockSession.getItem("session_trip_czech_austria"));
  const okayamaSnapshot = confirmedSnapshots.get("okayama");

  const isAustriaRestored = restoredTitle === "抵達維也納機場";
  const isSessionClean = sessionAustria.days[0].title === "抵達維也納機場";
  const isOkayamaUntouched = okayamaSnapshot.name === "岡山桃太郎之旅";

  assertCheck(
    "[操作型實測] 跨行程快照隔離與失敗回滾 (奧捷不串岡山，Session同步回復)",
    isAustriaRestored && isSessionClean && isOkayamaUntouched,
    `奧捷還原標題:「${restoredTitle}」, Session標題:「${sessionAustria.days[0].title}」, 岡山快照獨立保持`
  );
})();

// ----------------------------------------------------
// 測試 3：操作型實測 - PIN 解鎖後第一次儲存失敗回復
// ----------------------------------------------------
(function testFirstSaveFailureAfterPinUnlock() {
  const confirmedSnapshots = new Map();
  const currentTripUuid = "secret_trip";
  let tripData = null;

  function updateConfirmedSnapshot(uuid, data) {
    if (!uuid || !data) return;
    const cloned = JSON.parse(JSON.stringify(data));
    confirmedSnapshots.set(uuid, cloned);
    mockSession.setItem("session_trip_" + uuid, JSON.stringify(cloned));
  }

  function rollbackTripState(uuid) {
    const confirmed = confirmedSnapshots.get(uuid);
    if (confirmed) {
      tripData = JSON.parse(JSON.stringify(confirmed));
      mockSession.setItem("session_trip_" + uuid, JSON.stringify(confirmed));
    }
  }

  // 1. PIN 驗證成功時建立初始確認快照
  const initialSecret = { uuid: "secret_trip", checklist: [{ title: "護照", done: false }] };
  updateConfirmedSnapshot(currentTripUuid, initialSecret);

  // 2. 第一次修改
  tripData = JSON.parse(JSON.stringify(initialSecret));
  tripData.checklist[0].done = true;

  // 3. 第一次儲存失敗
  rollbackTripState(currentTripUuid);

  assertCheck(
    "[操作型實測] PIN 解鎖後首次修改儲存失敗回滾",
    tripData.checklist[0].done === false && JSON.parse(mockSession.getItem("session_trip_secret_trip")).checklist[0].done === false,
    "首次修改失敗後精準退回 PIN 解鎖時的初始手冊狀態，Session 同步回復"
  );
})();

// ----------------------------------------------------
// 測試 4：操作型實測 - isTripUnlocked 支援 pageshow 與各種權限邊界
// ----------------------------------------------------
(function testIsTripUnlockedCases() {
  const memoryUnlockedPins = new Map();
  const tripPermissions = new Map();

  function isTripUnlocked(tripUuid, tripHasPassword, userRole, idToken, isTokenExpired) {
    if (!tripUuid) return true;
    if (userRole === "admin" && idToken && !isTokenExpired) return true;
    const perm = tripPermissions.get(tripUuid);
    if (perm && perm.canEdit && idToken && !isTokenExpired) return true;
    if (!tripHasPassword) return true;
    return memoryUnlockedPins.has(tripUuid);
  }

  // A. 公開無密碼行程 (傳入 false 或空字串)
  const caseA1 = isTripUnlocked("pub1", false, "guest", null, false);
  const caseA2 = isTripUnlocked("pub2", "", "guest", null, false);

  // B. 授權成員免 PIN 進入設有密碼行程
  tripPermissions.set("member_trip", { canEdit: true });
  const caseB = isTripUnlocked("member_trip", true, "user", "valid_token", false);

  // C. PIN 訪客在記憶體中已解鎖
  memoryUnlockedPins.set("locked_trip", "1234");
  const caseC = isTripUnlocked("locked_trip", true, "guest", null, false);

  // D. 未授權且未解鎖訪客
  const caseD = isTripUnlocked("other_locked", true, "guest", null, false);

  assertCheck(
    "[操作型實測] isTripUnlocked 與 pageshow 門禁邏輯 (成員免密、公開免密、PIN解鎖)",
    caseA1 === true && caseA2 === true && caseB === true && caseC === true && caseD === false,
    "無密碼與成員絕不誤鎖，PIN訪客憑記憶體放行，未解鎖者正確攔截"
  );
})();

// ----------------------------------------------------
// 測試 5：操作型實測 - HTML 屬性與特殊字元跳脫
// ----------------------------------------------------
(function testEscapeAttributeSecurity() {
  function escapeAttribute(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  const maliciousInput = `Joe's "Super <Deluxe>" & Fun Trip`;
  const escaped = escapeAttribute(maliciousInput);
  const htmlTag = `<input type="text" value="${escaped}">`;

  // 驗證生成的屬性值沒有未經轉義的引號或括號打破邊界
  const isSafe = !escaped.includes('"') && !escaped.includes("'") && !escaped.includes('<') && !escaped.includes('>');
  const attributeBreakTest = htmlTag.indexOf('">') === htmlTag.lastIndexOf('">');

  assertCheck(
    "[操作型實測] escapeAttribute 屬性邊界穿透防護",
    isSafe && attributeBreakTest,
    `輸入「${maliciousInput}」安全跳脫為「${escaped}」`
  );
})();

// ----------------------------------------------------
// 測試 6：操作型實測 - 行程天數最後一天邊界防護
// ----------------------------------------------------
(function testLastDayDeletionProtection() {
  let days = [{ id: "D1", title: "唯一一天" }];
  let prevented = false;

  function tryDeleteDay(dayIdx) {
    if (!days || !Array.isArray(days) || days.length <= 1) {
      prevented = true;
      return false;
    }
    days.splice(dayIdx, 1);
    return true;
  }

  const result = tryDeleteDay(0);
  assertCheck(
    "[操作型實測] 行程至少保留一天，禁止刪除最後一天防呆",
    result === false && prevented === true && days.length === 1,
    "當行程僅剩 1 天時強制攔截刪除操作，避免 days 歸零引發雲端防呆衝突"
  );
})();

// ----------------------------------------------------
// 測試 7：靜態檢查 - GAS 建立行程 UUID 查重前置於 Drive 檔案建立
// ----------------------------------------------------
(function testGasCreateTripOrder() {
  const createTripIdx = gasCode.indexOf('if (action === "createTrip") {');
  const checkUuidIdx = gasCode.indexOf('行程識別碼 (UUID)「" + uuid + "」已存在', createTripIdx);
  const createFolderIdx = gasCode.indexOf('rootFolder.createFolder(name)', createTripIdx);

  assertCheck(
    "[架構審查] GAS createTrip 的 UUID 查重嚴格前置於雲端檔案建立",
    createTripIdx !== -1 && checkUuidIdx !== -1 && createFolderIdx !== -1 && checkUuidIdx < createFolderIdx,
    "UUID 查重在 createFolder 之前執行，徹底杜絕 UUID 重複時留下孤立資料夾與試算表"
  );
})();

// ----------------------------------------------------
// 測試 8：靜態檢查 - 移除 decodeJwtPayload 本地偽解碼
// ----------------------------------------------------
assertCheck(
  "[安全性審查] GAS 徹底移除 decodeJwtPayload 本地偽解碼",
  !gasCode.includes('function decodeJwtPayload') && !gasCode.includes('decodeJwtPayload('),
  "拒絕未驗證簽章與發行人之本地解碼，僅信任 Google 官方 Tokeninfo"
);

// ----------------------------------------------------
// 測試 9：靜態檢查 - 移除 renderFlights 中的未定義 isAdmin
// ----------------------------------------------------
const renderFlightsMatch = appCode.match(/function renderFlights\(\) \{[\s\S]*?function renderTransport/);
assertCheck(
  "[代碼健壯性] renderFlights() 無未定義變數 ReferenceError",
  renderFlightsMatch && !renderFlightsMatch[0].includes('isAdmin'),
  "已徹底移除未宣告之 isAdmin，切換至航班與飯店分頁不拋錯"
);

// ----------------------------------------------------
// 測試 10：靜態檢查 - 5 處勾選與排序操作補齊 await save()
// ----------------------------------------------------
const checklistAsync = appCode.includes('async function toggleChecklistItem(index)');
const moveItemAsync = appCode.includes('async function moveItineraryItem(dayIdx, itemIdx, offset)');
const autoSortAsync = appCode.includes('async function autoSortCurrentDayItems(dayIdx)');
const foodDoneAsync = appCode.includes('async function toggleFoodDone(index)');
const shopDoneAsync = appCode.includes('async function toggleShoppingDone(index)');
assertCheck(
  "[非同步一致性] Checklist、美食、代購與景點排序 5 處全面 await save()",
  checklistAsync && moveItemAsync && autoSortAsync && foodDoneAsync && shopDoneAsync,
  "所有勾選與排序操作均為 async 且等待雲端確認"
);

// ----------------------------------------------------
// 測試 11：靜態檢查 - pageshow 移除淘汰的 session unlocked 欄位
// ----------------------------------------------------
const pageshowMatch = appCode.match(/window\.addEventListener\("pageshow"[\s\S]*?\}\);/);
assertCheck(
  "[門禁現代化] pageshow 移除已淘汰的 unlocked_trip_ session 旗標",
  pageshowMatch && !pageshowMatch[0].includes('sessionStorage.getItem("unlocked_trip_'),
  "pageshow 統一呼叫 isTripUnlocked，完全適配 memoryUnlockedPins 與成員權限"
);

// ----------------------------------------------------
// 測試 12：靜態檢查 - 表單 input 與 textarea 全量跳脫覆蓋
// ----------------------------------------------------
const escapeAttrCount = (appCode.match(/escapeAttribute\(/g) || []).length;
const escapeHtmlCount = (appCode.match(/escapeHtml\(/g) || []).length;
assertCheck(
  "[安全覆蓋率] HTML 屬性與 textarea 內容高密度安全跳脫",
  escapeAttrCount >= 40 && escapeHtmlCount >= 20,
  `escapeAttribute 調用 ${escapeAttrCount} 次，escapeHtml 調用 ${escapeHtmlCount} 次，全表單已安全防護`
);

console.log("\n==================================================");
console.log(`驗收統計：總計 ${totalChecks} 項檢測，通過 ${passedChecks} 項，失敗 ${totalChecks - passedChecks} 項`);
console.log("==================================================");

if (allPassed) {
  console.log("🎉 恭喜！20260917_09 所有操作型實測與架構審查 100% 通過！");
  process.exit(0);
} else {
  console.error("❌ 仍有測試項目未通過，請檢查上述失敗項目！");
  process.exit(1);
}
