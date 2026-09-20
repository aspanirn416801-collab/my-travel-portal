// =========================================================================
// Google Apps Script 後端程式碼
// 部署時請選擇：網頁應用程式 (Web App)
// 執行身分：我 (Me - 管理員的帳號)
// 誰有權限存取：任何人 (Anyone)
// =========================================================================

// 請貼上您在第一步建立的「主控試算表 (Master Sheet)」的 ID
const MASTER_SHEET_ID = "YOUR_MASTER_SHEET_ID_HERE";

// 請填寫您的 Google Client ID (用於防止 GIS Token 偽造/跨應用替換)
const GOOGLE_CLIENT_ID = "1097668023463-ibj8qn5c98mhviggncl5a9m3t7dmjc45.apps.googleusercontent.com";

// Firebase 專案配置 (用於 Firebase ID Token 驗證)
const FIREBASE_API_KEY = "AIzaSyCx2E_CGqqd0j6xtMSDYeWbdpXPZcReKLM";
const FIREBASE_PROJECT_ID = "my-travel-portal-1d647";

// 雲端硬碟總資料夾名稱（當建立新行程且未指定 ID 時，所有行程資料夾與手冊將自動歸檔於此路徑下）
const ROOT_TRAVEL_FOLDER_NAME = "my-travels";

// 輔助函式：取得或建立雲端硬碟根目錄下的指定資料夾 (加入防呆預設值)
function getOrCreateRootFolder(folderName) {
  const name = folderName || ROOT_TRAVEL_FOLDER_NAME || "my-travels";
  const folders = DriveApp.getFoldersByName(name);
  if (folders.hasNext()) {
    return folders.next();
  }
  return DriveApp.createFolder(name);
}

// 輔助函式：標準化 Email（清除前後空白、不可見特殊字元、零寬空格與 BOM）
function normalizeEmail(email) {
  if (!email) return "";
  return email.toString().toLowerCase().replace(/[\u200B-\u200D\uFEFF\u00A0\s]/g, "");
}

// 產生安全 Token 雜湊鍵 (避免將完整憑證直接當作快取鍵)
function hashToken(token) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token);
  return digest.map(function(byte) {
    var v = (byte < 0 ? byte + 256 : byte).toString(16);
    return v.length === 1 ? "0" + v : v;
  }).join("");
}

let lastAuthErrorReason = "";

// 輔助函式：未驗證解析 Token Payload Claims (僅用於驗證器路由派發，絕不據此授權！)
function peekTokenClaims(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) { b64 += "="; }
    let decodedStr = "";
    if (typeof Utilities !== "undefined" && Utilities.base64Decode) {
      decodedStr = Utilities.newBlob(Utilities.base64Decode(b64)).getDataAsString("UTF-8");
    } else if (typeof Buffer !== "undefined") {
      decodedStr = Buffer.from(b64, "base64").toString("utf8");
    }
    const payload = JSON.parse(decodedStr);
    return {
      iss: payload.iss || "",
      exp: Number(payload.exp) || 0,
      aud: payload.aud || ""
    };
  } catch (e) {
    return null;
  }
}

// 核心雙軌驗證器：基於 iss 嚴格路由分流，選定後失敗即阻斷拒絕，絕不交叉嘗試！
function verifyIdToken(token) {
  lastAuthErrorReason = "";
  if (!token) {
    lastAuthErrorReason = "未收到 Token";
    return null;
  }

  // 1. 優先查詢伺服器快取 (綁定完整 Token SHA-256 雜湊，且快取命中仍須檢核到期時間)
  const tokenKey = "auth_" + hashToken(token);
  const cache = CacheService.getScriptCache();
  const cachedDataStr = cache.get(tokenKey);
  if (cachedDataStr) {
    try {
      const cached = JSON.parse(cachedDataStr);
      const nowSec = Math.floor(Date.now() / 1000);
      if (cached && cached.email && cached.exp && nowSec < cached.exp) {
        return cached.email;
      } else {
        cache.remove(tokenKey);
      }
    } catch (e) {
      cache.remove(tokenKey);
    }
  }

  // 2. 解析未驗證 claims (僅作路由依據，絕不授權)
  const claims = peekTokenClaims(token);
  if (!claims || !claims.iss) {
    lastAuthErrorReason = "Token 格式無效或無法解析 iss";
    return null;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (claims.exp && nowSec >= claims.exp) {
    lastAuthErrorReason = "Token 已超過宣告之到期時間 (Expired)";
    return null;
  }

  // 3. 嚴格路由分流
  const expectedFirebaseIss = "https://securetoken.google.com/" + FIREBASE_PROJECT_ID;
  if (claims.iss === expectedFirebaseIss) {
    // 路由 A：Firebase Auth 專用驗證器（選定後若失敗直接拒絕，絕不嘗試 GIS）
    return verifyFirebaseToken(token, claims.exp, tokenKey);
  } else if (claims.iss === "accounts.google.com" || claims.iss === "https://accounts.google.com") {
    // 路由 B：Google GIS 專用驗證器（選定後若失敗直接拒絕，絕不嘗試 Firebase）
    return verifyGisToken(token, claims.exp, tokenKey);
  } else {
    lastAuthErrorReason = "不支援的 Token 發行方 (iss): " + claims.iss;
    return null;
  }
}

// 專用驗證器 A：Firebase accounts:lookup (驗證簽章與發行專案)
function verifyFirebaseToken(token, exp, tokenKey) {
  try {
    const url = "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + encodeURIComponent(FIREBASE_API_KEY);
    const payload = JSON.stringify({ idToken: token });
    const response = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: payload,
      muteHttpExceptions: true
    });

    const respCode = response.getResponseCode();
    const respText = response.getContentText();

    if (respCode === 200) {
      const json = JSON.parse(respText);
      if (json && Array.isArray(json.users) && json.users.length > 0) {
        const user = json.users[0];
        if (user && user.email) {
          const cleanEmail = normalizeEmail(user.email);
          const nowSec = Math.floor(Date.now() / 1000);
          const remainingSec = Math.floor(exp) - nowSec;
          if (remainingSec > 60) {
            const ttl = Math.floor(Math.min(remainingSec - 60, 1800));
            try {
              const cache = CacheService.getScriptCache();
              cache.put(tokenKey, JSON.stringify({ email: cleanEmail, exp: exp }), ttl);
            } catch (cErr) {}
          }
          return cleanEmail;
        } else {
          lastAuthErrorReason = "Firebase 回傳無 email 欄位";
        }
      } else {
        lastAuthErrorReason = "Firebase 回傳 users 清單為空: " + respText;
      }
    } else {
      lastAuthErrorReason = "Firebase HTTP " + respCode + ": " + respText;
    }
  } catch (e) {
    lastAuthErrorReason = "Firebase 驗證異常: " + e.message;
  }
  return null;
}

// 專用驗證器 B：Google OAuth2 Tokeninfo (驗證 GIS 舊版簽章與 Client ID 受眾)
function verifyGisToken(token, exp, tokenKey) {
  try {
    const url = "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token);
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });

    const respCode = response.getResponseCode();
    const respText = response.getContentText();

    if (respCode === 200) {
      const json = JSON.parse(respText);
      // 嚴格核對受眾 (aud)
      if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_ID !== "YOUR_GOOGLE_CLIENT_ID_HERE") {
        if (json.aud !== GOOGLE_CLIENT_ID) {
          lastAuthErrorReason = "GIS Token 受眾 (aud) 不匹配，拒絕存取 (預期: " + GOOGLE_CLIENT_ID + "，實際: " + json.aud + ")";
          Logger.log(lastAuthErrorReason);
          return null;
        }
      }
      if (json.email) {
        const cleanEmail = normalizeEmail(json.email);
        const nowSec = Math.floor(Date.now() / 1000);
        const remainingSec = Math.floor(exp) - nowSec;
        if (remainingSec > 60) {
          const ttl = Math.floor(Math.min(remainingSec - 60, 1800));
          try {
            const cache = CacheService.getScriptCache();
            cache.put(tokenKey, JSON.stringify({ email: cleanEmail, exp: exp }), ttl);
          } catch (cErr) {}
        }
        return cleanEmail;
      } else {
        lastAuthErrorReason = "GIS Token 回傳無 email 欄位";
      }
    } else {
      lastAuthErrorReason = "GIS Tokeninfo HTTP " + respCode + ": " + respText;
    }
  } catch (e) {
    lastAuthErrorReason = "GIS 驗證異常: " + e.message;
  }
  return null;
}

// =========================================================================
// 核心快取服務與權限版本控制 (CacheService + ScriptProperties + LockService)
// =========================================================================

// 取得當前權限版本號 (持久化於 ScriptProperties)
function getAccessRevision() {
  try {
    const props = PropertiesService.getScriptProperties();
    return props.getProperty("ACCESS_REVISION") || "1";
  } catch (e) {
    return "1";
  }
}

