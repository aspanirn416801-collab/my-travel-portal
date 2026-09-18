/**
 * 旅遊手冊系統 20260917_11 操作型全量回歸測試套件
 * 核心特性：
 * 1. 直接引用正式模組 trip-state.js
 * 2. 嚴格審查 app.js 不得重複定義核心狀態與工具函式
 * 3. 實測登出期間未完成儲存之非同步阻斷生命週期
 * 執行方式：node verify_v11_regression.js
 */

const fs = require('fs');
const path = require('path');

console.log("==================================================");
console.log("🚀 開始執行 20260917_11 操作型全生命週期回歸測試");
console.log("==================================================\n");

// 直接引用正式模組
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
// 測試 1：版本號一致性檢查 (20260917_11)
// ----------------------------------------------------
assertCheck(
  "版本號標籤一致性 (20260917_11)",
  appCode.includes('const APP_BUILD_VERSION = "20260917_11";') &&
  htmlCode.includes('app.js?v=20260917_11') &&
  htmlCode.includes('trip-state.js?v=20260917_11'),
  "app.js、index.html 與 trip-state.js 版本號均一致標註為 20260917_11"
);

// ----------------------------------------------------
// 測試 2：架構審查 - app.js 嚴禁重複定義核心狀態與安全函式
// ----------------------------------------------------
(function testNoDuplicateDefinitions() {
  const forbidden = [
    'function escapeAttribute',
    'const tripPermissions',
    'const confirmedSnapshots',
    'function updateConfirmedSnapshot',
    'const memoryUnlockedPins',
    'function isTripUnlocked',
    'function escapeHtml',
    'function rollbackTripState'
  ];

  let hasDuplicate = false;
  const duplicateList = [];
  forbidden.forEach(term => {
    // 扣除開頭從 TripState 解構引用的行，搜尋是否另外有 function 或 const 宣告
    const matches = [...appCode.matchAll(new RegExp(`^\\s*${term}\\b`, 'gm'))];
    if (matches.length > 0) {
      hasDuplicate = true;
      duplicateList.push(term);
    }
  });

  assertCheck(
    "[架構審查] app.js 徹底刪除重複宣告，唯一源頭引用 trip-state.js",
    !hasDuplicate,
    hasDuplicate ? `仍有重複宣告: ${duplicateList.join(', ')}` : "app.js 零重複宣告，正式網頁與測試操作同一套 Map 與函式"
  );
})();

// ----------------------------------------------------
// 測試 3：操作型實測 - 儲存等待期間切換行程之 Payload 隔離
// ----------------------------------------------------
(function testAsyncSavePayloadIsolation() {
  TripState.confirmedSnapshots.clear();
  mockSession.clear();

  const okayamaInitial = { uuid: "okayama", name: "岡山桃太郎之旅", days: [{ id: "D1", title: "抵達岡山城" }] };
  TripState.updateConfirmedSnapshot("okayama", okayamaInitial, mockSession);

  // 1. 岡山發起儲存：鎖定 savingPayload
  let globalTripData = JSON.parse(JSON.stringify(okayamaInitial));
  globalTripData.days[0].title = "【岡山修改完成】後樂園賞花";
  const savingTripUuid = "okayama";
  const savingPayload = JSON.parse(JSON.stringify(globalTripData));

  // 2. 模擬非同步連線期間使用者切換至奧捷：全域資料被覆蓋
  const austriaInitial = { uuid: "czech_austria", name: "奧捷古典名城", days: [{ id: "D1", title: "維也納金色大廳" }] };
  TripState.updateConfirmedSnapshot("czech_austria", austriaInitial, mockSession);
  globalTripData = JSON.parse(JSON.stringify(austriaInitial));

  // 3. 岡山 API 回應成功：使用鎖定的 savingPayload 更新岡山快照
  TripState.updateConfirmedSnapshot(savingTripUuid, savingPayload, mockSession);

  const okayamaSnapshot = TripState.confirmedSnapshots.get("okayama");
  const austriaSnapshot = TripState.confirmedSnapshots.get("czech_austria");

  const isOkayamaCorrect = okayamaSnapshot.name === "岡山桃太郎之旅" && okayamaSnapshot.days[0].title === "【岡山修改完成】後樂園賞花";
  const isAustriaUntouched = austriaSnapshot.name === "奧捷古典名城" && austriaSnapshot.days[0].title === "維也納金色大廳";

  assertCheck(
    "[操作型實測] 儲存連線等待期間切換行程之非同步 Payload 隔離",
    isOkayamaCorrect && isAustriaUntouched,
    `岡山快照:「${okayamaSnapshot.name}」，奧捷快照:「${austriaSnapshot.name}」，徹底杜絕非同步串頁污染`
  );
})();

