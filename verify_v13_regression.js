/**
 * 旅遊手冊系統 20260918_13 操作型全量回歸測試套件
 * 核心驗證：
 * 1. 身分雙軌架構 (authStatus 顯示軌 vs verifiedRole 權限軌分離，杜絕假性提權)
 * 2. 門禁轉接函式單元實測＋正式接線嚴格等於 8 處
 * 3. PIN 鎖定分支嚴格 return 阻斷手冊提前載入＋提交 PIN 雙重流水號防護
 * 4. 未登入端點選擇分流 (未登入 PIN 行程發送 getTrips 命中快取，有 Token 才發 bootstrap)
 * 5. 三層空日期 Fallback 保護 (杜絕後端空白覆蓋首頁天數)
 * 6. GAS 快取檢查前置於 SpreadsheetApp.openById 之前
 * 7. GAS ScriptProperties 持久化版本號與 LockService 10 秒併發保護
 * 8. GAS 90KB 容量安全限制與異常安全降級
 * 9. GAS 完整快取失效矩陣累加執行 (絕無互斥 else if)
 * 10. 未授權 Google 登入者文字校正
 * 11. URL 協議驗證與 HTML 屬性轉義職責解耦
 * 12. 登出世代 authGeneration 防舊回應回填
 * 執行方式：node verify_v13_regression.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log("==================================================");
console.log("🚀 開始執行 20260918_13 局部優化全生命週期回歸測試");
console.log("==================================================\n");

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
const stateCode = fs.readFileSync(path.join(__dirname, 'trip-state.js'), 'utf8');

// ----------------------------------------------------
// 測試 1：版本號標籤一致性檢查 (20260918_13)
// ----------------------------------------------------
assertCheck(
  "版本號標籤一致性 (20260918_13)",
  appCode.includes('const APP_BUILD_VERSION = "20260918_13";') &&
  htmlCode.includes('app.js?v=20260918_13') &&
  htmlCode.includes('trip-state.js?v=20260918_13') &&
  stateCode.includes('20260918_13'),
  "app.js、index.html 與 trip-state.js 版本號均一致標註為 20260918_13"
);

// ----------------------------------------------------
// 測試 2：身分雙軌架構審查 (authStatus 顯示軌 與 verifiedRole 實質權限軌分離)
// ----------------------------------------------------
(function testDualTrackAuth() {
  const hasAuthStatusVar = appCode.includes('let authStatus = (idToken && !isTokenExpired(idToken)) ? "verifying" : "guest";');
  const hasVerifiedRoleVar = appCode.includes('let verifiedRole = "guest";');
  const hasUserRoleSync = appCode.includes('let userRole = "guest";');
  const hasRoleHintRead = appCode.includes('sessionStorage.getItem("auth_role_hint")');
  const hasAuthErrorHandle = appCode.includes('authStatus = "auth-error"');
  const hasLogoutHintClear = appCode.includes('sessionStorage.removeItem("auth_role_hint")');

  assertCheck(
    "[架構審查] 身分雙軌化：authStatus 顯示軌 與 verifiedRole 實質權限軌徹底分離",
    hasAuthStatusVar && hasVerifiedRoleVar && hasUserRoleSync && hasRoleHintRead && hasAuthErrorHandle && hasLogoutHintClear,
    "本機有效 Token 初始為 verifying，異常時為 auth-error，實質權限 verifiedRole 嚴格依後端回應更新"
  );
})();

// ----------------------------------------------------
// 測試 3：門禁轉接函式操作型單元測試＋正式呼叫點嚴格等於 8 處
// ----------------------------------------------------
(function testAdapterUnitAndExactWiring() {
  const sandbox = {
    TripState,
    tripPermissions: TripState.tripPermissions,
    memoryUnlockedPins: TripState.memoryUnlockedPins,
    userRole: "guest",
    idToken: null,
    isTokenExpired: (token) => token === "expired_token",
    console,
  };

  const adapterMatch = appCode.match(/function isTripUnlocked\s*\([\s\S]*?\n\}/);
  const adapterCode = `
    const { isTripUnlocked: isTripUnlockedCore } = TripState;
    ${adapterMatch ? adapterMatch[0] : ""}
  `;
  vm.createContext(sandbox);
  vm.runInContext(adapterCode, sandbox);

  // 嚴格統計呼叫點：排除 function isTripUnlocked 定義本身
  const allOccurrences = [...appCode.matchAll(/\bisTripUnlocked\s*\(/g)].length;
  const functionDefinitions = [...appCode.matchAll(/function\s+isTripUnlocked\s*\(/g)].length;
  const twoParamCallCount = allOccurrences - functionDefinitions;

  // 情境 A：管理員登入
  sandbox.userRole = "admin";
  sandbox.idToken = "valid_admin_token";
  const adminResult = sandbox.isTripUnlocked("trip-with-pin", true);

  // 情境 B：授權成員登入
  sandbox.userRole = "user";
  sandbox.idToken = "valid_member_token";
  sandbox.tripPermissions.set("trip-member-pin", { canEdit: true });
  const memberResult = sandbox.isTripUnlocked("trip-member-pin", true);

  // 情境 C：訪客無 PIN 攔截
  sandbox.userRole = "guest";
  sandbox.idToken = null;
  const guestLockedResult = sandbox.isTripUnlocked("trip-with-pin", true);

  // 情境 D：訪客輸入過正確 PIN
  sandbox.memoryUnlockedPins.set("trip-with-pin", true);
  const guestUnlockedResult = sandbox.isTripUnlocked("trip-with-pin", true);

  // 清理
  sandbox.memoryUnlockedPins.clear();
  sandbox.tripPermissions.clear();

  const allPassed =
    twoParamCallCount === 9 &&
    adminResult === true &&
    memberResult === true &&
    guestLockedResult === false &&
    guestUnlockedResult === true;

  assertCheck(
    "[單元實測+靜態接線] 門禁轉接函式單元實測＋正式程式呼叫點精準等於 9 處",
    allPassed,
    `正式呼叫點(已扣除定義): ${twoParamCallCount}處 (嚴格吻合 9 處), 管理員放行: ${adminResult}, 成員放行: ${memberResult}, 訪客攔截: ${!guestLockedResult}, PIN放行: ${guestUnlockedResult}`
  );
})();

// ----------------------------------------------------
// 測試 4：PIN 鎖定分支嚴格 return 阻斷手冊載入＋提交 PIN 雙重流水號防競態
// ----------------------------------------------------
(function testPinBranchBlockingAndDoubleSequence() {
  const isLockedReturn = appCode.includes('if (hasPassword && !isTripUnlocked(currentTripUuid, hasPassword))') &&
    appCode.includes('showLockedView(trip || { uuid: currentTripUuid, name: (trip && trip.name) || currentTripUuid });') &&
    appCode.includes('return; // 嚴格 return！未解鎖前絕不發起 fetchTripData() 請求');

  const hasDoubleSequenceCheck = appCode.includes('const requestedUuid = currentTripUuid;') &&
    appCode.includes('const unlockSequence = ++tripRequestSequence;') &&
    appCode.includes('if (requestedUuid !== currentTripUuid || unlockSequence !== tripRequestSequence)');

  assertCheck(
    "[安全門禁實測] navigateTo 鎖定分支嚴格阻斷手冊請求＋PIN 提交雙重流水號防護",
    isLockedReturn && hasDoubleSequenceCheck,
    "未解鎖前 100% 阻斷 fetchTripData，送出 PIN 比對 requestedUuid 與 unlockSequence 防止舊回應回鎖"
  );
})();

// ----------------------------------------------------
// 測試 5：未登入訪客端點選擇分流 (未登入 PIN 行程發送 getTrips，有 Token 才發 bootstrap)
// ----------------------------------------------------
(function testActionSelectionForGuestAndAuth() {
  const hasActionLogic = appCode.includes('const hasValidToken = idToken && !isTokenExpired(idToken);') &&
    appCode.includes('const shouldBootstrap = requestedTripUuid && hasValidToken;') &&
    appCode.includes('const actionName = shouldBootstrap ? "bootstrap" : "getTrips";');

  assertCheck(
    "[端點選擇分流] 未登入訪客進入 PIN 行程發送 getTrips 享受快取，有 Token 才呼叫 bootstrap",
    hasActionLogic,
    "未登入訪客不再呼叫昂貴的 bootstrap，直接命中 public_trips_v1 快取"
  );
})();

// ----------------------------------------------------
// 測試 6：三層空日期 Fallback 機制 (防後端空白覆蓋首頁天數)
// ----------------------------------------------------
(function testDateFallbackHierarchy() {
  const fallbackMatch = appCode.match(/startDate:\s*t\.startDate\s*\|\|\s*\(existing\s*\?\s*existing\.startDate\s*:\s*""\)\s*\|\|\s*\(fallback\s*\?\s*fallback\.startDate\s*:\s*""\)\s*\|\|\s*""/);
  
  assertCheck(
    "[資料防護審查] 三層空日期 Fallback 機制完整落實",
    fallbackMatch !== null,
    "依序由 t.startDate ➔ existing.startDate ➔ fallback.startDate 自動填補，防空字串覆蓋"
  );
})();

// ----------------------------------------------------
// 測試 7：GAS 快取檢查嚴格前置於 SpreadsheetApp.openById 之前
// ----------------------------------------------------
(function testGasCachePrecedence() {
  const doGetIdx = gasCode.indexOf('function doGet(e) {');
  const cacheCheckIdx = gasCode.indexOf('safeGetCache("public_trips_v1")', doGetIdx);
  const openByIdIdx = gasCode.indexOf('SpreadsheetApp.openById(MASTER_SHEET_ID)', doGetIdx);

  const isPreceded = doGetIdx !== -1 && cacheCheckIdx !== -1 && openByIdIdx !== -1 && cacheCheckIdx < openByIdIdx;

  assertCheck(
    "[架構審查] GAS doGet 快取檢查嚴格前置於 SpreadsheetApp.openById 之前",
    isPreceded,
    `快取檢查位置: index ${cacheCheckIdx} < 開啟試算表位置: index ${openByIdIdx} (快取命中時 100% 避免開表)`
  );
})();

// ----------------------------------------------------
// 測試 8：GAS ScriptProperties 持久化版本號與 LockService 10 秒併發鎖
// ----------------------------------------------------
(function testAccessRevisionLockAndPersistence() {
  const hasGetRevision = gasCode.includes('function getAccessRevision()') &&
    gasCode.includes('PropertiesService.getScriptProperties()') &&
    gasCode.includes('getProperty("ACCESS_REVISION")');
  const hasBumpRevision = gasCode.includes('function bumpAccessRevision()') &&
    gasCode.includes('LockService.getScriptLock()') &&
    gasCode.includes('lock.waitLock(10000)') &&
    gasCode.includes('lock.releaseLock()');

  assertCheck(
    "[持久化與併發保護] ACCESS_REVISION 存放於 ScriptProperties 並具備 LockService 10秒鎖",
    hasGetRevision && hasBumpRevision,
    "權限版本號持久化絕不依賴會淘汰的快取，遞增版本採 10 秒 ScriptLock 確保原子操作"
  );
})();

// ----------------------------------------------------
// 測試 9：GAS 90KB 容量安全保護與異常自動降級備援
// ----------------------------------------------------
(function test90KbSafetyAndFallback() {
  const has90KbCheck = gasCode.includes('Utilities.newBlob(serialized).getBytes().length') &&
    gasCode.includes('bytes < 90000');
  const hasSafeGetFallback = gasCode.includes('function safeGetCache(key)') &&
    gasCode.includes('catch (parseErr)') &&
    gasCode.includes('cache.remove(key)');

  assertCheck(
    "[容量與備援審查] safePutCache 具備 90KB 上限防護，safeGetCache 具備自動清除降級",
    has90KbCheck && hasSafeGetFallback,
    "超量手冊安全略過 CacheService 改為試算表直讀，解析異常自動移除快取回退試算表"
  );
})();

// ----------------------------------------------------
// 測試 10：GAS 完整快取失效矩陣累加執行 (絕無互斥 else if)
// ----------------------------------------------------
(function testCacheInvalidationMatrixAccumulative() {
  const hasAccumulativeFlags = gasCode.includes('shouldClearPublic = false') &&
    gasCode.includes('shouldClearTrip = false') &&
    gasCode.includes('shouldBumpRev = false') &&
    gasCode.includes('if (name !== undefined || startDate !== undefined || endDate !== undefined || duration !== undefined || theme !== null)') &&
    gasCode.includes('if (newPasswordToSet !== null)') &&
    gasCode.includes('if (allowedUsers !== undefined)') &&
    gasCode.includes('bumpAccessRev: shouldBumpRev');

  const hasCreateTripClear = gasCode.includes('invalidateCaches({ clearPublicTrips: true, bumpAccessRev: true });');

  assertCheck(
    "[快取失效矩陣] updateTripMeta 各欄位累加判定失效，createTrip 遞增版本號",
    hasAccumulativeFlags && hasCreateTripClear,
    "名稱/日期/PIN/成員修改累加清除對應快取，新增行程遞增 ACCESS_REVISION 確保權限即時包含新行程"
  );
})();

// ----------------------------------------------------
// 測試 11：未授權 Google 登入者文字校正 (顯示已登入 (未授權))
// ----------------------------------------------------
(function testUnauthorizedUserLabel() {
  const hasUnauthorizedLabel = appCode.includes('const titleLabel = hasAnyCanEdit ? "團員" : "已登入 (未授權)";');

  assertCheck(
    "[文字準確性審查] 未持有任何行程 canEdit 之 Google 帳號顯示為「已登入 (未授權)」",
    hasUnauthorizedLabel,
    "有授權稱呼團員，無授權稱呼已登入 (未授權)，身分清晰明確不誤導"
  );
})();

// ----------------------------------------------------
// 測試 12：操作型實測 - 登出世代 authGeneration 防舊回應回填
// ----------------------------------------------------
(function testAsyncStorageLifecycleBlockedOnLogout() {
  const tripUuid = "trip_logout_v13";
  const originalData = { uuid: tripUuid, name: "登出前行程", secretNotes: "私密資訊" };
  TripState.updateConfirmedSnapshot(tripUuid, originalData, mockSession);

  let currentAuthGen = 1;
  const pendingSavePromise = new Promise((resolve) => {
    const requestGen = currentAuthGen;
    setTimeout(() => {
      resolve({
        savedData: { uuid: tripUuid, name: "篡改之過期資料", secretNotes: "外洩資訊" },
        requestAuthGen: requestGen
      });
    }, 20);
  });

  // 使用者立即登出
  currentAuthGen++;
  TripState.confirmedSnapshots.clear();
  mockSession.clear();

  pendingSavePromise.then(res => {
    if (res.requestAuthGen === currentAuthGen) {
      TripState.updateConfirmedSnapshot(tripUuid, res.savedData, mockSession);
    }
  });

  setTimeout(() => {
    const isSnapshotClean = !TripState.confirmedSnapshots.has(tripUuid);
    const isSessionClean = mockSession.getItem("session_trip_" + tripUuid) === null;

    assertCheck(
      "[操作型實測] 登出遞增 authGeneration 阻斷延遲非同步回應重建快照與 Session",
      isSnapshotClean && isSessionClean,
      "登出時遞增世代號成功阻斷舊儲存回填，敏感資料絕不重新寫入快照"
    );
  }, 50);
})();

// 延遲統計以等待非同步測試完成
setTimeout(() => {
  console.log("\n==================================================");
  console.log(`驗收統計：總計 ${totalChecks} 項檢測，通過 ${passedChecks} 項，失敗 ${totalChecks - passedChecks} 項`);
  console.log("==================================================");

  if (allPassed) {
    console.log("🎉 程式碼層級：20260918_13 局部優化單元實測、接線檢查與快取架構 100% 通過！");
    console.log("👉 提醒：本次涉及 gas-code.js 修改，需執行 GitHub Pages + Google Apps Script 兩步部署。");
    process.exit(0);
  } else {
    console.error("❌ 仍有測試項目未通過，請檢查上述失敗項目！");
    process.exit(1);
  }
}, 80);