// 遞增權限版本號 (LockService 併發保護，最長等待 10 秒)
function bumpAccessRevision() {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const props = PropertiesService.getScriptProperties();
    const current = Number(props.getProperty("ACCESS_REVISION") || "1");
    props.setProperty("ACCESS_REVISION", String(current + 1));
  } catch (e) {
    Logger.log("遞增權限版本號失敗: " + e);
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// 安全寫入 CacheService (90KB 上限保護，保留試算表備援)
function safePutCache(key, data, ttlSeconds) {
  if (!key || !data) return false;
  try {
    const serialized = JSON.stringify(data);
    const bytes = Utilities.newBlob(serialized).getBytes().length;
    if (bytes < 90000) {
      const cache = CacheService.getScriptCache();
      cache.put(key, serialized, ttlSeconds || 300);
      return true;
    } else {
      Logger.log("快取項目超過 90KB (" + bytes + " bytes)，安全略過 CacheService: " + key);
      return false;
    }
  } catch (e) {
    Logger.log("寫入快取異常: " + e);
    return false;
  }
}

// 安全讀取 CacheService (含 JSON 解析錯誤自動清除降級)
function safeGetCache(key) {
  if (!key) return null;
  try {
    const cache = CacheService.getScriptCache();
    const cached = cache.get(key);
    if (!cached) return null;
    try {
      return JSON.parse(cached);
    } catch (parseErr) {
      cache.remove(key);
      return null;
    }
  } catch (e) {
    return null;
  }
}

// 快取失效管理：各端點寫入成功後精準調用 (累加執行，絕不用互斥 else if)
function invalidateCaches(options) {
  const opts = options || {};
  const cache = CacheService.getScriptCache();
  if (opts.clearPublicTrips) {
    try { cache.remove("public_trips_v1"); } catch (e) {}
  }
  if (opts.clearTripUuid) {
    try {
      cache.remove("trip_meta_" + opts.clearTripUuid);
      cache.remove("trip_content_" + opts.clearTripUuid);
    } catch (e) {}
  }
  if (opts.bumpAccessRev) {
    bumpAccessRevision();
  }
}

// 輔助函式：標準化試算表讀出之日期為 YYYY-MM-DD 格式 (支援眼見純字串、Date物件、斜線與ISO字串)
function normalizeDateStr(val) {
  if (!val) return "";
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, "0");
    const d = String(val.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(val).trim();
  if (!s) return "";
  // 1. 若已經是標準 YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // 2. 若是斜線 YYYY/MM/DD 或 YYYY/M/D，標準化為 YYYY-MM-DD
  const slashMatch = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (slashMatch) {
    const y = slashMatch[1];
    const m = slashMatch[2].padStart(2, "0");
    const d = slashMatch[3].padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  // 3. 若是帶 T 的 ISO 格式 (例如 2027-08-05T...)
  if (s.includes("T")) return s.split("T")[0].trim();
  // 4. 若為長日期格式，嘗試解析
  try {
    const parsed = new Date(s);
    if (!isNaN(parsed.getTime())) {
      const y = parsed.getFullYear();
      const m = String(parsed.getMonth() + 1).padStart(2, "0");
      const d = String(parsed.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
  } catch (e) {}
  return s;
}

// 自動根據出發與結束日期推算天數晚數 (例如: 8天7夜)
function calcTripDurationInGas(startDate, endDate) {
  const s = normalizeDateStr(startDate);
  const e = normalizeDateStr(endDate);
  if (!s || !e) return "";
  try {
    const d1 = new Date(s + "T00:00:00");
    const d2 = new Date(e + "T00:00:00");
    if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return "";
    const diffDays = Math.round((d2.getTime() - d1.getTime()) / 86400000) + 1;
    if (diffDays > 0) {
      const nights = diffDays - 1;
      return diffDays + "天" + (nights > 0 ? nights + "夜" : "");
    }
  } catch (err) {}
  return "";
}

// 取得使用者角色與可存取行程列表
function getUserAccess(email) {
  const masterSpreadsheet = SpreadsheetApp.openById(MASTER_SHEET_ID);
  const cleanEmail = normalizeEmail(email);
  const allowedTrips = [];
  
  let isAdmin = false;

  // A. 最高管理員保護：若使用者帳號與此 GAS 應用程式部署者/擁有者本人一致，100% 給予管理員權限
  try {
    const ownerEmail = normalizeEmail(Session.getEffectiveUser().getEmail());
    if (cleanEmail && ownerEmail && cleanEmail === ownerEmail) {
      isAdmin = true;
    }
  } catch (e) {
    Logger.log("檢查部署者 Email 失敗: " + e.message);
  }

  // B. 檢查主控表「Admins」分頁
  if (!isAdmin) {
    let adminSheet = masterSpreadsheet.getSheetByName("Admins");
    if (!adminSheet) {
      const allSheets = masterSpreadsheet.getSheets();
      for (let s of allSheets) {
        const sName = s.getName().toLowerCase().replace(/[\s_]/g, "");
        if (sName === "admins" || sName === "admin" || sName === "管理員" || sName === "管理者") {
          adminSheet = s;
          break;
        }
      }
    }

    if (adminSheet) {
      const adminRows = adminSheet.getDataRange().getValues();
      for (let i = 0; i < adminRows.length; i++) {
        // 搜尋整列所有欄位，防止使用者將 Email 貼在第 B 欄或其他位置
        for (let col = 0; col < adminRows[i].length; col++) {
          const rowEmail = normalizeEmail(adminRows[i][col]);
          if (rowEmail && rowEmail === cleanEmail) {
            isAdmin = true;
            break;
          }
        }
        if (isAdmin) break;
      }
    }
  }
  
  // 2. 檢索可存取行程 (關鍵：全面改用 getDisplayValues 眼見即所得，100% 回傳人類肉眼看到的純字串，杜絕 Date 物件時區問題！)
  const tripSheet = masterSpreadsheet.getSheetByName("Trips");
  const tripRows = tripSheet.getDataRange().getDisplayValues();
  for (let i = 1; i < tripRows.length; i++) {
    const uuid = tripRows[i][0];
    const name = tripRows[i][1];
    const sheetId = tripRows[i][2];
    const folderId = tripRows[i][3];
    const allowedUsersStr = tripRows[i][4] || "";
    
    if (!uuid) continue;
    
    const password = tripRows[i][5] ? String(tripRows[i][5]).trim() : "";
    const startDate = tripRows[i][6] ? String(tripRows[i][6]).trim() : "";
    const endDate = tripRows[i][7] ? String(tripRows[i][7]).trim() : "";
    let duration = tripRows[i][8] ? String(tripRows[i][8]).trim() : "";
    if (!duration && startDate && endDate) {
      duration = calcTripDurationInGas(startDate, endDate);
    }

    // 如果是管理員，可以看到所有行程並可編輯
    // 如果是一般人，檢查其 Email 是否在 allowedUsersStr 清單內
    if (isAdmin) {
      allowedTrips.push({ 
        uuid: uuid, 
        name: name, 
        sheet_id: sheetId, 
        folder_id: folderId, 
        allowed_users: allowedUsersStr, 
        hasPassword: Boolean(password),
        canEdit: true,
        startDate: startDate,
        endDate: endDate,
        duration: duration
      });
    } else {
      const allowedEmails = allowedUsersStr.toLowerCase().split(",").map(e => normalizeEmail(e));
      const isMember = Boolean(cleanEmail && allowedEmails.includes(cleanEmail));
      // 所有行程均公開大廳卡片摘要（所有人可見），手冊閱讀權限由 PIN 或成員登入嚴格把關
      allowedTrips.push({ 
        uuid: uuid, 
        name: name, 
        hasPassword: Boolean(password),
        canEdit: isMember,
        startDate: startDate,
        endDate: endDate,
        duration: duration
      });
    }
  }
  
  return {
    role: isAdmin ? "admin" : (cleanEmail ? "user" : "guest"),
    trips: allowedTrips
  };
}

// 處理 GET 請求 (支援已登入管理員/團員，以及未登入訪客唯讀瀏覽)
function doGet(e) {
  try {
    if (!e || !e.parameter) {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "缺少請求參數" }))
                           .setMimeType(ContentService.MimeType.JSON);
    }
    const action = e.parameter.action;
    const authHeader = e.parameter.token || "";
    let token = authHeader;

    // =========================================================================
    // 快取前置檢查 (CacheService 前置於 SpreadsheetApp.openById 之前)
    // =========================================================================

    // 1. 訪客公開大廳端點 (getTrips 且無 Token)：
    // 快取命中時直接回傳，避免執行 SpreadsheetApp.openById()！實際速度依 GAS 冷啟動及網路狀態而異。
    if (action === "getTrips" && !token) {
      const cachedPublic = safeGetCache("public_trips_v1");
      if (cachedPublic) {
        return ContentService.createTextOutput(JSON.stringify({
          status: "success",
          role: "guest",
          trips: cachedPublic
        })).setMimeType(ContentService.MimeType.JSON);
      }
    }

    // 身份驗證：未提供 token 視為訪客；若有附帶 token 卻驗證失敗，絕不降級為訪客，明確回傳 auth_error！
    let email = null;
    if (token) {
      email = verifyIdToken(token);
      if (!email) {
        return ContentService.createTextOutput(JSON.stringify({
          status: "auth_error",
          message: "Google 身分驗證暫時失敗，請重新嘗試"
        })).setMimeType(ContentService.MimeType.JSON);
      }
    }

    // 2. 已驗證帳號之權限快取檢查 (以 Email 雜湊與當前 ACCESS_REVISION 進行版本隔離)
    let access = null;
    if (email) {
      const accessCacheKey = "access_" + hashToken(email) + "_" + getAccessRevision();
      const cachedAccess = safeGetCache(accessCacheKey);
      if (cachedAccess) {
        access = cachedAccess;
        // 若 action 為 getTrips 且權限快取命中，直接回傳，無需開表！
        if (action === "getTrips") {
          return ContentService.createTextOutput(JSON.stringify({
            status: "success",
            role: access.role,
            trips: access.trips
          })).setMimeType(ContentService.MimeType.JSON);
        }
      }
    }

    // 3. Cache Miss 時才開啟主控試算表 (延遲載入)
    const masterSpreadsheet = SpreadsheetApp.openById(MASTER_SHEET_ID);
  const tripSheet = masterSpreadsheet.getSheetByName("Trips");
  const tripRows = tripSheet.getDataRange().getDisplayValues();
  
  if (email) {
    if (!access) {
      access = getUserAccess(email);
      // 成功讀取後安全存入權限快取 (綁定 accessRevision)
      const accessCacheKey = "access_" + hashToken(email) + "_" + getAccessRevision();
      safePutCache(accessCacheKey, access, 300);
    }
  } else {
    // 訪客模式：讀取所有行程之公開摘要（絕不包含密碼與內部試算表 ID）
    const publicTrips = [];
    for (let i = 1; i < tripRows.length; i++) {
      const uuid = tripRows[i][0];
      const name = tripRows[i][1];
      const password = tripRows[i][5] ? String(tripRows[i][5]).trim() : "";
      const startDate = normalizeDateStr(tripRows[i][6]);
      const endDate = normalizeDateStr(tripRows[i][7]);
      let duration = tripRows[i][8] ? String(tripRows[i][8]).trim() : "";
      if (!duration && startDate && endDate) {
        duration = calcTripDurationInGas(startDate, endDate);
      }
      if (uuid) {
        publicTrips.push({
          uuid: uuid,
          name: name,
          hasPassword: Boolean(password),
          canEdit: false,
          startDate: startDate,
          endDate: endDate,
          duration: duration
        });
      }
    }
    access = { role: "guest", trips: publicTrips };
    // 成功讀取後安全存入公開行程快取 (時效 600 秒)
    safePutCache("public_trips_v1", publicTrips, 600);
  }
  
  // 一次性初始化合併端點：整合角色、行程清單與目前手冊資料，解決冷啟動兩段式等待過長問題
  if (action === "bootstrap") {
    const tripUuid = e.parameter.tripUuid;
    let currentTripData = null;
    let canEditCurrent = false;

    if (tripUuid) {
      let targetSheetId = "";
      let allowedUsersStr = "";
      let tripPassword = "";
      let tripName = "";
      let tripStartDate = "";
      let tripEndDate = "";
      let tripDuration = "";

      for (let i = 1; i < tripRows.length; i++) {
        if (tripRows[i][0] === tripUuid) {
          tripName = tripRows[i][1];
          targetSheetId = tripRows[i][2];
          allowedUsersStr = tripRows[i][4] || "";
          tripPassword = tripRows[i][5] ? String(tripRows[i][5]).trim() : "";
          tripStartDate = normalizeDateStr(tripRows[i][6]);
          tripEndDate = normalizeDateStr(tripRows[i][7]);
          tripDuration = tripRows[i][8] ? String(tripRows[i][8]).trim() : "";
          break;
        }
      }

      if (targetSheetId) {
        const allowedList = (allowedUsersStr || "").toLowerCase().split(",").map(s => normalizeEmail(s));
        const isMember = Boolean(email && allowedList.includes(normalizeEmail(email)));
        const isAdmin = access.role === "admin";
        canEditCurrent = Boolean(isAdmin || isMember);

        const clientPin = String(e.parameter.tripPassword || e.parameter.password || "").trim();
        const hasValidPin = Boolean(tripPassword && clientPin === tripPassword);
        const isPublicWithoutPin = !tripPassword;

        if (isAdmin || isMember || hasValidPin || isPublicWithoutPin) {
          try {
            // 優先檢查手冊純內容快取
            let data = safeGetCache("trip_content_" + tripUuid);
            if (!data) {
              data = loadTripDetails(targetSheetId);
              if (!data.name && tripName) data.name = tripName;
              if (!data.startDate && tripStartDate) data.startDate = tripStartDate;
              if (!data.endDate && tripEndDate) data.endDate = tripEndDate;
              if (!data.duration && tripDuration) data.duration = tripDuration;
              if (!data.duration && data.startDate && data.endDate) {
                data.duration = calcTripDurationInGas(data.startDate, data.endDate);
              }
              delete data.password;
              delete data.allowed_users;
              delete data.sheet_id;
              delete data.folder_id;
              // 成功讀取後安全存入手冊快取 (檢查 < 90KB)
              safePutCache("trip_content_" + tripUuid, data, 300);
            }
            currentTripData = data;
          } catch (loadErr) {}
        }
      }
    }

    const responseData = {
      status: "success",
      role: access.role,
      trips: access.trips,
      currentTrip: currentTripData,
      canEdit: canEditCurrent
    };
    return ContentService.createTextOutput(JSON.stringify(responseData))
                         .setMimeType(ContentService.MimeType.JSON);
  }

  if (action === "getTrips") {
    const responseData = {
      status: "success",
      role: access.role,
      trips: access.trips
    };
    return ContentService.createTextOutput(JSON.stringify(responseData))
                         .setMimeType(ContentService.MimeType.JSON);
  }

  // 管理員專用端點：讀取指定行程之完整管理 Meta (包含原 PIN、授權成員名單、試算表與資料夾 ID)
  if (action === "getTripMeta") {
    if (access.role !== "admin") {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Admin privileges required" }))
                           .setMimeType(ContentService.MimeType.JSON);
    }
    const tripUuid = e.parameter.tripUuid;
    let foundTrip = null;
    for (let i = 1; i < tripRows.length; i++) {
      if (tripRows[i][0] === tripUuid) {
        const password = tripRows[i][5] ? String(tripRows[i][5]).trim() : "";
        const startDate = normalizeDateStr(tripRows[i][6]);
        const endDate = normalizeDateStr(tripRows[i][7]);
        let duration = tripRows[i][8] ? String(tripRows[i][8]).trim() : "";
        if (!duration && startDate && endDate) {
          duration = calcTripDurationInGas(startDate, endDate);
        }
        let themeVal = "";
        try {
          if (tripRows[i][2]) {
            const subSs = SpreadsheetApp.openById(tripRows[i][2]);
            const infoSheet = subSs.getSheetByName("Info");
            if (infoSheet) {
              const infoData = infoSheet.getDataRange().getValues();
              for (let r = 0; r < infoData.length; r++) {
                if (String(infoData[r][0]).trim().toLowerCase() === "theme") {
                  themeVal = String(infoData[r][1] || "").trim();
                  break;
                }
              }
            }
          }
        } catch (e) {}

        foundTrip = {
          uuid: tripRows[i][0],
          name: tripRows[i][1],
          sheet_id: tripRows[i][2],
          folder_id: tripRows[i][3],
          allowed_users: tripRows[i][4] || "",
          password: password,
          hasPassword: Boolean(password),
          startDate: startDate,
          endDate: endDate,
          duration: duration,
          theme: themeVal
        };
        break;
      }
    }
    if (foundTrip) {
      return ContentService.createTextOutput(JSON.stringify({ status: "success", trip: foundTrip }))
                           .setMimeType(ContentService.MimeType.JSON);
    } else {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Trip not found" }))
                           .setMimeType(ContentService.MimeType.JSON);
    }
  }
  
  if (action === "getTripData") {
    const tripUuid = e.parameter.tripUuid;
    let targetSheetId = "";
    let allowedUsersStr = "";
    let tripPassword = "";
    let tripName = "";
    let tripStartDate = "";
    let tripEndDate = "";
    let tripDuration = "";
    
    // 搜尋對應的 Sheet ID、授權名單與專屬密碼及 Meta
    for (let i = 1; i < tripRows.length; i++) {
      if (tripRows[i][0] === tripUuid) {
        tripName = tripRows[i][1];
        targetSheetId = tripRows[i][2];
        allowedUsersStr = tripRows[i][4] || "";
        tripPassword = tripRows[i][5] ? String(tripRows[i][5]).trim() : "";
        tripStartDate = normalizeDateStr(tripRows[i][6]);
        tripEndDate = normalizeDateStr(tripRows[i][7]);
        tripDuration = tripRows[i][8] ? String(tripRows[i][8]).trim() : "";
        break;
      }
    }
    
    if (!targetSheetId) {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "找不到該行程專屬試算表" }))
                           .setMimeType(ContentService.MimeType.JSON);
    }
    
    // 權限檢查：閱讀手冊門禁判定（PIN 與成員名單解耦）
    const allowedList = (allowedUsersStr || "").toLowerCase().split(",").map(s => normalizeEmail(s));
    const isMember = Boolean(email && allowedList.includes(normalizeEmail(email)));
    const isAdmin = access.role === "admin";
    const canEdit = Boolean(isAdmin || isMember);

    const clientPin = String(e.parameter.tripPassword || e.parameter.password || "").trim();
    const hasValidPin = Boolean(tripPassword && clientPin === tripPassword);
    const isPublicWithoutPin = !tripPassword;

    // 門禁校驗：管理員、成員、正確 PIN、或未設 PIN 的行程放行閱讀手冊
    if (!isAdmin && !isMember && !hasValidPin && !isPublicWithoutPin) {
      return ContentService.createTextOutput(JSON.stringify({
        status: "locked",
        uuid: tripUuid,
        name: tripName,
        hasPassword: true,
        canEdit: false,
        message: "此旅程設有專屬密碼保護，請輸入密碼以解鎖手冊內容。"
      })).setMimeType(ContentService.MimeType.JSON);
    }
    
    // 讀取該旅遊專屬試算表的資料
    try {
      const data = loadTripDetails(targetSheetId);
      // 雙向防呆對齊：若子表 Info 的 Name、日期或天數為空，自動以 Trips 總表登記資料作為強健備援
      if (!data.name && tripName) data.name = tripName;
      if (!data.startDate && tripStartDate) data.startDate = tripStartDate;
      if (!data.endDate && tripEndDate) data.endDate = tripEndDate;
      if (!data.duration && tripDuration) data.duration = tripDuration;
      if (!data.duration && data.startDate && data.endDate) {
        data.duration = calcTripDurationInGas(data.startDate, data.endDate);
      }

      // 資安強化：一般手冊資料一律清除 password 及敏感試算表 ID，嚴禁外洩 PIN
      delete data.password;
      delete data.allowed_users;
      delete data.sheet_id;
      delete data.folder_id;

      return ContentService.createTextOutput(JSON.stringify({ 
        status: "success", 
        role: access.role, 
        canEdit: canEdit,
        data: data 
      })).setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "讀取資料庫失敗: " + err.message }))
                           .setMimeType(ContentService.MimeType.JSON);
    }
  }
  
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "無效的操作指令" }))
                         .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "後端讀取異常: " + err.message }))
                         .setMimeType(ContentService.MimeType.JSON);
  }
}