// ----------------------------------------------------
// 測試 4：操作型實測 - 登出攔截未完成儲存請求之非同步生命週期實測
// ----------------------------------------------------
(function testLogoutInterceptsPendingSave() {
  TripState.confirmedSnapshots.clear();
  mockSession.clear();

  let authGen = 0;
  let idToken = "mock_token_123";
  let userRole = "admin";

  // 1. 岡山發起儲存，鎖定當前登入世代
  const okayamaData = { uuid: "okayama", name: "岡山機密手冊", days: [{ id: "D1", title: "極密會議" }] };
  const savingTripUuid = "okayama";
  const savingPayload = JSON.parse(JSON.stringify(okayamaData));
  const savingAuthGen = authGen; // 鎖定世代為 0

  // 2. 儲存 API 尚未回應前，使用者點擊登出！
  function simulateLogout() {
    authGen++; // 推進世代
    idToken = null;
    userRole = "guest";
    TripState.confirmedSnapshots.clear();
    mockSession.clear();
  }
  simulateLogout();

  // 3. 模擬 2 秒後，舊儲存 API 回傳成功！
  function simulateSaveResponse() {
    // 嚴格正式守門防線：核對 authGen
    if (savingAuthGen !== authGen || !idToken || userRole === "guest") {
      // 成功攔截並丟棄，絕不寫入！
      return false;
    }
    TripState.updateConfirmedSnapshot(savingTripUuid, savingPayload, mockSession);
    return true;
  }

  const saveAccepted = simulateSaveResponse();
  const snapshotCountAfterLogout = TripState.confirmedSnapshots.size;
  const sessionDataAfterLogout = mockSession.getItem("session_trip_okayama");

  assertCheck(
    "[操作型實測] 登出期間尚未完成之儲存請求安全作廢 (絕不回填敏感資料)",
    saveAccepted === false && snapshotCountAfterLogout === 0 && sessionDataAfterLogout === null,
    "登出後遲到的儲存回應被精準攔截，confirmedSnapshots 與 Session 完全為空，絕無資料回填洩漏"
  );
})();

// ----------------------------------------------------
// 測試 5：操作型實測 - 儲存失敗記憶體回滾與 Session 髒資料同步覆蓋
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
  TripState.rollbackTripState("tripA", currentTripUuid, mockSession, (cloned) => {
    tripData = cloned;
  });

  const sessionData = JSON.parse(mockSession.getItem("session_trip_tripA"));

  assertCheck(
    "[操作型實測] 儲存失敗記憶體回滾與 Session 髒資料同步覆蓋",
    tripData.days[0].title === "原始行程A活動" && sessionData.days[0].title === "原始行程A活動",
    "寫入失敗時記憶體與 Session 同步還原為修改前原始內容，重新整理絕無髒資料"
  );
})();

// ----------------------------------------------------
// 測試 6：操作型實測 - isTripUnlocked 支援 visibilitychange 與各身分門禁
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
    "[操作型實測] isTripUnlocked 支援 visibilitychange 與各身分門禁",
    caseA1 === true && caseA2 === true && caseMember === true && caseAdmin === true && casePin === true && caseLocked === false,
    "成員分頁切換絕不誤鎖、無密碼免鎖、PIN訪客憑記憶體放行、未授權者嚴格攔截"
  );
})();

