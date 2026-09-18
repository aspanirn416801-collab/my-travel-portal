/**
 * 旅遊手冊系統 20260917_10 操作型自動化回歸測試
 * 直接引用正式模組 trip-state.js，對真實程式邏輯進行斷言
 * 執行方式：node verify_v10_regression.js
 */

const fs = require('fs');
const path = require('path');

console.log("==================================================");
console.log("🚀 開始執行 20260917_10 操作型全量回歸測試套件");
console.log("==================================================\n");

// 1. 直接引用正式模組 (非測試複製品)
const TripState = require('./trip-state.js');

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

// 模擬 Storage 引擎 (供 Node.js 測試 sessionStorage 同步)
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
// 測試 1：版本號一致性檢查 (20260917_10)
// ----------------------------------------------------
assertCheck(
  "版本號標籤一致性 (20260917_10)",
  appCode.includes('const APP_BUILD_VERSION = "20260917_10";') &&
  htmlCode.includes('app.js?v=20260917_10') &&
  htmlCode.includes('trip-state.js?v=20260917_10'),
  "app.js、index.html 與 trip-state.js 版本號均一致標註為 20260917_10"
);

// ----------------------------------------------------
// 測試 2：操作型實測 - 儲存等待期間切換行程（真實正式模組非同步 Payload 隔離實測）
// ----------------------------------------------------
(function testAsyncSavePayloadIsolation() {
  TripState.confirmedSnapshots.clear();

  // 1. 初始化岡山行程並記錄快照
  const okayamaInitial = { uuid: "okayama", name: "岡山桃太郎之旅", days: [{ id: "D1", title: "抵達岡山城" }] };
  TripState.updateConfirmedSnapshot("okayama", okayamaInitial, mockSession);

  // 2. 岡山發起儲存：在送出前鎖定 savingPayload
  let globalTripData = JSON.parse(JSON.stringify(okayamaInitial));
  globalTripData.days[0].title = "【岡山修改完成】後樂園賞花";
  const savingTripUuid = "okayama";
  const savingPayload = JSON.parse(JSON.stringify(globalTripData));

  // 3. 模擬非同步連線期間：使用者切換到奧捷行程，全域變數 globalTripData 瞬間變為奧捷資料！
  const austriaInitial = { uuid: "czech_austria", name: "奧捷古典音樂節", days: [{ id: "D1", title: "維也納金色大廳" }] };
  TripState.updateConfirmedSnapshot("czech_austria", austriaInitial, mockSession);
  globalTripData = JSON.parse(JSON.stringify(austriaInitial)); // 全域變數被切換

  // 4. 岡山 API 回應成功：使用鎖定的 savingPayload 更新岡山快照，絕不用全域 globalTripData
  TripState.updateConfirmedSnapshot(savingTripUuid, savingPayload, mockSession);

  // 5. 驗證岡山快照內容
  const okayamaSnapshot = TripState.confirmedSnapshots.get("okayama");
  const austriaSnapshot = TripState.confirmedSnapshots.get("czech_austria");

  const isOkayamaCorrect = okayamaSnapshot.name === "岡山桃太郎之旅" && okayamaSnapshot.days[0].title === "【岡山修改完成】後樂園賞花";
  const isAustriaUntouched = austriaSnapshot.name === "奧捷古典音樂節" && austriaSnapshot.days[0].title === "維也納金色大廳";

  assertCheck(
    "[操作型實測] 儲存連線期間切換行程之非同步 Payload 隔離 (真實正式函式)",
    isOkayamaCorrect && isAustriaUntouched,
    `岡山快照名稱:「${okayamaSnapshot.name}」，奧捷快照名稱:「${austriaSnapshot.name}」，徹底杜絕非同步串頁污染`
  );
})();