// 處理 POST 請求 (建立、修改、上傳)
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "缺少請求內文 (Empty payload)" }))
                           .setMimeType(ContentService.MimeType.JSON);
    }
    const postData = JSON.parse(e.postData.contents);
    const action = postData.action;
  
  // 取得 Authorization Token
  // 處理 headers 驗證
  // 由於 Google Web App 的限制，通常我們在 postData 中將 token 一併帶上，或在 headers 解析
  
  // 實作上以 client 發送的 JSON postData 中的 token 或手動驗證
  // 這裡假設驗證方式同 doGet
  
  // 安全性防禦：檢查呼叫者權限
  // 我們讓前端在 body 中附帶 token 進行驗證
  const token = postData.token;
  const email = verifyIdToken(token);
  if (!email) {
    return ContentService.createTextOutput(JSON.stringify({ status: "auth_error", message: "Google 身分驗證暫時失敗，請重新嘗試" }))
                         .setMimeType(ContentService.MimeType.JSON);
  }
  
  const access = getUserAccess(email);
  const isAdmin = access.role === "admin";
  
  const masterSpreadsheet = SpreadsheetApp.openById(MASTER_SHEET_ID);
  const tripSheet = masterSpreadsheet.getSheetByName("Trips");
  const tripRows = tripSheet.getDataRange().getDisplayValues();

  // 1. 儲存/更新行程詳細旅遊資料（允許 admin 或被該行程授權的 member 編輯手冊內容）
  if (action === "updateTripData") {
    const tripUuid = postData.tripUuid;
    const data = postData.data;
    
    // 查詢該行程的試算表 ID 與授權成員清單
    let targetSheetId = "";
    let allowedUsersStr = "";
    for (let i = 1; i < tripRows.length; i++) {
      if (tripRows[i][0] === tripUuid) {
        targetSheetId = tripRows[i][2];
        allowedUsersStr = tripRows[i][4] || "";
        break;
      }
    }
    
    if (!targetSheetId) {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "找不到該行程試算表" }))
                           .setMimeType(ContentService.MimeType.JSON);
    }

    const allowedList = (allowedUsersStr || "").toLowerCase().split(",").map(s => normalizeEmail(s));
    const isMember = Boolean(email && allowedList.includes(normalizeEmail(email)));

    if (!isAdmin && !isMember) {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "您未被授權編輯此行程手冊" }))
                           .setMimeType(ContentService.MimeType.JSON);
    }

    if (isAdmin) {
      saveTripDetails(targetSheetId, data);
    } else {
      // 授權成員專屬儲存：完全不觸碰 Info/Meta 分頁，僅清洗並更新七類內容工作表
      saveTripContentOnly(targetSheetId, data);
    }

    // 快取失效：清除該行程手冊內容快取
    invalidateCaches({ clearTripUuid: tripUuid });

    return ContentService.createTextOutput(JSON.stringify({ status: "success", message: "Cloud sync success" }))
                         .setMimeType(ContentService.MimeType.JSON);
  }

  // 4. 上傳圖片到該行程的雲端硬碟 (允許 admin 或該行程授權 member 上傳)
  if (action === "uploadImage") {
    const tripUuid = postData.tripUuid;
    const filename = postData.filename;
    const mimeType = postData.mimeType;
    const base64Data = postData.data;
    
    let folderId = "";
    let allowedUsersStr = "";
    for (let i = 1; i < tripRows.length; i++) {
      if (tripRows[i][0] === tripUuid) {
        folderId = tripRows[i][3];
        allowedUsersStr = tripRows[i][4] || "";
        break;
      }
    }

    const allowedList = (allowedUsersStr || "").toLowerCase().split(",").map(s => normalizeEmail(s));
    const isMember = Boolean(email && allowedList.includes(normalizeEmail(email)));

    if (!isAdmin && !isMember) {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "您未被授權上傳照片至此行程" }))
                           .setMimeType(ContentService.MimeType.JSON);
    }
    
    if (folderId) {
      try {
        const folder = DriveApp.getFolderById(folderId);
        const decoded = Utilities.base64Decode(base64Data);
        const blob = Utilities.newBlob(decoded, mimeType, filename);
        const file = folder.createFile(blob);
        
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        const fileId = file.getId();
        const previewUrl = "https://lh3.googleusercontent.com/d/" + fileId;
        
        // 快取失效：清除該行程手冊內容快取
        invalidateCaches({ clearTripUuid: tripUuid });

        return ContentService.createTextOutput(JSON.stringify({ status: "success", url: previewUrl }))
                             .setMimeType(ContentService.MimeType.JSON);
      } catch (err) {
        return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Drive upload failed: " + err.message }))
                             .setMimeType(ContentService.MimeType.JSON);
      }
    } else {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Folder not found" }))
                           .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // 門禁保護：除 updateTripData 與 uploadImage 外，其餘行程管理操作 (createTrip, updateTripMeta) 嚴格僅限系統管理員！
  if (!isAdmin) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "此操作僅限系統管理員 (Admin privileges required)" }))
                         .setMimeType(ContentService.MimeType.JSON);
  }
  
  // 2. 建立新行程與初始化 (支援自動建立 Google 雲端硬碟資料夾與試算表)
  if (action === "createTrip") {
    const uuid = (postData.uuid || "").trim();
    const name = (postData.name || "").trim();

    if (!uuid || !name) {
      return ContentService.createTextOutput(JSON.stringify({
        status: "error",
        message: "缺少必要參數：行程識別碼 (UUID) 或名稱不能為空"
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // P2: 行程識別碼 (UUID) 防重複檢查（必須在建立任何 Drive 資料夾或試算表前執行，防止留下孤立垃圾檔案）
    for (let i = 1; i < tripRows.length; i++) {
      if (tripRows[i][0] === uuid) {
        return ContentService.createTextOutput(JSON.stringify({
          status: "error",
          message: "行程識別碼 (UUID)「" + uuid + "」已存在，請使用不同識別碼！"
        })).setMimeType(ContentService.MimeType.JSON);
      }
    }

    let sheetId = (postData.sheetId || "").trim();
    let folderId = (postData.folderId || "").trim();
    const allowedUsers = postData.allowedUsers || "";
    const startDate = postData.startDate || "";
    const endDate = postData.endDate || "";
    const duration = postData.duration || "";
    const theme = (postData.theme || "violet").trim();
    
    // 若 sheetId 或 folderId 為空，啟動全自動建立機制
    if (!sheetId || !folderId) {
      try {
        // 1. 取得或建立總目錄 my-travels
        const rootFolder = getOrCreateRootFolder(ROOT_TRAVEL_FOLDER_NAME);
        
        // 2. 在 my-travels 底下為該行程建立專屬主資料夾
        const tripFolder = rootFolder.createFolder(name);
        
        // 3. 若 folderId 為空，在行程資料夾內建立「景點照片與上傳檔案」相簿資料夾
        if (!folderId) {
          const photoFolder = tripFolder.createFolder("景點照片與上傳檔案");
          // 設定共享權限為「任何知道連結的人均可檢視」，避免圖片讀取 403
          photoFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
          folderId = photoFolder.getId();
        }
        
        // 4. 若 sheetId 為空，在行程資料夾內建立專屬試算表
        if (!sheetId) {
          const newSS = SpreadsheetApp.create(name + " - 行程手冊");
          sheetId = newSS.getId();
          
          // 將建立於根目錄的試算表檔案移入 tripFolder
          const file = DriveApp.getFileById(sheetId);
          tripFolder.addFile(file);
          DriveApp.getRootFolder().removeFile(file);
        }
      } catch (driveErr) {
        return ContentService.createTextOutput(JSON.stringify({
          status: "error",
          message: "自動在雲端硬碟建立資料夾或試算表失敗: " + driveErr.message
        })).setMimeType(ContentService.MimeType.JSON);
      }
    }
    
    const password = (postData.password || "").trim();

    let finalDuration = duration;
    if (!finalDuration && startDate && endDate) {
      finalDuration = calcTripDurationInGas(startDate, endDate);
    }
    
    // P2: 先確保關聯試算表結構與分頁初始化成功，最後才寫入 Trips 主表，防呆防孤立紀錄
    try {
      initializeSubSheet(sheetId, name, startDate, endDate, finalDuration, password, theme);
      const tripSheet = masterSpreadsheet.getSheetByName("Trips");
      tripSheet.appendRow([uuid, name, sheetId, folderId, allowedUsers, password, startDate, endDate, finalDuration]);

      // 快取失效：清除公開行程清單，並遞增權限版本號 (確保已登入者權限即時包含新行程)
      invalidateCaches({ clearPublicTrips: true, bumpAccessRev: true });

      return ContentService.createTextOutput(JSON.stringify({ 
        status: "success", 
        sheetId: sheetId,
        folderId: folderId,
        message: "行程建立成功！已自動在雲端硬碟「" + ROOT_TRAVEL_FOLDER_NAME + "/" + name + "」建立專屬資料夾與試算表手冊。" 
      })).setMimeType(ContentService.MimeType.JSON);
    } catch(err) {
      return ContentService.createTextOutput(JSON.stringify({ 
        status: "error", 
        message: "試算表初始化失敗: " + err.message 
      })).setMimeType(ContentService.MimeType.JSON);
    }
  }
  


  // 3. 修改行程基本設定（名稱、出發/結束日期、天數、主題色彩、授權名單，支援密碼防呆保護）
  if (action === "updateTripMeta") {
    const tripUuid = postData.tripUuid;
    const name = postData.name;
    const startDate = postData.startDate;
    const endDate = postData.endDate;
    const duration = postData.duration;
    const theme = postData.theme !== undefined ? String(postData.theme).trim() : null;
    const allowedUsers = postData.allowedUsers || "";
    
    // 密碼更新安全防呆：支援 passwordAction ("keep" | "set" | "remove")
    const passwordAction = postData.passwordAction || "";
    let newPasswordToSet = null;
    if (passwordAction === "remove") {
      newPasswordToSet = "";
    } else if (passwordAction === "set") {
      newPasswordToSet = postData.password !== undefined ? String(postData.password).trim() : "";
    } else if (postData.password !== undefined && String(postData.password).trim() !== "") {
      newPasswordToSet = String(postData.password).trim();
    }
    // 若為 "keep" 或未指定且未傳入非空密碼，newPasswordToSet 保持 null，保留原密碼不變！
    
    let targetSheetId = "";
    let targetRowIndex = -1;
    for (let i = 1; i < tripRows.length; i++) {
      if (tripRows[i][0] === tripUuid) {
        targetSheetId = tripRows[i][2];
        targetRowIndex = i + 1; // 1-based index
        break;
      }
    }
    
    if (targetRowIndex !== -1 && targetSheetId) {
      let finalDuration = duration;
      if (!finalDuration && startDate && endDate) {
        finalDuration = calcTripDurationInGas(startDate, endDate);
      }

      // 1. 更新主控表 Trips 分頁 (名稱、授權清單與密碼，以及出發日期、結束日期與天數)
      tripSheet.getRange(targetRowIndex, 2).setValue(name);
      tripSheet.getRange(targetRowIndex, 5).setValue(allowedUsers);
      if (newPasswordToSet !== null) {
        tripSheet.getRange(targetRowIndex, 6).setValue(newPasswordToSet);
      }
      if (startDate !== undefined) tripSheet.getRange(targetRowIndex, 7).setValue(startDate);
      if (endDate !== undefined) tripSheet.getRange(targetRowIndex, 8).setValue(endDate);
      if (finalDuration !== undefined) tripSheet.getRange(targetRowIndex, 9).setValue(finalDuration);
      
      // 2. 更新個別試算表 Info 分頁 (使用動態 Key-Value 寫入，徹底杜絕欄位錯位)
      try {
        const subSs = SpreadsheetApp.openById(targetSheetId);
        let infoSheet = subSs.getSheetByName("Info");
        if (!infoSheet) {
          infoSheet = subSs.insertSheet("Info");
          infoSheet.appendRow(["Key", "Value"]);
        }

        const metaMap = {
          "Name": name,
          "StartDate": startDate,
          "EndDate": endDate,
          "Duration": finalDuration
        };
        if (newPasswordToSet !== null) {
          metaMap["Password"] = newPasswordToSet;
        }
        if (theme !== null) {
          metaMap["Theme"] = theme;
        }
        setInfoSheetMap(infoSheet, metaMap);

        // 快取失效矩陣：累加判定執行，絕不用互斥 else if！
        let shouldClearPublic = false;
        let shouldClearTrip = false;
        let shouldBumpRev = false;

        // 1. 修改名稱、出發日期、結束日期、天數或主題色彩
        if (name !== undefined || startDate !== undefined || endDate !== undefined || duration !== undefined || theme !== null) {
          shouldClearPublic = true;
          shouldClearTrip = true; // 同步清除手冊內部頂部資料快取
        }

        // 2. 修改 PIN 密碼
        if (newPasswordToSet !== null) {
          shouldClearPublic = true;
          shouldClearTrip = true;
        }

        // 3. 修改成員名單
        if (allowedUsers !== undefined) {
          shouldClearTrip = true;
          shouldBumpRev = true; // 遞增 ACCESS_REVISION，舊成員權限快取立即失效
        }

        invalidateCaches({
          clearPublicTrips: shouldClearPublic,
          clearTripUuid: shouldClearTrip ? tripUuid : "",
          bumpAccessRev: shouldBumpRev
        });

        return ContentService.createTextOutput(JSON.stringify({ status: "success", message: "Trip meta updated successfully" }))
                             .setMimeType(ContentService.MimeType.JSON);
      } catch (err) {
        return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Failed to update sub sheet: " + err.message }))
                             .setMimeType(ContentService.MimeType.JSON);
      }
    } else {
      return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Trip not found" }))
                           .setMimeType(ContentService.MimeType.JSON);
    }
  }
  

  
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Action handler not found" }))
                         .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "後端處理失敗: " + err.message }))
                         .setMimeType(ContentService.MimeType.JSON);
  }
}