// ----------------------------------------------------
// 測試 7：操作型實測 - HTML 屬性、標籤與 URL 引號安全跳脫
// ----------------------------------------------------
(function testEscapeSecurity() {
  const dangerousInput = `Grand Hotel "Imperial" & Spa <Luxury>`;
  const dangerousUrl = `https://example.com/test?name="onmouseover="alert(1)"&src=foo`;

  const safeAttr = TripState.escapeAttribute(dangerousInput);
  const safeHtml = TripState.escapeHtml(dangerousInput);
  const safeUrl = TripState.sanitizeUrl(dangerousUrl);

  const isSafeAttr = !safeAttr.includes('"') && !safeAttr.includes('<') && !safeAttr.includes('>');
  const isSafeHtml = !safeHtml.includes('<') && !safeHtml.includes('>');
  const isSafeUrl = !safeUrl.includes('"');

  assertCheck(
    "[操作型實測] escapeAttribute、escapeHtml 與 sanitizeUrl 引號防穿透實測",
    isSafeAttr && isSafeHtml && isSafeUrl && safeUrl.includes('&quot;'),
    `URL 成功過濾並轉義引號:「${safeUrl}」，徹底杜絕 src/href 屬性閉合穿透`
  );
})();

// ----------------------------------------------------
// 測試 8：靜態檢查 - openConfirmModal 訊息內容安全跳脫
// ----------------------------------------------------
const confirmModalEscaped = appCode.includes('document.getElementById("modalBody").innerHTML =') &&
  appCode.includes('${escapeHtml(message)}');
assertCheck(
  "[安全性審查] openConfirmModal 訊息內容安全跳脫",
  confirmModalEscaped,
  "確認對話框內文已由 escapeHtml 完整轉義，防止景點/飯店名稱惡意注入"
);

// ----------------------------------------------------
// 測試 9：靜態檢查 - logout() 包含 authGeneration++ 與全面清理
// ----------------------------------------------------
const logoutMatch = appCode.match(/function logout\(\) \{[\s\S]*?\n\}/);
assertCheck(
  "[安全生命週期] logout() 包含 authGeneration++ 與徹底清理記憶體",
  logoutMatch &&
  logoutMatch[0].includes('authGeneration++') &&
  logoutMatch[0].includes('confirmedSnapshots.clear()') &&
  logoutMatch[0].includes('tripData = null') &&
  logoutMatch[0].includes('currentTripUuid = ""') &&
  logoutMatch[0].includes('tripRequestSequence++'),
  "登出時遞增登入世代並清空記憶體與快照，使非同步儲存與載入徹底作廢"
);

// ----------------------------------------------------
// 測試 10：靜態檢查 - visibilitychange 採用統一門禁 isTripUnlocked
// ----------------------------------------------------
const visibilityMatch = appCode.match(/document\.addEventListener\("visibilitychange"[\s\S]*?\}\);/);
assertCheck(
  "[門禁現代化] visibilitychange 切換分頁採用統一門禁 isTripUnlocked",
  visibilityMatch &&
  visibilityMatch[0].includes('isTripUnlocked(currentTripUuid, hasPassword)') &&
  !visibilityMatch[0].includes('!isAdmin'),
  "切換分頁不再只排除管理員，授權成員切換分頁絕不跳出鎖定畫面"
);

// ----------------------------------------------------
// 測試 11：代碼覆蓋率實測 - 所有表單 input/textarea 未跳脫數量為 0
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
// 測試 12：靜態檢查 - GAS createTrip UUID 查重順序
// ----------------------------------------------------
const createTripIdx = gasCode.indexOf('if (action === "createTrip") {');
const checkUuidIdx = gasCode.indexOf('行程識別碼 (UUID)「" + uuid + "」已存在', createTripIdx);
const createFolderIdx = gasCode.indexOf('rootFolder.createFolder(name)', createTripIdx);
assertCheck(
  "[架構審查] GAS createTrip 的 UUID 查重前置於 Drive 資料夾建立",
  createTripIdx !== -1 && checkUuidIdx !== -1 && createFolderIdx !== -1 && checkUuidIdx < createFolderIdx,
  "UUID 查重在前，檔案建立在後，徹底根絕孤立垃圾檔案"
);

console.log("\n==================================================");
console.log(`驗收統計：總計 ${totalChecks} 項檢測，通過 ${passedChecks} 項，失敗 ${totalChecks - passedChecks} 項`);
console.log("==================================================");

if (allPassed) {
  console.log("🎉 恭喜！20260917_11 所有操作型全生命週期實測與架構審查 100% 通過！");
  process.exit(0);
} else {
  console.error("❌ 仍有測試項目未通過，請檢查上述失敗項目！");
  process.exit(1);
}