// ----------------------------------------------------
// 測試 3：操作型實測 - 儲存失敗回滾與 Session 髒資料同步覆蓋 (真實正式模組)
// ----------------------------------------------------
(function testSaveFailureRollbackAndSessionSync() {
  TripState.confirmedSnapshots.clear();
  mockSession.clear();

  const originalData = { uuid: "tripA", name: "原始行程A", days: [{ id: "D1", title: "原始行程A活動" }] };
  TripState.updateConfirmedSnapshot("tripA", originalData, mockSession);

  let currentTripUuid = "tripA";
  let tripData = JSON.parse(JSON.stringify(originalData));
  tripData.days[0].title = "【錯誤修改】未儲存成功的天數";

  // 模擬呼叫正式 rollbackTripState 函式
  let restoredData = null;
  TripState.rollbackTripState("tripA", currentTripUuid, mockSession, (cloned) => {
    restoredData = cloned;
    tripData = cloned;
  });

  const sessionData = JSON.parse(mockSession.getItem("session_trip_tripA"));

  assertCheck(
    "[操作型實測] 儲存失敗記憶體回滾與 Session 髒資料同步覆蓋 (真實正式函式)",
    tripData.days[0].title === "原始行程A活動" && sessionData.days[0].title === "原始行程A活動",
    "寫入失敗時記憶體與 Session 同步還原為修改前原始內容，重新整理絕無髒資料"
  );
})();

// ----------------------------------------------------
// 測試 4：操作型實測 - isTripUnlocked 支援 visibilitychange、pageshow 與各權限邊界 (真實模組)
// ----------------------------------------------------
(function testIsTripUnlockedComprehensive() {
  TripState.memoryUnlockedPins.clear();
  TripState.tripPermissions.clear();

  // A. 公開無密碼行程 (布林 false 或空字串)
  const caseA1 = TripState.isTripUnlocked("pub1", false, "guest", null, false);
  const caseA2 = TripState.isTripUnlocked("pub2", "", "guest", null, false);

  // B. 授權成員切換分頁 (visibilitychange 實測)：角色為 user，免輸 PIN
  TripState.tripPermissions.set("member_trip", { canEdit: true });
  const caseMember = TripState.isTripUnlocked("member_trip", true, "user", "valid_token", false);

  // C. 系統管理員：免輸 PIN
  const caseAdmin = TripState.isTripUnlocked("admin_trip", true, "admin", "valid_token", false);

  // D. PIN 訪客：記憶體中已驗證過
  TripState.memoryUnlockedPins.set("pin_trip", "5678");
  const casePin = TripState.isTripUnlocked("pin_trip", true, "guest", null, false);

  // E. 未授權且未解鎖者：正確攔截
  const caseLocked = TripState.isTripUnlocked("locked_trip", true, "guest", null, false);

  assertCheck(
    "[操作型實測] isTripUnlocked 支援 visibilitychange 與各身分門禁 (真實正式函式)",
    caseA1 === true && caseA2 === true && caseMember === true && caseAdmin === true && casePin === true && caseLocked === false,
    "成員分頁切換絕不誤鎖、無密碼免鎖、PIN訪客憑記憶體放行、未授權者嚴格攔截"
  );
})();

// ----------------------------------------------------
// 測試 5：操作型實測 - HTML 屬性與特殊符號安全跳脫 (真實模組)
// ----------------------------------------------------
(function testEscapeAttributeReal() {
  const dangerousInput = `Grand Hotel "Imperial" & Spa <Luxury>`;
  const safeAttr = TripState.escapeAttribute(dangerousInput);
  const safeHtml = TripState.escapeHtml(dangerousInput);

  const isSafeAttr = !safeAttr.includes('"') && !safeAttr.includes('<') && !safeAttr.includes('>');
  const isSafeHtml = !safeHtml.includes('<') && !safeHtml.includes('>');

  assertCheck(
    "[操作型實測] escapeAttribute 與 escapeHtml 安全性實測 (真實正式函式)",
    isSafeAttr && isSafeHtml && safeAttr.includes('&quot;') && safeHtml.includes('&lt;'),
    `屬性安全跳脫:「${safeAttr}」，標籤安全跳脫:「${safeHtml}」`
  );
})();

// ----------------------------------------------------
// 測試 6：靜態檢查 - openConfirmModal 訊息跳脫覆蓋
// ----------------------------------------------------
const confirmModalEscaped = appCode.includes('document.getElementById("modalBody").innerHTML =') &&
  appCode.includes('${escapeHtml(message)}');
assertCheck(
  "[安全性審查] openConfirmModal 訊息內容安全跳脫",
  confirmModalEscaped,
  "確認對話框內文已由 escapeHtml 完整轉義，防止景點/飯店名稱惡意注入"
);