// 初始化關聯試算表結構 (遵循純白留空原則，建立標準欄位 Header，不預設硬編碼任何舊行程資料，徹底避免跨行程污染)
function initializeSubSheet(sheetId, tripName, startDate, endDate, duration, password, theme) {
  const ss = SpreadsheetApp.openById(sheetId);
  const effectiveName = tripName || "旅遊手冊";
  
  // 1. 基本資訊頁 (Info)
  let infoSheet = ss.getSheetByName("Info");
  if (!infoSheet) infoSheet = ss.insertSheet("Info");
  infoSheet.clear();
  infoSheet.appendRow(["Key", "Value"]);
  infoSheet.appendRow(["Name", effectiveName]);
  infoSheet.appendRow(["StartDate", startDate || ""]);
  infoSheet.appendRow(["EndDate", endDate || ""]);
  infoSheet.appendRow(["Duration", duration || ""]);
  infoSheet.appendRow(["Password", password || ""]);
  infoSheet.appendRow(["Theme", theme || ""]);
  
  // 2. 準備清單頁 (Checklist) - 保留最通用的出國準備基礎項，內容可自由編輯或增刪
  let checklistSheet = ss.getSheetByName("Checklist");
  if (!checklistSheet) checklistSheet = ss.insertSheet("Checklist");
  checklistSheet.clear();
  checklistSheet.appendRow(["id", "cat", "title", "note", "link", "done"]);
  checklistSheet.appendRow(["1", "證件", "護照與簽證", "出發前檢查效期需大於6個月", "", "FALSE"]);
  checklistSheet.appendRow(["2", "通訊", "網卡 / eSIM", "確認上網設定與開通日期", "", "FALSE"]);
  checklistSheet.appendRow(["3", "財務", "外幣與信用卡", "通知銀行開啟海外刷卡與提款", "", "FALSE"]);
  
  // 3. 航班與住宿 (Flights) - 純白留空：僅寫入標準欄位 Header，不預設任何航班
  let flightsSheet = ss.getSheetByName("Flights");
  if (!flightsSheet) flightsSheet = ss.insertSheet("Flights");
  flightsSheet.clear();
  flightsSheet.appendRow(["Type", "airline", "no", "from", "to", "date", "dep", "arr", "note"]);
  
  // 4. 飯店資訊 (Hotel) - 純白留空：僅寫入標準欄位 Header，不預設任何飯店
  let hotelSheet = ss.getSheetByName("Hotel");
  if (!hotelSheet) hotelSheet = ss.insertSheet("Hotel");
  hotelSheet.clear();
  hotelSheet.appendRow(["name", "addr", "checkin", "checkout", "nights", "note"]);
  
  // 5. 行程規劃 (Days) - 純白留空骨架：僅建立 Day 1 標題骨架，不預設任何景點或接駁資訊
  let daysSheet = ss.getSheetByName("Days");
  if (!daysSheet) daysSheet = ss.insertSheet("Days");
  daysSheet.clear();
  daysSheet.appendRow(["dayId", "date", "title", "time", "place", "desc", "imgUrl", "link"]);
  daysSheet.appendRow(["Day 1", startDate || "第一天", (tripName || "") + " 啟程日", "", "", "開啟精彩旅程！", "", ""]);
  
  // 6. 美食清單 (Food) - 純白留空：僅寫入標準欄位 Header，不預設任何特定餐廳或美食
  let foodSheet = ss.getSheetByName("Food");
  if (!foodSheet) foodSheet = ss.insertSheet("Food");
  foodSheet.clear();
  foodSheet.appendRow(["id", "emoji", "name", "area", "desc", "must", "done", "imgUrl"]);
  
  // 7. 代購清單 (Shopping) - 純白留空：僅寫入標準欄位 Header，不預設任何商品或特定店家
  let shoppingSheet = ss.getSheetByName("Shopping");
  if (!shoppingSheet) shoppingSheet = ss.insertSheet("Shopping");
  shoppingSheet.clear();
  shoppingSheet.appendRow(["id", "buyer", "name", "location", "price", "qty", "link", "imgUrl", "note", "done"]);

  // 8. 交通規劃 (交通 / Transport) - 純白留空：僅寫入標準欄位 Header，不預設任何車票或路線
  let transSheet = ss.getSheetByName("交通");
  if (!transSheet) transSheet = ss.insertSheet("交通");
  transSheet.clear();
  transSheet.appendRow(["日期", "行程", "起訖點/內容", "時間", "預估費用/人", "幣別", "車種資訊", "備註"]);
}

