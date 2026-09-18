/**
 * trip-state.js - 旅遊手冊狀態管理與核心門禁模組
 * 雙模支援：同時供瀏覽器端 (window.TripState) 與 Node.js 自動化測試共用
 * 版本：20260918_13
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    // Node.js CommonJS
    module.exports = factory();
  } else {
    // Browser 全域物件
    const exports = factory();
    root.TripState = exports;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  // 1. 跨行程確認快照字典：以 tripUuid 進行物理隔離，防止跨行程非同步覆蓋 (例如岡山覆蓋奧捷)
  const confirmedSnapshots = new Map();

  // 2. 記憶體專屬已解鎖 PIN 映射表：不存入 LocalStorage，分頁關閉即失效
  const memoryUnlockedPins = new Map();

  // 3. 記憶體專屬行程權限表：以行程 UUID 記錄後端簽發的 canEdit
  const tripPermissions = new Map();

  // 安全深拷貝輔助函式
  function deepClone(obj) {
    if (!obj) return obj;
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch (e) {
      console.error("深拷貝異常:", e);
      return obj;
    }
  }

  // 安全跳脫 HTML 屬性 (防止雙引號、單引號穿透屬性邊界或產生 XSS)
  function escapeAttribute(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // 安全跳脫 HTML 標籤內容 (防止 script/iframe 等惡意標籤注入)
  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // 協議安全校驗：驗證合法白名單 (http/https/data/blob/mailto/相對路徑)，回傳原始乾淨 URL，不混入 HTML 轉義
  function sanitizeUrl(url) {
    if (!url) return "";
    const trimmed = String(url).trim();
    if (/^(https?:\/\/|data:image\/|blob:|\/|mailto:|\.\/)/i.test(trimmed)) {
      return trimmed;
    }
    return "#";
  }

  // 統一更新確認快照與 Session 快取 (僅限經雲端確認成功或初次合法載入時調用)
  function updateConfirmedSnapshot(uuid, data, storageEngine) {
    if (!uuid || !data) return;
    const storage = storageEngine || (typeof sessionStorage !== "undefined" ? sessionStorage : null);
    try {
      const cloned = deepClone(data);
      confirmedSnapshots.set(uuid, cloned);
      if (storage && typeof storage.setItem === "function") {
        storage.setItem("session_trip_" + uuid, JSON.stringify(cloned));
      }
    } catch (e) {
      console.warn("更新確認快照失敗:", e);
    }
  }

  // 失敗精準回滾函式：依 uuid 取出快照，若使用者仍在該行程則還原記憶體，並同步修復 Session 避免髒資料
  function rollbackTripState(uuid, currentUuid, storageEngine, onRestoreCallback) {
    if (!uuid) return null;
    const storage = storageEngine || (typeof sessionStorage !== "undefined" ? sessionStorage : null);
    try {
      const confirmed = confirmedSnapshots.get(uuid);
      if (confirmed) {
        const cloned = deepClone(confirmed);
        // 若當前使用者仍停留在此行程，觸發還原回呼
        if (currentUuid === uuid && typeof onRestoreCallback === "function") {
          onRestoreCallback(cloned);
        }
        // 同步覆蓋 Session 快取，防止重新整理後讀到未成功的修改版
        if (storage && typeof storage.setItem === "function") {
          storage.setItem("session_trip_" + uuid, JSON.stringify(confirmed));
        }
        return cloned;
      }
    } catch (err) {
      console.error("回滾行程快照失敗:", err);
    }
    return null;
  }

  // 標準門禁校驗函式：適配 pageshow, visibilitychange, showTripView 等所有門禁點
  function isTripUnlocked(tripUuid, tripHasPassword, userRole, idToken, isTokenExpired) {
    if (!tripUuid) return true;

    // A. 管理員尊榮特權：持有有效 Token 直接放行
    if (userRole === "admin" && idToken && !isTokenExpired) return true;

    // B. 授權成員特權：後端授權 canEdit 者直接免 PIN 放行
    const perm = tripPermissions.get(tripUuid);
    if (perm && perm.canEdit && idToken && !isTokenExpired) return true;

    // C. 若未設密碼 (布林 false、空字串、null、undefined) 則直接放行，絕不誤鎖
    if (!tripHasPassword) return true;

    // D. 訪客模式：必須在當前記憶體中持有已驗證的 PIN
    return memoryUnlockedPins.has(tripUuid);
  }

  return {
    confirmedSnapshots,
    memoryUnlockedPins,
    tripPermissions,
    deepClone,
    escapeAttribute,
    escapeHtml,
    sanitizeUrl,
    updateConfirmedSnapshot,
    rollbackTripState,
    isTripUnlocked,
  };
});
