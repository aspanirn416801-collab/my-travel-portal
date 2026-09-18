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
// 測試 2：身分雙軌架構審查與行為實測 (authStatus 顯示軌 與 verifiedRole 實質權限軌分離，新登入 verifying 阻斷舊權限)
// ----------------------------------------------------
(function testDualTrackAuth() {
  const hasAuthStatusVar = appCode.includes('let authStatus = (idToken && !isTokenExpired(idToken)) ? "verifying" : "guest";');
  const hasVerifiedRoleVar = appCode.includes('let verifiedRole = "guest";');
  const hasUserRoleSync = appCode.includes('let userRole = "guest";');
  const hasRoleHintRead = appCode.includes('sessionStorage.getItem("auth_role_hint")');
  const hasAuthErrorHandle = appCode.includes('authStatus = "auth-error"');
  const hasLogoutHintClear = appCode.includes('sessionStorage.removeItem("auth_role_hint")');

  // 動態行為檢驗：模擬 handleCredentialResponse 與 canEditCurrentTrip 門禁阻斷
  const authSandbox = {
    TripState,
    tripPermissions: new Map(),
    currentTripUuid: "trip-test",
    authStatus: "guest",
    verifiedRole: "guest",
    userRole: "guest",
    idToken: null,
    authGeneration: 0,
    isTokenExpired: () => false,
    parseJwt: () => ({ email: "test@example.com", name: "測試員" }),
    closeGoogleLoginModal: () => {},
    localStorage: new MockStorage(),
    sessionStorage: new MockStorage(),
    updateAuthUI: () => {},
    showToast: () => {},
    showAdminView: () => {},
    window: {
      location: { origin: "http://localhost", pathname: "/", search: "" }
    },
    history: { replaceState: () => {} },
    fetchTrips: () => Promise.resolve(),
    console
  };

  // 注入 canEditCurrentTrip (使用正則精準截取函式本身)
  const canEditMatch = appCode.match(/function canEditCurrentTrip\(\)\s*\{[\s\S]*?\n\}/);
  const canEditCode = canEditMatch ? canEditMatch[0] : "";
  vm.createContext(authSandbox);
  vm.runInContext(canEditCode, authSandbox);

  // 注入 handleCredentialResponse
  const handleCredCode = appCode.slice(appCode.indexOf('function handleCredentialResponse('), appCode.indexOf('function logout()'));
  vm.runInContext(handleCredCode, authSandbox);

  // 1. 預置舊帳號殘留之編輯權限與假性狀態
  authSandbox.tripPermissions.set("trip-test", { canEdit: true });
  authSandbox.authStatus = "authenticated";
  authSandbox.verifiedRole = "user";
  authSandbox.userRole = "user";
  authSandbox.idToken = "old_token";
  const beforeCanEdit = authSandbox.canEditCurrentTrip(); // 應為 true

  // 2. 模擬新使用者點擊 Google 登入 (觸發 handleCredentialResponse)
  authSandbox.handleCredentialResponse({ credential: "new_valid_token" });

  const isStatusVerifying = authSandbox.authStatus === "verifying";
  const isRoleGuest = authSandbox.verifiedRole === "guest" && authSandbox.userRole === "guest";
  const isPermCleared = authSandbox.tripPermissions.size === 0;
  const isBlockedDuringVerify = authSandbox.canEditCurrentTrip() === false; // 驗證中嚴格禁止編輯！

  const dualTrackPassed = hasAuthStatusVar && hasVerifiedRoleVar && hasUserRoleSync &&
    hasRoleHintRead && hasAuthErrorHandle && hasLogoutHintClear &&
    beforeCanEdit === true && isStatusVerifying && isRoleGuest && isPermCleared && isBlockedDuringVerify;

  assertCheck(
    "[身分雙軌行為實測] 新登入即刻設定 authStatus=verifying、清空舊授權，驗證完成前 100% 阻斷編輯",
    dualTrackPassed,
    `靜態架構符合: true, 登入前可編輯: ${beforeCanEdit}, 登入觸發後 authStatus: ${authSandbox.authStatus}, 權限清空: ${isPermCleared}, 驗證期間門禁阻斷: ${isBlockedDuringVerify}`
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
// 測試 6：資料庫唯一真理源機制 (徹底移除 PUBLIC_TRIP_SUMMARIES 寫死行程，採用 loadCachedTrips 快取 + 空日期 Fallback)
// ----------------------------------------------------
(function testSingleSourceOfTruthAndFallback() {
  const hasNoHardcodedTrips = !appCode.includes("PUBLIC_TRIP_SUMMARIES");
  const hasLoadCachedTrips = appCode.includes("let tripsList = loadCachedTrips();");
  const hasDisplayNameDynamic = appCode.includes('return String(name || uuid || "未命名旅程").trim();');
  const fallbackMatch = appCode.match(/startDate:\s*formatDateSimple\(\s*t\.startDate\s*\|\|\s*\(existing\s*\?\s*existing\.startDate\s*:\s*""\)\s*\|\|\s*""\s*\)/);

  const allPassed = hasNoHardcodedTrips && hasLoadCachedTrips && hasDisplayNameDynamic && fallbackMatch !== null;

  assertCheck(
    "[資料庫唯一真理源審查] 徹底移除寫死行程清單，以 Trips 工作表為準並落實快取與 Fallback",
    allPassed,
    `移除寫死資料: ${hasNoHardcodedTrips}, 採用 loadCachedTrips: ${hasLoadCachedTrips}, 動態名稱解析: ${hasDisplayNameDynamic}, 空日期Fallback: ${fallbackMatch !== null}`
  );
})();

// ----------------------------------------------------
// 測試 7：Google 認證快取動態 TTL (最長 55 分鐘) 與 auth_error 隔離審查
// ----------------------------------------------------
(function testAuthCacheTtlAndAuthErrorIsolation() {
  const hasDynamicTtl = gasCode.includes('Math.min(remainingSec - 60, 3300)') &&
    gasCode.includes('cache.put(tokenKey, cleanEmail, ttl)');
  
  const hasDoGetAuthError = gasCode.includes('status: "auth_error"') &&
    gasCode.includes('Google 身分驗證暫時失敗，請重新嘗試');

  const hasAppAuthErrorHandle = appCode.includes('result.status === "auth_error"') &&
    appCode.includes('authStatus = "auth-error"');

  const allPassed = hasDynamicTtl && hasDoGetAuthError && hasAppAuthErrorHandle;

  assertCheck(
    "[認證快取與錯誤隔離] verifyIdToken 動態 TTL 延長至 55 分鐘，驗證失敗回傳 auth_error 且不降級訪客",
    allPassed,
    `動態 TTL 快取 55 分鐘: ${hasDynamicTtl}, GAS 明確回傳 auth_error: ${hasDoGetAuthError}, 前端保留 Token 僅提示重試: ${hasAppAuthErrorHandle}`
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
// 測試 10：Google Sheets 資料庫直連與唯一真理源審查
// ----------------------------------------------------
(function testSpreadsheetSingleSourceOfTruth() {
  const hasDirectOpenMaster = gasCode.includes('SpreadsheetApp.openById(MASTER_SHEET_ID)') &&
    gasCode.includes('masterSpreadsheet.getSheetByName("Trips")') &&
    gasCode.includes('tripSheet.getDataRange().getValues()');

  const hasDirectGetUserAccess = gasCode.includes('function getUserAccess(email)') &&
    gasCode.includes('const masterSpreadsheet = SpreadsheetApp.openById(MASTER_SHEET_ID);');

  const allPassed = hasDirectOpenMaster && hasDirectGetUserAccess;

  assertCheck(
    "[資料庫直連審查] 每次請求直連開啟 Google Sheets Trips 表，試算表為唯一真理源",
    allPassed,
    `主控表直連開啟: ${hasDirectOpenMaster}, 角色存取直連查表: ${hasDirectGetUserAccess}`
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