// 輔助函式：將試算表可能自動轉為 Date 物件的時間格式過濾回乾淨字串 (例如 "14:00")
function formatTimeString(val) {
  if (val === null || val === undefined) return "";
  if (val instanceof Date) {
    return Utilities.formatDate(val, Session.getScriptTimeZone(), "HH:mm");
  }
  const str = val.toString().trim();
  // 匹配 Sat Dec 30 1899 14:00:00 或 ISO 格式
  if (str.includes("1899") || str.includes("1900") || (str.includes("T") && str.includes("Z"))) {
    const m = str.match(/(\d{1,2}:\d{2})(?::\d{2})?/);
    if (m) return m[1];
    try {
      const d = new Date(str);
      if (!isNaN(d.getTime())) {
        return Utilities.formatDate(d, Session.getScriptTimeZone(), "HH:mm");
      }
    } catch (e) {}
  }
  return str;
}

// 從個別試算表加載完整 JSON 資料
function loadTripDetails(sheetId) {
  const ss = SpreadsheetApp.openById(sheetId);
  const result = {};
  
  // 1. Info (基本資料與密碼：採用動態 Key-Value 鍵值映射，徹底免疫試算表列順序變更或手動插行造成的錯位)
  result.name = "";
  result.startDate = "";
  result.endDate = "";
  result.duration = "";
  result.password = "";
  result.theme = "";

  const infoSheet = ss.getSheetByName("Info");
  if (infoSheet) {
    const infoRows = infoSheet.getDataRange().getDisplayValues();
    for (let r = 0; r < infoRows.length; r++) {
      const rowKey = String(infoRows[r][0] || "").trim().toLowerCase();
      const rowVal = infoRows[r][1] !== undefined ? String(infoRows[r][1]).trim() : "";
      if (!rowKey) continue;
      if (rowKey === "name" || rowKey === "行程名稱" || rowKey === "手冊名稱") {
        result.name = rowVal;
      } else if (rowKey === "startdate" || rowKey === "出發日期" || rowKey === "開始日期") {
        result.startDate = rowVal;
      } else if (rowKey === "enddate" || rowKey === "結束日期" || rowKey === "回程日期") {
        result.endDate = rowVal;
      } else if (rowKey === "duration" || rowKey === "天數" || rowKey === "旅遊天數") {
        result.duration = rowVal;
      } else if (rowKey === "password" || rowKey === "密碼") {
        result.password = rowVal;
      } else if (rowKey === "theme" || rowKey === "主題" || rowKey === "顏色風格") {
        result.theme = rowVal;
      }
    }
    // 天數防呆：若試算表未明確填寫 duration，但有出發與回程日期，全自動即時精算並補齊 (例如: 8天7夜)
    if (!result.duration && result.startDate && result.endDate) {
      result.duration = calcTripDurationInGas(result.startDate, result.endDate);
    }
  }
  
  // 2. Checklist (行前準備與必備清單)
  result.checklist = [];
  const chSheet = ss.getSheetByName("Checklist");
  if (chSheet) {
    const chRows = chSheet.getDataRange().getDisplayValues();
    for (let i = 1; i < chRows.length; i++) {
      if (!chRows[i][0] && !chRows[i][2]) continue;
      result.checklist.push({
        id: chRows[i][0] || ("c" + i),
        cat: chRows[i][1] || "",
        title: chRows[i][2] || "",
        note: chRows[i][3] || "",
        link: chRows[i][4] || "",
        done: (chRows[i][5] || "").toString().toUpperCase() === "TRUE"
      });
    }
  }
  
  // 3. Flights (去回程航班資訊)
  result.flights = { out: {}, in: {} };
  const flSheet = ss.getSheetByName("Flights");
  if (flSheet) {
    const flRows = flSheet.getDataRange().getDisplayValues();
    for (let i = 1; i < flRows.length; i++) {
      const type = flRows[i][0];
      const data = {
        airline: flRows[i][1] || "",
        no: flRows[i][2] || "",
        from: flRows[i][3] || "",
        to: flRows[i][4] || "",
        date: flRows[i][5] || "",
        dep: formatTimeString(flRows[i][6]),
        arr: formatTimeString(flRows[i][7]),
        note: flRows[i][8] || ""
      };
      if (type === "out") result.flights.out = data;
      if (type === "in") result.flights.in = data;
    }
  }
  
  // 4. Hotel (支援多筆飯店住宿)
  result.hotels = [];
  const hoSheet = ss.getSheetByName("Hotel");
  if (hoSheet) {
    const hoRows = hoSheet.getDataRange().getDisplayValues();
    for (let i = 1; i < hoRows.length; i++) {
      if (!hoRows[i][0] && !hoRows[i][1]) continue;
      result.hotels.push({
        id: "h" + i,
        name: hoRows[i][0] || "",
        addr: hoRows[i][1] || "",
        checkin: hoRows[i][2] || "",
        checkout: hoRows[i][3] || "",
        nights: hoRows[i][4] || "",
        note: hoRows[i][5] || ""
      });
    }
  }
  // 向下相容單筆物件
  result.hotel = result.hotels.length > 0 ? result.hotels[0] : {};
  
  // 5. Days (使用 getDisplayValues 直接讀取純文字，包含 link 欄位與景點自動去重防護)
  result.days = [];
  const dySheet = ss.getSheetByName("Days");
  if (dySheet) {
    const dyRows = dySheet.getDataRange().getDisplayValues();
    const dayMap = {};
    for (let i = 1; i < dyRows.length; i++) {
      const dayId = dyRows[i][0];
      if (!dayId) continue;
      const date = dyRows[i][1] || "";
      const dayTitle = dyRows[i][2] || "";
      const time = formatTimeString(dyRows[i][3]);
      const place = dyRows[i][4] || "";
      const desc = dyRows[i][5] || "";
      const imgUrl = dyRows[i][6] || "";
      const link = dyRows[i][7] || "";
      
      if (!dayMap[dayId]) {
        dayMap[dayId] = {
          id: dayId,
          date: date,
          title: dayTitle,
          items: [],
          _seenKeys: {}
        };
        result.days.push(dayMap[dayId]);
      }
      
      if (place) {
        // 景點唯一性防重保護：同一天內以「時段 + 地點」為鍵值，避免試算表重複行造成前端重複渲染
        const itemKey = (time || "").trim().toLowerCase() + "___" + (place || "").trim().toLowerCase();
        if (!dayMap[dayId]._seenKeys[itemKey]) {
          const itemObj = {
            time: time,
            place: place,
            desc: desc,
            imgUrl: imgUrl,
            link: link
          };
          dayMap[dayId]._seenKeys[itemKey] = itemObj;
          dayMap[dayId].items.push(itemObj);
        } else {
          // 若有重複列，自動保留備註或圖片更齊全的資料
          const exist = dayMap[dayId]._seenKeys[itemKey];
          if (!exist.desc && desc) exist.desc = desc;
          if (!exist.imgUrl && imgUrl) exist.imgUrl = imgUrl;
          if (!exist.link && link) exist.link = link;
        }
      }
    }
    // 清理內部輔助鍵
    result.days.forEach(d => { delete d._seenKeys; });
  }
  
  // 6. Food (美食口袋清單，支援圖片與店名去重合併)
  result.food = [];
  const fdSheet = ss.getSheetByName("Food");
  if (fdSheet) {
    const fdRows = fdSheet.getDataRange().getValues();
    const foodMap = {};
    for (let i = 1; i < fdRows.length; i++) {
      const name = (fdRows[i][2] || "").toString().trim();
      if (!name && !fdRows[i][0]) continue;
      const key = name.toLowerCase();
      const foodItem = {
        id: fdRows[i][0] || ("f" + i),
        emoji: fdRows[i][1] || "🍴",
        name: name,
        area: fdRows[i][3] || "",
        desc: fdRows[i][4] || "",
        must: (fdRows[i][5] || "").toString().toUpperCase() === "TRUE",
        done: (fdRows[i][6] || "").toString().toUpperCase() === "TRUE",
        imgUrl: fdRows[i][7] || ""
      };
      if (key) {
        if (!foodMap[key]) {
          foodMap[key] = foodItem;
          result.food.push(foodItem);
        } else {
          const exist = foodMap[key];
          if (foodItem.must) exist.must = true;
          if (foodItem.done) exist.done = true;
          if (!exist.desc && foodItem.desc) exist.desc = foodItem.desc;
          if (!exist.imgUrl && foodItem.imgUrl) exist.imgUrl = foodItem.imgUrl;
          if (!exist.area && foodItem.area) exist.area = foodItem.area;
        }
      } else {
        result.food.push(foodItem);
      }
    }
  }
  
  // 7. Shopping (代購清單)
  result.shopping = [];
  const shSheet = ss.getSheetByName("Shopping");
  if (shSheet) {
    const shRows = shSheet.getDataRange().getDisplayValues();
    if (shRows.length > 0) {
      const headers = shRows[0].map(h => h.toString().trim().toLowerCase());
      const qtyIdx = headers.indexOf("qty");
      const hasQtyCol = qtyIdx !== -1;
      
      for (let i = 1; i < shRows.length; i++) {
        if (!shRows[i][0] && !shRows[i][2]) continue;
        if (hasQtyCol) {
          result.shopping.push({
            id: shRows[i][0] || ("s" + i),
            buyer: shRows[i][1] || "自己",
            name: shRows[i][2] || "",
            location: shRows[i][3] || "",
            price: shRows[i][4] || "",
            qty: shRows[i][5] || "1",
            link: shRows[i][6] || "",
            imgUrl: shRows[i][7] || "",
            note: shRows[i][8] || "",
            done: (shRows[i][9] || "").toString().toUpperCase() === "TRUE"
          });
        } else {
          result.shopping.push({
            id: shRows[i][0] || ("s" + i),
            buyer: shRows[i][1] || "自己",
            name: shRows[i][2] || "",
            location: shRows[i][3] || "",
            price: shRows[i][4] || "",
            qty: "1",
            link: shRows[i][5] || "",
            imgUrl: shRows[i][6] || "",
            note: shRows[i][7] || "",
            done: (shRows[i][8] || "").toString().toUpperCase() === "TRUE"
          });
        }
      }
    }
  }

  // 8. 交通 (Transport) - 多張路線地圖相簿、周遊券與乘車行程
  result.transport = { maps: [], passes: [], routes: [], mapImgUrl: "", mapNote: "" };
  const transSheet = ss.getSheetByName("交通") || ss.getSheetByName("Transport");
  if (transSheet) {
    const trRows = transSheet.getDataRange().getDisplayValues();
    if (trRows.length > 0) {
      for (let i = 1; i < trRows.length; i++) {
        const colA = (trRows[i][0] || "").toString().trim();
        const colB = (trRows[i][1] || "").toString().trim();
        const colC = (trRows[i][2] || "").toString().trim();
        const colD = formatTimeString(trRows[i][3]);
        const colE = (trRows[i][4] || "").toString().trim();
        const colF = (trRows[i][5] || "日円").toString().trim();
        const colG = (trRows[i][6] || "").toString().trim();
        const colH = (trRows[i][7] || "").toString().trim();

        // 嚴格防呆：過濾全空行或無效路線
        if (!colA && !colB && !colC && !colD) continue;

        // 若 A 欄為「地圖」或「MAP」，則讀取為路線地圖相簿項目
        if (colA === "地圖" || colA === "MAP" || colA.toLowerCase() === "map") {
          if (!colB) continue;
          const mapTitle = colC || `路線圖 ${result.transport.maps.length + 1}`;
          const mapUrl = colB;
          const mapNote = colH || colC || "";
          result.transport.maps.push({
            id: "map_" + i,
            title: mapTitle,
            url: mapUrl,
            note: mapNote
          });
          if (!result.transport.mapImgUrl) {
            result.transport.mapImgUrl = mapUrl;
            result.transport.mapNote = mapTitle;
          }
          continue;
        }

        // 周遊券判定：精準比對 A 欄是否為「周遊券」或「PASS」
        if (colA === "周遊券" || colA === "PASS" || colA === "Pass") {
          const passName = colB || colC;
          if (!passName) continue;
          result.transport.passes.push({
            id: "p" + i,
            name: passName,
            cost: colE,
            currency: colF,
            note: colH || (colB ? colC : "")
          });
          continue;
        }

        // 一般乘車行程：若起訖點為空且無車次備註，視為無效幽靈空行予以過濾
        if (!colB && !colG && !colH) continue;

        // 一般乘車行程唯一性防重保護
        const routeKey = (colA || "主要交通") + "___" + colB + "___" + (colD || colC);
        if (!result.transport._seenRoutes) result.transport._seenRoutes = {};
        if (!result.transport._seenRoutes[routeKey]) {
          const routeObj = {
            id: "t" + i,
            dayTag: colA || "主要交通",
            fromTo: colB,
            time: colD || colC,
            cost: colE,
            currency: colF,
            trainInfo: colG || colC,
            seatInfo: colG,
            note: colH
          };
          result.transport._seenRoutes[routeKey] = routeObj;
          result.transport.routes.push(routeObj);
        }
      }
      delete result.transport._seenRoutes;
    }
  }
  
  return result;
}