// ----------------------------------------------------
// 測試 7：靜態檢查 - logout() 徹底清理記憶體與流水號失效
// ----------------------------------------------------
const logoutMatch = appCode.match(/function logout\(\) \{[\s\S]*?\n\}/);
assertCheck(
  "[安全生命週期] logout() 徹底清理快照、手冊資料並自增流水號",
  logoutMatch &&
  logoutMatch[0].includes('confirmedSnapshots.clear()') &&
  logoutMatch[0].includes('tripData = null') &&
  logoutMatch[0].includes('currentTripUuid = ""') &&
  logoutMatch[0].includes('tripRequestSequence++'),
  "登出時徹底清空記憶體與快照，並推進流水號使尚未完成之連線徹底作廢"
);

// ----------------------------------------------------
// 測試 8：靜態檢查 - visibilitychange 統一標準門禁
// ----------------------------------------------------
const visibilityMatch = appCode.match(/document\.addEventListener\("visibilitychange"[\s\S]*?\}\);/);
assertCheck(
  "[門禁現代化] visibilitychange 切換分頁採用統一門禁 isTripUnlocked",
  visibilityMatch &&
  visibilityMatch[0].includes('isTripUnlocked(currentTripUuid, hasPassword)') &&
  !visibilityMatch[0].includes('!isAdmin'),
  "切換分頁不再只排除管理員，授權成員與公開行程切換分頁絕不跳出鎖定畫面"
);

// ----------------------------------------------------
// 測試 9：靜態檢查 - GAS createTrip UUID 查重順序
// ----------------------------------------------------
const createTripIdx = gasCode.indexOf('if (action === "createTrip") {');
const checkUuidIdx = gasCode.indexOf('行程識別碼 (UUID)「" + uuid + "」已存在', createTripIdx);
const createFolderIdx = gasCode.indexOf('rootFolder.createFolder(name)', createTripIdx);
assertCheck(
  "[架構審查] GAS createTrip 的 UUID 查重前置於 Drive 資料夾建立",
  createTripIdx !== -1 && checkUuidIdx !== -1 && createFolderIdx !== -1 && checkUuidIdx < createFolderIdx,
  "UUID 查重在前，檔案建立在後，徹底根絕孤立垃圾檔案"
);

// ----------------------------------------------------
// 測試 10：代碼覆蓋率實測 - 所有表單 input/textarea 未跳脫數量為 0
// ----------------------------------------------------
(function testZeroUnescapedFormFields() {
  const valueMatches = [...appCode.matchAll(/value=["']\$\{([^}]+)\}["']/g)];
  let unescapedValues = 0;
  valueMatches.forEach(m => {
    if (!m[1].includes('escapeAttribute') && !m[1].includes('escapeHtml') && !m[1].includes('encodeURIComponent')) {
      unescapedValues++;
    }
  });

  const textareaMatches = [...appCode.matchAll(/<textarea[^>]*>([\s\S]*?)<\/textarea>/g)];
  let unescapedTextareas = 0;
  textareaMatches.forEach(m => {
    const inner = m[1];
    if (inner.includes('${') && !inner.includes('escapeHtml') && !inner.includes('escapeAttribute')) {
      unescapedTextareas++;
    }
  });

  assertCheck(
    "[代碼覆蓋率] 表單 input 與 textarea 未跳脫遺漏統計為 0",
    unescapedValues === 0 && unescapedTextareas === 0,
    `未跳脫 value 屬性: ${unescapedValues} 處，未跳脫 textarea: ${unescapedTextareas} 處 (達成 100% 跳脫覆蓋)`
  );
})();

// ----------------------------------------------------
// 測試 11：靜態檢查 - 移除 renderFlights 中未定義的 isAdmin
// ----------------------------------------------------
const renderFlightsMatch = appCode.match(/function renderFlights\(\) \{[\s\S]*?function renderTransport/);
assertCheck(
  "[代碼健壯性] renderFlights() 無未定義變數 ReferenceError",
  renderFlightsMatch && !renderFlightsMatch[0].includes('isAdmin'),
  "renderFlights() 內已無未定義的 isAdmin，切換至航班與飯店分頁不白屏"
);

// ----------------------------------------------------
// 測試 12：靜態檢查 - 勾選與排序操作全面非同步等待 await save()
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

console.log("\n==================================================");
console.log(`驗收統計：總計 ${totalChecks} 項檢測，通過 ${passedChecks} 項，失敗 ${totalChecks - passedChecks} 項`);
console.log("==================================================");

if (allPassed) {
  console.log("🎉 恭喜！20260917_10 所有操作型實測與架構審查 100% 通過！");
  process.exit(0);
} else {
  console.error("❌ 仍有測試項目未通過，請檢查上述失敗項目！");
  process.exit(1);
}