// 批次寫入工作表輔助函式 (一律一次性 setValues，自動補齊不足行數與欄數，儲存速度比逐行 appendRow 快 10 倍以上，防止 GAS 逾時與 Range 溢出錯誤)
function batchWriteSheetRows(sheet, rows) {
  if (!sheet) return;
  sheet.clearContents();
  if (rows && rows.length > 0) {
    const requiredRows = rows.length;
    const requiredCols = rows[0].length;
    const currentRows = sheet.getMaxRows();
    if (currentRows < requiredRows) {
      sheet.insertRowsAfter(currentRows, requiredRows - currentRows);
    }
    const currentCols = sheet.getMaxColumns();
    if (currentCols < requiredCols) {
      sheet.insertColumnsAfter(currentCols, requiredCols - currentCols);
    }
    sheet.getRange(1, 1, requiredRows, requiredCols).setValues(rows);
  }
}

// 輔助函式：動態設定 Info 工作表中的鍵值（依據第一欄 Key 尋找對應行寫入，若不存在則新增，徹底杜絕寫死行號造成的錯位）
function setInfoSheetKeyValue(infoSheet, key, value) {
  if (!infoSheet || !key) return;
  const targetKey = String(key).trim().toLowerCase();
  const data = infoSheet.getDataRange().getValues();
  for (let r = 0; r < data.length; r++) {
    const rowKey = String(data[r][0] || "").trim().toLowerCase();
    if (rowKey === targetKey) {
      infoSheet.getRange(r + 1, 2).setValue(value !== undefined && value !== null ? value : "");
      return;
    }
  }
  // 若該 Key 尚不存在，自動追加新行
  infoSheet.appendRow([key, value !== undefined && value !== null ? value : ""]);
}

// 輔助函式：批次設定 Info 表多個鍵值
function setInfoSheetMap(infoSheet, keyValueMap) {
  if (!infoSheet || !keyValueMap) return;
  const existingData = infoSheet.getDataRange().getValues();
  const keyToRowIndex = {};
  for (let r = 0; r < existingData.length; r++) {
    const rowKey = String(existingData[r][0] || "").trim().toLowerCase();
    if (rowKey) {
      keyToRowIndex[rowKey] = r + 1; // 1-indexed
    }
  }

  for (let [k, val] of Object.entries(keyValueMap)) {
    if (val === undefined) continue;
    const lk = String(k).trim().toLowerCase();
    if (keyToRowIndex[lk]) {
      infoSheet.getRange(keyToRowIndex[lk], 2).setValue(val !== null ? val : "");
    } else {
      infoSheet.appendRow([k, val !== null ? val : ""]);
      keyToRowIndex[lk] = infoSheet.getLastRow();
    }
  }
}

// 儲存前端修改後的完整資料回 Google 試算表 (全面採用高效能批次寫入架構)
function saveTripDetails(sheetId, data) {
  const ss = SpreadsheetApp.openById(sheetId);
  
  // 1. Info (基本手冊資訊與密碼同步，採用動態 Key 比對寫入)
  let infoSheet = ss.getSheetByName("Info");
  if (!infoSheet) {
    infoSheet = ss.insertSheet("Info");
    infoSheet.appendRow(["Key", "Value"]);
  }
  
  // 計算天數防呆
  let tripDuration = data.duration || "";
  if (!tripDuration && data.startDate && data.endDate) {
    tripDuration = calcTripDurationInGas(data.startDate, data.endDate);
  }

  const infoMap = {
    "Name": data.name || "",
    "StartDate": data.startDate || "",
    "EndDate": data.endDate || "",
    "Duration": tripDuration
  };
  if (data.password !== undefined) {
    infoMap["Password"] = data.password || "";
  }
  if (data.theme !== undefined) {
    infoMap["Theme"] = data.theme || "";
  }
  setInfoSheetMap(infoSheet, infoMap);
  
  // 2. Checklist (行前準備與行李清單)
  let checklistSheet = ss.getSheetByName("Checklist");
  if (!checklistSheet) checklistSheet = ss.insertSheet("Checklist");
  const rowsChecklist = [["id", "cat", "title", "note", "link", "done"]];
  (data.checklist || []).forEach(item => {
    if (!item || (!item.title && !item.id)) return;
    rowsChecklist.push([
      item.id || "",
      item.cat || "",
      item.title || "",
      item.note || "",
      item.link || "",
      item.done ? "TRUE" : "FALSE"
    ]);
  });
  batchWriteSheetRows(checklistSheet, rowsChecklist);
  
  // 3. Flights (航班資訊)
  let flightsSheet = ss.getSheetByName("Flights");
  if (!flightsSheet) flightsSheet = ss.insertSheet("Flights");
  const rowsFlights = [["Type", "airline", "no", "from", "to", "date", "dep", "arr", "note"]];
  if (data.flights && data.flights.out) {
    const f = data.flights.out;
    rowsFlights.push(["out", f.airline || "", f.no || "", f.from || "", f.to || "", f.date || "", f.dep || "", f.arr || "", f.note || ""]);
  }
  if (data.flights && data.flights.in) {
    const f = data.flights.in;
    rowsFlights.push(["in", f.airline || "", f.no || "", f.from || "", f.to || "", f.date || "", f.dep || "", f.arr || "", f.note || ""]);
  }
  batchWriteSheetRows(flightsSheet, rowsFlights);
  
  // 4. Hotel (支援多筆飯店住宿)
  let hotelSheet = ss.getSheetByName("Hotel");
  if (!hotelSheet) hotelSheet = ss.insertSheet("Hotel");
  const rowsHotel = [["name", "addr", "checkin", "checkout", "nights", "note"]];
  const hotelList = data.hotels || (data.hotel ? [data.hotel] : []);
  hotelList.forEach(h => {
    if (h && (h.name || h.addr)) {
      rowsHotel.push([
        h.name || "",
        h.addr || "",
        h.checkin || "",
        h.checkout || "",
        h.nights || "",
        h.note || ""
      ]);
    }
  });
  batchWriteSheetRows(hotelSheet, rowsHotel);
  
  // 5. Days (每日行程景點與活動，寫入前自動去重保護)
  let daysSheet = ss.getSheetByName("Days");
  if (!daysSheet) daysSheet = ss.insertSheet("Days");
    const rows = [["dayId", "date", "title", "time", "place", "desc", "imgUrl", "link"]];
    (data.days || []).forEach(d => {
      if (d.items && d.items.length > 0) {
        const seenDayItems = new Set();
        d.items.forEach(item => {
          const p = (item.place || "").trim();
          if (!p) return;
          const t = (item.time || "").trim();
          const itemKey = t.toLowerCase() + "___" + p.toLowerCase();
          if (!seenDayItems.has(itemKey)) {
            seenDayItems.add(itemKey);
            rows.push([
              d.id || "",
              d.date || "",
              d.title || "",
              t,
              p,
              item.desc || "",
              item.imgUrl || "",
              item.link || ""
            ]);
          }
        });
      } else {
        rows.push([d.id || "", d.date || "", d.title || "", "", "", "", "", ""]);
      }
    });
    batchWriteSheetRows(daysSheet, rows);
  
  // 6. Food (美食口袋清單，寫入前店名唯一性防重)
  let foodSheet = ss.getSheetByName("Food");
  if (!foodSheet) foodSheet = ss.insertSheet("Food");
  const foodRows = [["id", "emoji", "name", "area", "desc", "must", "done", "imgUrl"]];
  const seenFood = new Set();
  (data.food || []).forEach(item => {
    const name = (item.name || "").trim();
    if (!name) return;
    const k = name.toLowerCase();
    if (!seenFood.has(k)) {
      seenFood.add(k);
      foodRows.push([
        item.id || "",
        item.emoji || "🍴",
        name,
        item.area || "",
        item.desc || "",
        item.must ? "TRUE" : "FALSE",
        item.done ? "TRUE" : "FALSE",
        item.imgUrl || ""
      ]);
    }
  });
  batchWriteSheetRows(foodSheet, foodRows);

  // 7. Shopping (代購清單)
  let shoppingSheet = ss.getSheetByName("Shopping");
  if (!shoppingSheet) shoppingSheet = ss.insertSheet("Shopping");
  const shopRows = [["id", "buyer", "name", "location", "price", "qty", "link", "imgUrl", "note", "done"]];
  (data.shopping || []).forEach(item => {
    if (!item || (!item.name && !item.id)) return;
    shopRows.push([
      item.id || "",
      item.buyer || "",
      item.name || "",
      item.location || "",
      item.price || "",
      item.qty || "1",
      item.link || "",
      item.imgUrl || "",
      item.note || "",
      item.done ? "TRUE" : "FALSE"
    ]);
  });
  batchWriteSheetRows(shoppingSheet, shopRows);

  // 8. 交通 (Transport) - 多張路線地圖相簿、周遊券與乘車行程
  if (data.transport) {
    let transSheet = ss.getSheetByName("交通") || ss.getSheetByName("Transport");
    if (!transSheet) transSheet = ss.insertSheet("交通");
    const transRows = [["類別/日期", "圖片網址/行程", "名稱/起訖點", "時間", "預估費用/人", "幣別", "車種/座位", "備註"]];

    // 寫入多張地圖相簿資訊
    const maps = data.transport.maps || [];
    if (maps.length > 0) {
      maps.forEach(m => {
        if (m.url) {
          transRows.push(["地圖", m.url, m.title || "路線地圖", "", "", "", "", m.note || ""]);
        }
      });
    } else if (data.transport.mapImgUrl) {
      // 向下相容單張地圖
      transRows.push(["地圖", data.transport.mapImgUrl, data.transport.mapNote || "主要交通路線圖", "", "", "", "", data.transport.mapNote || ""]);
    }

    // 寫入周遊券
    (data.transport.passes || []).forEach(p => {
      transRows.push(["周遊券", p.name || "", "", "", p.cost || "", p.currency || "日円", "", p.note || ""]);
    });

    // 寫入乘車行程 (過濾幽靈空行並防止重複寫入)
    const seenRoutes = new Set();
    (data.transport.routes || []).forEach(r => {
      const ft = (r.fromTo || "").trim();
      const ti = (r.trainInfo || "").trim();
      const nt = (r.note || "").trim();
      if (!ft && !ti && !nt) return; // 略過全空假資料
      const rKey = (r.dayTag || "") + "___" + ft + "___" + (r.time || "");
      if (!seenRoutes.has(rKey)) {
        seenRoutes.add(rKey);
        transRows.push([
          r.dayTag || "",
          ft,
          ti,
          r.time || "",
          r.cost || "",
          r.currency || "日円",
          r.seatInfo || "",
          nt
        ]);
      }
    });

    batchWriteSheetRows(transSheet, transRows);
  }
}

// 專供授權成員 (Member) 使用的內容儲存函式
// 實體隔離：完全不讀寫 Info 工作表，僅更新七類內容工作表，徹底防止 PIN、名稱、天數被意外清空或竄改
function saveTripContentOnly(sheetId, rawData) {
  if (!sheetId || !rawData) return;
  const ss = SpreadsheetApp.openById(sheetId);

  // 1. Checklist (行前準備與行李清單)
  if (Array.isArray(rawData.checklist)) {
    let checklistSheet = ss.getSheetByName("Checklist");
    if (!checklistSheet) checklistSheet = ss.insertSheet("Checklist");
    const rowsChecklist = [["id", "cat", "title", "note", "link", "done"]];
    rawData.checklist.forEach(item => {
      if (!item || (!item.title && !item.id)) return;
      rowsChecklist.push([
        item.id || "",
        item.cat || "",
        item.title || "",
        item.note || "",
        item.link || "",
        item.done ? "TRUE" : "FALSE"
      ]);
    });
    batchWriteSheetRows(checklistSheet, rowsChecklist);
  }

  // 2. Flights (航班資訊)
  if (rawData.flights) {
    let flightsSheet = ss.getSheetByName("Flights");
    if (!flightsSheet) flightsSheet = ss.insertSheet("Flights");
    const rowsFlights = [["Type", "airline", "no", "from", "to", "date", "dep", "arr", "note"]];
    if (rawData.flights.out) {
      const f = rawData.flights.out;
      rowsFlights.push(["out", f.airline || "", f.no || "", f.from || "", f.to || "", f.date || "", f.dep || "", f.arr || "", f.note || ""]);
    }
    if (rawData.flights.in) {
      const f = rawData.flights.in;
      rowsFlights.push(["in", f.airline || "", f.no || "", f.from || "", f.to || "", f.date || "", f.dep || "", f.arr || "", f.note || ""]);
    }
    batchWriteSheetRows(flightsSheet, rowsFlights);
  }

  // 3. Hotel (支援多筆飯店住宿)
  if (rawData.hotels || rawData.hotel) {
    let hotelSheet = ss.getSheetByName("Hotel");
    if (!hotelSheet) hotelSheet = ss.insertSheet("Hotel");
    const rowsHotel = [["name", "addr", "checkin", "checkout", "nights", "note"]];
    const hotelList = rawData.hotels || (rawData.hotel ? [rawData.hotel] : []);
    hotelList.forEach(h => {
      if (h && (h.name || h.addr)) {
        rowsHotel.push([
          h.name || "",
          h.addr || "",
          h.checkin || "",
          h.checkout || "",
          h.nights || "",
          h.note || ""
        ]);
      }
    });
    batchWriteSheetRows(hotelSheet, rowsHotel);
  }

  // 4. Days (每日景點行程規劃)
  if (Array.isArray(rawData.days)) {
    let daysSheet = ss.getSheetByName("Days");
    if (!daysSheet) daysSheet = ss.insertSheet("Days");
    const rowsDays = [["dayId", "date", "title", "time", "place", "desc", "imgUrl", "link"]];
    rawData.days.forEach(day => {
      if (!day) return;
      const dId = day.id || "";
      const dDate = day.date || "";
      const dTitle = day.title || "";
      const activities = day.items || day.activities || [];
      if (activities.length === 0) {
        rowsDays.push([dId, dDate, dTitle, "", "", "", "", ""]);
      } else {
        const seenDayItems = new Set();
        activities.forEach(act => {
          if (!act) return;
          const p = (act.place || "").trim();
          if (!p) return;
          const t = (act.time || "").trim();
          const itemKey = t.toLowerCase() + "___" + p.toLowerCase();
          if (!seenDayItems.has(itemKey)) {
            seenDayItems.add(itemKey);
            rowsDays.push([
              dId,
              dDate,
              dTitle,
              t,
              p,
              act.desc || "",
              act.imgUrl || "",
              act.link || ""
            ]);
          }
        });
      }
    });
    batchWriteSheetRows(daysSheet, rowsDays);
  }

  // 5. Food (精選美食清單)
  if (Array.isArray(rawData.food)) {
    let foodSheet = ss.getSheetByName("Food");
    if (!foodSheet) foodSheet = ss.insertSheet("Food");
    const rowsFood = [["id", "emoji", "name", "area", "desc", "must", "done", "imgUrl"]];
    rawData.food.forEach(item => {
      if (!item || (!item.name && !item.id)) return;
      rowsFood.push([
        item.id || "",
        item.emoji || "🍽️",
        item.name || "",
        item.area || "",
        item.desc || "",
        item.must ? "TRUE" : "FALSE",
        item.done ? "TRUE" : "FALSE",
        item.imgUrl || ""
      ]);
    });
    batchWriteSheetRows(foodSheet, rowsFood);
  }

  // 6. Shopping (代購清單)
  if (Array.isArray(rawData.shopping)) {
    let shoppingSheet = ss.getSheetByName("Shopping");
    if (!shoppingSheet) shoppingSheet = ss.insertSheet("Shopping");
    const rowsShopping = [["id", "buyer", "name", "location", "price", "qty", "link", "imgUrl", "note", "done"]];
    rawData.shopping.forEach(item => {
      if (!item || (!item.name && !item.id)) return;
      rowsShopping.push([
        item.id || "",
        item.buyer || "自己",
        item.name || "",
        item.location || "",
        item.price || "",
        item.qty || "1",
        item.link || "",
        item.imgUrl || "",
        item.note || "",
        item.done ? "TRUE" : "FALSE"
      ]);
    });
    batchWriteSheetRows(shoppingSheet, rowsShopping);
  }

  // 7. 交通 (Transport)
  if (rawData.transport) {
    let transSheet = ss.getSheetByName("交通") || ss.getSheetByName("Transport");
    if (!transSheet) transSheet = ss.insertSheet("交通");
    const transRows = [["日期", "行程", "起訖點/內容", "時間", "預估費用/人", "幣別", "車種資訊", "備註"]];
    const maps = rawData.transport.maps || [];
    if (maps.length > 0) {
      maps.forEach(m => {
        if (m.url) {
          transRows.push(["地圖", m.url, m.title || "路線地圖", "", "", "", "", m.note || ""]);
        }
      });
    } else if (rawData.transport.mapImgUrl) {
      transRows.push(["地圖", rawData.transport.mapImgUrl, rawData.transport.mapNote || "主要交通路線圖", "", "", "", "", rawData.transport.mapNote || ""]);
    }
    (rawData.transport.passes || []).forEach(p => {
      transRows.push(["周遊券", p.name || "", "", "", p.cost || "", p.currency || "日円", "", p.note || ""]);
    });
    const seenRoutes = new Set();
    (rawData.transport.routes || []).forEach(r => {
      const ft = (r.fromTo || "").trim();
      const ti = (r.trainInfo || "").trim();
      const nt = (r.note || "").trim();
      if (!ft && !ti && !nt) return;
      const rKey = (r.dayTag || "") + "___" + ft + "___" + (r.time || "");
      if (!seenRoutes.has(rKey)) {
        seenRoutes.add(rKey);
        transRows.push([
          r.dayTag || "",
          ft,
          ti,
          r.time || "",
          r.cost || "",
          r.currency || "日円",
          r.seatInfo || "",
          nt
        ]);
      }
    });
    batchWriteSheetRows(transSheet, transRows);
  }
}

